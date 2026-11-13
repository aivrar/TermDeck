//! Keeping Claude Code, Codex and Grok up to date.
//!
//! The app does not know or care how each CLI was installed: it runs the CLI's own
//! `update` command, exactly as you would type it, and reports what it said. To tell
//! whether an update exists without installing anything it asks Grok itself
//! (`grok update --check`) and, for the other two, the public npm registry.

use crate::status;
use crate::usage::{Job, OnClose};
use serde::Serialize;
use std::io::Read;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct Ran {
    code: Option<i32>,
    out: String,
    timed_out: bool,
}

/// Removes colour and cursor codes so the text reads cleanly in a dialog.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            match chars.peek() {
                Some('[') => {
                    chars.next();
                    for d in chars.by_ref() {
                        if ('@'..='~').contains(&d) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    // OSC: up to BEL or ESC \
                    while let Some(d) = chars.next() {
                        if d == '\u{7}' {
                            break;
                        }
                        if d == '\u{1b}' {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {
                    chars.next();
                }
            }
        } else if c != '\r' {
            out.push(c);
        }
    }
    out
}

/// Runs one command line hidden, the way a shell would resolve it, with the same PATH
/// the tabs get. Output (stdout and stderr together) is captured; nothing can prompt.
///
/// It runs in a job of its own, which nothing it starts can leave: on timeout the
/// whole job is ended at once — programs whose parent already exited included. With
/// `OnClose::End` (version checks) anything it leaves running is ended when it is done,
/// and if TermDeck itself goes; `OnClose::Keep` (an update) is never stopped halfway by
/// that, only by the timeout.
fn run(line: &str, timeout: Duration, on_close: OnClose) -> Ran {
    let home = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".into());
    let spawned = Command::new("cmd.exe")
        .args(["/D", "/C"])
        .raw_arg(format!("{line} 2>&1"))
        .env("PATH", crate::pty::path_with_cli_dirs(&home))
        .env("NO_COLOR", "1")
        .current_dir(&home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => return Ran { code: None, out: format!("could not start: {e}"), timed_out: false },
    };
    let job = Job::for_process(child.id(), on_close);
    if let Some(job) = &job {
        // Anything it managed to start before it was put in the job goes in too.
        for (pid, _) in status::tree_exact(child.id()) {
            if pid != child.id() {
                job.adopt(pid);
            }
        }
    }
    // What it prints is collected as it comes, and only the last part is kept: an
    // updater that prints megabytes of progress must not be held in memory whole.
    const KEEP: usize = 512 * 1024;
    let printed = Arc::new(Mutex::new(Vec::<u8>::new()));
    let (tx, rx) = mpsc::channel::<()>();
    if let Some(mut pipe) = child.stdout.take() {
        let printed = printed.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            while let Ok(n) = pipe.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let mut all = printed.lock().unwrap();
                all.extend_from_slice(&buf[..n]);
                if all.len() > KEEP * 2 {
                    let cut = all.len() - KEEP;
                    all.drain(..cut);
                }
            }
            let _ = tx.send(());
        });
    }
    let started = Instant::now();
    let mut timed_out = false;
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => {
                if started.elapsed() > timeout {
                    timed_out = true;
                    // End it and whatever it started, so nothing is left half-running:
                    // the whole job at once, and (should there be no job) the tree,
                    // each one only if it is still the process that was listed.
                    if let Some(job) = &job {
                        job.terminate();
                    }
                    for (pid, born) in status::tree_exact(child.id()) {
                        crate::usage::kill_exact(pid, born);
                    }
                    let _ = child.kill();
                    // Never waits for good: it is reported as timed out either way.
                    let gone = Instant::now();
                    while gone.elapsed() < Duration::from_secs(5) && matches!(child.try_wait(), Ok(None)) {
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    break None;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(_) => break None,
        }
    };
    // Normally the output ends when the command does. A program it left running can
    // keep the pipe open, though; then what has arrived by now is what there is —
    // not "it printed nothing".
    let _ = rx.recv_timeout(Duration::from_secs(3));
    let bytes = std::mem::take(&mut *printed.lock().unwrap());
    Ran { code, out: strip_ansi(&String::from_utf8_lossy(&bytes)), timed_out }
}

