//! Read-only reader for the CLIs' own session files (the source of truth).
//! Only a bounded window at the end of the file is ever read, so a session file
//! of any size costs the same small amount of memory.

use serde::Serialize;
use serde_json::Value;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

const DEFAULT_WINDOW: u64 = 3 * 1024 * 1024;
const MAX_WINDOW: u64 = 8 * 1024 * 1024;
const TEXT_LIMIT: usize = 20_000;
const TOOL_RESULT_LIMIT: usize = 1_500;
const TOOL_CALL_LIMIT: usize = 400;

#[derive(Serialize)]
pub struct Msg {
    /// "user" | "assistant" | "tool"
    role: &'static str,
    /// "text" | "call" | "result"
    kind: &'static str,
    text: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    found: bool,
    path: String,
    title: Option<String>,
    session_id: Option<String>,
    messages: Vec<Msg>,
    /// Byte offset where this page starts; pass it back as `end` to load earlier.
    start: u64,
    file_size: u64,
}

fn clip(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{} … [{} more characters not shown]", &s[..end], s.len() - end)
}

pub(crate) fn home() -> PathBuf {
    PathBuf::from(std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".into()))
}

/// The folder a CLI keeps its files in: its own setting when one is set
/// (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), otherwise the usual one in the user folder.
/// The CLIs in the tabs get the app's environment, so this is the folder they use.
pub(crate) fn cli_home(cli: &str) -> PathBuf {
    let (var, dir) = match cli {
        "claude" => ("CLAUDE_CONFIG_DIR", ".claude"),
        "codex" => ("CODEX_HOME", ".codex"),
        _ => ("", ".grok"),
    };
    match std::env::var_os(var).filter(|v| !var.is_empty() && !v.is_empty()) {
        Some(v) => PathBuf::from(v),
        None => home().join(dir),
    }
}

pub(crate) fn norm(p: &str) -> String {
    p.trim().trim_end_matches(['\\', '/']).replace('/', "\\").to_lowercase()
}

pub(crate) fn mtime(p: &Path) -> SystemTime {
    fs::metadata(p).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH)
}

/// Codex rollout files, newest date folder first, at most `limit`.
pub(crate) fn codex_recent_files(limit: usize) -> Vec<PathBuf> {
    let root = crate::transcript::cli_home("codex").join("sessions");
    // Folders are YYYY/MM/DD, so a reverse name sort walks newest first.
    let sorted_desc = |dir: &Path| -> Vec<PathBuf> {
        let mut v: Vec<PathBuf> =
            fs::read_dir(dir).map(|r| r.flatten().map(|e| e.path()).collect()).unwrap_or_default();
        v.sort();
        v.reverse();
        v
    };
    let mut files: Vec<PathBuf> = Vec::new();
    for y in sorted_desc(&root) {
        for m in sorted_desc(&y) {
            for d in sorted_desc(&m) {
                for f in sorted_desc(&d) {
                    if f.extension().is_some_and(|x| x == "jsonl") {
                        files.push(f);
                        if files.len() >= limit {
                            return files;
                        }
                    }
                }
            }
        }
    }
    files
}

pub(crate) fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            if let Some(v) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------- bounded tail read ----------

struct Tail {
    lines: Vec<String>,
    /// Byte offset of the first line returned (or of the oversized record skipped).
    start: u64,
    size: u64,
    /// Size of a single record that is larger than the window and so is not shown.
    oversized: Option<u64>,
}

/// Where the line that ends at `end` begins (a newline right at `end - 1` is that
/// line's own). Scans backwards in small pieces, so the line itself is never loaded.
fn line_start_before(file: &mut File, end: u64) -> Result<u64, String> {
    const PIECE: u64 = 64 * 1024;
    let mut pos = end.saturating_sub(1); // skip the line's own trailing newline, if any
    let mut buf = vec![0u8; PIECE as usize];
    while pos > 0 {
        let from = pos.saturating_sub(PIECE);
        let len = (pos - from) as usize;
        file.seek(SeekFrom::Start(from)).map_err(|e| e.to_string())?;
        file.read_exact(&mut buf[..len]).map_err(|e| e.to_string())?;
        if let Some(i) = buf[..len].iter().rposition(|b| *b == b'\n') {
            return Ok(from + i as u64 + 1);
        }
        pos = from;
    }
    Ok(0)
}

/// Reads whole lines from the window `[end - window, end)`.
fn read_tail(path: &Path, end: Option<u64>, window: u64) -> Result<Tail, String> {
    let mut file = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    let end = end.unwrap_or(size).min(size);
    let mut start = end.saturating_sub(window);
    file.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut bytes = vec![0u8; (end - start) as usize];
    file.read_exact(&mut bytes).map_err(|e| e.to_string())?;

    let mut slice: &[u8] = &bytes;
    if start > 0 {
        // The window almost certainly begins mid-line; skip to the next line start.
        match slice.iter().position(|b| *b == b'\n') {
            Some(i) if i + 1 < slice.len() => {
                slice = &slice[i + 1..];
                start += i as u64 + 1;
            }
            // No complete line in the whole window: it lies inside one record that is
            // bigger than the window (a pasted image, a huge tool result). That record
            // is not shown — but the page must start where the record starts, or
            // "Load earlier" would come back to this same spot for ever.
            _ => {
                let record = line_start_before(&mut file, end)?;
                return Ok(Tail { lines: Vec::new(), start: record, size, oversized: Some(end - record) });
            }
        }
    }
    let lines = String::from_utf8_lossy(slice)
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.to_string())
        .collect();
    Ok(Tail { lines, start, size, oversized: None })
}

