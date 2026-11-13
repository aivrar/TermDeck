//! Live state of Codex and Grok sessions, read from the files those CLIs write
//! themselves (read-only). Claude Code publishes its state in a simpler per-process
//! file, handled in status.rs.
//!
//!   Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl
//!          event_msg task_started ... task_complete
//!   Grok:  ~/.grok/sessions/<url-encoded cwd>/<id>/events.jsonl
//!          turn_started ... permission_requested / permission_resolved ... turn_ended

use crate::transcript::{codex_recent_files, mtime, norm, percent_decode};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

const RESCAN: Duration = Duration::from_secs(4);
const TAIL: u64 = 256 * 1024;
/// Slack when comparing a process's start with a file's times.
const EARLY: Duration = Duration::from_secs(5);
/// How long after Enter (or after the CLI started) a session may appear and still be
/// put down to that tab.
const CLAIM: Duration = Duration::from_secs(120);
/// Grok makes its session folder as it starts (measured: under a second after the
/// process begins); anything this soon after a start is put down to that start.
const STARTUP: Duration = Duration::from_secs(30);

/// One tab that has Codex or Grok running, as seen in this poll.
pub struct Want {
    pub tab: String,
    pub cli: String,
    pub pid: u32,
    pub cwd: String,
    /// When the CLI process began.
    pub started: SystemTime,
    /// A session id given on the CLI's own command line (`codex resume <id>`,
    /// `grok --resume <id>`): the one exact fact there is about which session it is on.
    pub named: Option<String>,
    /// A session the tab is believed to be on; used only when nothing better is known.
    pub hint: Option<String>,
    /// When Enter was last pressed in the tab.
    pub input: Option<SystemTime>,
}

struct Bound {
    cli: String,
    pid: u32,
    /// Codex: the rollout file. Grok: the session folder.
    path: Option<PathBuf>,
    /// The moment (file created, or reopened) that earned the tab this session.
    /// Only something later than this can replace it.
    event: SystemTime,
}

/// A session found in a folder.
struct Cand {
    path: PathBuf,
    created: SystemTime,
    modified: SystemTime,
}

#[derive(Default)]
struct Inner {
    bound: HashMap<String, Bound>,
    /// Codex rollout file -> the folder it was started in (read once per file).
    codex_cwd: HashMap<PathBuf, Option<String>>,
    scanned: Option<Instant>,
    /// How long the last look through the session folders took. The next one is put
    /// off in proportion, so the looking never costs more than a few percent of the
    /// time however many sessions a folder holds.
    scan_cost: Duration,
    /// Session -> (size and time of its file when last read, the state read from it).
    /// The file is read again only when one of the two has changed.
    states: HashMap<PathBuf, (u64, SystemTime, Option<String>)>,
    /// Ids looked for and not found, and when: not looked for again for a while.
    missing: HashMap<(String, String), Instant>,
    /// What Grok's own list of running sessions said when it was last read whole:
    /// process id -> (session id, when that process opened it).
    grok_active: HashMap<u32, (String, Option<SystemTime>)>,
    /// Tabs whose session is known from that list — a fact, not worked out from times.
    by_fact: HashSet<String>,
}

/// How long a "no such session" answer is trusted before the folders are searched again.
const MISSING_FOR: Duration = Duration::from_secs(30);
/// The folder scan is spaced so that it takes at most about this share of the time...
const SCAN_SHARE: u32 = 20; // one twentieth
/// ...but is never put off longer than this.
const SCAN_MAX_GAP: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct SessionCache(Mutex<Inner>);

#[derive(Clone)]
pub struct Live {
    pub session_id: Option<String>,
    /// "busy" | "idle" | "waiting"
    pub status: Option<String>,
}

fn codex_cwd_of(inner: &mut Inner, file: &Path) -> Option<String> {
    if let Some(c) = inner.codex_cwd.get(file) {
        return c.clone();
    }
    // A file that could not even be opened this time (in use, a passing lock) says
    // nothing about its folder: nothing is remembered, and it is looked at again.
    let Ok(f) = File::open(file) else { return None };
    let cwd = {
        let mut first = String::new();
        BufReader::new(f).read_line(&mut first).ok().and_then(|_| serde_json::from_str::<Value>(&first).ok()?["payload"]["cwd"].as_str().map(norm))
    };
    // "No folder" is only remembered for a file that has been left alone for a minute.
    // A file caught in the instant before Codex has written its first line has none
    // yet, and must be looked at again next time — remembered as "no folder" it would
    // never show status or offer Resume.
    let settled = mtime(file).elapsed().map(|age| age > Duration::from_secs(60)).unwrap_or(false);
    if cwd.is_some() || settled {
        inner.codex_cwd.insert(file.to_path_buf(), cwd.clone());
    }
    cwd
}

