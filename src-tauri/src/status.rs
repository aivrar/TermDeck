//! Works out what each tab is running by walking the Windows process tree, and
//! reads Claude Code's own live-session file for its busy/idle state. Read-only.

use crate::pty::PtyManager;
use crate::sessions::{SessionCache, Want};
use crate::usage::{ProcUsage, SystemUsage, UsageCache};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::State;
use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

struct Proc {
    pid: u32,
    ppid: u32,
    name: String,
}

fn snapshot() -> Vec<Proc> {
    let mut out = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return out;
        }
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut e) != 0 {
            loop {
                let len = e.szExeFile.iter().position(|c| *c == 0).unwrap_or(e.szExeFile.len());
                out.push(Proc {
                    pid: e.th32ProcessID,
                    ppid: e.th32ParentProcessID,
                    name: String::from_utf16_lossy(&e.szExeFile[..len]).to_lowercase(),
                });
                if Process32NextW(snap, &mut e) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
    }
    out
}

/// Tells real parent → child links from accidental ones.
///
/// Windows records the id of the process that started each process and never updates
/// it — and it hands the id of a finished process to the next one that starts. So a
/// program whose starter quit long ago can have a "parent id" that now belongs to some
/// unrelated, younger process. Followed blindly, that link would make the program look
/// like part of a tab: counted in its usage, and ended by its Kill button.
/// A real child is always created after its parent; that is what is checked here.
#[derive(Default)]
pub(crate) struct Born(HashMap<u32, Option<u64>>);

impl Born {
    fn of(&mut self, pid: u32) -> Option<u64> {
        *self.0.entry(pid).or_insert_with(|| crate::usage::created(pid))
    }

    /// True only if both can be read and the child is not older than the parent.
    /// A process that cannot even be opened is never taken for a child.
    pub(crate) fn is_child(&mut self, parent: u32, child: u32) -> bool {
        matches!((self.of(parent), self.of(child)), (Some(p), Some(c)) if c >= p)
    }
}

/// A process and everything under it, by (checked) parent links — each with its
/// creation time, so that whoever ends them can make sure each id still means the
/// same process (`usage::kill_exact`). Empty if the root is gone.
pub(crate) fn tree_exact(root: u32) -> Vec<(u32, u64)> {
    tree_from(root, None)
}

/// The same, for a root that was identified earlier: empty unless the process with
/// that id is still the one created at `born`. (Between "this id is the tab's CLI"
/// and walking down from it, the id can have passed to another process.)
pub(crate) fn tree_exact_of(root: u32, born: u64) -> Vec<(u32, u64)> {
    tree_from(root, Some(born))
}

fn tree_from(root: u32, expected: Option<u64>) -> Vec<(u32, u64)> {
    let procs = snapshot();
    let mut born = Born::default();
    let Some(root_born) = born.of(root) else { return Vec::new() };
    if expected.is_some_and(|e| e != root_born) {
        return Vec::new();
    }
    let mut out = vec![(root, root_born)];
    let mut i = 0;
    while i < out.len() {
        let parent = out[i].0;
        for p in &procs {
            if p.ppid == parent && p.pid != 0 && p.pid != p.ppid && !out.iter().any(|o| o.0 == p.pid) && born.is_child(parent, p.pid) {
                if let Some(b) = born.of(p.pid) {
                    out.push((p.pid, b));
                }
            }
        }
        i += 1;
    }
    out
}

/// A process and its parents, nearest first, stopping at `stop` (not included).
pub(crate) fn with_ancestors(pid: u32, stop: u32) -> Vec<u32> {
    let procs = snapshot();
    let mut born = Born::default();
    let mut out = vec![pid];
    let mut cur = pid;
    for _ in 0..16 {
        let Some(p) = procs.iter().find(|p| p.pid == cur) else { break };
        if p.ppid == 0 || p.ppid == stop || p.ppid == cur || out.contains(&p.ppid) || !born.is_child(p.ppid, cur) {
            break;
        }
        out.push(p.ppid);
        cur = p.ppid;
    }
    out
}

