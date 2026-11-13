// Hotkeys must not interfere:
//  - keys meant for the program in the terminal must reach it unchanged, and must not
//    trigger anything in the app or in the browser engine underneath (reload, print, find...)
//  - the app's own shortcuts must do their job and must NOT leak into the program
// usage: node 06-hotkeys.mjs <data-dir>
import path from 'node:path';
import { launch, shot, send, text, waitText, sleep, check, summary, ROOT } from './harness.mjs';

const [dataDir] = process.argv.slice(2);
const app = await launch({ dataDir });
const { page } = app;

const keyLines = async () => (await text(page, 0, 400)).split('\n').filter((l) => l.startsWith('KEY '));
const appState = () =>
  page.evaluate(() => {
    const a = window.__termdeck.app;
    return {
      marker: window.__marker ?? null,
      tabs: a.tabs.length,
      font: a.state.fontSize,
      active: a.tabs.indexOf(a.activeTab),
      modal: document.getElementById('modal-root').childElementCount,
      library: a.state.libraryOpen,
      focusInTerminal: !!document.activeElement?.closest?.('.xterm'),
      searchFocused: document.activeElement?.closest?.('.lib-search') != null,
      history: document.querySelectorAll('.history').length,
    };
  });

try {
  await page.evaluate(() => { window.__marker = 'alive'; });
  // a second tab so tab-switching shortcuts have somewhere to go
  await page.evaluate(() => window.__termdeck.app.createTab({ shell: 'cmd', cwd: 'C:\\', cli: 'none' }));
  await page.evaluate(() => { const a = window.__termdeck.app; a.showTab(a.tabs[0]); a.tabs[0].focus(); });
  await waitText(page, 0, /PS .*>/);
  await send(page, 0, `powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(ROOT, 'tests', 'fixtures', 'keyecho.ps1')}"\r`);
  await waitText(page, 0, /KEYECHO READY/);
  await page.locator('.pane').first().locator('.pane-body').click();
  await sleep(300);

  // ---------- keys that belong to the program ----------
  // [key to press, expected ConsoleKey, expected modifiers]
  const passthrough = [
    ['Control+c', 'C', 'Control'], ['Control+r', 'R', 'Control'], ['Control+p', 'P', 'Control'],
    ['Control+f', 'F', 'Control'], ['Control+g', 'G', 'Control'], ['Control+j', 'J|Enter', 'Control'],
    ['Control+u', 'U', 'Control'], ['Control+n', 'N', 'Control'], ['Control+t', 'T', 'Control'],
    ['Control+w', 'W', 'Control'], ['Control+l', 'L', 'Control'], ['Control+d', 'D', 'Control'],
    ['Control+e', 'E', 'Control'], ['Control+k', 'K', 'Control'], ['Control+a', 'A', 'Control'],
    ['Control+z', 'Z', 'Control'], ['Control+b', 'B', 'Control'], ['Control+o', 'O', 'Control'],
    ['Control+y', 'Y', 'Control'],
    ['Control+h', 'H|Backspace', 'Control|0'],
    ['Escape', 'Escape', '0'], ['Tab', 'Tab', '0'], ['Shift+Tab', 'Tab', 'Shift'], ['Enter', 'Enter', '0'],
    ['Backspace', 'Backspace', '0'], ['Delete', 'Delete', '0'],
    ['ArrowUp', 'UpArrow', '0'], ['ArrowDown', 'DownArrow', '0'], ['ArrowLeft', 'LeftArrow', '0'], ['ArrowRight', 'RightArrow', '0'],
    ['Control+ArrowLeft', 'LeftArrow', 'Control'], ['Control+ArrowRight', 'RightArrow', 'Control'],
    ['Home', 'Home', '0'], ['End', 'End', '0'], ['PageUp', 'PageUp', '0'], ['PageDown', 'PageDown', '0'],
    ['F1', 'F1', '0'], ['F2', 'F2', '0'], ['F3', 'F3', '0'], ['F4', 'F4', '0'], ['F5', 'F5', '0'], ['F6', 'F6', '0'],
    ['F7', 'F7', '0'], ['F8', 'F8', '0'], ['F9', 'F9', '0'], ['F10', 'F10', '0'], ['F11', 'F11', '0'], ['F12', 'F12', '0'],
    ['Alt+b', 'B', 'Alt'], ['Alt+f', 'F', 'Alt'], ['Alt+v', 'V', 'Alt'], ['Alt+Enter', 'Enter', 'Alt'],
    ['Control+Shift+Minus', 'OemMinus|Oem', 'Shift, Control'],
  ];
  const before = await appState();
  const failures = [];
  for (const [press, key, mods] of passthrough) {
    const n = (await keyLines()).length;
    await page.keyboard.press(press);
    let got = null;
    for (let k = 0; k < 25 && !got; k++) {
      await sleep(40);
      const lines = await keyLines();
      if (lines.length > n) got = lines.slice(n).join(' + ');
    }
    const s = await appState();
    const keyOk = got && new RegExp(`key=(${key})\\b`).test(got) && new RegExp(`mods=(${mods.replace(/\|/g, '|')})`).test(got.replace(/mods=(?=\s|$)/, 'mods=0'));
    const appOk = s.marker === 'alive' && s.tabs === before.tabs && s.font === before.font && s.modal === 0 && s.active === before.active && s.history === 0;
    if (!keyOk || !appOk) failures.push(`${press}: program saw [${got ?? 'nothing'}]${appOk ? '' : `; APP CHANGED ${JSON.stringify(s)}`}`);
    if (s.modal) await page.keyboard.press('Escape');
  }
  check(`${passthrough.length} program keys reach the program and leave the app alone`, failures.length === 0, failures.join('\n      '));

  // ---------- the app's own shortcuts ----------
  const appKey = async (press, label, verify, cleanup) => {
    const n = (await keyLines()).length;
    await page.keyboard.press(press);
    await sleep(350);
    const s = await appState();
    const leaked = (await keyLines()).slice(n);
    check(`${label} (${press}) works`, verify(s), JSON.stringify(s));
    check(`${label} (${press}) does not leak into the program`, leaked.length === 0, leaked.join(' + '));
    if (cleanup) await cleanup();
    await sleep(200);
  };
  const base = before.font;
  await appKey('Control+Equal', 'zoom in', (s) => s.font === base + 1);
  await appKey('Control+Minus', 'zoom out', (s) => s.font === base);
  await appKey('Control+Minus', 'zoom out again', (s) => s.font === base - 1);
  await appKey('Control+0', 'zoom reset', (s) => s.font === 14);
  await appKey('Control+Tab', 'next tab', (s) => s.active === 1);
  await appKey('Control+Shift+Tab', 'previous tab', (s) => s.active === 0);
  await appKey('Control+Alt+2', 'go to tab 2', (s) => s.active === 1);
  await appKey('Control+Alt+1', 'go to tab 1', (s) => s.active === 0);
  await appKey('Control+Shift+P', 'snippet search', (s) => s.searchFocused, async () => {
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__termdeck.app.tabs[0].focus());
  });
  await appKey('Control+Shift+T', 'new session dialog', (s) => s.modal === 1, async () => {
    await page.keyboard.press('Escape');
  });
  let s = await appState();
  check('closing the dialog returns focus to the terminal', s.modal === 0 && s.focusInTerminal, JSON.stringify(s));

  // ---------- keys checked byte-for-byte with a raw-mode reader ----------
  // (This is how the AI CLIs read the keyboard. PowerShell's own key reader, used
  // above, hides a few of these: Ctrl+S pauses its output, for instance.)
  await page.keyboard.press('q');
  await waitText(page, 0, /^KEYECHO DONE$[\s\S]*PS .*>/m, 20000, 400);
  await send(page, 0, `node -e "process.stdin.setRawMode(true);process.stdin.resume();console.log('RAW'+'-UP');process.stdin.on('data',d=>{console.log('RAW '+[...d].map(b=>b.toString(16).padStart(2,'0')).join(' '));if(d[0]===0x51){console.log('RAW'+'-DOWN');process.exit(0)}})"\r`);
  await waitText(page, 0, /^RAW-UP$/m, 20000, 400);
  await sleep(300);
  const rawLines = async () => (await text(page, 0, 400)).split('\n').filter((l) => /^RAW [0-9a-f]{2}\b/.test(l));
  const raw = [
    ['Control+s', '13'], ['Control+x', '18'], ['Control+q', '11'], ['Control+r', '12'], ['Control+p', '10'],
    ['Alt+ArrowLeft', '1b 5b 31 3b 33 44'], ['Alt+ArrowRight', '1b 5b 31 3b 33 43'],
    ['Control+ArrowLeft', '1b 5b 31 3b 35 44'], ['Alt+Backspace', '1b 7f'], ['Control+Backspace', '08'],
    ['Escape', '1b'], ['Shift+Tab', '1b 5b 5a'], ['F5', '1b 5b 31 35 7e'], ['Alt+v', '1b 76'],
  ];
  const rawFailures = [];
  for (const [press, bytes] of raw) {
    const n0 = (await rawLines()).length;
    await page.keyboard.press(press);
    let got = '';
    for (let k = 0; k < 25 && !got; k++) {
      await sleep(40);
      got = (await rawLines()).slice(n0).map((l) => l.slice(4)).join(' ');
    }
    if (got !== bytes) rawFailures.push(`${press}: expected [${bytes}] got [${got || 'nothing'}]`);
  }
  check(`${raw.length} keys arrive byte-exact in a raw-mode program`, rawFailures.length === 0, rawFailures.join('\n      '));
  const sRaw = await appState();
  check('none of them changed the app', sRaw.marker === 'alive' && sRaw.tabs === before.tabs && sRaw.font === 14 && sRaw.modal === 0);
  await page.keyboard.type('Q');
  await waitText(page, 0, /^RAW-DOWN$[\s\S]*PS .*>/m, 20000, 400);
  await send(page, 0, `powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(ROOT, 'tests', 'fixtures', 'keyecho.ps1')}"\r`);
  await waitText(page, 0, /^RAW-DOWN$[\s\S]*^KEYECHO READY$/m, 20000, 400);
  await sleep(300);

  // Typing still lands in the program after all that.
  const n = (await keyLines()).length;
  await page.keyboard.type('zx');
  await sleep(400);
  const typed = (await keyLines()).slice(n).join(' ');
  check('plain typing still reaches the program', /key=Z/.test(typed) && /key=X/.test(typed), typed);

  // Copy vs interrupt: Ctrl+C copies only when text is selected, otherwise it is the program's.
  await page.evaluate(() => window.__termdeck.app.tabs[0].term.selectAll());
  const n2 = (await keyLines()).length;
  await page.keyboard.press('Control+c');
  await sleep(300);
  check('Ctrl+C with a selection copies instead of interrupting', (await keyLines()).length === n2);
  const copied = await page.evaluate(() => window.__TAURI__.core.invoke('clipboard_read'));
  check('the selection is on the clipboard', copied.kind === 'text' && /KEYECHO READY/.test(copied.text ?? ''));
  await page.keyboard.press('Control+c');
  await sleep(300);
  check('Ctrl+C with no selection goes to the program', (await keyLines()).length === n2 + 1);

  await shot(page, '06-hotkeys');
  await page.keyboard.press('q');
  s = await appState();
  check('window was never reloaded', s.marker === 'alive' && s.tabs === before.tabs);
  check('no page errors', app.errors.length === 0, app.errors.slice(0, 3).join(' | '));
} finally {
  await app.close();
}
process.exit(summary() ? 1 : 0);