/// (created, modified) of a file or folder, from one look at it.
fn times(p: &Path) -> (SystemTime, SystemTime) {
    match fs::metadata(p) {
        Ok(m) => (m.created().unwrap_or(SystemTime::UNIX_EPOCH), m.modified().unwrap_or(SystemTime::UNIX_EPOCH)),
        Err(_) => (SystemTime::UNIX_EPOCH, SystemTime::UNIX_EPOCH),
    }
}

/// Every session of one CLI, by the (normalised) folder it belongs to.
fn sessions_by_folder(inner: &mut Inner, cli: &str, folders: &HashSet<String>) -> HashMap<String, Vec<Cand>> {
    let mut out: HashMap<String, Vec<Cand>> = HashMap::new();
    if cli == "codex" {
        let recent = codex_recent_files(400);
        // What is remembered about files is kept only for the files still looked at,
        // so it cannot grow for as long as the app runs.
        let still: HashSet<&PathBuf> = recent.iter().collect();
        inner.codex_cwd.retain(|file, _| still.contains(file));
        for f in recent {
            let Some(cwd) = codex_cwd_of(inner, &f) else { continue };
            if folders.contains(&cwd) {
                let (created, modified) = times(&f);
                out.entry(cwd).or_default().push(Cand { created, modified, path: f });
            }
        }
    } else {
        let root = crate::transcript::cli_home("grok").join("sessions");
        for entry in fs::read_dir(root).into_iter().flatten().flatten() {
            let cwd = norm(&percent_decode(&entry.file_name().to_string_lossy()));
            if !folders.contains(&cwd) {
                continue;
            }
            for s in fs::read_dir(entry.path()).into_iter().flatten().flatten() {
                let dir = s.path();
                let modified = mtime(&dir.join("events.jsonl")).max(mtime(&dir.join("chat_history.jsonl")));
                out.entry(cwd.clone()).or_default().push(Cand { created: times(&dir).0, modified, path: dir });
            }
        }
    }
    out
}

/// When a session was last written to.
fn touched(cli: &str, path: &Path) -> SystemTime {
    if cli == "codex" {
        mtime(path)
    } else {
        mtime(&path.join("events.jsonl")).max(mtime(&path.join("chat_history.jsonl")))
    }
}

/// `2026-11-12T04:50:10.510896Z` -> a time. None for anything not written that way.
fn parse_utc(text: &str) -> Option<SystemTime> {
    let (date, time) = text.strip_suffix('Z')?.split_once('T')?;
    let mut d = date.split('-').map(|x| x.parse::<i64>());
    let (y, m, day) = (d.next()?.ok()?, d.next()?.ok()?, d.next()?.ok()?);
    let (hms, frac) = time.split_once('.').unwrap_or((time, ""));
    let mut t = hms.split(':').map(|x| x.parse::<u64>());
    let (h, min, sec) = (t.next()?.ok()?, t.next()?.ok()?, t.next()?.ok()?);
    if !(1970..=9999).contains(&y) || !(1..=12).contains(&m) || !(1..=31).contains(&day) || h > 23 || min > 59 || sec > 60 {
        return None;
    }
    if frac.len() > 12 || !frac.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let nanos: u32 = format!("{:0<9}", &frac[..frac.len().min(9)]).parse().ok()?;
    // Days since 1970-01-01, by the usual calendar arithmetic (years counted from March).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    SystemTime::UNIX_EPOCH.checked_add(Duration::new(days as u64 * 86_400 + h * 3600 + min * 60 + sec, nanos))
}

/// The id at the end of a Codex file name — `rollout-2026-11-11T13-28-15-<uuid>` — which
/// is its last 36 characters. None for a name too short to hold one, or one that is not
/// plain text there (a name with other characters could not be cut at that point).
pub(crate) fn codex_id_of(stem: &str) -> Option<&str> {
    stem.len().checked_sub(36).and_then(|at| stem.get(at..))
}

