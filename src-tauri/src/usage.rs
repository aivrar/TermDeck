//! How much CPU and memory each tab's processes are using, and the tools for a tab
//! that has run away: end everything it started, or drop it to low priority.
//!
//! Every shell is put in its own Windows Job Object when it starts. Everything the
//! shell starts afterwards lands in the same job automatically, and stays there even
//! when its parent exits — which is exactly the case a walk of the process tree
//! misses (a build tool that starts workers and then quits, leaving them running).
//!
//! Nothing may leave a tab's job. (It used to be allowed, "so nothing fails to start";
//! but Git Bash — which Claude Code runs every command through — then starts every
//! Windows program outside the job, and its own processes routinely exit mid-chain, so
//! what Claude ran was counted in no tab and outlived Kill and close. Measured
//! 2026-11-12.) And if TermDeck itself ends unexpectedly — a crash, Task Manager's End
//! task — the crash guard (guard.rs) ends every tab's programs instead of leaving them
//! running where nothing can see or stop them any more.
//!
//! None of this needs administrator rights: these are the app's own child processes.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::sync::Mutex;
use std::time::Instant;
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_MORE_DATA, FILETIME, HANDLE, WAIT_TIMEOUT};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JobObjectBasicProcessIdList, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject, JOBOBJECT_BASIC_PROCESS_ID_LIST,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_PRIORITY_CLASS,
};
use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use windows_sys::Win32::System::SystemInformation::{
    GetSystemInfo, GetSystemTimeAsFileTime, GlobalMemoryStatusEx, MEMORYSTATUSEX, SYSTEM_INFO,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetPriorityClass, GetProcessTimes, GetSystemTimes, OpenProcess, SetPriorityClass, TerminateProcess,
    WaitForSingleObject, ABOVE_NORMAL_PRIORITY_CLASS, IDLE_PRIORITY_CLASS,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_INFORMATION, PROCESS_SET_QUOTA, PROCESS_SYNCHRONIZE,
    PROCESS_TERMINATE,
};

fn ticks(ft: &FILETIME) -> u64 {
    ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64
}

// ---------- job objects ----------

/// A Job Object holding one tab's shell and everything started under it.
pub struct Job {
    handle: HANDLE,
    /// The limits it was made with, so that low priority can be added and taken off
    /// again without losing them.
    flags: u32,
    /// Its programs end with it (OnClose::End): when it is let go of, and — through the
    /// crash guard — when TermDeck ends unexpectedly.
    ends: bool,
}
// A job handle is a plain kernel handle; it is safe to use from any thread.
unsafe impl Send for Job {}
unsafe impl Sync for Job {}

/// How a job treats its processes when its last handle is closed.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum OnClose {
    /// Everything still in it is ended (tabs, and the app's own short-lived helpers).
    End,
    /// Left running (a CLI updater: stopping one halfway could break the CLI's install).
    Keep,
}

