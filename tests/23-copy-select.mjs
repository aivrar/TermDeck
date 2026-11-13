// Copying with the mouse, on the real app window and a real PowerShell tab:
//   - highlighting copies (a real mouse drag), and the text stays highlighted
//   - a plain click does not touch the clipboard
//   - right-click puts the highlighted text into the input, without pressing Enter
//   - right-click with nothing highlighted pastes the clipboard
//   - a program can put text on the clipboard with OSC 52; it cannot read it ("?")
//   - while a program takes the mouse (as Claude Code full-screen does): a drag still
//     highlights, a plain click still reaches the program, the right button stays the app's
// usage: node 23-copy-select.mjs <data-dir> <work-dir>
// Uses the Windows clipboard and puts back the text that was on it.
import { launch, shot, screen, send, sleep, check, summary, waitText } from './harness.mjs';
import { clipboardText, clipboardGetText } from './clis.mjs';

const [dataDir, workDir] = process.argv.slice(2);
const savedClipboard = clipboardGetText();

async function until(fn, timeout = 8000, step = 250) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) return false;
    await sleep(step);
  }
}
const clip = () => clipboardGetText().replace(/\r?\n$/, '');

const app = await launch({ dataDir });
const { page } = app;
const ev = (fn, arg) => page.evaluate(fn, arg);

/** Page position of the middle of cell (col, row) on screen in tab i. */
const cellAt = (i, col, row) =>
  ev(([i, col, row]) => {
    const t = window.__termdeck.app.tabs[i];
    const r = t.el.querySelector('.xterm-screen').getBoundingClientRect();
    const w = r.width / t.term.cols;
    const h = r.height / t.term.rows;
    return { x: r.left + (col + 0.5) * w, y: r.top + (row + 0.5) * h, w, h };
  }, [i, col, row]);

/** Screen row whose text is exactly `s` (trimmed), or -1. */
async function rowOf(i, s) {
  const rows = (await screen(page, i)).split('\n');
  return rows.findIndex((r) => r.trim() === s);
}

async function drag(i, row, fromCol, toCol, mods = []) {
  const a = await cellAt(i, fromCol, row);
  const b = await cellAt(i, toCol, row);
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.move(a.x - a.w * 0.4, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, a.y, { steps: 4 });
  await page.mouse.move(b.x + b.w * 0.45, b.y, { steps: 4 });
  await page.mouse.up();
  for (const m of mods) await page.keyboard.up(m);
}

/** The last non-empty row on screen: the prompt line with whatever is typed on it. */
const inputLine = async (i) => (await screen(page, i)).split('\n').filter((r) => r.trim()).pop() ?? '';

