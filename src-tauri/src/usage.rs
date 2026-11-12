//! How much CPU and memory each tab's processes are using, and the tools for a tab
//! that has run away: end everything it started, or drop it to low priority.
//!
//! Every shell is put in its own Windows Job Object when it starts. Everything the
//! shell starts afterwards lands in the same job automatically, and stays there even
//! when its parent exits — which is exactly the case a walk of the process tree
//! misses (a build tool that starts workers and then quits, leaving them running).
//!
//! None of this needs administrator rights: these are the app's own child processes.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::sync::Mutex;
use std::time::Instant;
use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, WAIT_TIMEOUT};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JobObjectBasicProcessIdList, JobObjectExtendedLimitInformation,
    QueryInformationJobObject, SetInformationJobObject, TerminateJobObject, JOBOBJECT_BASIC_PROCESS_ID_LIST,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
};
use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use windows_sys::Win32::System::SystemInformation::{
    GetSystemInfo, GetSystemTimeAsFileTime, GlobalMemoryStatusEx, MEMORYSTATUSEX, SYSTEM_INFO,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetProcessTimes, GetSystemTimes, OpenProcess, SetPriorityClass, TerminateProcess,
    WaitForSingleObject, ABOVE_NORMAL_PRIORITY_CLASS, IDLE_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_INFORMATION, PROCESS_SET_QUOTA, PROCESS_SYNCHRONIZE,
    PROCESS_TERMINATE,
};

fn ticks(ft: &FILETIME) -> u64 {
    ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64
}

// ---------- job objects ----------

/// A Job Object holding one tab's shell and everything started under it.
pub struct Job(HANDLE);
// A job handle is a plain kernel handle; it is safe to use from any thread.
unsafe impl Send for Job {}
unsafe impl Sync for Job {}

impl Job {
    /// Creates a job and puts the given (just started) process in it.
    pub fn for_process(pid: u32) -> Option<Job> {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            // Programs that ask to leave the job (some updaters and launchers do)
            // are allowed to, so being in a job never makes anything fail to start.
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_BREAKAWAY_OK;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() {
                CloseHandle(job);
                return None;
            }
            let ok = AssignProcessToJobObject(job, process);
            CloseHandle(process);
            if ok == 0 {
                CloseHandle(job);
                return None;
            }
            Some(Job(job))
        }
    }

    /// Every process currently in the job.
    pub fn pids(&self) -> Vec<u32> {
        const ROOM: usize = 2048;
        // u64 storage keeps the buffer aligned for the structure laid over it.
        let mut buf = vec![0u64; ROOM + 2];
        unsafe {
            QueryInformationJobObject(
                self.0,
                JobObjectBasicProcessIdList,
                buf.as_mut_ptr() as *mut c_void,
                (buf.len() * 8) as u32,
                std::ptr::null_mut(),
            );
            let list = buf.as_ptr() as *const JOBOBJECT_BASIC_PROCESS_ID_LIST;
            let n = ((*list).NumberOfProcessIdsInList as usize).min(ROOM);
            std::slice::from_raw_parts((*list).ProcessIdList.as_ptr(), n).iter().map(|p| *p as u32).collect()
        }
    }

    /// Every process currently in the job, each with its creation time. Membership is
    /// confirmed on the same handle the creation time is read from: a process id from
    /// the list above can, in the instant after it was read, have passed to a new and
    /// unrelated process (the old one ended, Windows handed its id on) — that one is
    /// not in this job, and is left out here instead of being taken for the tab's.
    pub fn members_exact(&self) -> Vec<(u32, u64)> {
        let mut out = Vec::new();
        for pid in self.pids() {
            unsafe {
                let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                if handle.is_null() {
                    continue;
                }
                let mut inside = 0;
                let member = IsProcessInJob(handle, self.0, &mut inside) != 0 && inside != 0;
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

    /// Ends every process in the job at once.
    pub fn terminate(&self) {
        unsafe {
            TerminateJobObject(self.0, 1);
        }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        // Closing the handle does not end the processes; the job just stops being tracked.
        unsafe {
            CloseHandle(self.0);
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

/// Low = only gets CPU nothing else wants. Processes it starts later inherit that.
pub fn set_low_priority(pid: u32, low: bool) -> bool {
    unsafe {
        let handle = OpenProcess(PROCESS_SET_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let ok = SetPriorityClass(handle, if low { IDLE_PRIORITY_CLASS } else { NORMAL_PRIORITY_CLASS });
        CloseHandle(handle);
        ok != 0
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