impl Job {
    /// Creates a job and puts the given (just started) process in it. Nothing in the
    /// job may leave it (no breakaway is allowed).
    pub fn for_process(pid: u32, on_close: OnClose) -> Option<Job> {
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return None;
            }
            // No limits at all: in particular not Windows' "end everything when the last
            // handle closes" — see guard.rs for why the crash guard does that instead.
            let job = Job { handle, flags: 0, ends: on_close == OnClose::End };
            if !job.set_flags(job.flags, 0) {
                return None;
            }
            if job.ends {
                // Without the guard the tab still works and is still ended on every
                // normal close; only a crash of TermDeck would leave its programs.
                crate::guard::watch(job.handle);
            }
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() {
                return None;
            }
            let ok = AssignProcessToJobObject(job.handle, process);
            CloseHandle(process);
            if ok == 0 {
                return None;
            }
            Some(job)
        }
    }

    /// Adds a process to the job (one that was started before its parent was put in
    /// it). False if it could not be.
    pub fn adopt(&self, pid: u32) -> bool {
        unsafe {
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() {
                return false;
            }
            let ok = AssignProcessToJobObject(self.handle, process) != 0;
            CloseHandle(process);
            ok
        }
    }

    fn set_flags(&self, flags: u32, priority: u32) -> bool {
        unsafe {
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = flags;
            info.BasicLimitInformation.PriorityClass = priority;
            SetInformationJobObject(
                self.handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) != 0
        }
    }

    /// Low priority for everything in the job — what runs now and anything started in
    /// it later — or the limit taken off again. (Taking it off does not change the
    /// processes back by themselves; whoever set it puts back what each had before.)
    /// True if Windows took it.
    pub fn set_low_priority(&self, low: bool) -> bool {
        if low {
            self.set_flags(self.flags | JOB_OBJECT_LIMIT_PRIORITY_CLASS, IDLE_PRIORITY_CLASS)
        } else {
            self.set_flags(self.flags, 0)
        }
    }

    /// Every process currently in the job — or None if Windows would not say (then
    /// nothing may be concluded, least of all that the job is empty).
    pub fn pids(&self) -> Option<Vec<u32>> {
        // Room grows to what Windows reports, up to far more than any tab will hold.
        let mut room: usize = 512;
        loop {
            // u64 storage keeps the buffer aligned for the structure laid over it:
            // two counts (one u64), then one u64-sized id per process.
            let mut buf = vec![0u64; room + 1];
            unsafe {
                let ok = QueryInformationJobObject(
                    self.handle,
                    JobObjectBasicProcessIdList,
                    buf.as_mut_ptr() as *mut c_void,
                    (buf.len() * 8) as u32,
                    std::ptr::null_mut(),
                ) != 0;
                let list = buf.as_ptr() as *const JOBOBJECT_BASIC_PROCESS_ID_LIST;
                let assigned = (*list).NumberOfAssignedProcesses as usize;
                if ok {
                    let n = ((*list).NumberOfProcessIdsInList as usize).min(room);
                    return Some(std::slice::from_raw_parts((*list).ProcessIdList.as_ptr(), n).iter().map(|p| *p as u32).collect());
                }
                if GetLastError() == ERROR_MORE_DATA && room < 65_536 {
                    room = (assigned + 64).max(room * 2).min(65_536);
                    continue;
                }
                return None;
            }
        }
    }

    /// True only when Windows confirms the job holds nothing.
    pub fn is_empty(&self) -> bool {
        self.pids().is_some_and(|p| p.is_empty())
    }

    /// Every process currently in the job, each with its creation time. Membership is
    /// confirmed on the same handle the creation time is read from: a process id from
    /// the list above can, in the instant after it was read, have passed to a new and
    /// unrelated process (the old one ended, Windows handed its id on) — that one is
    /// not in this job, and is left out here instead of being taken for the tab's.
    pub fn members_exact(&self) -> Vec<(u32, u64)> {
        let mut out = Vec::new();
        for pid in self.pids().unwrap_or_default() {
            unsafe {
                let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                if handle.is_null() {
                    continue;
                }
                let mut inside = 0;
                let member = IsProcessInJob(handle, self.handle, &mut inside) != 0 && inside != 0;
                let mut created: FILETIME = std::mem::zeroed();
                let mut other: [FILETIME; 3] = std::mem::zeroed();
                let timed = member && GetProcessTimes(handle, &mut created, &mut other[0], &mut other[1], &mut other[2]) != 0;
                CloseHandle(handle);
                if timed {
                    out.push((pid, ticks(&created)));
                }
            }
        }
        out
    }

    /// Ends every process in the job at once. False if Windows refused.
    pub fn terminate(&self) -> bool {
        unsafe { TerminateJobObject(self.handle, 1) != 0 }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        // A job whose programs end with it (OnClose::End) ends whatever is still in it.
        // Every place that lets go of a tab's job has ended its programs already or has
        // confirmed the job is empty; for the app's short-lived helpers this ends what
        // a helper left running.
        unsafe {
            if self.ends {
                TerminateJobObject(self.handle, 1);
                crate::guard::release(self.handle);
            }
            CloseHandle(self.handle);
        }
    }
}

// ---------- single processes ----------

/// (creation time, CPU time used so far, memory in use) — times in 100 ns ticks.
fn read(pid: u32) -> Option<(u64, u64, u64)> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut born: FILETIME = std::mem::zeroed();
        let mut exited: FILETIME = std::mem::zeroed();
        let mut kernel: FILETIME = std::mem::zeroed();
        let mut user: FILETIME = std::mem::zeroed();
        let ok = GetProcessTimes(handle, &mut born, &mut exited, &mut kernel, &mut user);
        let mut pmc: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
        pmc.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        let mem_ok = K32GetProcessMemoryInfo(handle, &mut pmc, pmc.cb);
        CloseHandle(handle);
        if ok == 0 {
            return None;
        }
        let mem = if mem_ok != 0 { pmc.WorkingSetSize as u64 } else { 0 };
        Some((ticks(&born), ticks(&kernel) + ticks(&user), mem))
    }
}

