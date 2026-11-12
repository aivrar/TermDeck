//! A list of past conversations, read from the CLIs' own session folders (read-only),
//! so one can be picked and reopened instead of typing its id.
//! Only the start of each file is read, and only for the newest files, so a large
//! history costs little.

use crate::transcript::{codex_recent_files, home, mtime, norm, percent_decode};
use serde::Serialize;
use serde_json::Value;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const HEAD: usize = 256 * 1024;
const TITLE: usize = 140;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    cli: String,
    id: String,
    /// Folder the conversation was held in ("" if it could not be read).
    cwd: String,
    /// The CLI's own title where it keeps one, else the first thing the user said.
    title: String,
    /// Milliseconds since 1970.
    modified: u64,
    size: u64,
}

fn millis(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Whole lines from the first part of a file.
fn head_lines(path: &Path) -> Vec<String> {
    let Ok(mut file) = File::open(path) else { return Vec::new() };
    let mut buf = vec![0u8; HEAD];
    let mut got = 0;
    while got < HEAD {
        match file.read(&mut buf[got..]) {
            Ok(0) | Err(_) => break,
            Ok(n) => got += n,
        }
    }
    let text = String::from_utf8_lossy(&buf[..got]);
    let mut lines: Vec<String> = text.lines().map(|l| l.to_string()).collect();
    if got == HEAD {
        lines.pop(); // the last line was cut off
    }
    lines
}

fn one_line(s: &str) -> String {
    let flat: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > TITLE {
        format!("{}…", flat.chars().take(TITLE).collect::<String>())
    } else {
        flat
    }
}

fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter(|b| b["type"].as_str().map_or(true, |t| t == "text" || t == "input_text"))
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

/// (folder, first thing the user said) from the start of a Claude Code session file.
fn claude_head(path: &Path) -> (String, String) {
    let (mut cwd, mut first) = (String::new(), String::new());
    for line in head_lines(path) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if cwd.is_empty() {
            if let Some(c) = v["cwd"].as_str() {
                cwd = c.to_string();
            }
        }
        if first.is_empty()
            && v["type"].as_str() == Some("user")
            && v["isMeta"].as_bool() != Some(true)
            && v["isSidechain"].as_bool() != Some(true)
        {
            let t = text_of(&v["message"]["content"]);
            let t = t.trim();
            if !t.is_empty() && !t.starts_with('<') {
                first = one_line(t);
            }
        }
        if !cwd.is_empty() && !first.is_empty() {
            break;
        }
    }
    (cwd, first)
}

fn codex_head(path: &Path) -> (String, String, String) {
    let (mut id, mut cwd, mut first) = (String::new(), String::new(), String::new());
    for line in head_lines(path) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        let p = &v["payload"];
        if v["type"].as_str() == Some("session_meta") {
            id = p["id"].as_str().unwrap_or("").to_string();
            cwd = p["cwd"].as_str().unwrap_or("").to_string();
        } else if first.is_empty()
            && v["type"].as_str() == Some("response_item")
            && p["type"].as_str() == Some("message")
            && p["role"].as_str() == Some("user")
        {
            let t = text_of(&p["content"]);
            let t = t.trim();
            if !t.is_empty() && !t.starts_with('<') {
                first = one_line(t);
            }
        }
        if !id.is_empty() && !first.is_empty() {
            break;
        }
    }
    if id.is_empty() {
        // rollout-<time>-<uuid>.jsonl
        let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        if let Some(tail) = crate::sessions::codex_id_of(&stem) {
            id = tail.to_string();
        }
    }
    (id, cwd, first)
}

fn grok_first(chat: &Path) -> String {
    for line in head_lines(chat) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if v["type"].as_str() == Some("user") && v.get("synthetic_reason").is_none() {
            let t = text_of(&v["content"]);
            if !t.trim().is_empty() {
                return one_line(t.trim());
            }
        }
    }
    String::new()
}

fn newest(mut files: Vec<(SystemTime, PathBuf)>, limit: usize) -> Vec<(SystemTime, PathBuf)> {
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.truncate(limit);
    files
}

