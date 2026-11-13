//! What this machine offers: shells, WSL distros, home folder, Windows build.

use serde::Serialize;
use std::io::Read;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// How long a start-up question to Windows (which distros, which build, is pwsh there)
/// may take before the app goes on without the answer.
const PROBE_LIMIT: Duration = Duration::from_secs(4);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvInfo {
    home: String,
    /// Windows build number; the terminal view needs it to resize correctly.
    build: u32,
    has_git_bash: bool,
    has_pwsh: bool,
    wsl_distros: Vec<String>,
    /// True when Microsoft's current console layer sits beside the exe and is in use.
    modern_conpty: bool,
}

fn modern_conpty() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|d| d.join("conpty.dll").is_file() && d.join("OpenConsole.exe").is_file()))
        .unwrap_or(false)
}

/// Runs a small helper program hidden and returns what it printed — or None if it
/// failed, or had not finished within `limit`. The limit matters: `wsl.exe` is known to
/// hang when the WSL service is stuck, and the app must still start then.
fn quiet(program: &str, args: &[&str], limit: Duration) -> Option<String> {
    let mut child = Command::new(program)
        .args(args)
        .env("WSL_UTF8", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .ok()?;
    // In a job of its own: whatever it starts ends with it, also when it is given up on.
    let job = crate::usage::Job::for_process(child.id(), crate::usage::OnClose::End);
    // Read on a thread of its own, so a helper that never answers cannot hold this one.
    let mut pipe = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = pipe.read_to_end(&mut out);
        let _ = tx.send(out);
    });
    let began = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if began.elapsed() < limit => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                if let Some(job) = &job {
                    job.terminate();
                }
                let _ = child.kill();
                // Never waits for good: a helper that will not end is given up on.
                let gone = Instant::now();
                while gone.elapsed() < Duration::from_secs(2) && matches!(child.try_wait(), Ok(None)) {
                    std::thread::sleep(Duration::from_millis(25));
                }
                return None;
            }
        }
    };
    if !status.success() {
        return None;
    }
    let out = rx.recv_timeout(Duration::from_secs(2)).ok()?;
    // Older wsl.exe ignores WSL_UTF8 and answers in UTF-16; dropping NULs covers both.
    let bytes: Vec<u8> = out.into_iter().filter(|b| *b != 0).collect();
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn windows_build() -> u32 {
    // "Microsoft Windows [Version 10.0.19045.5011]"
    quiet("cmd.exe", &["/c", "ver"], PROBE_LIMIT)
        .and_then(|s| {
            let inner = s.split('[').nth(1)?.split(']').next()?.to_string();
            inner.split('.').nth(2)?.trim().parse().ok()
        })
        .unwrap_or(19045)
}

/// The distros WSL lists; empty if WSL is not installed or did not answer in time.
/// (A WSL tab saved earlier is still restored: it carries its distro's name itself.)
fn wsl_distros() -> Vec<String> {
    // Test hook: TERMDECK_TEST_WSL names a stand-in for wsl.exe (one that never
    // answers), to check that the app starts all the same.
    let program = std::env::var("TERMDECK_TEST_WSL").unwrap_or_else(|_| "wsl.exe".into());
    quiet(&program, &["-l", "-q"], PROBE_LIMIT)
        .map(|s| s.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default()
}

#[tauri::command(async)]
pub fn env_info() -> EnvInfo {
    // Asked side by side, so even if every one of them ran into its limit the app
    // would be held up by one limit, not three.
    let distros = std::thread::spawn(wsl_distros);
    let build = std::thread::spawn(windows_build);
    let pwsh = std::thread::spawn(|| quiet("where.exe", &["pwsh.exe"], PROBE_LIMIT).is_some());
    EnvInfo {
        home: std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".into()),
        build: build.join().unwrap_or(19045),
        has_git_bash: crate::pty::git_bash_path().is_some(),
        has_pwsh: pwsh.join().unwrap_or(false),
        wsl_distros: distros.join().unwrap_or_default(),
        modern_conpty: modern_conpty(),
    }
}

/// Opens a web link in the default browser. Only http(s) is accepted.
/// The link is handed to Windows as a link ("open"), never to a command line, so no
/// character in it — comma, quote, ampersand — can be read as anything but part of it.
#[tauri::command(async)]
pub fn open_external(url: String) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let web = url.starts_with("https://") || url.starts_with("http://");
    if !web || url.len() > 4096 || url.chars().any(|c| c.is_control() || c.is_whitespace() || c == '"') {
        return Err("only web links can be opened".into());
    }
    let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
    let (verb, target) = (wide("open"), wide(&url));
    let result = unsafe {
        ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), target.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL)
    };
    // By Windows' own rule, a value above 32 means it worked.
    if result as usize > 32 {
        Ok(())
    } else {
        Err(format!("Windows could not open the link (code {})", result as usize))
    }
}

#[tauri::command]
pub fn dir_exists(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_helper_that_never_answers_is_given_up_on() {
        let began = Instant::now();
        let got = quiet("ping.exe", &["-n", "30", "127.0.0.1"], Duration::from_millis(800));
        assert!(got.is_none());
        assert!(began.elapsed() < Duration::from_secs(3), "took {:?}", began.elapsed());
    }

    #[test]
    fn a_helper_that_answers_is_read() {
        let got = quiet("cmd.exe", &["/c", "echo", "hello"], Duration::from_secs(10));
        assert_eq!(got.as_deref().map(str::trim), Some("hello"));
        assert!(windows_build() > 9000);
    }
}