/// The process ids of every Claude Code, Codex or Grok process on the PC.
pub(crate) fn cli_pids() -> HashSet<u32> {
    snapshot().into_iter().filter(|p| classify(&p.name).is_some()).map(|p| p.pid).collect()
}

/// How many processes of each CLI are running on the whole PC.
pub(crate) fn cli_process_counts() -> HashMap<String, u32> {
    let mut out = HashMap::new();
    for p in snapshot() {
        if let Some(kind) = classify(&p.name) {
            *out.entry(kind.to_string()).or_insert(0) += 1;
        }
    }
    out
}

/// The WebView2 processes that draw this app's window.
pub(crate) fn window_helpers() -> Vec<u32> {
    let procs = snapshot();
    let mut born = Born::default();
    let mut out: Vec<u32> = Vec::new();
    let mut frontier = vec![std::process::id()];
    while let Some(parent) = frontier.pop() {
        for p in &procs {
            if p.ppid == parent && p.name == "msedgewebview2.exe" && !out.contains(&p.pid) && born.is_child(parent, p.pid) {
                out.push(p.pid);
                frontier.push(p.pid);
            }
        }
    }
    out
}

#[derive(Deserialize)]
pub struct PollTab {
    id: String,
    /// The tab's terminal id, which its tracked processes are filed under.
    #[serde(default)]
    pty: String,
    /// The shell's process id, or 0 once the shell has ended.
    pid: u32,
    /// Folder the tab's CLI was started in.
    #[serde(default)]
    cwd: String,
    /// Session this tab is already known to be on (e.g. one it just resumed).
    #[serde(default)]
    session: Option<String>,
    /// When Enter was last pressed in the tab (milliseconds since 1970), if ever.
    #[serde(default)]
    input: Option<u64>,
}

pub(crate) fn looks_like_id(s: &str) -> bool {
    s.len() >= 8 && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && s.chars().any(|c| c.is_ascii_digit())
}

/// The session id a CLI was started with, if its command line names one.
///   codex resume <id> ...        grok -r <id> | --resume <id> | --resume=<id> | -s / --session-id <id>
pub(crate) fn named_session(cli: &str, args: &[String]) -> Option<String> {
    match cli {
        "codex" => {
            let at = args.iter().position(|a| a == "resume")?;
            args[at + 1..].iter().find(|a| !a.starts_with('-')).filter(|a| looks_like_id(a)).cloned()
        }
        "grok" => {
            for (i, a) in args.iter().enumerate() {
                for flag in ["--resume", "--session-id"] {
                    if let Some(v) = a.strip_prefix(flag).and_then(|r| r.strip_prefix('=')) {
                        if looks_like_id(v) {
                            return Some(v.to_string());
                        }
                    }
                }
                if matches!(a.as_str(), "-r" | "--resume" | "-s" | "--session-id") {
                    if let Some(v) = args.get(i + 1).filter(|v| looks_like_id(v)) {
                        return Some(v.clone());
                    }
                }
            }
            None
        }
        _ => None,
    }
}