/// When a process was created; used to be sure a process id still means the same process.
pub fn created(pid: u32) -> Option<u64> {
    read(pid).map(|r| r.0)
}

/// True while the process with this id is the one created at `born` and has not ended.
/// (A finished process can still be opened for as long as anyone holds a handle to it,
/// so "can be opened" alone does not mean "running".)
pub fn alive_exact(pid: u32, born: u64) -> bool {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut created: FILETIME = std::mem::zeroed();
        let mut other: [FILETIME; 3] = std::mem::zeroed();
        let same = GetProcessTimes(handle, &mut created, &mut other[0], &mut other[1], &mut other[2]) != 0
            && ticks(&created) == born;
        let running = same && WaitForSingleObject(handle, 0) == WAIT_TIMEOUT;
        CloseHandle(handle);
        running
    }
}

/// Ends a process only if it is still the one that was listed: same id AND same
/// creation time, checked on the very handle that is then used to end it. Windows
/// hands a finished process's id to the next process that starts, so an id on its own
/// can come to mean a different program between listing and ending.
pub fn kill_exact(pid: u32, born: u64) -> bool {
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut created: FILETIME = std::mem::zeroed();
        let mut other: [FILETIME; 3] = std::mem::zeroed();
        let same = GetProcessTimes(handle, &mut created, &mut other[0], &mut other[1], &mut other[2]) != 0
            && ticks(&created) == born;
        let ok = same && TerminateProcess(handle, 1) != 0;
        CloseHandle(handle);
        ok
    }
}

/// A process's priority class, if it can be read.
pub fn priority_of(pid: u32) -> Option<u32> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let class = GetPriorityClass(handle);
        CloseHandle(handle);
        (class != 0).then_some(class)
    }
}

