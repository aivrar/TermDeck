//! Clipboard access. An image on the clipboard is saved as a PNG beside the app and
//! its path is returned, because the CLIs take images as file paths.

use serde::Serialize;
use std::fs::File;
use std::io::BufWriter;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipData {
    /// "files" | "text" | "image" | "empty"
    kind: String,
    text: Option<String>,
    paths: Vec<String>,
}

fn save_png(width: usize, height: usize, rgba: &[u8]) -> Result<String, String> {
    let dir = crate::store::data_dir().join("pastes");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let path = dir.join(format!("paste-{ms}.png"));
    let file = File::create(&path).map_err(|e| e.to_string())?;
    let mut enc = png::Encoder::new(BufWriter::new(file), width as u32, height as u32);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    let mut writer = enc.write_header().map_err(|e| e.to_string())?;
    writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    writer.finish().map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command(async)]
pub fn clipboard_read() -> Result<ClipData, String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;

    // Files copied in Explorer.
    if let Ok(files) = cb.get().file_list() {
        if !files.is_empty() {
            return Ok(ClipData {
                kind: "files".into(),
                text: None,
                paths: files.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
            });
        }
    }
    // Text wins over an image: spreadsheets and documents put both on the clipboard.
    if let Ok(text) = cb.get_text() {
        if !text.is_empty() {
            return Ok(ClipData { kind: "text".into(), text: Some(text), paths: vec![] });
        }
    }
    if let Ok(img) = cb.get_image() {
        if img.width > 0 && img.height > 0 {
            let path = save_png(img.width, img.height, &img.bytes)?;
            return Ok(ClipData { kind: "image".into(), text: None, paths: vec![path] });
        }
    }
    Ok(ClipData { kind: "empty".into(), text: None, paths: vec![] })
}

#[tauri::command(async)]
pub fn clipboard_write(text: String) -> Result<(), String> {
    arboard::Clipboard::new()
        .and_then(|mut cb| cb.set_text(text))
        .map_err(|e| e.to_string())
}
