// Opens Claude Code, Codex and Grok side by side, then resizes and zooms hard,
// checking after every step that each one is still drawn correctly.
// usage: node 02-clis.mjs <data-dir> <work-dir>
import { launch, shot, info, screen, screenCells, resize, sleep, check, summary } from './harness.mjs';
import { ensureReady } from './clis.mjs';

const [dataDir, workDir] = process.argv.slice(2);
const app = await launch({ dataDir });
const { page } = app;

const open = (cli, shell = 'powershell') =>
  page.evaluate(([cli, shell, cwd]) => window.__termdeck.app.createTab({ shell, cwd, cli }).then(() => window.__termdeck.app.tabs.length - 1), [cli, shell, workDir]);

/** Waits until a tab's screen stops changing. */
async function settle(i, quietMs = 1200, maxMs = 25000) {
  const start = Date.now();
  let last = '';
  let since = Date.now();
  while (Date.now() - start < maxMs) {
    const s = await screen(page, i);
    if (s !== last) {
      last = s;
      since = Date.now();
    } else if (Date.now() - since > quietMs) break;
    await sleep(250);
  }
  return last;
}

/** Structural checks on what is on screen: frames intact, nothing garbled. */
function inspect(label, s, cols, cells) {
  const lines = s.split('\n');
  const problems = [];
  const at = (r, x) => cells[r]?.[x];
  if (/�/.test(s)) problems.push('replacement characters');
  // A box top must have a matching bottom of the same width somewhere below it.
  lines.forEach((l, y) => {
    const m = /╭(─+)╮/.exec(l) || /┌(─+)┐/.exec(l);
    if (!m) return;
    const width = m[1].length;
    const left = m.index;
    const [bl, br] = m[0][0] === '╭' ? ['╰', '╯'] : ['└', '┘'];
    // The bottom edge sits in the same columns; it may carry a label inside it.
    // Checked by screen cell, not by character: an emoji or CJK character is one
    // character but two cells wide.
    const right = left + width + 1;
    if (at(y, left) !== m[0][0]) return; // box sits after a wide character; skip
    let closed = false;
    for (let r = y + 1; r < cells.length; r++) {
      if (at(r, left) === bl && at(r, right) === br) {
        closed = true;
        break;
      }
      if (at(r, left) !== '│' || at(r, right) !== '│') {
        problems.push(`box side wall broken on row ${r}`);
        closed = true;
        break;
      }
    }
    if (!closed) problems.push(`box opened on row ${y} (width ${width}) never closes`);
  });
  if (cells.some((row) => row.length !== cols)) problems.push('a row does not match the terminal width');
  check(`${label}: drawn cleanly`, problems.length === 0, problems.join('; '));
}

try {
  await page.evaluate(() => window.__termdeck.app.setSplit(3));
  await resize(page, 1900, 900);
  await page.evaluate(() => window.__termdeck.app.toggleLibrary(false));

  const tabs = {};
  for (const cli of ['claude', 'codex', 'grok']) {
    await page.evaluate((n) => { window.__termdeck.app.state.activePane = n; }, Object.keys(tabs).length);
    tabs[cli] = await open(cli);
    await sleep(500);
  }
  // Only first-run prompts this suite recognises are answered, always with the choice
  // that changes nothing (see toInputBox). Anything else is left on screen as it is.
  for (const cli of Object.keys(tabs)) await ensureReady(page, tabs[cli], cli);
  await sleep(1500);
  await shot(page, '02-b-ready');
  let st = await info(page);
  for (const cli of Object.keys(tabs)) {
    const t = st[tabs[cli]];
    console.log(`${cli}: ${t.cols}x${t.rows} running=${t.running} status=${t.cliStatus} activity=${t.activity} bracketedPaste=${t.bracketed} buffer=${t.altScreen} title=${JSON.stringify(t.title)} session=${t.session}`);
    check(`${cli}: detected as running`, t.running === cli, `running=${t.running}`);
    inspect(`${cli} at start`, await screen(page, tabs[cli]), t.cols, await screenCells(page, tabs[cli]));
  }

  // ---- resize storm ----
  const sizes = [[1900, 900], [1300, 700], [900, 520], [1600, 400], [700, 800], [2200, 1000], [1000, 600], [1900, 900]];
  for (const [w, h] of sizes) {
    await resize(page, w, h);
    await sleep(300);
    for (const cli of Object.keys(tabs)) await settle(tabs[cli], 900, 8000);
    st = await info(page);
    await shot(page, `02-c-resize-${w}x${h}`);
    for (const cli of Object.keys(tabs)) inspect(`${cli} at ${w}x${h} (${st[tabs[cli]].cols}x${st[tabs[cli]].rows})`, await screen(page, tabs[cli]), st[tabs[cli]].cols, await screenCells(page, tabs[cli]));
  }

  // A fast drag: many sizes with no pause between them.
  for (let i = 0; i < 25; i++) {
    await resize(page, 1900 - i * 40, 900 - i * 14);
    await sleep(30);
  }
  for (let i = 25; i >= 0; i--) {
    await resize(page, 1900 - i * 40, 900 - i * 14);
    await sleep(30);
  }
  for (const cli of Object.keys(tabs)) await settle(tabs[cli], 1200, 10000);
  st = await info(page);
  await shot(page, '02-d-after-fast-drag');
  for (const cli of Object.keys(tabs)) inspect(`${cli} after fast drag`, await screen(page, tabs[cli]), st[tabs[cli]].cols, await screenCells(page, tabs[cli]));

  // ---- zoom ----
  for (const size of [18, 24, 10, 8, 14]) {
    await page.evaluate((s) => window.__termdeck.app.setFontSize(s), size);
    await sleep(300);
    for (const cli of Object.keys(tabs)) await settle(tabs[cli], 900, 8000);
    st = await info(page);
    await shot(page, `02-e-zoom-${size}`);
    for (const cli of Object.keys(tabs)) inspect(`${cli} at zoom ${size} (${st[tabs[cli]].cols}x${st[tabs[cli]].rows})`, await screen(page, tabs[cli]), st[tabs[cli]].cols, await screenCells(page, tabs[cli]));
  }

  // Scrollback after all that: how much was pushed into history by redraws?
  st = await info(page);
  for (const cli of Object.keys(tabs)) console.log(`${cli}: scrollback lines after resize+zoom = ${st[tabs[cli]].scrollback}`);

  check('no page errors', app.errors.length === 0, app.errors.slice(0, 3).join(' | '));
} finally {
  // Leave the CLIs cleanly: Ctrl+C twice is "quit" in all three.
  await app.close();
}
process.exit(summary() ? 1 : 0);
