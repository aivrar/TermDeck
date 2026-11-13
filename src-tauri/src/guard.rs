//! The crash guard: if TermDeck ends unexpectedly — a crash, Task Manager's End task —
//! every tab's programs end with it, instead of running on where nothing can see or
//! stop them any more.
//!
//! The guard is a second copy of TermDeck, started hidden at launch with `--termdeck-guard`.
//! TermDeck hands it a copy of the handle of each job whose programs must end with the
//! app, over the guard's input pipe. When TermDeck ends, however it ends, Windows closes
//! TermDeck's end of that pipe; the guard reads end-of-input, ends every job it holds,
//! and exits. On a normal close TermDeck has already ended them itself, so this changes
//! nothing.
//!
//! Why not simply mark the jobs "end everything when the last handle closes" (Windows'
//! own `KILL_ON_JOB_CLOSE`)? That did the same, but Claude Code behaves differently while
//! it starts up inside a job marked that way: closed in its first seconds, it no longer
//! quits by itself, and being ended by force then counts against it — two of those and
//! Claude turns its full-screen mode off on the whole PC. Measured 2026-11-12. With the
//! guard, the tabs' jobs carry no such mark.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use windows_sys::Win32::Foundation::{CloseHandle, DuplicateHandle, DUPLICATE_SAME_ACCESS, HANDLE};
use windows_sys::Win32::System::JobObjects::TerminateJobObject;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, CREATE_NO_WINDOW};

/// The switch that starts TermDeck as the guard.
pub const ARG: &str = "--termdeck-guard";

/// Guard mode: holds the job handles it is given until its input ends, then ends every
/// one of them. Never returns.
pub fn run() -> ! {
    unsafe {
        // Nothing typed anywhere is meant for the guard.
        windows_sys::Win32::System::Console::SetConsoleCtrlHandler(None, 1);
    }
    let mut held: Vec<usize> = Vec::new();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let mut words = line.split_whitespace();
        let (Some(what), Some(Ok(h))) = (words.next(), words.next().map(str::parse::<usize>)) else { continue };
        match what {
            "add" => held.push(h),
            "del" => {
                if let Some(i) = held.iter().position(|x| *x == h) {
                    held.swap_remove(i);
                    unsafe {
                        CloseHandle(h as HANDLE);
                    }
                }
            }
            _ => {}
        }
    }
    // TermDeck is gone.
    for h in held {
        unsafe {
            TerminateJobObject(h as HANDLE, 1);
        }
    }
    std::process::exit(0)
}

struct Guard {
    child: Child,
    input: ChildStdin,
}

#[derive(Default)]
struct State {
    guard: Option<Guard>,
    /// The jobs being watched: TermDeck's handle -> the guard's copy of it.
    watched: HashMap<usize, usize>,
    /// Set once the app has started its guard (unit tests never do).
    enabled: bool,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

fn spawn() -> Option<Guard> {
    let exe = std::env::current_exe().ok()?;
    let mut child = Command::new(exe)
        .arg(ARG)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .ok()?;
    let input = child.stdin.take()?;
    Some(Guard { child, input })
}

/// Hands one job to the guard. False if that failed.
fn hand_over(guard: &mut Guard, job: usize) -> Option<usize> {
    let mut copy: HANDLE = std::ptr::null_mut();
    let ok = unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            job as HANDLE,
            guard.child.as_raw_handle() as HANDLE,
            &mut copy,
            0,
            0,
            DUPLICATE_SAME_ACCESS,
        ) != 0
    };
    if !ok {
        return None;
    }
    writeln!(guard.input, "add {}", copy as usize).ok()?;
    guard.input.flush().ok()?;
    Some(copy as usize)
}

/// A guard that is running, started again (with every watched job handed over anew)
/// if the last one is gone.
fn running(st: &mut State) -> Option<&mut Guard> {
    let alive = st.guard.as_mut().is_some_and(|g| matches!(g.child.try_wait(), Ok(None)));
    if !alive {
        st.guard = spawn();
        let g = st.guard.as_mut()?;
        let jobs: Vec<usize> = st.watched.keys().copied().collect();
        for job in jobs {
            match hand_over(g, job) {
                Some(copy) => {
                    st.watched.insert(job, copy);
                }
                None => {
                    st.watched.remove(&job);
                }
            }
        }
    }
    st.guard.as_mut()
}

/// Starts the guard. Called once, at launch, before any tab exists — so the guard
/// inherits nothing of theirs. Without this, `watch` does nothing.
pub fn start() {
    let mut lock = STATE.lock().unwrap();
    let st = lock.get_or_insert_with(State::default);
    st.enabled = true;
    let _ = running(st);
}

/// Has the guard end this job's programs if TermDeck ends unexpectedly. False if it
/// could not be arranged (or no guard was started).
pub fn watch(job: HANDLE) -> bool {
    let mut lock = STATE.lock().unwrap();
    let Some(st) = lock.as_mut().filter(|s| s.enabled) else { return false };
    let Some(g) = running(st) else { return false };
    match hand_over(g, job as usize) {
        Some(copy) => {
            st.watched.insert(job as usize, copy);
            true
        }
        None => false,
    }
}

/// The job is being let go of (its programs ended, or none left): the guard drops its copy.
pub fn release(job: HANDLE) {
    let mut lock = STATE.lock().unwrap();
    let Some(st) = lock.as_mut() else { return };
    if let Some(copy) = st.watched.remove(&(job as usize)) {
        if let Some(g) = st.guard.as_mut() {
            let _ = writeln!(g.input, "del {copy}").and_then(|_| g.input.flush());
        }
    }
}
