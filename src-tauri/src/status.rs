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
    // Children looked up by parent, once: the walk stays quick however many processes
    // the machine (or a runaway tab) has — which is exactly when it is needed.
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for p in &procs {
        if p.pid != 0 && p.pid != p.ppid {
            children.entry(p.ppid).or_default().push(p.pid);
        }
    }
    let mut out = vec![(root, root_born)];
    let mut seen: HashSet<u32> = HashSet::from([root]);
    let mut i = 0;
    while i < out.len() {
        let parent = out[i].0;
        for &pid in children.get(&parent).map(|v| v.as_slice()).unwrap_or(&[]) {
            if !seen.contains(&pid) && born.is_child(parent, pid) {
                if let Some(b) = born.of(pid) {
                    seen.insert(pid);
                    out.push((pid, b));
                }
            }
        }
        i += 1;
    }
    out
}

/// The names of the given processes, as Windows lists them now (gone ones left out).
pub(crate) fn names_of(pids: &HashSet<u32>) -> Vec<String> {
    let mut out: Vec<String> = snapshot().into_iter().filter(|p| pids.contains(&p.pid)).map(|p| p.name).collect();
    out.sort();
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
    snapshot().into_iter().filter(|p| classify_proc(p).is_some()).map(|p| p.pid).collect()
}

/// How many processes of each CLI are running on the whole PC.
pub(crate) fn cli_process_counts() -> HashMap<String, u32> {
    let mut out = HashMap::new();
    for p in snapshot() {
        if let Some(kind) = classify_proc(&p) {
            *out.entry(kind.to_string()).or_insert(0) += 1;
        }
    }
    out
}

/// Which CLI a process is, if any: by its program name, or — for Claude Code installed
/// from npm, which runs as `node.exe …\@anthropic-ai\claude-code\cli.js` — by what
/// node was started with. (Codex from npm starts its own `codex-….exe`, found by name.)
fn classify_proc(p: &Proc) -> Option<&'static str> {
    classify(&p.name).or_else(|| (p.name == "node.exe" && node_runs_claude(p.pid)).then_some("claude"))
}

