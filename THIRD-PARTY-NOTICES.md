# Third-party notices

TermDeck includes or is built from the following third-party material.

## Included files

| What | Where | Licence |
|---|---|---|
| Cascadia Mono NF (regular and italic), © Microsoft Corporation | `src/fonts/` (built into the exe) | SIL Open Font License 1.1 — [`src/fonts/LICENSE-CascadiaCode.txt`](src/fonts/LICENSE-CascadiaCode.txt) |
| `conpty.dll`, `OpenConsole.exe` from the NuGet package `Microsoft.Windows.Console.ConPTY` 1.25.261109001 (Windows Terminal project), © Microsoft Corporation | `src-tauri/vendor/conpty/`, shipped beside `TermDeck.exe` | MIT — [`src-tauri/vendor/conpty/LICENSE.txt`](src-tauri/vendor/conpty/LICENSE.txt) |

## Libraries compiled into the app

Main direct dependencies (each brings its own dependencies, listed in `package-lock.json` and
`src-tauri/Cargo.lock` with their licences):

| Library | Licence |
|---|---|
| [Tauri](https://tauri.app) 2, `tauri-plugin-dialog` | MIT or Apache-2.0 |
| [xterm.js](https://xtermjs.org) and its addons (fit, search, unicode11, web-links, webgl) | MIT |
| [portable-pty](https://github.com/wezterm/wezterm/tree/main/pty) | MIT |
| [arboard](https://github.com/1Password/arboard) | MIT or Apache-2.0 |
| [serde](https://serde.rs), serde_json | MIT or Apache-2.0 |
| [windows-sys](https://github.com/microsoft/windows-rs) | MIT or Apache-2.0 |
| png, base64 | MIT or Apache-2.0 |

The app runs on Microsoft Edge WebView2, which is part of Windows and is not included.

## Trademarks

Claude Code is a product of Anthropic, Codex of OpenAI, and Grok of xAI. TermDeck is an
independent project, not affiliated with or endorsed by any of them. It hosts those
command-line programs as they are installed on your computer; it does not include them.