/// The first thing in the text that looks like a version number: 2.1.322, 0.167.0 …
fn first_version(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() && (i == 0 || !(bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'.')) {
            let mut j = i;
            let mut dots = 0;
            while j < bytes.len() && (bytes[j].is_ascii_digit() || (bytes[j] == b'.' && j + 1 < bytes.len() && bytes[j + 1].is_ascii_digit())) {
                if bytes[j] == b'.' {
                    dots += 1;
                }
                j += 1;
            }
            if dots >= 1 {
                return Some(text[i..j].to_string());
            }
            i = j;
        } else {
            i += 1;
        }
    }
    None
}

fn newer(latest: &str, installed: &str) -> bool {
    let parse = |v: &str| v.split('.').map(|p| p.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    parse(latest) > parse(installed)
}

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CliVersion {
    cli: String,
    /// None when the CLI is not installed (or did not answer).
    installed: Option<String>,
    /// None when the latest version could not be looked up (offline, npm missing).
    latest: Option<String>,
    update_available: bool,
    /// Processes of this CLI running anywhere on the PC, inside this app or not.
    running: u32,
    /// The command "Update" runs.
    command: String,
    note: Option<String>,
}

fn update_command(cli: &str) -> Option<&'static str> {
    match cli {
        "claude" => Some("claude update"),
        "codex" => Some("codex update"),
        "grok" => Some("grok update"),
        _ => None,
    }
}

/// Installed and latest version of each CLI. Installs nothing.
#[tauri::command(async)]
pub fn cli_versions() -> Vec<CliVersion> {
    let short = Duration::from_secs(20);
    let net = Duration::from_secs(30);
    let jobs: Vec<(&str, std::thread::JoinHandle<Ran>)> = vec![
        ("claude", std::thread::spawn(move || run("claude --version", short, OnClose::End))),
        ("codex", std::thread::spawn(move || run("codex --version", short, OnClose::End))),
        ("grok", std::thread::spawn(move || run("grok update --check --json", net, OnClose::End))),
        ("grok-v", std::thread::spawn(move || run("grok --version", short, OnClose::End))),
        ("npm-codex", std::thread::spawn(move || run("npm view @openai/codex version", net, OnClose::End))),
        ("npm-claude", std::thread::spawn(move || run("npm view @anthropic-ai/claude-code dist-tags --json", net, OnClose::End))),
    ];
    let mut got = std::collections::HashMap::new();
    for (name, handle) in jobs {
        if let Ok(r) = handle.join() {
            got.insert(name, r);
        }
    }
    let ok = |name: &str| got.get(name).filter(|r| r.code == Some(0)).map(|r| r.out.clone());
    let running = status::cli_process_counts();
    let count = |cli: &str| running.get(cli).copied().unwrap_or(0);

    let mut out = Vec::new();

    // Claude Code
    let mut c = CliVersion { cli: "claude".into(), command: "claude update".into(), running: count("claude"), ..Default::default() };
    c.installed = ok("claude").and_then(|t| first_version(&t));
    if let Some(tags) = ok("npm-claude").and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()) {
        let tag = |k: &str| tags.get(k).and_then(|v| v.as_str()).map(|s| s.to_string());
        c.latest = tag("latest");
        if let (Some(inst), Some(latest)) = (&c.installed, &c.latest) {
            // Someone who chose the slower "stable" channel is up to date on its version.
            let on_stable = tag("stable").as_deref() == Some(inst.as_str());
            c.update_available = newer(latest, inst) && !on_stable;
            if on_stable && newer(latest, inst) {
                c.note = Some(format!("on the stable channel ({inst}); newest is {latest}"));
            }
        }
    }
    out.push(c);

    // Codex
    let mut c = CliVersion { cli: "codex".into(), command: "codex update".into(), running: count("codex"), ..Default::default() };
    c.installed = ok("codex").and_then(|t| first_version(&t));
    c.latest = ok("npm-codex").and_then(|t| first_version(&t));
    if let (Some(inst), Some(latest)) = (&c.installed, &c.latest) {
        c.update_available = newer(latest, inst);
    }
    out.push(c);

    // Grok answers both questions itself.
    let mut c = CliVersion { cli: "grok".into(), command: "grok update".into(), running: count("grok"), ..Default::default() };
    if let Some(j) = ok("grok").and_then(|t| serde_json::from_str::<serde_json::Value>(t.trim()).ok()) {
        let s = |k: &str| j.get(k).and_then(|v| v.as_str()).map(|s| s.to_string());
        c.installed = s("currentVersion");
        c.latest = s("latestVersion");
        c.update_available = j.get("updateAvailable").and_then(|v| v.as_bool()).unwrap_or(false);
        if let Some(e) = s("error") {
            c.note = Some(e);
        }
    }
    if c.installed.is_none() {
        c.installed = ok("grok-v").and_then(|t| first_version(&t));
    }
    out.push(c);
    out
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    cli: String,
    ok: bool,
    code: Option<i32>,
    timed_out: bool,
    /// What the updater printed (the end of it, if it was long).
    output: String,
    command: String,
}