/// Grok's own list of the sessions that are running, as `process id -> (session id,
/// opened when)`. None if the text is not that list.
///
/// Grok keeps it in `~/.grok/active_sessions.json` (seen 2026-11-11, Grok 1.0.77):
///   [ { "session_id": "...", "pid": 21792, "cwd": "...", "opened_at": "2026-11-12T04:50:10.510896Z" }, ... ]
fn grok_active_from(text: &str) -> Option<HashMap<u32, (String, Option<SystemTime>)>> {
    let list: Value = serde_json::from_str(text).ok()?;
    let mut out = HashMap::new();
    for entry in list.as_array()? {
        let (Some(pid), Some(id)) = (entry["pid"].as_u64(), entry["session_id"].as_str()) else { continue };
        if crate::status::looks_like_id(id) {
            out.insert(pid as u32, (id.to_string(), entry["opened_at"].as_str().and_then(parse_utc)));
        }
    }
    Some(out)
}

/// The folder of a Grok session, which exists from the moment Grok starts — before
/// anything has been said (`locate` only knows sessions with a saved conversation).
fn grok_dir(id: &str) -> Option<PathBuf> {
    fs::read_dir(crate::transcript::cli_home("grok").join("sessions")).ok()?.flatten().map(|e| e.path().join(id)).find(|p| p.is_dir())
}

/// Rule 0: where Grok itself says which of its processes is on which session, that is
/// taken — over anything worked out from times, and again whenever it changes (a new
/// or reopened session inside Grok).
///
/// Why it is needed: two Grok tabs opened one after the other in one folder can make
/// their sessions within milliseconds of each other and in the opposite order (seen
/// 2026-11-11: 52 ms apart, the later tab first). "The earlier start made the earlier
/// session" then puts each tab on the other's conversation.
fn bind_grok_facts(inner: &mut Inner, wants: &[Want], dir_of: &dyn Fn(&str) -> Option<PathBuf>) {
    inner.by_fact.clear();
    for w in wants.iter().filter(|w| w.cli == "grok") {
        let Some((id, opened)) = inner.grok_active.get(&w.pid).cloned() else { continue };
        // A note left behind by an earlier process that had the same process id (a
        // Grok ended by force does not take its note away) is older than this process.
        if opened.is_some_and(|o| o + EARLY < w.started) {
            continue;
        }
        let current = inner.bound.get(&w.tab).and_then(|b| b.path.clone());
        let on_it = current.as_ref().is_some_and(|p| p.file_name().is_some_and(|n| n.to_string_lossy() == id.as_str()));
        let path = if on_it { current.unwrap() } else if let Some(p) = dir_of(&id) { p } else { continue };
        // Whoever else was put on it by guesswork is taken off it.
        for (tab, b) in inner.bound.iter_mut() {
            if tab != &w.tab && b.path.as_ref() == Some(&path) {
                b.path = None;
            }
        }
        let b = inner.bound.entry(w.tab.clone()).or_insert(Bound { cli: w.cli.clone(), pid: w.pid, path: None, event: w.started });
        if b.path.as_ref() != Some(&path) {
            b.path = Some(path);
            b.event = opened.unwrap_or_else(SystemTime::now);
        }
        inner.by_fact.insert(w.tab.clone());
    }
}