/// Sets a process's priority class — with `born`, only if the id still means the
/// process created then. False if it could not be done.
pub fn set_priority_exact(pid: u32, born: Option<u64>, class: u32) -> bool {
    unsafe {
        let handle = OpenProcess(PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut created: FILETIME = std::mem::zeroed();
        let mut other: [FILETIME; 3] = std::mem::zeroed();
        let same = born.is_none_or(|b| {
            GetProcessTimes(handle, &mut created, &mut other[0], &mut other[1], &mut other[2]) != 0 && ticks(&created) == b
        });
        let ok = same && SetPriorityClass(handle, class) != 0;
        CloseHandle(handle);
        ok
    }
}

/// Puts the app itself, and the given helper processes that draw its window, a step
/// above normal so its buttons still answer while a tab is hammering the machine.
/// Shells and their programs do not inherit this: they start at normal priority.
pub fn raise_own_priority(helpers: &[u32]) {
    unsafe {
        SetPriorityClass(GetCurrentProcess(), ABOVE_NORMAL_PRIORITY_CLASS);
        for pid in helpers {
            let handle = OpenProcess(PROCESS_SET_INFORMATION, 0, *pid);
            if !handle.is_null() {
                SetPriorityClass(handle, ABOVE_NORMAL_PRIORITY_CLASS);
                CloseHandle(handle);
            }
        }
    }
}

// ---------- sampling ----------

#[derive(Serialize, Clone, Default)]
pub struct ProcUsage {
    pub pid: u32,
    /// The process that started it (as Windows records it), so the window can tell
    /// what a CLI itself started from what else is in the tab.
    pub ppid: u32,
    pub name: String,
    /// Percent of the whole machine (all cores), like Task Manager.
    pub cpu: f32,
    /// Bytes of memory in use (working set).
    pub mem: u64,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SystemUsage {
    pub cpu: f32,
    pub mem_used: u64,
    pub mem_total: u64,
    pub cores: u32,
    /// The WSL virtual machine is running (it is shared, so no tab counts it).
    pub wsl: bool,
    /// Its CPU (percent of the whole PC) and memory in use (bytes).
    pub wsl_cpu: f32,
    pub wsl_mem: u64,
}

#[derive(Default)]
struct Inner {
    at: Option<Instant>,
    /// pid -> (creation time, CPU time) at the previous sample
    procs: HashMap<u32, (u64, u64)>,
    /// (idle, total) system times at the previous sample
    sys: Option<(u64, u64)>,
    cores: u32,
}

/// Remembers the previous reading so CPU can be reported as a rate.
#[derive(Default)]
pub struct UsageCache(Mutex<Inner>);

impl UsageCache {
    /// CPU % and memory for each of the given processes, plus the machine totals.
    pub fn sample(&self, pids: &HashSet<u32>) -> (HashMap<u32, (f32, u64)>, SystemUsage) {
        let mut inner = self.0.lock().unwrap();
        if inner.cores == 0 {
            unsafe {
                let mut si: SYSTEM_INFO = std::mem::zeroed();
                GetSystemInfo(&mut si);
                inner.cores = si.dwNumberOfProcessors.max(1);
            }
        }
        let now = Instant::now();
        let elapsed = inner.at.map(|t| now.duration_since(t).as_secs_f64()).unwrap_or(0.0);
        let window = elapsed * 1e7; // the interval in 100 ns ticks
        let capacity = window * inner.cores as f64;
        let wall_now = unsafe {
            let mut ft: FILETIME = std::mem::zeroed();
            GetSystemTimeAsFileTime(&mut ft);
            ticks(&ft)
        };

        let mut out = HashMap::new();
        let mut next = HashMap::new();
        for &pid in pids {
            let Some((born, cpu, mem)) = read(pid) else { continue };
            let used = match inner.procs.get(&pid) {
                Some(&(prev_born, prev_cpu)) if prev_born == born => cpu.saturating_sub(prev_cpu),
                // Started since the last reading: all of its CPU time falls in this interval.
                _ if window > 0.0 && (wall_now.saturating_sub(born) as f64) < window * 1.5 => cpu,
                _ => 0,
            };
            let pct = if capacity > 0.0 { (used as f64 / capacity * 100.0).clamp(0.0, 100.0) } else { 0.0 };
            out.insert(pid, (pct as f32, mem));
            next.insert(pid, (born, cpu));
        }
        inner.procs = next;

        let mut system = SystemUsage { cores: inner.cores, ..Default::default() };
        unsafe {
            let mut idle: FILETIME = std::mem::zeroed();
            let mut kernel: FILETIME = std::mem::zeroed();
            let mut user: FILETIME = std::mem::zeroed();
            if GetSystemTimes(&mut idle, &mut kernel, &mut user) != 0 {
                // "kernel" includes idle time.
                let (i, total) = (ticks(&idle), ticks(&kernel) + ticks(&user));
                if let Some((pi, pt)) = inner.sys {
                    let dt = total.saturating_sub(pt);
                    if dt > 0 {
                        let busy = dt.saturating_sub(i.saturating_sub(pi));
                        system.cpu = (busy as f64 / dt as f64 * 100.0).clamp(0.0, 100.0) as f32;
                    }
                }
                inner.sys = Some((i, total));
            }
            let mut ms: MEMORYSTATUSEX = std::mem::zeroed();
            ms.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
            if GlobalMemoryStatusEx(&mut ms) != 0 {
                system.mem_total = ms.ullTotalPhys;
                system.mem_used = ms.ullTotalPhys.saturating_sub(ms.ullAvailPhys);
            }
        }
        inner.at = Some(now);
        (out, system)
    }
}

// ---------- command lines ----------

#[link(name = "ntdll")]
extern "system" {
    fn NtQueryInformationProcess(process: HANDLE, class: u32, info: *mut c_void, len: u32, ret_len: *mut u32) -> i32;
}

/// The arguments a process was started with (without the program name itself).
/// Used to bring a CLI back with the same switches it was started with.
pub fn arguments(pid: u32) -> Vec<String> {
    #[repr(C)]
    struct UnicodeString {
        length: u16,
        maximum_length: u16,
        buffer: *const u16,
    }
    const PROCESS_COMMAND_LINE_INFORMATION: u32 = 60;
    let line = unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return Vec::new();
        }
        // u64 storage keeps the buffer aligned for the structure Windows writes into it.
        let mut buf = vec![0u64; 8192];
        let mut wrote = 0u32;
        let status = NtQueryInformationProcess(
            handle,
            PROCESS_COMMAND_LINE_INFORMATION,
            buf.as_mut_ptr() as *mut c_void,
            (buf.len() * 8) as u32,
            &mut wrote,
        );
        CloseHandle(handle);
        if status < 0 {
            return Vec::new();
        }
        let us = &*(buf.as_ptr() as *const UnicodeString);
        if us.buffer.is_null() || us.length == 0 {
            return Vec::new();
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(us.buffer, (us.length / 2) as usize))
    };
    split_args(&line).into_iter().skip(1).collect()
}