/// Past conversations of one CLI, newest first. With `cwd`, only those held in that folder.
#[tauri::command(async)]
pub fn sessions_list(cli: String, cwd: Option<String>, limit: Option<usize>) -> Vec<SessionInfo> {
    let limit = limit.unwrap_or(150).clamp(1, 500);
    let want = cwd.as_deref().filter(|c| !c.trim().is_empty()).map(norm);
    let mut out: Vec<SessionInfo> = Vec::new();
    match cli.as_str() {
        "claude" => {
            let projects = home().join(".claude").join("projects");
            let dirs: Vec<PathBuf> = match &want {
                // Claude names the folder after the path, every other character as "-".
                Some(_) => {
                    let raw = cwd.as_deref().unwrap_or("").trim_end_matches(['\\', '/']);
                    let encoded: String = raw.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
                    vec![projects.join(encoded)]
                }
                None => fs::read_dir(&projects).map(|r| r.flatten().map(|e| e.path()).collect()).unwrap_or_default(),
            };
            let mut files = Vec::new();
            for dir in dirs {
                for f in fs::read_dir(&dir).into_iter().flatten().flatten().map(|e| e.path()) {
                    if f.extension().is_some_and(|x| x == "jsonl") {
                        files.push((mtime(&f), f));
                    }
                }
            }
            for (m, f) in newest(files, limit) {
                let (dir, first) = claude_head(&f);
                // Claude Code closed with nothing said leaves a file with a title and no
                // conversation; it cannot be resumed, so it is not offered.
                if dir.is_empty() && first.is_empty() && !crate::sessions::claude_has_conversation(&f) {
                    continue;
                }
                out.push(SessionInfo {
                    cli: cli.clone(),
                    id: f.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
                    cwd: dir,
                    title: first,
                    modified: millis(m),
                    size: fs::metadata(&f).map(|x| x.len()).unwrap_or(0),
                });
            }
        }
        "codex" => {
            // Already newest first by folder date; look further back when filtering by folder.
            let pool = codex_recent_files(if want.is_some() { 3000 } else { limit * 2 });
            let mut files: Vec<(SystemTime, PathBuf)> = pool.into_iter().map(|f| (mtime(&f), f)).collect();
            files.sort_by(|a, b| b.0.cmp(&a.0));
            for (m, f) in files {
                if out.len() >= limit {
                    break;
                }
                let (id, dir, first) = codex_head(&f);
                if want.as_ref().is_some_and(|w| &norm(&dir) != w) {
                    continue;
                }
                out.push(SessionInfo {
                    cli: cli.clone(),
                    id,
                    cwd: dir,
                    title: first,
                    modified: millis(m),
                    size: fs::metadata(&f).map(|x| x.len()).unwrap_or(0),
                });
            }
        }
        "grok" => {
            let root = home().join(".grok").join("sessions");
            let mut files = Vec::new();
            for entry in fs::read_dir(&root).into_iter().flatten().flatten() {
                let dir = percent_decode(&entry.file_name().to_string_lossy());
                if want.as_ref().is_some_and(|w| &norm(&dir) != w) {
                    continue;
                }
                for s in fs::read_dir(entry.path()).into_iter().flatten().flatten() {
                    let chat = s.path().join("chat_history.jsonl");
                    if chat.is_file() {
                        files.push((mtime(&chat), chat));
                    }
                }
            }
            for (m, chat) in newest(files, limit) {
                let dir = chat.parent().unwrap_or(Path::new(""));
                let title = fs::read_to_string(dir.join("summary.json"))
                    .ok()
                    .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                    .and_then(|v| v["generated_title"].as_str().map(one_line))
                    .filter(|t| !t.is_empty())
                    .unwrap_or_else(|| grok_first(&chat));
                out.push(SessionInfo {
                    cli: cli.clone(),
                    id: dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                    cwd: dir.parent().and_then(|p| p.file_name()).map(|n| percent_decode(&n.to_string_lossy())).unwrap_or_default(),
                    title,
                    modified: millis(m),
                    size: fs::metadata(&chat).map(|x| x.len()).unwrap_or(0),
                });
            }
        }
        _ => {}
    }
    // An id ends up typed into a shell (`claude --resume <id>`). The CLIs' ids are
    // letters, digits and dashes; a file or folder named anything else is not offered.
    out.retain(|s| crate::status::looks_like_id(&s.id));
    out
}
