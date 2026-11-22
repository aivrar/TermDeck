//! One pseudo-terminal per tab. Each has its own process tree, reader thread and
//! sender thread, plus backpressure so a tab that floods output only slows itself.

use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use crate::usage::{self, Job};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::State;

/// Bytes sent to the window but not yet drawn before the sender pauses.
const HIGH_WATER: usize = 1_500_000;
/// Bytes buffered from the process before the reader stops reading.
const READ_BUFFER_CAP: usize = 1_000_000;
/// Largest single message to the window.
const MAX_CHUNK: usize = 131_072;
/// Small wait so bursts are sent as one message instead of hundreds.
const COALESCE: Duration = Duration::from_millis(5);
/// Most input that may wait for a program that has stopped reading it. Beyond this,
/// more is refused (and the tab says so) instead of piling up in memory without end.
const INPUT_CAP: usize = 32 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PtyEvent {
    Output { data: String, n: usize },
    Exit { code: Option<u32> },
}

#[derive(Default)]
struct Shared {
    buf: Vec<u8>,
    eof: bool,
    unacked: usize,
}

#[derive(Default)]
struct Flow {
    state: Mutex<Shared>,
    cv: Condvar,
}

/// One tab's terminal. Shared (`Arc`) so that a slow call on one tab — a resize, or
/// closing its pseudo-terminal — is made without holding the list of all tabs.
struct Session {
    master: Mutex<Box<dyn MasterPty + Send>>,
    /// Input goes through a queue to this tab's own writer thread, so a process that
    /// has stopped reading its input can never block another tab or the window.
    input: Mutex<std::sync::mpsc::Sender<Vec<u8>>>,
    /// Bytes in that queue, not yet written.
    queued: Arc<AtomicUsize>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    flow: Arc<Flow>,
}

impl Session {
    /// Ends the shell and tells the tab's threads there is nothing more to come.
    fn end(&self) {
        let _ = self.killer.lock().unwrap().kill();
        self.flow.state.lock().unwrap().eof = true;
        self.flow.cv.notify_all();
    }
}

/// What is needed to find, measure and stop everything a tab has started. Kept
/// after the shell itself exits, so leftovers can still be seen and stopped.
struct TabProcs {
    job: Option<Job>,
    /// The jobs of this tab's earlier shells that still hold running programs. A shell
    /// that ends (you type `exit`, it crashes) can leave programs behind; when the tab's
    /// shell is started again they stay the tab's — shown, asked about, ended on close.
    older: Vec<Job>,
    shell_pid: u32,
    /// The shell's creation time: a process id is only trusted while this matches.
    shell_born: u64,
    /// The CLI running in the tab, what started it and what it started, as noted just
    /// before the CLI was asked to quit for an update (`pty_cli_note`).
    cli_noted: Vec<(u32, u64)>,
    /// While the tab runs at low priority: what each of its processes had before
    /// (id, creation time, priority class), so "back to normal" puts that back.
    low: Option<Vec<(u32, u64, u32)>>,
}

impl TabProcs {
    fn new(job: Option<Job>, older: Vec<Job>, shell_pid: u32, shell_born: u64) -> TabProcs {
        TabProcs { job, older, shell_pid, shell_born, cli_noted: Vec::new(), low: None }
    }

    /// The current shell's job and those of earlier shells.
    fn jobs(&self) -> impl Iterator<Item = &Job> {
        self.job.iter().chain(self.older.iter())
    }

    /// Every job this tab has, the current one included — taken out, for a new shell
    /// to carry on (any that Windows confirms empty are let go).
    fn into_jobs(self) -> Vec<Job> {
        self.job.into_iter().chain(self.older).filter(|job| !job.is_empty()).collect()
    }
}

/// What an attempt to end processes left behind: programs that are still running
/// (Windows refused, or they were started again meanwhile), by name.
#[derive(Serialize, Default)]
pub struct Ended {
    /// How many processes were set to be ended.
    pub targeted: u32,
    /// Names of the ones still running afterwards.
    pub survivors: Vec<String>,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, Arc<Session>>>>,
    procs: Arc<Mutex<HashMap<String, TabProcs>>>,
}

impl PtyManager {
    fn session(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().unwrap().get(id).cloned()
    }