/// Decides which session each tab is on.
///
/// The old rule was "the newest session in the tab's folder", which let two tabs running
/// the same CLI in the same folder swap sessions, and let a tab wander onto a session
/// that a CLI in some other window was writing. Now:
///   0. (Grok) What Grok's own list of running sessions says settles it — see
///      `bind_grok_facts`. The rules below are for Codex, and for a Grok that keeps no
///      such list.
///   1. A session id on the CLI's command line settles it.
///   2. Otherwise a session that appears belongs to the tab that caused it:
///      - Grok makes its session as it starts, so a new one goes to the tab whose Grok
///        has just started and has none yet (the earlier start first);
///      - Codex makes its session at the first prompt, so a new one goes to the tab in
///        which Enter was pressed last before it appeared. The same holds for a session
///        made or reopened from inside either CLI (/new, the resume picker).
///   3. A tab keeps its session until rule 2 gives it a later one. A tab whose last
///      Enter was recorded by its own session is not moved at all.
fn rebind(inner: &mut Inner, wants: &[Want]) {
    for w in wants {
        inner.bound.entry(w.tab.clone()).or_insert(Bound { cli: w.cli.clone(), pid: w.pid, path: None, event: w.started });
    }
    // 1. Named on the command line.
    for w in wants {
        if inner.bound[&w.tab].path.is_some() {
            continue;
        }
        if let Some(path) = w.named.as_deref().and_then(|id| locate_remembering(inner, &w.cli, id)) {
            inner.bound.get_mut(&w.tab).unwrap().path = Some(path);
        }
    }
    // 2. Sessions that appeared, or were reopened, since the CLIs started.
    for cli in ["codex", "grok"] {
        let at_start = cli == "grok";
        // Tabs whose session is known for a fact are not part of the guessing.
        let tabs: Vec<&Want> = wants.iter().filter(|w| w.cli == cli && !inner.by_fact.contains(&w.tab)).collect();
        if tabs.is_empty() {
            continue;
        }
        let folders: HashSet<String> = tabs.iter().map(|w| norm(&w.cwd)).collect();
        let mut found = sessions_by_folder(inner, cli, &folders);
        for folder in &folders {
            let group: Vec<&Want> = tabs.iter().copied().filter(|w| &norm(&w.cwd) == folder).collect();
            let earliest = group.iter().map(|w| w.started).min().unwrap_or(SystemTime::UNIX_EPOCH);
            let group_floor = earliest.checked_sub(EARLY).unwrap_or(earliest);
            // A file made since the CLI started is a new session; an older one that
            // was written to since is one it reopened.
            let moment_of = |f: &Cand, floor: SystemTime| if f.created >= floor { f.created } else { f.modified };
            let mut files = found.remove(folder).unwrap_or_default();
            let held: HashSet<PathBuf> = inner.bound.values().filter_map(|b| b.path.clone()).collect();
            files.retain(|f| !held.contains(&f.path) && moment_of(f, group_floor) >= group_floor);
            files.sort_by_key(|f| moment_of(f, group_floor)); // oldest first
            let mut settled: HashSet<&str> = HashSet::new();
            for f in &files {
                // (strength of the claim, the moment it rests on, tab, the file's moment)
                let mut best: Option<(u8, SystemTime, &Want, SystemTime)> = None;
                for &t in &group {
                    if settled.contains(t.tab.as_str()) {
                        continue;
                    }
                    let b = &inner.bound[&t.tab];
                    let floor = t.started.checked_sub(EARLY).unwrap_or(t.started);
                    let new = f.created >= floor;
                    let moment = moment_of(f, floor);
                    if moment < floor || (b.path.is_some() && moment <= b.event) {
                        continue;
                    }
                    let typed = t.input.filter(|i| {
                        *i <= moment + Duration::from_secs(2) && moment.duration_since(*i).map_or(true, |d| d <= CLAIM)
                    });
                    let claim: (u8, SystemTime) = if at_start && new && b.path.is_none() && moment <= t.started + STARTUP {
                        // Made as this tab's CLI started.
                        (3, t.started)
                    } else {
                        match (typed, &b.path) {
                            // Enter was pressed here just before. If this tab already has a
                            // session and that session took the Enter, it is not a claim.
                            (Some(i), Some(current)) if touched(cli, current) < i => (2, i),
                            (Some(i), None) => (2, i),
                            // Nothing known about typing: no session yet and only just started.
                            (None, None) if moment <= t.started + CLAIM => (1, t.started),
                            _ => continue,
                        }
                    };
                    let better = match best {
                        None => true,
                        Some((rank, _, _, _)) if claim.0 != rank => claim.0 > rank,
                        // Two starts: the earlier start made the earlier session.
                        // Two Enters: the later one is the cause.
                        Some((_, at, _, _)) => if claim.0 == 2 { claim.1 > at } else { claim.1 < at },
                    };
                    if better {
                        best = Some((claim.0, claim.1, t, moment));
                    }
                }
                if let Some((_, _, t, moment)) = best {
                    let b = inner.bound.get_mut(&t.tab).unwrap();
                    b.path = Some(f.path.clone());
                    b.event = moment;
                    settled.insert(t.tab.as_str());
                }
            }
        }
    }
    // 3. Nothing found: fall back on what the tab was last known to be on.
    for w in wants {
        if inner.bound[&w.tab].path.is_none() {
            if let Some(path) = w.hint.as_deref().and_then(|id| locate_remembering(inner, &w.cli, id)) {
                inner.bound.get_mut(&w.tab).unwrap().path = Some(path);
            }
        }
    }
}

fn tail_lines(path: &Path) -> Vec<String> {
    let Ok(mut file) = File::open(path) else { return Vec::new() };
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let start = size.saturating_sub(TAIL);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut bytes = Vec::with_capacity((size - start) as usize);
    if file.read_to_end(&mut bytes).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<String> = text.lines().map(|l| l.to_string()).collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0); // partial first line
    }
    lines
}