/// When a process started, used to tell this run's session files from older ones.
fn process_start(pid: u32) -> Option<SystemTime> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut created: FILETIME = std::mem::zeroed();
        let mut other: [FILETIME; 3] = std::mem::zeroed();
        let ok = GetProcessTimes(handle, &mut created, &mut other[0], &mut other[1], &mut other[2]);
        CloseHandle(handle);
        if ok == 0 {
            return None;
        }
        // FILETIME counts 100 ns ticks from 1601; shift to the Unix epoch.
        let ticks = ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64;
        let unix_ticks = ticks.checked_sub(116_444_736_000_000_000)?;
        Some(UNIX_EPOCH + Duration::from_nanos(unix_ticks * 100))
    }
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TabStatus {
    id: String,
    /// "claude" | "codex" | "grok" when one is running under this tab's shell.
    cli: Option<String>,
    cli_pid: Option<u32>,
    session_id: Option<String>,
    session_name: Option<String>,
    /// The CLI's own state, read from its files: "busy", "idle", "waiting", "blocked".
    cli_status: Option<String>,
    /// What it is waiting for, when the CLI says.
    waiting_for: Option<String>,
    cli_cwd: Option<String>,
    /// Processes under the shell, not counting console hosts.
    child_count: u32,
    /// What the CLI was started with (its arguments, without the program name).
    cli_args: Vec<String>,
    /// Everything the tab has running, heaviest first.
    procs: Vec<ProcUsage>,
    /// Totals over `procs`: percent of the whole machine, and bytes.
    cpu: f32,
    mem: u64,
}