    /// The creation time `pid` must have to be this tab's shell: None if the tab's shell
    /// is not tracked (nothing to check against), Some(0) — which no process has — if
    /// the tab's shell is a different process.
    pub fn shell_born(&self, id: &str, pid: u32) -> Option<u64> {
        let procs = self.procs.lock().unwrap();
        let tp = procs.get(id).filter(|tp| tp.shell_pid != 0 && tp.shell_born != 0)?;
        Some(if tp.shell_pid == pid { tp.shell_born } else { 0 })
    }

    /// The members of the tab's jobs (empty if it has none). Jobs of earlier shells
    /// that Windows confirms are now empty are let go here.
    pub fn job_pids(&self, id: &str) -> Vec<u32> {
        let mut procs = self.procs.lock().unwrap();
        let Some(tp) = procs.get_mut(id) else { return Vec::new() };
        tp.older.retain(|job| !job.is_empty());
        tp.jobs().flat_map(|job| job.pids().unwrap_or_default()).collect()
    }

    /// Every process the tab is known to have started: the members of its job, plus
    /// the process tree under its shell (which covers a shell that could not be put
    /// in a job, and programs that left the job). Includes the shell itself while it
    /// is alive. Each comes with its creation time, so that ending one can be made
    /// conditional on the id still meaning the same process.
    fn tab_exact(&self, id: &str) -> Vec<(u32, u64)> {
        // Only what is needed is read under the lock; walking the process tree is not
        // done while holding it (the once-a-second look needs the same lock).
        let (shell_pid, shell_born, in_job) = {
            let procs = self.procs.lock().unwrap();
            let Some(tp) = procs.get(id) else { return Vec::new() };
            // Each job member with its creation time, read from a handle on which it was
            // confirmed to be in the job — not from its id alone, a moment later.
            (tp.shell_pid, tp.shell_born, tp.jobs().flat_map(|job| job.members_exact()).collect::<Vec<_>>())
        };
        // Empty unless the shell's id still means the shell that was started.
        let mut out: Vec<(u32, u64)> = crate::status::tree_exact_of(shell_pid, shell_born);
        for member in in_job {
            if !out.iter().any(|o| o.0 == member.0) {
                out.push(member);
            }
        }
        let me = std::process::id();
        out.retain(|p| p.0 != 0 && p.0 != me);
        out
    }