fn codex_state(file: &Path) -> Option<String> {
    for line in tail_lines(file).iter().rev() {
        if !line.contains("\"event_msg\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let Some(kind) = v["payload"]["type"].as_str() else { continue };
        match kind {
            "task_started" => return Some("busy".into()),
            "task_complete" | "turn_aborted" | "turn_complete" | "error" => return Some("idle".into()),
            k if k.contains("approval_request") || k.contains("request_user_input") || k.contains("elicitation") => {
                return Some("waiting".into())
            }
            _ => {}
        }
    }
    None
}

fn grok_state(dir: &Path) -> Option<String> {
    for line in tail_lines(&dir.join("events.jsonl")).iter().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let Some(kind) = v["type"].as_str() else { continue };
        return Some(
            match kind {
                "turn_ended" => "idle",
                "permission_requested" => "waiting",
                "phase_changed" if v["phase"].as_str() == Some("permission_prompt") => "waiting",
                _ => "busy",
            }
            .into(),
        );
    }
    None
}

/// The state of a session, read from its file only when the file has changed since
/// the last look. (It used to be read — up to 256 KB — once a second per tab, changed
/// or not.)
fn state_of(inner: &mut Inner, cli: &str, path: &Path) -> Option<String> {
    let file = if cli == "codex" { path.to_path_buf() } else { path.join("events.jsonl") };
    let stamp = fs::metadata(&file).ok().map(|m| (m.len(), m.modified().unwrap_or(SystemTime::UNIX_EPOCH)));
    if let (Some((len, at)), Some((seen_len, seen_at, state))) = (stamp, inner.states.get(path)) {
        if *seen_len == len && *seen_at == at {
            return state.clone();
        }
    }
    // The size and time were taken before reading: if the file grows meanwhile, the
    // next look sees a different size and reads again.
    let state = if cli == "codex" { codex_state(path) } else { grok_state(path) };
    match stamp {
        Some((len, at)) => {
            inner.states.insert(path.to_path_buf(), (len, at, state.clone()));
        }
        None => {
            inner.states.remove(path);
        }
    }
    state
}

/// How long to wait before looking through the session folders again: as often as
/// wanted while a look is quick, less often — in proportion — when it is slow.
fn scan_gap(wanted: Duration, cost: Duration) -> Duration {
    wanted.max(cost * SCAN_SHARE).min(SCAN_MAX_GAP)
}

/// `locate`, for the once-a-second look: an id that was not found is not searched for
/// again for half a minute (the search walks every session folder).
fn locate_remembering(inner: &mut Inner, cli: &str, id: &str) -> Option<PathBuf> {
    let key = (cli.to_string(), id.to_string());
    if inner.missing.get(&key).is_some_and(|at| at.elapsed() < MISSING_FOR) {
        return None;
    }
    let found = locate(cli, id);
    if found.is_none() {
        inner.missing.insert(key, Instant::now());
    } else {
        inner.missing.remove(&key);
    }
    found
}

/// Where a session with this id lives, if it has been saved at all.
/// Every saved session is considered, however old (until 2026-11-11 only the newest
/// 2,000 Codex files were, and an older conversation was taken for "never saved").
pub fn locate(cli: &str, id: &str) -> Option<PathBuf> {
    // The id becomes part of a file name; only something that looks like an id is used.
    if !crate::status::looks_like_id(id) {
        return None;
    }
    match cli {
        "claude" => fs::read_dir(crate::transcript::cli_home("claude").join("projects"))
            .ok()?
            .flatten()
            .map(|e| e.path().join(format!("{id}.jsonl")))
            .find(|p| p.is_file()),
        // The whole id, not "a name ending in it": a shorter id that happens to be the
        // tail of another conversation's id must not find that other conversation.
        "codex" => codex_recent_files(usize::MAX)
            .into_iter()
            .find(|f| f.file_stem().is_some_and(|s| codex_id_of(&s.to_string_lossy()) == Some(id))),
        "grok" => fs::read_dir(crate::transcript::cli_home("grok").join("sessions"))
            .ok()?
            .flatten()
            .map(|e| e.path().join(id))
            .find(|p| p.join("chat_history.jsonl").is_file()),
        _ => None,
    }
}