try {
  await ev(() => window.__termdeck.app.toggleLibrary(false));
  await ev(() => window.__termdeck.app.setSplit(1));
  const i = await ev(async (cwd) => {
    const a = window.__termdeck.app;
    await a.createTab({ shell: 'powershell', cwd, cli: 'none' });
    return a.tabs.length - 1;
  }, workDir);
  await waitText(page, i, /PS .*>/, 20000);
  await ev((i) => window.__termdeck.app.tabs[i].term.focus(), i);

  // What the tab sends to its program, to check the right button never reaches it.
  await ev((i) => {
    const t = window.__termdeck.app.tabs[i];
    window.__sent = [];
    t.term.onData((d) => window.__sent.push(d));
    t.term.onBinary((d) => window.__sent.push(d));
  }, i);

  const MARK = 'MARKER-COPY-7731';
  await send(page, i, "Write-Output ('MARKER-' + 'COPY-7731')\r");
  await waitText(page, i, new RegExp(`^${MARK}\\s*$`, 'm'));
  await sleep(400);
  const row = await rowOf(i, MARK);
  check('the marker is on screen', row >= 0, `row ${row}`);

  // 1. Highlighting copies.
  clipboardText('BEFORE-DRAG');
  await drag(i, row, 0, MARK.length - 1);
  const copied = await until(() => clip() === MARK && MARK);
  check('highlighting copies to the clipboard', copied === MARK, `clipboard: ${JSON.stringify(clip())}`);
  check('the text stays highlighted', await ev((i) => window.__termdeck.app.tabs[i].term.getSelection().trim(), i) === MARK);
  await shot(page, '23-a-highlighted');

  // 2. Right-click on it puts it in the input, not run.
  const before = (await screen(page, i)).split('\n').filter((r) => r.trim() === MARK).length;
  const at = await cellAt(i, 4, row);
  await page.mouse.click(at.x, at.y, { button: 'right' });
  const typed = await until(async () => new RegExp(`PS .*>.*${MARK}`).test(await inputLine(i)));
  check('right-click puts the highlighted text into the input', typed, await inputLine(i));
  await sleep(800);
  const after = (await screen(page, i)).split('\n').filter((r) => r.trim() === MARK).length;
  check('it is not run (no Enter)', after === before && new RegExp(`PS .*>.*${MARK}`).test(await inputLine(i)), `${before} -> ${after} output lines; input: ${await inputLine(i)}`);
  check('the highlight is gone after inserting', !(await ev((i) => window.__termdeck.app.tabs[i].term.hasSelection(), i)));
  check('the right button did not reach the program as a mouse report', !(await ev(() => window.__sent.some((d) => d.includes('\x1b[M') || d.includes('\x1b[<')))));
  await shot(page, '23-b-inserted');
  await send(page, i, '\x1b'); // clear the input line
  await until(async () => !(await inputLine(i)).includes(MARK));

  // 3. A plain click does not change the clipboard.
  clipboardText('KEEP-AFTER-CLICK');
  await page.mouse.click(at.x, at.y);
  await sleep(700);
  check('a plain click leaves the clipboard alone', clip() === 'KEEP-AFTER-CLICK', JSON.stringify(clip()));

  // 4. Right-click with nothing highlighted pastes the clipboard.
  clipboardText('PASTE-WHEN-NONE-4410');
  await ev((i) => window.__termdeck.app.tabs[i].term.clearSelection(), i);
  await page.mouse.click(at.x, at.y, { button: 'right' });
  check('right-click with nothing highlighted pastes', await until(async () => /PASTE-WHEN-NONE-4410/.test(await inputLine(i))), await inputLine(i));
  await sleep(600);
  check('the paste is not run either', /PS .*>.*PASTE-WHEN-NONE-4410/.test(await inputLine(i)), await inputLine(i));
  await send(page, i, '\x1b');
  await until(async () => !(await inputLine(i)).includes('PASTE-WHEN-NONE'));

  // 5. OSC 52 from a real program, through the console layer.
  clipboardText('BEFORE-OSC');
  await send(page, i, "[Console]::Write([char]27 + ']52;c;' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('OSC-' + 'COPY-8822')) + [char]7); 'osc-sent'\r");
  await waitText(page, i, /^osc-sent\s*$/m);
  check('a program can copy with OSC 52', await until(() => clip() === 'OSC-COPY-8822'), JSON.stringify(clip()));

  // Non-ASCII text through OSC 52, and a read request, straight into the terminal.
  clipboardText('BEFORE-UTF8');
  await ev((i) => {
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode('naïve → 日本 ✓')));
    window.__termdeck.app.tabs[i].term.write(`\x1b]52;c;${b64}\x07`);
  }, i);
  await sleep(800);
  const got = await ev(() => window.__TAURI__.core.invoke('clipboard_read'));
  check('OSC 52 text arrives as UTF-8', got?.text === 'naïve → 日本 ✓', JSON.stringify(got?.text));
  clipboardText('NOT-FOR-READING');
  const sentBefore = await ev(() => window.__sent.length);
  await ev((i) => window.__termdeck.app.tabs[i].term.write('\x1b]52;c;?\x07'), i);
  await sleep(800);
  const reply = await ev((n) => window.__sent.slice(n).join(''), sentBefore);
  check('a program cannot read the clipboard with OSC 52', clip() === 'NOT-FOR-READING' && !reply.includes(']52'), `clipboard ${JSON.stringify(clip())}, reply ${JSON.stringify(reply)}`);

  // 6. A program that takes the mouse (as a full-screen CLI does).
  await send(page, i, 'Clear-Host\r');
  await sleep(600);
  await send(page, i, "Write-Output ('TRACK-' + 'MARK-5150')\r");
  await waitText(page, i, /^TRACK-MARK-5150\s*$/m);
  await sleep(400);
  const trow = await rowOf(i, 'TRACK-MARK-5150');
  await ev((i) => window.__termdeck.app.tabs[i].term.write('\x1b[?1000h\x1b[?1002h\x1b[?1006h'), i);
  await sleep(200);
  check('the program now has the mouse', (await ev((i) => window.__termdeck.app.tabs[i].term.modes.mouseTrackingMode, i)) !== 'none');
  const sentMark = await ev(() => window.__sent.length);

  clipboardText('BEFORE-PLAIN-DRAG');
  await drag(i, trow, 0, 14);
  check('a "Copied" tag shows by the mouse', await until(() => ev(() => document.querySelector('.mouse-tip')?.textContent === 'Copied'), 1000, 30));
  check('a plain drag still highlights and copies', await until(() => clip() === 'TRACK-MARK-5150'), JSON.stringify(clip()));
  const plain = await ev((n) => window.__sent.slice(n).join(''), sentMark);
  check('…and the program does not get the drag', !/\x1b\[<(0|32);/.test(plain), JSON.stringify(plain.slice(0, 60)));
  await sleep(1300);
  check('…and goes away by itself', !(await ev(() => !!document.querySelector('.mouse-tip'))));

  // Moving the mouse afterwards (the program asked for every move) keeps the highlight.
  const sentMoves = await ev(() => window.__sent.length);
  const m0 = await cellAt(i, 30, trow + 3);
  await page.mouse.move(m0.x, m0.y, { steps: 6 });
  await page.mouse.move(m0.x + 200, m0.y + 60, { steps: 6 });
  await sleep(300);
  check('moving the mouse afterwards keeps the highlight', await ev((i) => window.__termdeck.app.tabs[i].term.hasSelection(), i));
  check('…(those moves are not passed to the program while something is highlighted)', (await ev((n) => window.__sent.slice(n).join(''), sentMoves)) === '');

  // The program redraws under the highlight: right-click still inserts what was copied.
  await ev(([i, row]) => window.__termdeck.app.tabs[i].term.write(`\x1b7\x1b[${row + 1};1HREDRAWN-OVER-IT\x1b8`), [i, trow]);
  await sleep(300);
  clipboardText('SOMETHING-ELSE');
  const sentRedraw = await ev(() => window.__sent.length);
  await page.mouse.click(m0.x, m0.y, { button: 'right' });
  await sleep(700);
  const afterRedraw = await ev((n) => window.__sent.slice(n).join(''), sentRedraw);
  check('right-click inserts what was copied, even after the screen under it changed', afterRedraw.includes('TRACK-MARK-5150') && !afterRedraw.includes('REDRAWN') && !afterRedraw.includes('SOMETHING-ELSE'), JSON.stringify(afterRedraw.slice(0, 80)));
  await send(page, i, '\x1b');
  await ev(([i, row]) => window.__termdeck.app.tabs[i].term.write(`\x1b7\x1b[${row + 1};1HTRACK-MARK-5150\x1b8`), [i, trow]);
  await sleep(200);

  // A plain click (no drag) still reaches the program, press and release.
  const sentClick = await ev(() => window.__sent.length);
  const c6 = await cellAt(i, 20, trow + 2);
  await page.mouse.click(c6.x, c6.y);
  await sleep(500);
  const click = await ev((n) => window.__sent.slice(n).join(''), sentClick);
  check('a plain click still reaches the program', /\x1b\[<0;21;\d+M/.test(click) && /\x1b\[<0;21;\d+m/.test(click), JSON.stringify(click));
  check('…and clears the highlight', !(await ev((i) => window.__termdeck.app.tabs[i].term.hasSelection(), i)));

  clipboardText('BEFORE-SHIFT-DRAG');
  await drag(i, trow, 0, 14, ['Shift']);
  check('Shift+drag highlights and copies', await until(() => clip() === 'TRACK-MARK-5150'), JSON.stringify(clip()));

  const sentRight = await ev(() => window.__sent.length);
  const t6 = await cellAt(i, 3, trow);
  await page.mouse.click(t6.x, t6.y, { button: 'right' });
  await sleep(700);
  const rightData = await ev((n) => window.__sent.slice(n).join(''), sentRight);
  check('the right button is kept from the program', !/\x1b\[<2;/.test(rightData), JSON.stringify(rightData.slice(0, 80)));
  check('right-click still inserts', /TRACK-MARK-5150/.test(rightData), JSON.stringify(rightData.slice(0, 80)));
  await ev((i) => window.__termdeck.app.tabs[i].term.write('\x1b[?1006l\x1b[?1002l\x1b[?1000l'), i);
  await shot(page, '23-c-mouse-taken');
  await send(page, i, '\x1b');

  check('no page errors', app.errors.length === 0, app.errors.slice(0, 3).join(' | '));
} finally {
  await app.close();
  if (savedClipboard.trim()) clipboardText(savedClipboard.replace(/\r?\n$/, ''));
}
process.exit(summary() ? 1 : 0);