    /// Closes tabs for good: the shell ends, the pseudo-terminal is closed, and every
    /// process the tab started is ended with it — including background programs that
    /// have no terminal and would otherwise run on unseen.
    ///
    /// Closing the pseudo-terminal is what tells console programs to finish (the same
    /// signal as closing a terminal window), so they get `grace` to do that by
    /// themselves; a CLI ended by force can count it as a crash. Whatever is still
    /// running after that is ended by force (`targeted` is how many that was), and
    /// what is running even after that is named in `survivors`.
    pub fn close(&self, ids: &[String], grace: Duration) -> Ended {
        struct Closing {
            procs: Option<TabProcs>,
            listed: Vec<(u32, u64)>,
        }
        // A Claude that has only just started first gets past its start (see
        // status::settle_claudes): closing it in its first seconds would count against it.
        let everything: Vec<u32> = ids.iter().flat_map(|id| self.tab_exact(id)).map(|p| p.0).collect();
        crate::status::settle_claudes(&everything);
        let mut closing: Vec<Closing> = Vec::new();
        for id in ids {
            // Listed while the shell is still there to walk down from.
            let listed = self.tab_exact(id);
            let procs = self.procs.lock().unwrap().remove(id);
            let session = self.sessions.lock().unwrap().remove(id);
            if let Some(s) = session {
                s.end();
                // `s` is dropped here, outside the lock: that closes the pseudo-terminal.
            }
            if procs.is_some() || !listed.is_empty() {
                closing.push(Closing { procs, listed });
            }
        }
        let left = |c: &Closing| -> HashSet<u32> {
            let mut pids: HashSet<u32> = c.listed.iter().filter(|(pid, born)| usage::alive_exact(*pid, *born)).map(|p| p.0).collect();
            if let Some(tp) = c.procs.as_ref() {
                pids.extend(tp.jobs().flat_map(|job| job.pids().unwrap_or_default()));
            }
            pids
        };
        // The full grace is for the CLIs: they are the ones that record a forced end as
        // a crash. Anything else gets a short moment — a background program with no
        // terminal never hears that the tab closed, so waiting longer for it only
        // makes closing slow.
        let began = std::time::Instant::now();
        while began.elapsed() < grace {
            let rest: HashSet<u32> = closing.iter().flat_map(|c| left(c)).collect();
            if rest.is_empty() || (began.elapsed() >= OTHERS_GRACE.min(grace) && rest.is_disjoint(&crate::status::cli_pids())) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let mut forced = 0;
        for c in &closing {
            forced += left(c).len() as u32;
            for job in c.procs.iter().flat_map(|tp| tp.jobs()) {
                job.terminate();
            }
            // Listed again now, not only before the wait: a program outside the job
            // (there should be none) can have started another meanwhile.
            let mut again: Vec<(u32, u64)> = c.listed.clone();
            for (pid, born) in &c.listed {
                for p in crate::status::tree_exact_of(*pid, *born) {
                    if !again.contains(&p) {
                        again.push(p);
                    }
                }
            }
            for (pid, born) in &again {
                usage::kill_exact(*pid, *born);
            }
        }
        // Ending takes Windows a moment; then whatever still runs is named.
        let began = std::time::Instant::now();
        let mut rest: HashSet<u32> = closing.iter().flat_map(|c| left(c)).collect();
        while !rest.is_empty() && began.elapsed() < Duration::from_millis(1500) {
            std::thread::sleep(Duration::from_millis(100));
            rest = closing.iter().flat_map(|c| left(c)).collect();
        }
        // (The jobs are let go as `closing` is dropped on return: that also ends
        // anything that is somehow still in them.)
        Ended { targeted: forced, survivors: crate::status::names_of(&rest) }
    }

    /// Closes every tab (see `close`).
    pub fn close_all(&self, grace: Duration) -> Ended {
        let mut ids: HashSet<String> = self.procs.lock().unwrap().keys().cloned().collect();
        ids.extend(self.sessions.lock().unwrap().keys().cloned());
        self.close(&ids.into_iter().collect::<Vec<_>>(), grace)
    }
}

/// How long programs get to finish by themselves once their tab's terminal is closed.
/// (Windows itself allows a console program five seconds for this.)
pub const CLOSE_GRACE: Duration = Duration::from_millis(4000);
/// The shorter wait when no CLI is among what is still running.
const OTHERS_GRACE: Duration = Duration::from_millis(1200);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnArgs {
    id: String,
    shell: String,
    cwd: String,
    cols: u16,
    rows: u16,
    wsl_distro: Option<String>,
    /// The id this tab's previous shell ran under, when the shell is being started
    /// again: what that shell left running stays tracked under the new one.
    #[serde(default)]
    previous: Option<String>,
}

#[derive(Serialize)]
pub struct SpawnInfo {
    pid: Option<u32>,
    /// False if the shell could not be put in a job of its own: then what it starts is
    /// followed only through the process tree, and the tab says so.
    tracked: bool,
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Runs once in every PowerShell tab: UTF-8 in and out, and a prompt wrapper that
/// reports the current directory to the app (OSC 9;9) without changing how the
/// prompt looks.
const PS_INIT: &str = r#"
try { [Console]::InputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
$global:__td_prompt = $function:prompt
function global:prompt {
  try {
    $l = $ExecutionContext.SessionState.Path.CurrentLocation
    if ($l.Provider.Name -eq 'FileSystem') { [Console]::Write("$([char]27)]9;9;$($l.ProviderPath)$([char]27)\") }
  } catch {}
  & $global:__td_prompt
}
"#;

/// For bash (Git Bash, and bash inside WSL): before each prompt, report the current
/// directory to the app the same way PowerShell and cmd do (OSC 9;9), so a restart
/// brings the tab back in the folder it was in. It is bash's PROMPT_COMMAND, passed as
/// an environment variable: a shell start-up file that sets its own replaces it (then
/// the tab simply comes back in its starting folder, as before), and another shell
/// (zsh, fish) ignores it.
const BASH_REPORT_CWD: &str = r#"printf '\e]9;9;%s\e\\' "$PWD""#;

fn ps_encoded(script: &str) -> String {
    let utf16: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    base64::engine::general_purpose::STANDARD.encode(utf16)
}

pub fn git_bash_path() -> Option<String> {
    [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
    ]
    .iter()
    .find(|p| Path::new(p).is_file())
    .map(|p| p.to_string())
}

fn build_command(a: &SpawnArgs) -> Result<CommandBuilder, String> {
    let home = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".into());
    let cwd = if !a.cwd.is_empty() && Path::new(&a.cwd).is_dir() {
        a.cwd.clone()
    } else {
        home.clone()
    };
    let mut cmd;
    match a.shell.as_str() {
        "cmd" => {
            cmd = CommandBuilder::new("cmd.exe");
            cmd.args(["/K", "chcp 65001>nul"]);
            // $E]9;9;<path>$E\ reports the directory; the rest is the normal prompt.
            cmd.env("PROMPT", "$E]9;9;$P$E\\$P$G");
            cmd.cwd(&cwd);
        }
        "powershell" | "pwsh" => {
            let exe = if a.shell == "pwsh" { "pwsh.exe" } else { "powershell.exe" };
            cmd = CommandBuilder::new(exe);
            cmd.args(["-NoLogo", "-NoExit", "-EncodedCommand", &ps_encoded(PS_INIT)]);
            cmd.cwd(&cwd);
        }
        "gitbash" => {
            let bash = git_bash_path().ok_or("Git Bash was not found")?;
            cmd = CommandBuilder::new(bash);
            cmd.args(["--login", "-i"]);
            cmd.env("CHERE_INVOKING", "1");
            cmd.env("PROMPT_COMMAND", BASH_REPORT_CWD);
            cmd.cwd(&cwd);
        }
        "wsl" => {
            cmd = CommandBuilder::new("wsl.exe");
            if let Some(d) = a.wsl_distro.as_deref().filter(|d| !d.is_empty()) {
                cmd.args(["-d", d]);
            }
            if !a.cwd.is_empty() {
                cmd.args(["--cd", &a.cwd]);
            }
            // Handed into Linux through WSLENV ("/u": only in this direction).
            cmd.env("PROMPT_COMMAND", BASH_REPORT_CWD);
            let passed = std::env::var("WSLENV").unwrap_or_default();
            cmd.env("WSLENV", if passed.is_empty() { "PROMPT_COMMAND/u".to_string() } else { format!("{passed}:PROMPT_COMMAND/u") });
            cmd.cwd(&home);
        }
        other => return Err(format!("unknown shell: {other}")),
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("PATH", path_with_cli_dirs(&home));
    Ok(cmd)
}

/// The CLIs install into per-user folders that are not always on PATH
/// (Claude Code's and Antigravity's are not always on PATH). Appending them means
/// typing `claude`, `codex`, `grok` or `agy` works in every tab. Existing PATH order
/// is left untouched.
pub(crate) fn path_with_cli_dirs(home: &str) -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    let have: Vec<String> = current
        .split(';')
        .map(|p| p.trim().trim_end_matches('\\').to_lowercase())
        .collect();
    let mut extra = vec![format!(r"{home}\.local\bin"), format!(r"{home}\.grok\bin")];
    if let Ok(appdata) = std::env::var("APPDATA") {
        extra.push(format!(r"{appdata}\npm"));
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        extra.push(format!(r"{local}\agy\bin"));
    }
    let mut path = current.clone();
    for dir in extra {
        if Path::new(&dir).is_dir() && !have.contains(&dir.to_lowercase()) {
            if !path.is_empty() && !path.ends_with(';') {
                path.push(';');
            }
            path.push_str(&dir);
        }
    }
    path
}

/// Removes and returns the longest valid UTF-8 prefix, leaving a split multi-byte
/// character in `pending` for the next read. Invalid bytes become U+FFFD.
fn take_utf8(pending: &mut Vec<u8>) -> String {
    let mut out = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(s) => {
                out.push_str(s);
                pending.clear();
                return out;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                out.push_str(std::str::from_utf8(&pending[..valid]).unwrap_or(""));
                match e.error_len() {
                    None => {
                        pending.drain(..valid);
                        return out;
                    }
                    Some(bad) => {
                        out.push('\u{FFFD}');
                        pending.drain(..valid + bad);
                    }
                }
            }
        }
    }
}

#[tauri::command]
pub fn pty_spawn(
    state: State<'_, PtyManager>,
    args: SpawnArgs,
    on_event: Channel<PtyEvent>,
) -> Result<SpawnInfo, String> {
    // The tab's previous shell, when this is a restart: it is ended if it is somehow
    // still there, and it stops being tracked — but the jobs that still hold programs
    // it left running are carried over, so those programs stay this tab's. (They used
    // to be let go here: no longer shown, not asked about, and left running when the
    // tab or the app was closed. Measured 2026-11-12: a hidden `ping` outlived both.)
    let mut older: Vec<Job> = Vec::new();
    if let Some(prev) = args.previous.as_deref().filter(|p| !p.is_empty() && *p != args.id) {
        if let Some(tp) = state.procs.lock().unwrap().remove(prev) {
            // Every job kept unless Windows confirms it is empty: a job let go ends
            // what is in it, and one Windows could not be asked about may hold programs.
            older = tp.into_jobs();
        }
        let session = state.sessions.lock().unwrap().remove(prev);
        if let Some(s) = session {
            s.end();
        }
    }
    let result = spawn_shell(&state, &args, on_event, &mut older);
    if !older.is_empty() {
        // No new shell took them over (it could not be started): kept under the new id
        // all the same, where the tab looks for what it has running.
        let mut procs = state.procs.lock().unwrap();
        let tp = procs.entry(args.id.clone()).or_insert_with(|| TabProcs::new(None, Vec::new(), 0, 0));
        tp.older.extend(older);
    }
    result
}

fn spawn_shell(state: &PtyManager, args: &SpawnArgs, on_event: Channel<PtyEvent>, older: &mut Vec<Job>) -> Result<SpawnInfo, String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: args.rows.max(4),
            cols: args.cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(err)?;
    let cmd = build_command(args)?;
    let mut child = pair.slave.spawn_command(cmd).map_err(err)?;
    drop(pair.slave);

    let pid = child.process_id();
    let mut tracked = false;
    if let Some(p) = pid {
        // Straight into its own job, before it has had time to start anything. A
        // shell can still be quicker than that (a profile script that starts a
        // program at once): whatever it has started by then is put in the job too.
        let born = usage::created(p).unwrap_or(0);
        let job = Job::for_process(p, usage::OnClose::End);
        if let Some(job) = &job {
            for (child_pid, _) in crate::status::tree_exact_of(p, born) {
                if child_pid != p {
                    job.adopt(child_pid);
                }
            }
        }
        tracked = job.is_some();
        let mut entry = TabProcs::new(job, std::mem::take(older), p, born);
        let mut procs = state.procs.lock().unwrap();
        // A tab id that is somehow still tracked keeps its jobs (letting one go would
        // end what is in it): they are carried over like an earlier shell's.
        if let Some(prev) = procs.remove(&args.id) {
            entry.older.extend(prev.into_jobs());
        }
        procs.insert(args.id.clone(), entry);
    }
    let killer = child.clone_killer();
    // If the terminal cannot be wired up after all, the shell that was just started is
    // ended and no longer tracked, instead of running on with nothing to show it.
    let mut undo = |state: &PtyManager, mut child: Box<dyn portable_pty::Child + Send + Sync>| {
        let _ = child.kill();
        if let Some(tp) = state.procs.lock().unwrap().remove(&args.id) {
            if let Some(job) = &tp.job {
                job.terminate();
            }
            // Earlier shells' jobs stay the tab's.
            if !tp.older.is_empty() {
                older.extend(tp.older);
            }
        }
    };
    let mut reader = match pair.master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => {
            undo(state, child);
            return Err(err(e));
        }
    };
    let mut writer: Box<dyn Write + Send> = match pair.master.take_writer() {
        Ok(w) => w,
        Err(e) => {
            undo(state, child);
            return Err(err(e));
        }
    };
    let flow = Arc::new(Flow::default());
    let (input, input_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let queued = Arc::new(AtomicUsize::new(0));

    state.sessions.lock().unwrap().insert(
        args.id.clone(),
        Arc::new(Session {
            master: Mutex::new(pair.master),
            input: Mutex::new(input),
            queued: queued.clone(),
            killer: Mutex::new(killer),
            flow: flow.clone(),
        }),
    );

    // Writer: keystrokes and pastes, in order, on this tab's own thread.
    std::thread::spawn(move || {
        while let Ok(bytes) = input_rx.recv() {
            let ok = writer.write_all(&bytes).is_ok() && writer.flush().is_ok();
            queued.fetch_sub(bytes.len(), Ordering::Relaxed);
            if !ok {
                break;
            }
        }
    });

    // Reader: process output -> bounded buffer. When the buffer is full it stops
    // reading, the pipe fills, and only this tab's process is made to wait.
    let rflow = flow.clone();
    std::thread::spawn(move || {
        let mut chunk = [0u8; 32_768];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut st = rflow.state.lock().unwrap();
                    while st.buf.len() > READ_BUFFER_CAP && !st.eof {
                        st = rflow.cv.wait_timeout(st, Duration::from_millis(500)).unwrap().0;
                    }
                    // The tab has ended and nothing is sending any more: something that
                    // still holds the terminal open must not fill memory without end.
                    if st.eof && st.buf.len() > READ_BUFFER_CAP {
                        break;
                    }
                    st.buf.extend_from_slice(&chunk[..n]);
                    rflow.cv.notify_all();
                }
            }
        }
        rflow.state.lock().unwrap().eof = true;
        rflow.cv.notify_all();
    });

    // Sender: buffer -> window, batched, paused while the window is behind.
    let sflow = flow.clone();
    let out = on_event.clone();
    std::thread::spawn(move || {
        let mut pending: Vec<u8> = Vec::new();
        loop {
            {
                let mut st = sflow.state.lock().unwrap();
                while st.buf.is_empty() && !st.eof {
                    st = sflow.cv.wait(st).unwrap();
                }
                if st.buf.is_empty() && st.eof {
                    break;
                }
            }
            std::thread::sleep(COALESCE);
            let data = {
                let mut st = sflow.state.lock().unwrap();
                // Wait for the window to catch up. The timeout is a safety net so a
                // lost acknowledgement can never freeze a tab for good.
                let mut waited = 0u32;
                while st.unacked > HIGH_WATER && waited < 20 {
                    st = sflow.cv.wait_timeout(st, Duration::from_millis(250)).unwrap().0;
                    waited += 1;
                }
                if waited >= 20 {
                    // Five seconds without a word from the window: one more chunk goes,
                    // then it waits again. A lost acknowledgement cannot freeze the tab,
                    // and a window that has hung is not sent output at full speed.
                    st.unacked = HIGH_WATER;
                }
                let take = st.buf.len().min(MAX_CHUNK);
                pending.extend(st.buf.drain(..take));
                sflow.cv.notify_all();
                let text = take_utf8(&mut pending);
                st.unacked += text.len();
                text
            };
            if data.is_empty() {
                continue;
            }
            let n = data.len();
            if out.send(PtyEvent::Output { data, n }).is_err() {
                break;
            }
        }
    });

    // Waiter: when the shell exits, close the pseudo-terminal (which ends the
    // reader) and tell the window.
    let sessions = state.sessions.clone();
    let id = args.id.clone();
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code());
        std::thread::sleep(Duration::from_millis(150));
        let session = sessions.lock().unwrap().remove(&id);
        if let Some(s) = session {
            s.flow.state.lock().unwrap().eof = true;
            s.flow.cv.notify_all();
            // Dropped here, outside the lock: that closes the pseudo-terminal.
        }
        std::thread::sleep(Duration::from_millis(60));
        let _ = on_event.send(PtyEvent::Exit { code });
    });

    Ok(SpawnInfo { pid, tracked })
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyManager>, id: String, data: String) -> Result<(), String> {
    let s = state.session(&id).ok_or("terminal is closed")?;
    let bytes = data.into_bytes();
    // Reserved before it is queued, counting what is being added: a single huge paste,
    // or several at once, cannot take the queue past the cap.
    let n = bytes.len();
    if s.queued.fetch_update(Ordering::AcqRel, Ordering::Acquire, |q| (q + n <= INPUT_CAP).then_some(q + n)).is_err() {
        return Err("input not passed on: the program in this tab has stopped reading its input".into());
    }
    let sent = s.input.lock().unwrap().send(bytes);
    sent.map_err(err)
}