/// True if a Claude Code session file holds an actual conversation.
/// Claude Code that is closed the normal way with nothing said still leaves a small
/// file behind — a title line and a name line, no message — and `claude --resume <id>`
/// then fails on it. (Seen 2026-11-11: 228 bytes, lines of type "ai-title" and
/// "agent-name" only.) Only the start of the file is read.
pub(crate) fn claude_has_conversation(path: &Path) -> bool {
    const HEAD: u64 = 256 * 1024;
    let Ok(file) = File::open(path) else { return false };
    let long = file.metadata().map(|m| m.len() > HEAD).unwrap_or(false);
    let mut text = Vec::new();
    if file.take(HEAD).read_to_end(&mut text).is_err() {
        return false;
    }
    let said = String::from_utf8_lossy(&text).lines().any(|line| {
        serde_json::from_str::<Value>(line).is_ok_and(|v| matches!(v["type"].as_str(), Some("user") | Some("assistant")))
    });
    // A file that long with no message in its first part is not an empty stub.
    said || long
}

/// Whether there is a saved conversation with this id that the CLI could resume.
#[tauri::command(async)]
pub fn session_exists(cli: String, session_id: String) -> bool {
    locate(&cli, &session_id).is_some_and(|path| cli != "claude" || claude_has_conversation(&path))
}

