// Input paths into each CLI: multi-line insert, Shift+Enter, typed symbols,
// image paste from the clipboard, dropped files. Nothing is submitted to a model.
// usage: node 03-input.mjs <data-dir> <work-dir>
import fs from 'node:fs';
import path from 'node:path';
import { launch, shot, info, screen, send, resize, sleep, check, summary } from './harness.mjs';
import { CLIS, settle, ensureReady, openCli, focusTab, clipboardImage, clipboardText, clipboardGetText } from './clis.mjs';

const [dataDir, workDir] = process.argv.slice(2);
const only = process.argv[4] ? process.argv[4].split(',') : CLIS;
const savedClipboard = clipboardGetText();
const app = await launch({ dataDir });
const { page } = app;

try {
  await page.evaluate(() => window.__termdeck.app.setSplit(3));
  await resize(page, 1900, 900);
  await page.evaluate(() => window.__termdeck.app.toggleLibrary(false));

  const tabs = {};
  let pane = 0;
  for (const cli of only) tabs[cli] = await openCli(page, cli, workDir, pane++);
  for (const cli of only) check(`${cli}: started`, await ensureReady(page, tabs[cli], cli));
  await shot(page, '03-a-input-boxes');

  const st = await info(page);
  for (const cli of only) {
    const t = st[tabs[cli]];
    console.log(`${cli}: bracketedPaste=${t.bracketed} buffer=${t.altScreen} status=${t.cliStatus} session=${t.session}`);
  }

  for (const cli of only) {
    const i = tabs[cli];
    // A CLI can quit on its own some seconds after starting (Codex does when its
    // sign-in check times out on a slow connection). Start it again if so.
    if ((await info(page))[i].running !== cli) {
      console.log(`(${cli}: had quit by itself; starting it again)`);
      await send(page, i, `${cli}\r`);
      check(`${cli}: restarted`, await ensureReady(page, i, cli));
    }
    await focusTab(page, i);
    await sleep(300);

    // 1. multi-line snippet inserted as one block, not submitted line by line
    await page.evaluate((i) => window.__termdeck.app.tabs[i].insert('ALPHA first line\nBRAVO second line\nCHARLIE third line'), i);
    let s = await settle(page, i, 900, 8000);
    const hasAll = /ALPHA first line/.test(s) && /BRAVO second line/.test(s) && /CHARLIE third line/.test(s);
    const pasted = /\[Pasted text|\[Pasted Content|pasted \d+ lines/i.test(s);
    check(`${cli}: multi-line insert stays in the input as one block`, hasAll || pasted, pasted ? 'shown as a pasted-text chip' : '');
    let now = (await info(page))[i];
    check(`${cli}: multi-line insert did not submit`, now.activity !== 'working' && now.cliStatus !== 'busy', `activity=${now.activity} status=${now.cliStatus}`);

    // 2. Shift+Enter on the real keyboard path makes a new line
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('DELTA after shift-enter');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('ECHO symbols: → ✓ ┌─┐ 日本語 é ñ');
    s = await settle(page, i, 900, 8000);
    const rows = s.split('\n');
    const rowOf = (re) => rows.findIndex((r) => re.test(r));
    check(`${cli}: Shift+Enter starts a new line`, rowOf(/DELTA after shift-enter/) >= 0 && rowOf(/ECHO symbols/) > rowOf(/DELTA after shift-enter/), `rows ${rowOf(/DELTA/)} -> ${rowOf(/ECHO/)}`);
    check(`${cli}: typed symbols arrive intact`, /→ ✓ ┌─┐ 日本語 é ñ/.test(s), rows[rowOf(/ECHO/)] ?? '(row not found)');
    now = (await info(page))[i];
    check(`${cli}: still not submitted`, now.activity !== 'working' && now.cliStatus !== 'busy');

    // 3. image on the clipboard, pasted with Ctrl+V
    await page.keyboard.press('Shift+Enter');
    clipboardImage();
    const before = fs.existsSync(path.join(dataDir, 'pastes')) ? fs.readdirSync(path.join(dataDir, 'pastes')).length : 0;
    await page.keyboard.press('Control+v');
    await sleep(1200);
    s = await settle(page, i, 900, 8000);
    const after = fs.existsSync(path.join(dataDir, 'pastes')) ? fs.readdirSync(path.join(dataDir, 'pastes')).length : 0;
    check(`${cli}: clipboard image saved as a PNG`, after === before + 1, `${before} -> ${after} files`);
    const chip = /\[Image ?#?\d+\]|\[image\b[^\]]*\]/i.test(s);
    const asPath = /paste-\d+\.png/.test(s.replace(/\s+/g, ''));
    check(`${cli}: pasted image reaches the input`, chip || asPath, chip ? 'shown as an image chip' : asPath ? 'shown as a file path' : 'not visible');

    // 4. plain text on the clipboard, Ctrl+V
    clipboardText('FOXTROT from clipboard');
    await page.keyboard.press('Control+v');
    s = await settle(page, i, 900, 8000);
    check(`${cli}: clipboard text pastes`, /FOXTROT\s+from\s+clipboard/.test(s.replace(/[│\n]/g, ' ')));

    // 5. dropped files (the app's drop handler, given the paths a real drop delivers)
    const dropped = path.join(workDir, 'README.md');
    await page.evaluate(([i, p]) => {
      const app = window.__termdeck.app;
      app.dropFiles([p], app.state.panes.indexOf(app.tabs[i].state.id));
    }, [i, dropped]);
    s = await settle(page, i, 900, 8000);
    check(`${cli}: dropped file path reaches the input`, /README\.md/.test(s) || /\[.*README.*\]/i.test(s));
    now = (await info(page))[i];
    check(`${cli}: nothing was submitted by any of it`, now.activity !== 'working' && now.cliStatus !== 'busy');
    console.log(`\n----- ${cli} input area -----\n${s.split('\n').filter((r) => r.trim()).slice(-16).join('\n')}\n`);
  }
  await shot(page, '03-b-inputs-filled');

  // Resize with long multi-line input in every box, then check again.
  await resize(page, 1250, 640);
  for (const cli of only) await settle(page, tabs[cli], 900, 8000);
  await shot(page, '03-c-inputs-filled-small');
  await resize(page, 1900, 900);
  for (const cli of only) await settle(page, tabs[cli], 900, 8000);
  await shot(page, '03-d-inputs-filled-restored');
  for (const cli of only) {
    const s = await screen(page, tabs[cli]);
    check(`${cli}: input survives resize`, /DELTA after shift-enter/.test(s) || /\[Pasted/i.test(s));
  }
  check('no page errors', app.errors.length === 0, app.errors.slice(0, 3).join(' | '));
} finally {
  await app.close();
  if (savedClipboard.trim()) clipboardText(savedClipboard.replace(/\r?\n$/, ''));
}
process.exit(summary() ? 1 : 0);