#[tauri::command]
pub fn pty_resize(state: State<'_, PtyManager>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    // The tab is looked up and the list let go again before the resize itself, which
    // can take a moment: one tab resizing never holds up the others.
    let s = state.session(&id).ok_or("terminal is closed")?;
    let master = s.master.lock().unwrap();
    master
        .resize(PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 })
        .map_err(err)
}

/// The window reports how many bytes it has finished drawing.
#[tauri::command]
pub fn pty_ack(state: State<'_, PtyManager>, id: String, n: usize) {
    if let Some(s) = state.session(&id) {
        let mut st = s.flow.state.lock().unwrap();
        st.unacked = st.unacked.saturating_sub(n);
        s.flow.cv.notify_all();
    }
}

/// Closes tabs for good, ending everything they started (see `PtyManager::close`).
/// Says how many processes had to be ended by force, and names any still running.
#[tauri::command(async)]
pub fn pty_close(state: State<'_, PtyManager>, ids: Vec<String>) -> Ended {
    state.close(&ids, CLOSE_GRACE)
}

/// Closes every tab, ending everything they started: when the app closes, and when
/// its page starts (which finds something only if the page was reloaded).
#[tauri::command(async)]
pub fn pty_kill_all(state: State<'_, PtyManager>) -> Ended {
    state.close_all(CLOSE_GRACE)
}

