// The window itself, driven with real mouse and keyboard: new-session dialog, the
// other shell types, rename, panel resizing, the snippet library and quick buttons,
// drag-to-reorder, closing, and everything coming back after a restart.
// usage: node 08-ui.mjs <data-dir> <work-dir> [running-wsl-distro]
import fs from 'node:fs';
import path from 'node:path';
import { launch, shot, info, send, text, waitText, resize, sleep, check, summary } from './harness.mjs';

const [dataDir, workDir, wslDistro] = process.argv.slice(2);
let app = await launch({ dataDir });
let page = app.page;
const state = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__termdeck.app.state)));
const names = () => page.locator('#tablist .tab .t-name').allInnerTexts();

try {
  await resize(page, 1700, 850);
  await sleep(600);

  // ---- new session through the dialog: cmd ----
  await page.locator('#btn-new').click();
  await page.locator('.modal').waitFor();
  await shot(page, '08-a-new-session-dialog');
  const dirInput = page.locator('.modal input').first();
  await dirInput.fill(workDir);
  await page.locator('.modal .choice', { hasText: /^cmd$/ }).click();
  await page.locator('.modal input').last().fill('my cmd');
  await page.locator('.modal .foot .btn.primary').click();
  await page.waitForFunction(() => window.__termdeck.app.tabs.length === 2 && window.__termdeck.app.tabs[1].pid);
  await waitText(page, 1, />\s*$/);
  let st = await info(page);
  check('dialog creates a cmd tab with the chosen name and folder', st[1].shell === 'cmd' && st[1].name === 'my cmd' && st[1].cwd === workDir, JSON.stringify({ shell: st[1].shell, name: st[1].name }));
  await send(page, 1, 'echo cmd says ✓ → ┌─┐ 日本語\r');
  check('cmd: Unicode output is intact', /cmd says ✓ → ┌─┐ 日本語\n/.test(await waitText(page, 1, /cmd says .*\n.*cmd says/s)));
  await send(page, 1, 'cd ..\r');
  await sleep(1200);
  st = await info(page);
  check('cmd: folder changes are tracked', st[1].cwd === path.dirname(workDir), st[1].cwd);

  // bad folder is refused, dialog stays open
  await page.keyboard.press('Control+Shift+T');
  await page.locator('.modal').waitFor();
  await page.locator('.modal input').first().fill('Z:\\no\\such\\folder');
  await page.locator('.modal .foot .btn.primary').click();
  await sleep(500);
  check('dialog refuses a folder that does not exist', (await page.locator('.modal').count()) === 1 && (await page.locator('.toast.error').count()) >= 1);
  await page.keyboard.press('Escape');

  // ---- Git Bash ----
  const env = await page.evaluate(() => window.__termdeck.app.env);
  if (env.hasGitBash) {
    await page.evaluate((cwd) => window.__termdeck.app.createTab({ shell: 'gitbash', cwd, cli: 'none' }), workDir);
    const i = (await info(page)).length - 1;
    await waitText(page, i, /\$\s*$/, 25000);
    await send(page, i, 'echo "bash says ✓ → 日本語 in $(basename "$PWD")"\r');
    const said = await waitText(page, i, /bash says ✓[^\n]*\n[\s\S]*\$\s*$/);
    check('Git Bash: starts in the folder, Unicode intact', said.includes(`bash says ✓ → 日本語 in ${path.basename(workDir)}\n`), `folder ${path.basename(workDir)}`);
  }

  // ---- WSL (only into a distro that is already running) ----
  if (wslDistro) {
    await page.evaluate(([d]) => window.__termdeck.app.createTab({ shell: 'wsl', cwd: '~', cli: 'none', wslDistro: d }), [wslDistro]);
    const i = (await info(page)).length - 1;
    await waitText(page, i, /[$#]\s*$/, 30000);
    await send(page, i, 'echo "wsl says ✓ → 日本語 on $(uname -s)"\r');
    check(`WSL (${wslDistro}): shell works, Unicode intact`, /wsl says ✓ → 日本語 on Linux\n/.test(await waitText(page, i, /wsl says ✓[^\n]*\n[\s\S]*[$#]\s*$/)));
    await send(page, i, 'exit\r');
    await page.waitForFunction((i) => window.__termdeck.app.tabs[i].exited, i, { timeout: 15000 }).catch(() => {});
    st = await info(page);
    check('WSL: "exit" ends the tab cleanly', st[i].activity === 'exited');
    await page.locator('#tablist .tab').nth(i).hover();
    await page.locator('#tablist .tab').nth(i).locator('.t-close').click();
    await sleep(400);
    check('an ended tab closes without a prompt', (await info(page)).length === i);
  } else {
    console.log('(WSL not tested live: no distro is running, and starting one could boot services in it)');
  }
  await shot(page, '08-b-shell-types');

  // ---- rename by double-click ----
  await page.locator('#tablist .tab').first().dblclick();
  await page.locator('#tablist input.rename').fill('Main shell');
  await page.keyboard.press('Enter');
  check('rename by double-click', (await names())[0] === 'Main shell', (await names()).join(', '));

  // ---- drag the left panel wider: terminal re-fits ----
  await page.evaluate(() => { const a = window.__termdeck.app; a.showTab(a.tabs[0]); });
  await sleep(400);
  const colsBefore = (await info(page))[0].cols;
  const handle = await page.locator('#h-left').boundingBox();
  await page.mouse.move(handle.x + 2, handle.y + 200);
  await page.mouse.down();
  await page.mouse.move(handle.x + 150, handle.y + 210, { steps: 12 });
  await page.mouse.up();
  await sleep(500);
  let s = await state();
  const colsAfter = (await info(page))[0].cols;
  check('dragging the side panel resizes it', s.sidebarWidth > 330, `sidebar ${s.sidebarWidth}px`);
  check('terminal re-fits when the side panel grows', colsAfter < colsBefore, `${colsBefore} -> ${colsAfter} columns`);

  // ---- library: add a snippet, pin it, use it ----
  await page.locator('#library .lib-head .btn', { hasText: '+ New' }).click();
  await page.locator('.modal').waitFor();
  await page.locator('.modal input').first().fill('Say hi');
  await page.locator('.modal textarea').fill('Write-Output "snippet-insert-ok"');
  await page.locator('.modal .foot .btn.primary').click();
  await sleep(300);
  check('new snippet appears in the library', (await page.locator('#library .snip .s-label', { hasText: 'Say hi' }).count()) === 1);
  check('pinned snippet appears as a quick button', (await page.locator('#quickbar .qbtn', { hasText: 'Say hi' }).count()) === 1);
  await page.locator('#quickbar .qbtn', { hasText: 'Say hi' }).click();
  await sleep(700);
  let t = await text(page, 0, 6);
  check('"insert only" puts the text at the prompt without running it', /> Write-Output "snippet-insert-ok"$/.test(t.trimEnd()), t.split('\n').slice(-2).join(' | '));
  await page.keyboard.press('Enter');
  await waitText(page, 0, /\nsnippet-insert-ok\n/);
  check('typing Enter then runs it, focus stayed in the terminal', true);

  // a submit-mode snippet from the library list
  await page.locator('#library .snip', { hasText: 'git status' }).click();
  await waitText(page, 0, /git status\n[\s\S]*(fatal|On branch|not a git)/i, 15000);
  check('"insert and press Enter" snippet runs immediately', true);

  // search + Enter sends the first match
  await send(page, 0, 'cls\r');
  await page.keyboard.press('Control+Shift+P');
  await page.keyboard.type('say h');
  await sleep(200);
  check('search narrows the library', (await page.locator('#library .snip').count()) === 1);
  await page.keyboard.press('Enter');
  await sleep(600);
  check('Enter in search sends the match and clears the search', /snippet-insert-ok/.test(await text(page, 0, 4)) && (await page.locator('#library .snip').count()) > 3);
  await send(page, 0, '\x03');
  await shot(page, '08-c-library');

  // multi-line snippet into a plain shell prompt arrives as one block (not run line by line)
  await page.evaluate(() => window.__termdeck.app.tabs[0].insert('Write-Output "ML-one"\nWrite-Output "ML-two"'));
  await sleep(700);
  t = await text(page, 0, 8);
  check('multi-line insert into PowerShell is not run until Enter', !/\nML-one\n/.test(t) && /ML-one/.test(t), t.split('\n').slice(-3).join(' | '));
  await send(page, 0, '\x03');

  // ---- hide the library: terminal gets wider ----
  const colsLib = (await info(page))[0].cols;
  await page.locator('#quickbar .btn', { hasText: 'Library' }).click();
  await sleep(500);
  check('hiding the library widens the terminal', (await info(page))[0].cols > colsLib, `${colsLib} -> ${(await info(page))[0].cols}`);

  // ---- drag a tab to reorder ----
  const order0 = await names();
  const first = await page.locator('#tablist .tab').nth(0).boundingBox();
  const last = await page.locator('#tablist .tab').nth(order0.length - 1).boundingBox();
  await page.mouse.move(first.x + 60, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(last.x + 60, last.y + last.height - 4, { steps: 15 });
  await page.mouse.up();
  await sleep(400);
  const order1 = await names();
  check('dragging a tab reorders the list', order1[order1.length - 1] === order0[0] && order1[0] === order0[1], `${order0.join(', ')}  ->  ${order1.join(', ')}`);

  // ---- split + zoom, then restart and compare ----
  await page.locator('#split-seg button[data-n="2"]').click();
  await page.locator('#zoom-in').click();
  await page.locator('#zoom-in').click();
  await sleep(600);
  await resize(page, 1500, 760);
  await sleep(800);
  await shot(page, '08-d-before-restart');
  const before = await state();
  const beforeNames = await names();
  const beforeSize = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
  await app.close();
  await sleep(1200);

  check('portable: everything is in the data folder beside the app', ['state.json', 'snippets.json', 'window.json'].every((f) => fs.existsSync(path.join(dataDir, f))), fs.readdirSync(dataDir).join(', '));
  const stray = [path.join(process.env.LOCALAPPDATA, 'local.termdeck.app'), path.join(process.env.APPDATA, 'local.termdeck.app'), path.join(process.env.APPDATA, 'TermDeck')].filter((p) => fs.existsSync(p));
  check('portable: nothing written to the Windows profile', stray.length === 0, stray.join(', '));

  app = await launch({ dataDir });
  page = app.page;
  await sleep(2000);
  const after = await state();
  const afterNames = await names();
  const afterSize = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
  await shot(page, '08-e-after-restart');
  check('restart: tabs, names and order', JSON.stringify(afterNames) === JSON.stringify(beforeNames), afterNames.join(', '));
  check('restart: folders', JSON.stringify(after.tabs.map((x) => x.cwd)) === JSON.stringify(before.tabs.map((x) => x.cwd)));
  check('restart: split view and which tab is in which pane', JSON.stringify(after.panes) === JSON.stringify(before.panes), `${after.panes.length} panes`);
  check('restart: text size', after.fontSize === before.fontSize && after.fontSize === 16, `${after.fontSize}px`);
  check('restart: panel widths and library hidden', after.sidebarWidth === before.sidebarWidth && after.libraryOpen === false);
  check('restart: window size', Math.abs(afterSize[0] - beforeSize[0]) <= 2 && Math.abs(afterSize[1] - beforeSize[1]) <= 2, `${beforeSize} -> ${afterSize}`);
  check('restart: snippet library', (await page.evaluate(() => window.__termdeck.app.library.snippets.some((x) => x.label === 'Say hi'))));
  st = await info(page);
  check('restart: every shell is running again', st.every((x) => x.activity !== 'exited'), st.map((x) => x.activity).join(','));
  check('restart: plain shells get no Resume bar', (await page.locator('.resume-bar:not([hidden])').count()) === 0);

  // ---- closing a busy tab asks first ----
  await page.evaluate(() => { const a = window.__termdeck.app; a.showTab(a.tabs[0]); });
  await send(page, 0, 'ping -n 30 127.0.0.1\r');
  await page.waitForFunction(() => window.__termdeck.app.tabs[0].activity === 'working', null, { timeout: 15000 }).catch(() => {});
  const count = (await info(page)).length;
  await page.locator('#tablist .tab').first().hover();
  await page.locator('#tablist .tab').first().locator('.t-close').click();
  await sleep(400);
  check('closing a working tab asks for confirmation', (await page.locator('.modal').count()) === 1);
  await shot(page, '08-f-close-confirm');
  await page.locator('.modal .foot .btn', { hasText: 'Cancel' }).click();
  check('Cancel keeps the tab', (await info(page)).length === count);
  await page.locator('#tablist .tab').first().hover();
  await page.locator('#tablist .tab').first().locator('.t-close').click();
  await page.locator('.modal .foot .btn.primary').click();
  await sleep(500);
  check('confirming closes it', (await info(page)).length === count - 1);
  check('no page errors', app.errors.length === 0, app.errors.slice(0, 3).join(' | '));
} finally {
  await app.close();
}
process.exit(summary() ? 1 : 0);
