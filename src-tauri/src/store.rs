//! Portable storage: everything lives in a `data` folder beside the executable.

use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

fn writable(dir: &PathBuf) -> bool {
    let probe = dir.join(".write-test");
    let ok = fs::write(&probe, b"ok").is_ok();
    let _ = fs::remove_file(&probe);
    ok
}

pub fn data_dir() -> PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        if let Ok(p) = std::env::var("TERMDECK_DATA_DIR") {
            if !p.trim().is_empty() {
                let p = PathBuf::from(p);
                let _ = fs::create_dir_all(&p);
                return p;
            }
        }
        if let Some(beside) = std::env::current_exe()
            .ok()
            .and_then(|e| e.parent().map(|d| d.join("data")))
        {
            if fs::create_dir_all(&beside).is_ok() && writable(&beside) {
                return beside;
            }
        }
        // Read-only location (e.g. Program Files): fall back to the user profile.
        let fallback = PathBuf::from(std::env::var("APPDATA").unwrap_or_else(|_| ".".into()))
            .join("TermDeck");
        let _ = fs::create_dir_all(&fallback);
        fallback
    })
    .clone()
}

fn file_for(name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("invalid store name: {name}"));
    }
    Ok(data_dir().join(format!("{name}.json")))
}

#[tauri::command]
pub fn store_load(name: String) -> Result<Option<serde_json::Value>, String> {
    let path = file_for(&name)?;
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

#[tauri::command]
pub fn store_save(name: String, value: serde_json::Value) -> Result<(), String> {
    use std::io::Write;
    let path = file_for(&name)?;
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    let written = fs::File::create(&tmp).and_then(|mut f| {
        f.write_all(text.as_bytes())?;
        // On disk before it takes the real file's place, so a power cut cannot leave
        // the real name pointing at an empty file.
        f.sync_all()
    });
    written.map_err(|e| format!("{}: {e}", tmp.display()))?;
    // Write-then-rename so a crash never leaves a half-written file.
    fs::rename(&tmp, &path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Keeps a copy of a store file that could not be read, before anything is saved over
/// it: `<name>.unreadable-<date>-<time>.json` in the same folder. Returns the copy's
/// file name. The window only saves over an unreadable file once this has succeeded.
#[tauri::command]
pub fn store_keep(name: String) -> Result<String, String> {
    let path = file_for(&name)?;
    let now = unsafe {
        let mut t: windows_sys::Win32::Foundation::SYSTEMTIME = std::mem::zeroed();
        windows_sys::Win32::System::SystemInformation::GetLocalTime(&mut t);
        format!("{:04}{:02}{:02}-{:02}{:02}{:02}", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond)
    };
    let mut copy = data_dir().join(format!("{name}.unreadable-{now}.json"));
    let mut n = 1;
    while copy.exists() {
        n += 1;
        copy = data_dir().join(format!("{name}.unreadable-{now}-{n}.json"));
    }
    let bytes = fs::copy(&path, &copy).map_err(|e| format!("{}: {e}", path.display()))?;
    let same = fs::metadata(&path).map(|m| m.len() == bytes).unwrap_or(false);
    if !same {
        let _ = fs::remove_file(&copy);
        return Err(format!("{}: the copy came out incomplete", path.display()));
    }
    Ok(copy.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default())
}

#[tauri::command]
pub fn data_dir_path() -> String {
    data_dir().to_string_lossy().into_owned()
}