/// Waits a moment for listed processes to be gone — ending takes Windows an instant —
/// and names those still running, with anything left in the tab's jobs.
fn still_running(state: &PtyManager, id: &str, listed: &[(u32, u64)]) -> Vec<String> {
    let left = || -> HashSet<u32> {
        let mut pids: HashSet<u32> = listed.iter().filter(|(pid, born)| usage::alive_exact(*pid, *born)).map(|p| p.0).collect();
        pids.extend(state.job_pids(id));
        pids
    };
    let began = std::time::Instant::now();
    let mut rest = left();
    while !rest.is_empty() && began.elapsed() < Duration::from_millis(1500) {
        std::thread::sleep(Duration::from_millis(100));
        rest = left();
    }
    crate::status::names_of(&rest)
}

/// Emergency stop: ends every process the tab has started, the shell included.
/// Says how many processes were targeted and names any still running afterwards
/// (Windows refused — e.g. a program running as administrator). The shell's exit is
/// then reported to the window the usual way.
#[tauri::command(async)]
pub fn pty_kill_tree(state: State<'_, PtyManager>, id: String) -> Ended {
    let listed = state.tab_exact(&id);
    // The job goes first: one call, and nothing in it can start a replacement.
    if let Some(tp) = state.procs.lock().unwrap().get(&id) {
        for job in tp.jobs() {
            job.terminate();
        }
    }
    for (pid, born) in &listed {
        usage::kill_exact(*pid, *born);
    }
    Ended { targeted: listed.len() as u32, survivors: still_running(&state, &id, &listed) }
}