/// Splits a Windows command line the way programs themselves do (quotes, and
/// backslashes before quotes).
fn split_args(line: &str) -> Vec<String> {
    let chars: Vec<char> = line.chars().collect();
    let mut args = Vec::new();
    let mut cur = String::new();
    let (mut quoted, mut started, mut i) = (false, false, 0);
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' {
            let mut n = 0;
            while i < chars.len() && chars[i] == '\\' {
                n += 1;
                i += 1;
            }
            started = true;
            if i < chars.len() && chars[i] == '"' {
                cur.extend(std::iter::repeat('\\').take(n / 2));
                if n % 2 == 1 {
                    cur.push('"');
                    i += 1;
                }
            } else {
                cur.extend(std::iter::repeat('\\').take(n));
            }
        } else if c == '"' {
            quoted = !quoted;
            started = true;
            i += 1;
        } else if (c == ' ' || c == '\t') && !quoted {
            if started {
                args.push(std::mem::take(&mut cur));
                started = false;
            }
            i += 1;
        } else {
            cur.push(c);
            started = true;
            i += 1;
        }
    }
    if started {
        args.push(cur);
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    /// Process ids of running `ping.exe` whose command line carries `marker`.
    fn pings(marker: &str) -> Vec<u32> {
        let out = Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", &format!("Get-CimInstance Win32_Process -Filter \"Name='PING.EXE'\" | ? {{ $_.CommandLine -match '-n {marker} ' }} | % {{ $_.ProcessId }}")])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).lines().filter_map(|l| l.trim().parse().ok()).collect()
    }

    /// Git Bash starts Windows programs outside the job whenever the job lets it, and
    /// its starter exits at once here — the way Claude Code's background commands run.
    /// In a tab's job the program must stay in, and must end when the job is let go
    /// (which is also what happens when TermDeck itself ends unexpectedly).
    #[test]
    fn a_program_started_from_git_bash_stays_in_the_job_and_ends_with_it() {
        let bash = r"C:\Program Files\Git\usr\bin\bash.exe";
        if !std::path::Path::new(bash).is_file() {
            eprintln!("Git Bash is not installed: skipped");
            return;
        }
        let marker = "4711";
        // bash waits a moment before it starts anything, so it is in the job by then;
        // then ping goes into the background and bash exits.
        let script = format!("sleep 1; (ping -n {marker} 127.0.0.1 >/dev/null &)");
        let mut child = Command::new(bash).args(["-c", &script]).stdout(Stdio::null()).creation_flags(0x0800_0000).spawn().unwrap();
        let job = Job::for_process(child.id(), OnClose::End).expect("a job");
        std::thread::sleep(Duration::from_millis(3500));
        let found = pings(marker);
        assert_eq!(found.len(), 1, "the background program did not start");
        assert!(job.pids().unwrap().contains(&found[0]), "the program left the job");
        drop(job);
        std::thread::sleep(Duration::from_millis(800));
        let left = pings(marker);
        for pid in &left {
            let _ = Command::new("taskkill").args(["/F", "/PID", &pid.to_string()]).output();
        }
        assert!(left.is_empty(), "the program outlived its job");
        let _ = child.wait();
    }

    #[test]
    fn an_unknown_job_is_never_taken_for_an_empty_one() {
        // A handle that is not a job: Windows cannot list it, and that must not read as "empty".
        // (Not null: to Windows that means "the job this process is in".)
        let bogus = Job { handle: unsafe { GetCurrentProcess() }, flags: 0, ends: false };
        assert!(bogus.pids().is_none());
        assert!(!bogus.is_empty());
        std::mem::forget(bogus);
    }
}
