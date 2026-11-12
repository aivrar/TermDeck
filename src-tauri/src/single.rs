//! One running copy per data folder.
//!
//! Two copies sharing a data folder would both restore the same tabs and could both
//! resume the same conversations, and would overwrite each other's saved state. So a
//! second start does not open another window: it brings the first one to the front
//! and ends. Copies with *different* data folders (another portable folder, or the
//! tests) do not affect each other.

use std::ffi::c_void;
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE};
use windows_sys::Win32::System::Threading::{
    CreateEventW, CreateMutexW, OpenEventW, SetEvent, WaitForSingleObject, EVENT_MODIFY_STATE, INFINITE,
};

/// Held for the life of the app; dropping it lets another copy start.
pub struct Guard {
    mutex: HANDLE,
    event: HANDLE,
}
// Plain kernel handles, usable from any thread.
unsafe impl Send for Guard {}
unsafe impl Sync for Guard {}

impl Drop for Guard {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.event);
            CloseHandle(self.mutex);
        }
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn names() -> (Vec<u16>, Vec<u16>) {
    // FNV-1a of the data folder path: a short, stable name for "this data folder".
    // The path is first resolved to where the folder really is, so the same folder
    // reached another way (a `subst` drive letter, a link, a different spelling)
    // still counts as the same folder.
    let dir = crate::store::data_dir();
    let path = std::fs::canonicalize(&dir).unwrap_or(dir).to_string_lossy().to_lowercase();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in path.bytes() {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    (wide(&format!("Local\\TermDeck-{hash:016x}")), wide(&format!("Local\\TermDeck-{hash:016x}-show")))
}

/// Some(guard) for the first copy. None for a later one, which has by then asked the
/// first to show itself.
pub fn acquire() -> Option<Guard> {
    let (mutex_name, event_name) = names();
    unsafe {
        let mutex = CreateMutexW(std::ptr::null(), 1, mutex_name.as_ptr());
        let already = GetLastError() == ERROR_ALREADY_EXISTS;
        if mutex.is_null() || already {
            // The first copy makes its "come forward" signal a moment after it takes
            // the name. Two starts in the same instant could find the name taken but
            // no signal yet — so look for it a few times before giving up.
            for attempt in 0..20 {
                let event = OpenEventW(EVENT_MODIFY_STATE, 0, event_name.as_ptr());
                if !event.is_null() {
                    SetEvent(event);
                    CloseHandle(event);
                    break;
                }
                if attempt < 19 {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
            }
            if !mutex.is_null() {
                CloseHandle(mutex);
            }
            return None;
        }
        let event = CreateEventW(std::ptr::null(), 0, 0, event_name.as_ptr());
        Some(Guard { mutex, event })
    }
}

impl Guard {
    /// Calls `show` each time another copy is started.
    pub fn on_second_start(&self, show: impl Fn() + Send + 'static) {
        let event = self.event as usize;
        std::thread::spawn(move || loop {
            let handle = event as *mut c_void;
            if unsafe { WaitForSingleObject(handle, INFINITE) } != 0 {
                break; // the handle was closed: the app is ending
            }
            show();
        });
    }
}