/// Ends one process, if it belongs to the tab.
#[tauri::command(async)]
pub fn proc_kill(state: State<'_, PtyManager>, id: String, pid: u32) -> bool {
    state.tab_exact(&id).iter().any(|p| p.0 == pid && usage::kill_exact(p.0, p.1))
}

/// Low priority on or off for everything in the tab — on, it also holds for whatever
/// the tab starts later (it is set on the tab's job); off, each process gets back the
/// priority it had before. Returns how many processes were changed.
#[tauri::command(async)]
pub fn tab_priority(state: State<'_, PtyManager>, id: String, low: bool) -> u32 {
    use windows_sys::Win32::System::Threading::{IDLE_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS};
    let listed = state.tab_exact(&id);
    let mut procs = state.procs.lock().unwrap();
    let Some(tp) = procs.get_mut(&id) else { return 0 };
    if low {
        if tp.low.is_none() {
            tp.low = Some(listed.iter().filter_map(|(pid, born)| usage::priority_of(*pid).map(|c| (*pid, *born, c))).collect());
        }
        for job in tp.jobs() {
            job.set_low_priority(true);
        }
        // Set one by one as well: that covers anything not in a job, and is what says
        // whether it took.
        listed.iter().filter(|(pid, born)| usage::set_priority_exact(*pid, Some(*born), IDLE_PRIORITY_CLASS)).count() as u32
    } else {
        for job in tp.jobs() {
            job.set_low_priority(false);
        }
        let before = tp.low.take().unwrap_or_default();
        listed
            .iter()
            .filter(|(pid, born)| {
                let class = before.iter().find(|b| b.0 == *pid && b.1 == *born).map(|b| b.2).unwrap_or(NORMAL_PRIORITY_CLASS);
                usage::set_priority_exact(*pid, Some(*born), class)
            })
            .count() as u32
    }
}

