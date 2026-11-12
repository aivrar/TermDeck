use std::path::PathBuf;

fn main() {
    // Put Microsoft's current console layer (conpty.dll + OpenConsole.exe) beside the
    // built exe. portable-pty picks it up from there in preference to the one built
    // into Windows.
    println!("cargo:rerun-if-changed=vendor/conpty");
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    if let Some(profile_dir) = out.ancestors().nth(3) {
        for name in ["conpty.dll", "OpenConsole.exe"] {
            let from = PathBuf::from("vendor/conpty").join(name);
            if from.is_file() {
                let _ = std::fs::copy(&from, profile_dir.join(name));
            }
        }
    }
    tauri_build::build()
}