/// Runs the CLI's own update command and waits for it. Only the three known CLIs.
#[tauri::command(async)]
pub fn cli_update(cli: String) -> Result<UpdateResult, String> {
    let real = update_command(&cli).ok_or("unknown CLI")?;
    // Test hook: with TERMDECK_UPDATE_DRYRUN set, nothing is installed — the CLI is only
    // asked for its version, so the stop / update / resume sequence can be exercised.
    let line = if std::env::var_os("TERMDECK_UPDATE_DRYRUN").is_some() { format!("{cli} --version") } else { real.to_string() };
    let r = run(&line, Duration::from_secs(15 * 60), OnClose::Keep);
    let mut output = r.out.trim().to_string();
    if output.chars().count() > 6000 {
        let skip = output.chars().count() - 6000;
        output = format!("…{}", output.chars().skip(skip).collect::<String>());
    }
    Ok(UpdateResult { cli, ok: r.code == Some(0) && !r.timed_out, code: r.code, timed_out: r.timed_out, output, command: line })
}

/// How many processes of each CLI are running on the PC right now.
#[tauri::command(async)]
pub fn cli_processes() -> std::collections::HashMap<String, u32> {
    status::cli_process_counts()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A command that prints and leaves a program running which keeps the output pipe
    /// open: what was printed must still come back (it used to be reported as nothing).
    #[test]
    fn output_survives_a_program_left_running() {
        let began = Instant::now();
        let r = run("echo it-printed-this& start /b ping -n 9 127.0.0.1 >nul", Duration::from_secs(30), OnClose::End);
        assert_eq!(r.code, Some(0));
        assert!(!r.timed_out);
        assert!(r.out.contains("it-printed-this"), "got: {:?}", r.out);
        assert!(began.elapsed() < Duration::from_secs(7), "did not wait for the left-over program: {:?}", began.elapsed());
        // …and what it left running is ended with its job, not left behind.
        std::thread::sleep(Duration::from_millis(500));
        let left = Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", "@(Get-CimInstance Win32_Process -Filter \"Name='PING.EXE'\" | ? { $_.CommandLine -match '-n 9 127' }).Count"])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&left.stdout).trim(), "0", "the program it left running is still there");
    }

    #[test]
    fn only_the_end_of_very_long_output_is_kept() {
        // About 3 MB of lines, then a last line.
        let r = run("(for /L %i in (1,1,40000) do @echo line %i 0123456789012345678901234567890123456789012345678901234567890123456789) & echo the-last-line", Duration::from_secs(120), OnClose::End);
        assert_eq!(r.code, Some(0));
        assert!(r.out.len() <= 1_100_000, "kept {} bytes", r.out.len());
        assert!(r.out.trim_end().ends_with("the-last-line"));
    }
}