/// "Close for update", step one — before the CLI is asked to quit: notes the CLI's
/// process, the launcher chain between it and the shell (the `cmd`/`node` that
/// started it), and everything the CLI has started. Returns how many were noted;
/// 0 if that process is not in this tab.
///
/// Noted now because once the CLI has quit, what it started can no longer be told
/// from what was started in the tab before it — a dev server, a watcher, a background
/// job — and those are not to be touched by an update.
#[tauri::command(async)]
pub fn pty_cli_note(state: State<'_, PtyManager>, id: String, cli: u32) -> u32 {
    let shell = state.procs.lock().unwrap().get(&id).map(|tp| tp.shell_pid).unwrap_or(0);
    let in_tab = state.tab_exact(&id);
    let mut noted: Vec<(u32, u64)> = Vec::new();
    if let Some(found) = in_tab.iter().find(|p| p.0 == cli && cli != shell) {
        // Walked down from the very process that was just found in the tab — not from
        // whatever has that id a moment later.
        noted = crate::status::tree_exact_of(cli, found.1);
        for pid in crate::status::with_ancestors(cli, shell) {
            // Only what is known to be this tab's, and never the shell.
            if let Some(known) = in_tab.iter().find(|p| p.0 == pid && p.0 != shell) {
                if !noted.contains(known) {
                    noted.push(*known);
                }
            }
        }
    }
    let count = noted.len() as u32;
    if let Some(tp) = state.procs.lock().unwrap().get_mut(&id) {
        tp.cli_noted = noted;
    }
    // It is asked to quit next: a Claude that has only just started first gets past its
    // start (see status::settle_claudes).
    crate::status::settle_claudes(&[cli]);
    count
}

