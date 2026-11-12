#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod clip;
mod picker;
mod pty;
mod sessions;
mod shells;
mod single;
mod status;
mod store;
mod transcript;
mod updates;
mod usage;

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// Window placement, kept beside the exe so the app stays portable.
#[derive(Serialize, Deserialize, Clone, Copy, Default)]
struct Geometry {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    maximized: bool,
}

struct GeometryState(Mutex<Option<Geometry>>);

fn load_geometry() -> Option<Geometry> {
    let text = std::fs::read_to_string(store::data_dir().join("window.json")).ok()?;
    serde_json::from_str(&text).ok()
}

fn save_geometry(g: &Geometry) {
    if let Ok(text) = serde_json::to_string(g) {
        let _ = std::fs::write(store::data_dir().join("window.json"), text);
    }
}

/// Flashes the taskbar button until the window is brought to the front (stops by itself
/// then). Does nothing while the window already has the keyboard.
#[tauri::command]
fn attention(window: tauri::WebviewWindow, on: bool) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        FlashWindowEx, FLASHWINFO, FLASHW_STOP, FLASHW_TIMERNOFG, FLASHW_TRAY,
    };
    let Ok(hwnd) = window.hwnd() else { return };
    let info = FLASHWINFO {
        cbSize: std::mem::size_of::<FLASHWINFO>() as u32,
        hwnd: hwnd.0 as _,
        dwFlags: if on { FLASHW_TRAY | FLASHW_TIMERNOFG } else { FLASHW_STOP },
        uCount: 0,
        dwTimeout: 0,
    };
    unsafe {
        FlashWindowEx(&info);
    }
}

fn main() {
    // Windows lets a process be started with "ignore Ctrl+C" set, and every program
    // it starts inherits that. If this app were launched that way (some launchers
    // and scripts do it), Ctrl+C would silently stop interrupting commands in every
    // tab. Clear the flag so the shells always start with normal Ctrl+C handling.
    unsafe {
        windows_sys::Win32::System::Console::SetConsoleCtrlHandler(None, 0);
    }
    // One copy per data folder: a second start brings the first to the front and ends.
    let Some(guard) = single::acquire() else { return };
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::PtyManager::default())
        .manage(sessions::SessionCache::default())
        .manage(usage::UsageCache::default())
        .manage(GeometryState(Mutex::new(None)))
        .setup(move |app| {
            let data = store::data_dir();
            let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("TermDeck")
                .inner_size(1500.0, 780.0)
                .min_inner_size(520.0, 300.0)
                .visible(false)
                .data_directory(data.join("webview"));
            // Test hook: only when TERMDECK_DEBUG_PORT is set does the window accept an
            // automation connection (used by the Playwright tests). Off otherwise.
            if let Some(port) = std::env::var("TERMDECK_DEBUG_PORT").ok().and_then(|p| p.parse::<u16>().ok()) {
                builder = builder.additional_browser_args(&format!(
                    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port}"
                ));
            }
            let win = builder.build()?;

            if let Some(g) = load_geometry() {
                // Only restore a position that still lands on a connected monitor.
                let on_screen = win
                    .available_monitors()
                    .map(|ms| {
                        ms.iter().any(|m| {
                            let p = m.position();
                            let s = m.size();
                            g.x + 80 > p.x
                                && g.x < p.x + s.width as i32 - 80
                                && g.y + 20 > p.y
                                && g.y < p.y + s.height as i32 - 80
                        })
                    })
                    .unwrap_or(false);
                if g.w >= 400 && g.h >= 250 {
                    let _ = win.set_size(PhysicalSize::new(g.w, g.h));
                }
                if on_screen {
                    let _ = win.set_position(PhysicalPosition::new(g.x, g.y));
                }
                if g.maximized {
                    let _ = win.maximize();
                }
                *app.state::<GeometryState>().0.lock().unwrap() = Some(g);
            }
            // Test hook: TERMDECK_NO_FOCUS shows the window without taking the keyboard,
            // so a test run does not steal what is being typed into another program.
            if std::env::var_os("TERMDECK_NO_FOCUS").is_some() {
                if let Ok(hwnd) = win.hwnd() {
                    unsafe {
                        windows_sys::Win32::UI::WindowsAndMessaging::ShowWindow(
                            hwnd.0 as _,
                            windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNOACTIVATE,
                        );
                    }
                }
            } else {
                let _ = win.show();
                let _ = win.set_focus();
            }
            // Keep the window answering while a tab hammers the machine: the app and
            // the processes that draw it run one step above normal priority. The
            // drawing processes appear a moment after start, hence the delay.
            let front = win.clone();
            guard.on_second_start(move || {
                // (The tests run with TERMDECK_NO_FOCUS and must not take the keyboard.)
                if std::env::var_os("TERMDECK_NO_FOCUS").is_none() {
                    let _ = front.unminimize();
                    let _ = front.show();
                    let _ = front.set_focus();
                }
                let _ = tauri::Emitter::emit(&front, "second-start", ());
            });
            app.manage(guard);
            usage::raise_own_priority(&[]);
            std::thread::spawn(|| {
                for wait in [3, 12] {
                    std::thread::sleep(std::time::Duration::from_secs(wait));
                    usage::raise_own_priority(&status::window_helpers());
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                if window.is_minimized().unwrap_or(false) {
                    return;
                }
                let maximized = window.is_maximized().unwrap_or(false);
                let state = window.state::<GeometryState>();
                let mut guard = state.0.lock().unwrap();
                let mut g = guard.unwrap_or_default();
                g.maximized = maximized;
                if !maximized {
                    if let (Ok(p), Ok(s)) = (window.outer_position(), window.inner_size()) {
                        if s.width > 0 && s.height > 0 {
                            g.x = p.x;
                            g.y = p.y;
                            g.w = s.width;
                            g.h = s.height;
                        }
                    }
                }
                *guard = Some(g);
            }
            WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed => {
                if let Some(g) = *window.state::<GeometryState>().0.lock().unwrap() {
                    save_geometry(&g);
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_ack,
            pty::pty_close,
            pty::pty_kill_all,
        pty::pty_kill_tree,
        pty::proc_kill,
        pty::tab_priority,
        pty::pty_kill_children,
        pty::pty_cli_note,
        pty::pty_cli_end,
        updates::cli_versions,
        updates::cli_update,
        updates::cli_processes,
            status::poll_status,
            sessions::session_exists,
            picker::sessions_list,
            attention,
            store::store_load,
            store::store_save,
            store::store_keep,
            store::data_dir_path,
            clip::clipboard_read,
            clip::clipboard_write,
            shells::env_info,
            shells::dir_exists,
            shells::open_external,
            transcript::transcript_load,
        ])
        .build(tauri::generate_context!())
        .expect("error while running TermDeck")
        .run(|app, event| {
            // Safety net. The window closes its tabs itself before it goes (after asking);
            // this covers every other way out, so that leaving the app never leaves
            // programs running that nothing shows any more. Does nothing if all is closed.
            if let tauri::RunEvent::Exit = event {
                app.state::<pty::PtyManager>().close_all(pty::CLOSE_GRACE);
            }
        });
}