/// Whether a node process is Claude Code. Remembered per process (id and creation
/// time), so each node is asked about its command line once, not every second.
fn node_runs_claude(pid: u32) -> bool {
    static SEEN: std::sync::Mutex<Option<HashMap<u32, (u64, bool)>>> = std::sync::Mutex::new(None);
    let Some(born) = crate::usage::created(pid) else { return false };
    let mut guard = SEEN.lock().unwrap();
    let seen = guard.get_or_insert_with(HashMap::new);
    if let Some(&(b, is)) = seen.get(&pid) {
        if b == born {
            return is;
        }
    }
    let is = crate::usage::arguments(pid).iter().any(|a| {
        let a = a.to_ascii_lowercase().replace('/', "\\");
        a.contains("@anthropic-ai\\claude-code\\")
    });
    if seen.len() > 1024 {
        seen.clear();
    }
    seen.insert(pid, (born, is));
    is
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
///   agy --conversation <id> | --conversation=<id>
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
        "agy" => {
            for (i, a) in args.iter().enumerate() {
                if let Some(v) = a.strip_prefix("--conversation=") {
                    if looks_like_id(v) {
                        return Some(v.to_string());
                    }
                }
                if a == "--conversation" {
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

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ClaudeSession {
    session_id: Option<String>,
    cwd: Option<String>,
    name: Option<String>,
    status: Option<String>,
    waiting_for: Option<serde_json::Value>,
}

fn claude_session(pid: u32) -> Option<ClaudeSession> {
    let path = crate::transcript::cli_home("claude").join("sessions").join(format!("{pid}.json"));
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

/// What the CLIs' own files said: per Claude process its live-session file, per tab
/// (Codex, Grok) its session and state.
#[derive(Default, Clone)]
struct FileFacts {
    claude: HashMap<u32, Option<ClaudeSession>>,
    lives: HashMap<String, crate::sessions::Live>,
}

/// The last complete reading, for when a fresh one does not arrive in time.
static FACTS: std::sync::Mutex<Option<FileFacts>> = std::sync::Mutex::new(None);
/// A reading is under way (at most one at a time).
static READING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// How long a status look waits for the files.
const FILE_BUDGET: Duration = Duration::from_millis(1000);

/// Reads the CLIs' files for this look — on a reader of its own, and for at most
/// `FILE_BUDGET`. Normally that takes milliseconds. On a disk that has stalled (a
/// sleeping network drive, a failing disk, a virus scanner holding a file) the look
/// goes on without waiting: usage, the process list and Kill stay live, and status
/// shows what was last read until the reader is back. A stalled reader is never
/// joined by a second one.
fn read_files(app: &tauri::AppHandle, claude: Vec<u32>, wants: Vec<Want>) -> FileFacts {
    use std::sync::atomic::Ordering;
    if !READING.swap(true, Ordering::SeqCst) {
        let (tx, rx) = std::sync::mpsc::channel();
        let app = app.clone();
        std::thread::spawn(move || {
            let facts = FileFacts {
                claude: claude.iter().map(|&pid| (pid, claude_session(pid))).collect(),
                lives: tauri::Manager::state::<SessionCache>(&app).resolve(&wants),
            };
            *FACTS.lock().unwrap() = Some(facts.clone());
            READING.store(false, Ordering::SeqCst);
            let _ = tx.send(facts);
        });
        if let Ok(facts) = rx.recv_timeout(FILE_BUDGET) {
            return facts;
        }
    }
    FACTS.lock().unwrap().clone().unwrap_or_default()
}

// ---------- letting a just-started Claude Code get past its start ----------
//
// Claude Code (seen in 2.1.323) records each full-screen start in its `.claude.json`
// (`fullscreenBootPending`) and clears the record once it has drawn for 10 s, or when it
// quits normally. A start that finds the record of a Claude that is gone counts that as
// a failed start, and after two Claude turns full-screen off on the whole PC. A Claude
// closed in its first seconds tends not to get as far as quitting normally — it is ended
// a few seconds later (by Windows' console-close timeout, or by force) and leaves its
// record behind. So before a Claude is closed, stopped or closed for an update, it is
// given the moment to get past that: until it is `SETTLE_MIN_AGE` old and its record
// is gone (read-only), but never longer than `SETTLE_MAX_WAIT`. Only ever noticeable
// when a Claude is closed right after it was started.

const SETTLE_MIN_AGE: Duration = Duration::from_secs(12);
const SETTLE_MAX_AGE: Duration = Duration::from_secs(25);
const SETTLE_MAX_WAIT: Duration = Duration::from_secs(20);

/// The processes Claude Code currently lists as "full-screen start not yet confirmed",
/// or None if that could not be read quickly (then only the age rule applies).
fn claude_boot_pending() -> Option<HashSet<u32>> {
    let file = match std::env::var_os("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()) {
        Some(dir) => std::path::PathBuf::from(dir).join(".claude.json"),
        None => crate::transcript::home().join(".claude.json"),
    };
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let ids = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok()).map(|v| {
            v.get("fullscreenBootPending")
                .and_then(|p| p.as_object())
                .map(|o| o.keys().filter_map(|k| k.parse::<u32>().ok()).collect::<HashSet<u32>>())
                .unwrap_or_default()
        });
        let _ = tx.send(ids);
    });
    rx.recv_timeout(Duration::from_millis(500)).ok().flatten()
}

/// Waits until every Claude Code among these processes is past its full-screen start
/// (see above), or gone. Returns at once when there is none.
pub(crate) fn settle_claudes(pids: &[u32]) {
    let claudes: Vec<(u32, u64, SystemTime)> = snapshot()
        .iter()
        .filter(|p| pids.contains(&p.pid) && classify_proc(p) == Some("claude"))
        .filter_map(|p| Some((p.pid, crate::usage::created(p.pid)?, process_start(p.pid)?)))
        .collect();
    if claudes.is_empty() {
        return;
    }
    let began = std::time::Instant::now();
    while began.elapsed() < SETTLE_MAX_WAIT {
        let young: Vec<&(u32, u64, SystemTime)> = claudes
            .iter()
            .filter(|(pid, born, _)| crate::usage::alive_exact(*pid, *born))
            .filter(|(_, _, start)| start.elapsed().unwrap_or_default() < SETTLE_MAX_AGE)
            .collect();
        if young.is_empty() {
            return;
        }
        let too_new = young.iter().any(|(_, _, start)| start.elapsed().unwrap_or_default() < SETTLE_MIN_AGE);
        if !too_new {
            match claude_boot_pending() {
                Some(pending) if young.iter().any(|(pid, _, _)| pending.contains(pid)) => {}
                _ => return,
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

fn classify(name: &str) -> Option<&'static str> {
    let stem = name.strip_suffix(".exe").unwrap_or(name);
    if stem == "claude" {
        Some("claude")
    } else if stem == "grok" {
        Some("grok")
    } else if stem == "codex" || stem.starts_with("codex-") {
        Some("codex")
    } else if stem == "agy" {
        Some("agy")
    } else {
        None
    }
}

#[tauri::command(async)]
pub fn poll_status(
    app: tauri::AppHandle,
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

    let found: Vec<(TabStatus, HashSet<u32>, Vec<u32>)> = tabs
        .into_iter()
        .map(|t| {
            let cwd = t.cwd;
            let hint = t.session;
            let input = t.input.map(|ms| UNIX_EPOCH + Duration::from_millis(ms));
            let mut st = TabStatus { id: t.id, ..Default::default() };
            // Claude processes in the tab, nearest the shell first. Which of them is the
            // tab's Claude (the one with a live-session file, else the first) is settled
            // once the files have been read, below.
            let mut claudes: Vec<u32> = Vec::new();
            // Breadth-first, so the CLI nearest the shell wins over anything it spawned.
            // A tab whose shell has ended (pid 0) has no tree to walk.
            let mut queue = std::collections::VecDeque::new();
            let mut seen = HashSet::new();
            // Only from the shell this tab started: the window's idea of its id can be
            // a moment old, and by then Windows can have given that id to another
            // program — whose children would otherwise be shown as this tab's.
            if t.pid != 0 && ptys.shell_born(&t.pty, t.pid).is_none_or(|b| born.of(t.pid) == Some(b)) {
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
                        if let Some(kind) = classify_proc(p) {
                            if kind == "claude" {
                                // A launcher may wrap the real process: the one that owns
                                // a live-session file is preferred (settled below).
                                claudes.push(p.pid);
                                if st.cli_pid.is_none() {
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
            // Everything to measure: the tree just walked, plus the tab's job, which
            // also holds processes whose parent has already exited.
            let mut all = seen;
            all.extend(ptys.job_pids(&t.pty));
            all.retain(|pid| names.contains_key(pid));
            // A CLI whose launcher has already exited is not under the shell any more,
            // but it is still in the tab's job: found there (the oldest one, if several).
            if st.cli_pid.is_none() {
                let found = procs
                    .iter()
                    .filter(|p| p.pid != t.pid && all.contains(&p.pid))
                    .filter_map(|p| classify_proc(p).map(|kind| (kind, p.pid, born.of(p.pid).unwrap_or(u64::MAX))))
                    .min_by_key(|c| c.2);
                if let Some((kind, pid, _)) = found {
                    st.cli_pid = Some(pid);
                    if kind == "claude" {
                        claudes.push(pid);
                    }
                    st.cli = Some(kind.into());
                }
            }
            // A Claude (its session file, if any, is read below).
            if st.cli.is_none() && st.cli_pid.is_some() {
                st.cli = Some("claude".into());
            }
            if let Some(pid) = st.cli_pid {
                st.cli_args = crate::usage::arguments(pid);
            }
            // Codex, Grok and Antigravity: state comes from the session files they write (filled in below).
            if let (Some(cli), Some(pid)) = (st.cli.as_deref(), st.cli_pid) {
                if matches!(cli, "codex" | "grok" | "agy") {
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
            // "Something is running in this tab" includes those parentless leftovers.
            st.child_count = all
                .iter()
                .filter(|pid| **pid != t.pid && !matches!(names.get(*pid).copied(), Some("conhost.exe") | Some("openconsole.exe")))
                .count() as u32;
            (st, all, claudes)
        })
        .collect();
    let claude_pids: Vec<u32> = found.iter().flat_map(|f| f.2.iter().copied()).collect();
    let mut facts = read_files(&app, claude_pids, wants);
    let mut found: Vec<(TabStatus, HashSet<u32>)> = found
        .into_iter()
        .map(|(mut st, all, claudes)| {
            if let Some((pid, s)) = claudes.iter().find_map(|p| facts.claude.get(p).cloned().flatten().map(|s| (*p, s))) {
                if st.cli_pid != Some(pid) {
                    st.cli_pid = Some(pid);
                    st.cli_args = crate::usage::arguments(pid);
                }
                st.session_id = s.session_id;
                st.session_name = s.name;
                st.cli_status = s.status;
                st.waiting_for = s.waiting_for.and_then(|w| w.as_str().map(|x| x.to_string()));
                st.cli_cwd = s.cwd;
            }
            // (Only for a tab running Codex, Grok or Antigravity: a reading kept from an
            // earlier look can name a tab whose CLI has changed since.)
            if matches!(st.cli.as_deref(), Some("codex") | Some("grok") | Some("agy")) {
                if let Some(live) = facts.lives.remove(&st.id) {
                    st.session_id = live.session_id;
                    st.cli_status = live.status;
                    if live.session_name.is_some() {
                        st.session_name = live.session_name;
                    }
                }
            }
            (st, all)
        })
        .collect();

    let mut every: HashSet<u32> = found.iter().flat_map(|(_, pids)| pids.iter().copied()).collect();
    // The WSL virtual machine (vmmem / vmmemWSL): Windows starts it, it is shared by
    // every Linux distro and app, and no tab owns it — so it is shown on its own,
    // beside the PC totals, and never ended by TermDeck.
    let vm: Vec<u32> = procs.iter().filter(|p| p.name.starts_with("vmmem")).map(|p| p.pid).collect();
    every.extend(vm.iter().copied());
    let (readings, mut system) = usage.sample(&every);
    if !vm.is_empty() {
        system.wsl = true;
        for pid in &vm {
            if let Some(&(cpu, mem)) = readings.get(pid) {
                system.wsl_cpu += cpu;
                system.wsl_mem += mem;
            }
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agy_process_and_conversation_flag_are_recognised() {
        assert_eq!(classify("agy.exe"), Some("agy"));
        assert_eq!(classify("agy"), Some("agy"));
        let id = "d65584ac-a896-4d44-91d0-8810da5b3b72";
        assert_eq!(
            named_session("agy", &[format!("--conversation={id}"), "--dangerously-skip-permissions".into()]),
            Some(id.to_string())
        );
        assert_eq!(
            named_session("agy", &["--conversation".into(), id.into()]),
            Some(id.to_string())
        );
        assert_eq!(named_session("agy", &["--conversation".into(), "../bad".into()]), None);
    }
}