/// "Close for update", step two — after the CLI was asked to quit: ends whatever of
/// the noted processes is still there, with anything they have started since, and
/// any process of one of the three CLIs left in the tab (that is what would keep the
/// CLI's files in use). The shell stays, and so does everything else in the tab.
/// Returns how many processes were ended.
#[tauri::command(async)]
pub fn pty_cli_end(state: State<'_, PtyManager>, id: String) -> u32 {
    let (shell, noted) = {
        let mut procs = state.procs.lock().unwrap();
        let Some(tp) = procs.get_mut(&id) else { return 0 };
        (tp.shell_pid, std::mem::take(&mut tp.cli_noted))
    };
    let mut targets: Vec<(u32, u64)> = Vec::new();
    for (pid, born) in noted {
        // Same id and same creation time, or it is not the process that was noted — and
        // then nothing under that id is touched either.
        if pid != shell && usage::alive_exact(pid, born) {
            for p in crate::status::tree_exact_of(pid, born) {
                if p.0 != shell && !targets.contains(&p) {
                    targets.push(p);
                }
            }
        }
    }
    let clis = crate::status::cli_pids();
    for p in state.tab_exact(&id) {
        if p.0 != shell && clis.contains(&p.0) && !targets.contains(&p) {
            targets.push(p);
        }
    }
    targets.iter().filter(|(pid, born)| usage::kill_exact(*pid, *born)).count() as u32
}

/// Ends what is running in the tab but keeps its shell at the prompt. With `spare`
/// (the CLI's process id) the CLI itself and the launcher chain above it are left
/// alone too, so only what the CLI started is ended — the CLI is then asked to quit
/// the normal way. Returns how many processes were actually ended.
#[tauri::command(async)]
pub fn pty_kill_children(state: State<'_, PtyManager>, id: String, spare: Option<u32>) -> u32 {
    let shell = state.procs.lock().unwrap().get(&id).map(|tp| tp.shell_pid);
    let mut listed = state.tab_exact(&id);
    if let Some(shell) = shell {
        listed.retain(|p| p.0 != shell);
    }
    if let Some(cli) = spare {
        if listed.iter().any(|p| p.0 == cli) {
            let keep = crate::status::with_ancestors(cli, shell.unwrap_or(0));
            listed.retain(|p| !keep.contains(&p.0));
        }
    }
    let ended = listed.iter().filter(|(pid, born)| usage::kill_exact(*pid, *born)).count() as u32;
    // The CLI is asked to quit next: a Claude that has only just started first gets past
    // its start (see status::settle_claudes). What it started is ended already.
    if let Some(cli) = spare {
        crate::status::settle_claudes(&[cli]);
    }
    ended
}