#[derive(Serialize)]
pub struct Poll {
    tabs: Vec<TabStatus>,
    system: SystemUsage,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeSession {
    session_id: Option<String>,
    cwd: Option<String>,
    name: Option<String>,
    status: Option<String>,
    waiting_for: Option<serde_json::Value>,
}

fn claude_session(pid: u32) -> Option<ClaudeSession> {
    let home = std::env::var("USERPROFILE").ok()?;
    let path = std::path::Path::new(&home).join(".claude").join("sessions").join(format!("{pid}.json"));
    // The file is named after the process id, and Windows reuses ids. A file last
    // written before this process even started belongs to an earlier Claude that had
    // the same id (and did not clean up): it must not lend its session to this one.
    if let (Some(started), Ok(written)) = (process_start(pid), std::fs::metadata(&path).and_then(|m| m.modified())) {
        if written + Duration::from_secs(5) < started {
            return None;
        }
    }
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn classify(name: &str) -> Option<&'static str> {
    let stem = name.strip_suffix(".exe").unwrap_or(name);
    if stem == "claude" {
        Some("claude")
    } else if stem == "grok" {
        Some("grok")
    } else if stem == "codex" || stem.starts_with("codex-") {
        Some("codex")
    } else {
        None
    }
}

#[tauri::command(async)]
pub fn poll_status(
    cache: State<'_, SessionCache>,
    ptys: State<'_, PtyManager>,
    usage: State<'_, UsageCache>,
    tabs: Vec<PollTab>,
) -> Poll {
    let procs = snapshot();
    let names: HashMap<u32, &str> = procs.iter().map(|p| (p.pid, p.name.as_str())).collect();
    let parents: HashMap<u32, u32> = procs.iter().map(|p| (p.pid, p.ppid)).collect();
    let mut wants: Vec<Want> = Vec::new();
    let mut born = Born::default();
    let mut children: HashMap<u32, Vec<usize>> = HashMap::new();
    for (i, p) in procs.iter().enumerate() {
        if p.pid != 0 && p.pid != p.ppid {
            children.entry(p.ppid).or_default().push(i);
        }
    }

    let mut found: Vec<(TabStatus, HashSet<u32>)> = tabs
        .into_iter()
        .map(|t| {
            let cwd = t.cwd;
            let hint = t.session;
            let input = t.input.map(|ms| UNIX_EPOCH + Duration::from_millis(ms));
            let mut st = TabStatus { id: t.id, ..Default::default() };
            // Breadth-first, so the CLI nearest the shell wins over anything it spawned.
            // A tab whose shell has ended (pid 0) has no tree to walk.
            let mut queue = std::collections::VecDeque::new();
            let mut seen = HashSet::new();
            if t.pid != 0 {
                queue.push_back(t.pid);
                seen.insert(t.pid);
            }
            while let Some(pid) = queue.pop_front() {
                let Some(kids) = children.get(&pid) else { continue };
                for &i in kids {
                    let p = &procs[i];
                    // Not a real child if it is older than its "parent" (a reused id).
                    if seen.contains(&p.pid) || !born.is_child(pid, p.pid) {
                        continue;
                    }
                    seen.insert(p.pid);
                    if p.name != "conhost.exe" && p.name != "openconsole.exe" {
                        st.child_count += 1;
                    }
                    if st.cli.is_none() {
                        if let Some(kind) = classify(&p.name) {
                            if kind == "claude" {
                                // A launcher may wrap the real process: prefer the one
                                // that owns a live-session file, but accept either.
                                if let Some(s) = claude_session(p.pid) {
                                    st.session_id = s.session_id;
                                    st.session_name = s.name;
                                    st.cli_status = s.status;
                                    st.waiting_for = s.waiting_for.and_then(|w| w.as_str().map(|x| x.to_string()));
                                    st.cli_cwd = s.cwd;
                                    st.cli = Some(kind.into());
                                    st.cli_pid = Some(p.pid);
                                } else if st.cli_pid.is_none() {
                                    st.cli_pid = Some(p.pid);
                                }
                            } else if st.cli_pid.is_none() {
                                st.cli = Some(kind.into());
                                st.cli_pid = Some(p.pid);
                            }
                            // (A Codex or Grok found *under* a Claude Code that has no
                            // status file to show — it has only just started, or the file
                            // was caught half-written — is something Claude is running.
                            // The tab is Claude's, and is not handed to it.)
                        }
                    }
                    queue.push_back(p.pid);
                }
            }
            // Claude is running but has not written its session file yet.
            if st.cli.is_none() && st.cli_pid.is_some() {
                st.cli = Some("claude".into());
            }
            if let Some(pid) = st.cli_pid {
                st.cli_args = crate::usage::arguments(pid);
            }
            // Codex and Grok: state comes from the session files they write (filled in below).
            if let (Some(cli), Some(pid)) = (st.cli.as_deref(), st.cli_pid) {
                if cli == "codex" || cli == "grok" {
                    if let Some(started) = process_start(pid) {
                        wants.push(Want {
                            tab: st.id.clone(),
                            cli: cli.to_string(),
                            pid,
                            cwd,
                            started,
                            named: named_session(cli, &st.cli_args),
                            hint,
                            input,
                        });
                    }
                }
            }
            // Everything to measure: the tree just walked, plus the tab's job, which
            // also holds processes whose parent has already exited.
            let mut all = seen;
            all.extend(ptys.job_pids(&t.pty));
            all.retain(|pid| names.contains_key(pid));
            // "Something is running in this tab" includes those parentless leftovers.
            st.child_count = all
                .iter()
                .filter(|pid| **pid != t.pid && !matches!(names.get(*pid).copied(), Some("conhost.exe") | Some("openconsole.exe")))
                .count() as u32;
            (st, all)
        })
        .collect();
    let mut lives = cache.resolve(&wants);
    for (st, _) in found.iter_mut() {
        if let Some(live) = lives.remove(&st.id) {
            st.session_id = live.session_id;
            st.cli_status = live.status;
        }
    }

    let every: HashSet<u32> = found.iter().flat_map(|(_, pids)| pids.iter().copied()).collect();
    let (readings, system) = usage.sample(&every);
    for (st, pids) in found.iter_mut() {
        for pid in pids.iter() {
            let Some(&(cpu, mem)) = readings.get(pid) else { continue };
            st.cpu += cpu;
            st.mem += mem;
            st.procs.push(ProcUsage {
                pid: *pid,
                ppid: parents.get(pid).copied().unwrap_or(0),
                name: names.get(pid).copied().unwrap_or("").to_string(),
                cpu,
                mem,
            });
        }
        st.procs.sort_by(|a, b| b.cpu.total_cmp(&a.cpu).then(b.mem.cmp(&a.mem)));
    }
    Poll { tabs: found.into_iter().map(|(st, _)| st).collect(), system }
}