// ---------- per-CLI parsing ----------

fn blocks_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|b| b["text"].as_str().or_else(|| b["content"].as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn push_text(out: &mut Vec<Msg>, role: &'static str, text: &str) {
    let t = text.trim();
    if !t.is_empty() {
        out.push(Msg { role, kind: "text", text: clip(t, TEXT_LIMIT) });
    }
}

fn push_call(out: &mut Vec<Msg>, name: &str, input: &Value) {
    let args = match input {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    };
    out.push(Msg {
        role: "tool",
        kind: "call",
        text: clip(&format!("{name}  {args}"), TOOL_CALL_LIMIT),
    });
}

fn push_result(out: &mut Vec<Msg>, text: &str) {
    let t = text.trim();
    if !t.is_empty() {
        out.push(Msg { role: "tool", kind: "result", text: clip(t, TOOL_RESULT_LIMIT) });
    }
}

fn parse_claude(v: &Value, out: &mut Vec<Msg>) {
    if v["isMeta"].as_bool() == Some(true) || v["isSidechain"].as_bool() == Some(true) {
        return;
    }
    let content = &v["message"]["content"];
    match v["type"].as_str() {
        Some("user") => match content {
            Value::String(s) => {
                // Slash-command plumbing is not conversation.
                if !s.starts_with("<command-") && !s.starts_with("<local-command") {
                    push_text(out, "user", s);
                }
            }
            Value::Array(items) => {
                for b in items {
                    match b["type"].as_str() {
                        Some("text") => push_text(out, "user", b["text"].as_str().unwrap_or("")),
                        Some("tool_result") => push_result(out, &blocks_text(&b["content"])),
                        Some("image") => push_text(out, "user", "[image]"),
                        _ => {}
                    }
                }
            }
            _ => {}
        },
        Some("assistant") => {
            if let Value::Array(items) = content {
                for b in items {
                    match b["type"].as_str() {
                        Some("text") => push_text(out, "assistant", b["text"].as_str().unwrap_or("")),
                        Some("tool_use") => push_call(out, b["name"].as_str().unwrap_or("tool"), &b["input"]),
                        _ => {}
                    }
                }
            }
        }
        _ => {}
    }
}

fn parse_codex(v: &Value, out: &mut Vec<Msg>) {
    if v["type"].as_str() != Some("response_item") {
        return;
    }
    let p = &v["payload"];
    match p["type"].as_str() {
        Some("message") => {
            let text = blocks_text(&p["content"]);
            match p["role"].as_str() {
                Some("user") => {
                    // Context the CLI injects on the user's behalf.
                    if !text.trim_start().starts_with('<') {
                        push_text(out, "user", &text);
                    }
                }
                Some("assistant") => push_text(out, "assistant", &text),
                _ => {}
            }
        }
        Some("custom_tool_call") => push_call(out, p["name"].as_str().unwrap_or("tool"), &p["input"]),
        Some("function_call") => push_call(out, p["name"].as_str().unwrap_or("tool"), &p["arguments"]),
        Some("local_shell_call") => push_call(out, "shell", &p["action"]),
        Some("custom_tool_call_output") | Some("function_call_output") => {
            push_result(out, &blocks_text(&p["output"]))
        }
        _ => {}
    }
}

fn parse_grok(v: &Value, out: &mut Vec<Msg>) {
    match v["type"].as_str() {
        Some("user") => {
            if v.get("synthetic_reason").is_none() {
                push_text(out, "user", &blocks_text(&v["content"]));
            }
        }
        Some("assistant") => {
            push_text(out, "assistant", &blocks_text(&v["content"]));
            if let Value::Array(calls) = &v["tool_calls"] {
                for c in calls {
                    let f = if c["function"].is_object() { &c["function"] } else { c };
                    push_call(out, f["name"].as_str().unwrap_or("tool"), &f["arguments"]);
                }
            }
        }
        Some("tool_result") => push_result(out, &blocks_text(&v["content"])),
        _ => {}
    }
}

#[tauri::command(async)]
pub fn transcript_load(
    cli: String,
    cwd: String,
    session_id: Option<String>,
    end: Option<u64>,
    window: Option<u64>,
) -> Result<Transcript, String> {
    if !matches!(cli.as_str(), "claude" | "codex" | "grok") {
        return Err(format!("no session reader for: {cli}"));
    }
    // This tab's own conversation, wherever it is — or nothing. (Without an id it used
    // to show the newest conversation in the tab's folder, which can be another tab's
    // or another window's.)
    let _ = &cwd;
    let path = session_id
        .as_deref()
        .filter(|id| !id.trim().is_empty())
        .and_then(|id| crate::sessions::locate(&cli, id))
        .map(|p| if cli == "grok" { p.join("chat_history.jsonl") } else { p });
    let Some(path) = path else {
        return Ok(Transcript::default());
    };

    let window = window.unwrap_or(DEFAULT_WINDOW).clamp(64 * 1024, MAX_WINDOW);
    let Tail { lines, start, size: file_size, oversized } = read_tail(&path, end, window)?;

    let mut messages = Vec::new();
    if let Some(bytes) = oversized {
        // Said, rather than skipped without a word.
        messages.push(Msg {
            role: "tool",
            kind: "result",
            text: format!(
                "[One record of {:.1} MB is too large to show here — usually a pasted image or a very large tool result. Everything before and after it is shown.]",
                bytes as f64 / 1_048_576.0
            ),
        });
    }
    for line in &lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        match cli.as_str() {
            "claude" => parse_claude(&v, &mut messages),
            "codex" => parse_codex(&v, &mut messages),
            _ => parse_grok(&v, &mut messages),
        }
    }

    let (title, found_id) = match cli.as_str() {
        "grok" => {
            let dir = path.parent().unwrap_or(Path::new(""));
            let title = fs::read_to_string(dir.join("summary.json"))
                .ok()
                .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                .and_then(|v| v["generated_title"].as_str().map(|s| s.to_string()));
            (title, dir.file_name().map(|n| n.to_string_lossy().into_owned()))
        }
        "claude" => (None, path.file_stem().map(|n| n.to_string_lossy().into_owned())),
        _ => (None, None),
    };

    Ok(Transcript {
        found: true,
        path: path.to_string_lossy().into_owned(),
        title,
        session_id: found_id,
        messages,
        start,
        file_size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("termdeck-unit-{}-{name}", std::process::id()))
    }

    /// Walks a file from the end to the start the way the History view does, and
    /// returns (lines seen newest page first, sizes of records reported as too large).
    fn walk(path: &Path, window: u64) -> (Vec<String>, Vec<u64>) {
        let (mut lines, mut big, mut end) = (Vec::new(), Vec::new(), None);
        for _ in 0..1000 {
            let t = read_tail(path, end, window).unwrap();
            if let Some(n) = t.oversized {
                big.push(n);
            }
            lines.extend(t.lines);
            if t.start == 0 {
                return (lines, big);
            }
            assert!(end.map_or(true, |e| t.start < e), "no progress at offset {}", t.start);
            end = Some(t.start);
        }
        panic!("did not reach the start of the file");
    }

    #[test]
    fn a_record_larger_than_the_window_is_reported_and_passed() {
        let path = temp("big.jsonl");
        let mut f = File::create(&path).unwrap();
        for i in 0..50 {
            writeln!(f, "before-{i}").unwrap();
        }
        let giant = "x".repeat(300_000);
        writeln!(f, "{giant}").unwrap();
        for i in 0..50 {
            writeln!(f, "after-{i}").unwrap();
        }
        drop(f);
        // A 64 KB window against a 300 KB record.
        let (lines, big) = walk(&path, 64 * 1024);
        let _ = fs::remove_file(&path);
        assert_eq!(big, vec![300_001], "the record is reported once, with its size");
        assert_eq!(lines.iter().filter(|l| l.starts_with("after-")).count(), 50);
        assert_eq!(lines.iter().filter(|l| l.starts_with("before-")).count(), 50, "everything before it is still reached");
        assert!(!lines.iter().any(|l| l.contains("xxxx")), "no piece of the record is shown as a line");
    }

    #[test]
    fn a_record_larger_than_the_window_at_the_very_end_and_at_the_very_start() {
        for at_end in [true, false] {
            let path = temp(if at_end { "end.jsonl" } else { "start.jsonl" });
            let mut f = File::create(&path).unwrap();
            let giant = "y".repeat(200_000);
            if !at_end {
                writeln!(f, "{giant}").unwrap();
            }
            for i in 0..20 {
                writeln!(f, "line-{i}").unwrap();
            }
            if at_end {
                writeln!(f, "{giant}").unwrap();
            }
            drop(f);
            let (lines, big) = walk(&path, 64 * 1024);
            let _ = fs::remove_file(&path);
            assert_eq!(lines.iter().filter(|l| l.starts_with("line-")).count(), 20, "at_end={at_end}");
            // At the very start of the file the record is simply read (nothing lies before it).
            assert!(big.len() <= 1, "at_end={at_end}: {big:?}");
        }
    }

    #[test]
    fn an_ordinary_file_is_read_whole_with_no_report() {
        let path = temp("plain.jsonl");
        let mut f = File::create(&path).unwrap();
        for i in 0..5000 {
            writeln!(f, "row-{i}-{}", "z".repeat(40)).unwrap();
        }
        drop(f);
        let (lines, big) = walk(&path, 64 * 1024);
        let _ = fs::remove_file(&path);
        assert!(big.is_empty());
        assert_eq!(lines.len(), 5000);
    }
}