impl SessionCache {
    /// Session and state for every tab that has Codex or Grok running.
    pub fn resolve(&self, wants: &[Want]) -> HashMap<String, Live> {
        let mut inner = self.0.lock().unwrap();
        // Forget tabs whose CLI has gone or been restarted.
        inner.bound.retain(|tab, b| wants.iter().any(|w| &w.tab == tab && w.cli == b.cli && w.pid == b.pid));
        let unseen = wants.iter().any(|w| !inner.bound.contains_key(&w.tab));
        // Look more often just after Enter was pressed somewhere: that is when a new
        // session appears, and its tab should show "working" without a four-second lag.
        let now = SystemTime::now();
        let just_typed = wants.iter().any(|w| w.input.is_some_and(|i| now.duration_since(i).map_or(true, |d| d < Duration::from_secs(15))));
        let wanted = if just_typed { Duration::from_secs(1) } else { RESCAN };
        // With thousands of sessions in a folder a scan takes real time; it is then
        // done less often, in proportion.
        let every = scan_gap(wanted, inner.scan_cost);
        // What Grok says about its own sessions, on every look (one small file). A
        // read that fails or catches the file half-written changes nothing.
        if wants.iter().any(|w| w.cli == "grok") {
            if let Some(list) = fs::read_to_string(crate::transcript::cli_home("grok").join("active_sessions.json")).ok().and_then(|t| grok_active_from(&t)) {
                inner.grok_active = list;
            }
            bind_grok_facts(&mut inner, wants, &grok_dir);
        } else {
            inner.grok_active.clear();
            inner.by_fact.clear();
        }
        if !wants.is_empty() && (unseen || inner.scanned.map_or(true, |t| t.elapsed() >= every)) {
            let began = Instant::now();
            rebind(&mut inner, wants);
            inner.scan_cost = began.elapsed();
            inner.scanned = Some(Instant::now());
        }
        let paths: Vec<(&Want, Option<PathBuf>)> =
            wants.iter().map(|w| (w, inner.bound.get(&w.tab).and_then(|b| b.path.clone()))).collect();
        // Only sessions a tab is on are remembered.
        let live: HashSet<&PathBuf> = paths.iter().filter_map(|(_, p)| p.as_ref()).collect();
        inner.states.retain(|path, _| live.contains(path));
        inner.missing.retain(|_, at| at.elapsed() < MISSING_FOR);
        let inner = &mut *inner;
        paths
            .iter()
            .map(|(w, path)| {
                let live = match path.as_ref() {
                    None => Live { session_id: None, status: None },
                    Some(path) if w.cli == "codex" => {
                        // rollout-2026-11-11T13-28-15-<uuid>.jsonl — the id is the last 36 characters.
                        let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                        let id = codex_id_of(&stem).map(str::to_string);
                        Live { session_id: id, status: state_of(inner, "codex", path) }
                    }
                    Some(path) => Live {
                        session_id: path.file_name().map(|n| n.to_string_lossy().into_owned()),
                        status: state_of(inner, "grok", path),
                    },
                };
                (w.tab.clone(), live)
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("termdeck-unit-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_session_file_is_read_again_only_when_it_has_changed() {
        let dir = scratch("state");
        let file = dir.join("rollout-test.jsonl");
        // Two records of the same length that mean different things.
        let busy = r#"{"type":"event_msg","payload":{"type":"task_started"}}"#;
        let idle = r#"{"type":"event_msg","payload":{"type":"turn_aborted"}}"#;
        assert_eq!(busy.len(), idle.len());
        fs::write(&file, format!("{busy}\n")).unwrap();
        let stamp = fs::metadata(&file).unwrap().modified().unwrap();

        let mut inner = Inner::default();
        assert_eq!(state_of(&mut inner, "codex", &file).as_deref(), Some("busy"));

        // Same size, same time, different content: if the file were read again the
        // answer would change. It does not — so it was not read.
        fs::write(&file, format!("{idle}\n")).unwrap();
        File::options().write(true).open(&file).unwrap().set_modified(stamp).unwrap();
        assert_eq!(state_of(&mut inner, "codex", &file).as_deref(), Some("busy"));

        // The file grows, as it does when the CLI writes: read again.
        let mut f = File::options().append(true).open(&file).unwrap();
        writeln!(f, "{idle}").unwrap();
        drop(f);
        assert_eq!(state_of(&mut inner, "codex", &file).as_deref(), Some("idle"));

        // Gone: no state, and nothing kept about it.
        fs::remove_file(&file).unwrap();
        assert_eq!(state_of(&mut inner, "codex", &file), None);
        assert!(inner.states.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    fn grok_tab(tab: &str, pid: u32, started: SystemTime) -> Want {
        Want { tab: tab.into(), cli: "grok".into(), pid, cwd: "C:\\work".into(), started, named: None, hint: None, input: None }
    }

    #[test]
    fn times_written_by_grok_are_read() {
        let at = |secs: u64, nanos: u32| SystemTime::UNIX_EPOCH + Duration::new(secs, nanos);
        assert_eq!(parse_utc("1970-01-01T00:00:00Z"), Some(at(0, 0)));
        assert_eq!(parse_utc("2000-01-01T00:00:00Z"), Some(at(946_684_800, 0)));
        assert_eq!(parse_utc("2024-02-29T12:00:00.5Z"), Some(at(1_709_208_000, 500_000_000)));
        assert_eq!(parse_utc("2024-03-01T00:00:00.000000001Z"), Some(at(1_709_251_200, 1)));
        // Both forms seen in the file: 6 and 7 digits after the point.
        assert_eq!(parse_utc("2026-11-12T04:50:10.510896Z"), Some(at(1_794_459_010, 510_896_000)));
        assert_eq!(parse_utc("2026-11-12T04:50:10.7445582Z"), Some(at(1_794_459_010, 744_558_200)));
        for bad in ["", "yesterday", "2026-11-12", "2026-11-12T04:50:10", "2026-13-01T00:00:00Z", "2026-11-12T04:50:10.5x6Z", "2026-11-12T04:50:10+01:00"] {
            assert_eq!(parse_utc(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_time_far_out_of_range_is_not_a_time() {
        assert!(parse_utc("9999-12-31T23:59:59Z").is_some());
        for bad in ["10000-01-01T00:00:00Z", "999999999999-01-01T00:00:00Z", "1969-12-31T23:59:59Z"] {
            assert_eq!(parse_utc(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_codex_id_is_the_whole_tail_of_the_file_name_or_nothing() {
        let id = "01900000-0000-7000-8000-00000000c0de";
        assert_eq!(codex_id_of(&format!("rollout-2026-11-11T13-28-15-{id}")), Some(id));
        assert_eq!(codex_id_of(id), Some(id));
        assert_eq!(codex_id_of("too-short"), None);
        // A name with other characters, where the cut would fall inside one of them:
        // no id — and no crash (cutting text there used to be one).
        let odd = format!("é{}", "x".repeat(35));
        assert_eq!(odd.len(), 37);
        assert_eq!(codex_id_of(&odd), None);
    }

    #[test]
    fn groks_own_list_of_running_sessions_is_read() {
        let text = r#"[
          {"session_id":"01900000-0000-7000-8000-0000000000a1","pid":21792,"cwd":"C:/work","opened_at":"2026-11-12T04:50:10.510896Z"},
          {"session_id":"01900000-0000-7000-8000-0000000000a2","pid":16564,"cwd":"C:/work","opened_at":"not a time"},
          {"session_id":"../../elsewhere","pid":7,"cwd":"C:/work","opened_at":"2026-11-12T04:50:10Z"},
          {"pid":8}
        ]"#;
        let list = grok_active_from(text).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[&21792].0, "01900000-0000-7000-8000-0000000000a1");
        assert!(list[&21792].1.is_some());
        assert_eq!(list[&16564], ("01900000-0000-7000-8000-0000000000a2".to_string(), None));
        assert_eq!(grok_active_from("[]").map(|l| l.len()), Some(0));
        // Half-written, or something else altogether: not a list, so nothing is changed.
        assert!(grok_active_from(r#"[{"session_id":"01900000-0000"#).is_none());
        assert!(grok_active_from(r#"{"sessions":[]}"#).is_none());
    }

    #[test]
    fn what_grok_says_about_its_sessions_overrules_the_guess() {
        let t0 = SystemTime::UNIX_EPOCH + Duration::from_secs(1_794_459_000);
        let (x, y) = ("01900000-0000-7000-8000-0000000000b1", "01900000-0000-7000-8000-0000000000b2");
        let dir = |id: &str| Some(PathBuf::from("C:\\sessions\\work").join(id));
        // Tab A's Grok started first, tab B's a second later.
        let wants = vec![grok_tab("A", 100, t0), grok_tab("B", 200, t0 + Duration::from_secs(1))];
        let mut inner = Inner::default();
        // The guess: the earlier start made the earlier session — A on x, B on y.
        for (w, id) in wants.iter().zip([x, y]) {
            inner.bound.insert(w.tab.clone(), Bound { cli: "grok".into(), pid: w.pid, path: dir(id), event: w.started });
        }
        // The fact, from Grok: it was the other way round.
        inner.grok_active.insert(100, (y.to_string(), Some(t0 + Duration::from_secs(3))));
        inner.grok_active.insert(200, (x.to_string(), Some(t0 + Duration::from_secs(3))));
        bind_grok_facts(&mut inner, &wants, &dir);
        assert_eq!(inner.bound["A"].path, dir(y));
        assert_eq!(inner.bound["B"].path, dir(x));
        assert!(inner.by_fact.contains("A") && inner.by_fact.contains("B"));

        // Inside tab A's Grok another session is opened: the tab follows.
        let z = "01900000-0000-7000-8000-0000000000b3";
        inner.grok_active.insert(100, (z.to_string(), Some(t0 + Duration::from_secs(60))));
        bind_grok_facts(&mut inner, &wants, &dir);
        assert_eq!(inner.bound["A"].path, dir(z));
        assert_eq!(inner.bound["B"].path, dir(x));

        // A note older than the process (left by an earlier process with the same id)
        // is not about this process: the tab keeps what it had and is not "known".
        inner.grok_active.insert(200, (y.to_string(), Some(t0 - Duration::from_secs(3600))));
        bind_grok_facts(&mut inner, &wants, &dir);
        assert_eq!(inner.bound["B"].path, dir(x));
        assert!(inner.by_fact.contains("A") && !inner.by_fact.contains("B"));

        // A session whose folder cannot be found is not taken on.
        inner.grok_active.insert(200, (y.to_string(), Some(t0 + Duration::from_secs(90))));
        bind_grok_facts(&mut inner, &wants, &|_| None);
        assert_eq!(inner.bound["B"].path, dir(x));
        assert!(!inner.by_fact.contains("B"));
    }

    #[test]
    fn slow_folder_scans_are_done_less_often() {
        let s = Duration::from_secs;
        let ms = Duration::from_millis;
        assert_eq!(scan_gap(s(4), ms(10)), s(4)); // quick: as often as wanted
        assert_eq!(scan_gap(s(1), ms(10)), s(1)); // quick, just after Enter
        assert_eq!(scan_gap(s(4), ms(500)), s(10)); // half a second per look: every 10 s
        assert_eq!(scan_gap(s(1), ms(500)), s(10));
        assert_eq!(scan_gap(s(4), s(5)), s(30)); // never put off longer than that
    }

    #[test]
    fn only_something_that_looks_like_an_id_is_looked_up() {
        for bad in ["", "..", "..\\..\\x", "../../../etc", "a b c d e f g h", "abc", "C:\\Windows\\win.ini", "*", "noDigitsHereAtAll"] {
            for cli in ["claude", "codex", "grok"] {
                assert_eq!(locate(cli, bad), None, "{cli} {bad}");
            }
        }
        // Well-formed but unknown: not found, for every CLI.
        for cli in ["claude", "codex", "grok", "other"] {
            assert_eq!(locate(cli, "00000000-0000-4000-8000-000000000000"), None);
        }
    }

    #[test]
    fn an_id_that_was_not_found_is_not_searched_for_again_at_once() {
        let mut inner = Inner::default();
        let id = "00000000-0000-4000-8000-000000000001";
        assert_eq!(locate_remembering(&mut inner, "codex", id), None);
        let first = inner.missing[&("codex".to_string(), id.to_string())];
        assert_eq!(locate_remembering(&mut inner, "codex", id), None);
        // The second question was answered from memory: the note is the first one's.
        assert_eq!(inner.missing[&("codex".to_string(), id.to_string())], first);
    }
}
