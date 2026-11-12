// Real conversations: status while working, reading back history, scrolling,
// then closing the app and resuming every session after a restart.
// Sends ONE short prompt to each CLI.
// usage: node 04-sessions.mjs <data-dir> <work-dir> [cli,cli]
import { launch, shot, info, screen, text, resize, sleep, check, summary } from './harness.mjs';
import { CLIS, settle, toInputBox, ensureReady, openCli, focusTab } from './clis.mjs';

const [dataDir, workDir] = process.argv.slice(2);
const only = process.argv[4] ? process.argv[4].split(',') : CLIS;
const marker = (cli) => `FINISHED-${cli.toUpperCase()}-7Q`;
const prompt = (cli) => `Do not use any tools. Print the numbers 1 to 60, one per line, each followed by the word "line". Then print exactly ${marker(cli)}`;

let app = await launch({ dataDir });
let page = app.page;
const paneOf = (i) => page.evaluate((i) => window.__termdeck.app.state.panes.indexOf(window.__termdeck.app.tabs[i].state.id), i);

async function wheelUp(i, notches) {
  const pane = await paneOf(i);
  const box = await page.locator('.pane').nth(pane).locator('.pane-body').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let n = 0; n < notches; n++) {
    await page.mouse.wheel(0, -240);
    await sleep(40);
  }
  await sleep(500);
}

try {
  await page.evaluate(() => window.__termdeck.app.setSplit(3));
  await resize(page, 1900, 900);
  await page.evaluate(() => window.__termdeck.app.toggleLibrary(false));

  const tabs = {};
  let pane = 0;
  for (const cli of only) tabs[cli] = await openCli(page, cli, workDir, pane++);
  for (const cli of only) check(`${cli}: started`, await ensureReady(page, tabs[cli], cli));

  // ---- send the prompts, then watch the status of all tabs together ----
  // Focus stays on the first pane, so the others must show "finished" when done.
  for (const cli of only) await page.evaluate(([i, p]) => window.__termdeck.app.tabs[i].submit(p), [tabs[cli], prompt(cli)]);
  await focusTab(page, tabs[only[0]]);

  const timeline = Object.fromEntries(only.map((c) => [c, []]));
  const done = new Set();
  const nudged = new Set();
  const began = Date.now();
  let midShot = false;
  while (done.size < only.length && Date.now() - began < 150000) {
    const st = await info(page);
    for (const cli of only) {
      const t = st[tabs[cli]];
      const state = `${t.activity}${t.cliStatus ? `(${t.cliStatus})` : ''}`;
      const tl = timeline[cli];
      if (tl[tl.length - 1]?.state !== state) tl.push({ state, at: ((Date.now() - began) / 1000).toFixed(1) });
      // The marker is also part of the prompt itself (which wraps on screen), so it only
      // counts as the answer once the CLI has been seen working and has stopped again.
      const worked = tl.some((e) => e.state.startsWith('working'));
      if (!done.has(cli) && worked && t.activity !== 'working' && new RegExp(marker(cli)).test(await text(page, tabs[cli], 40))) done.add(cli);
    }
    // A CLI that has not started on the prompt after 20 s did not take the Enter
    // (seen with Codex while its sign-in check was still running on a slow line).
    // Press Enter once more so the rest can be tested, and report it.
    if (Date.now() - began > 20000) {
      for (const cli of only) {
        if (nudged.has(cli) || timeline[cli].some((e) => e.state.startsWith('working'))) continue;
        nudged.add(cli);
        console.log(`(${cli}: prompt still sitting in the input box after 20 s; Enter pressed again)`);
        await page.evaluate((i) => window.__termdeck.app.tabs[i].send('\r'), tabs[cli]);
      }
    }
    if (!midShot && Date.now() - began > 4000) {
      await shot(page, '04-a-working');
      midShot = true;
    }
    await sleep(400);
  }
  await sleep(2500);
  let st = await info(page);
  await shot(page, '04-b-finished');
  for (const cli of only) {
    const t = st[tabs[cli]];
    const tl = timeline[cli].map((e) => `${e.state}@${e.at}s`).join(' -> ');
    console.log(`${cli} status timeline: ${tl}`);
    check(`${cli}: prompt was sent by the snippet's own Enter`, !nudged.has(cli), nudged.has(cli) ? 'needed a second Enter' : '');
    check(`${cli}: answered`, done.has(cli));
    check(`${cli}: showed "working" while answering`, timeline[cli].some((e) => e.state.startsWith('working')), tl);
    const expected = cli === only[0] ? ['idle', 'done'] : ['done'];
    check(`${cli}: shows ${cli === only[0] ? 'idle/finished (focused tab)' : '"finished" (unfocused tab)'} afterwards`, expected.includes(t.activity), `activity=${t.activity} status=${t.cliStatus}`);
    console.log(`${cli}: buffer=${t.altScreen} scrollback=${t.scrollback} session=${t.session} title=${JSON.stringify(t.title)}`);
  }

  // ---- scrolling back through what was said ----
  for (const cli of only) {
    const i = tabs[cli];
    const bottom = await screen(page, i);
    await wheelUp(i, 14);
    const up = await screen(page, i);
    const sawEarlier = /\b(1|2|3|4|5) line\b/.test(up) || /Print the numbers 1 to 60/.test(up.replace(/\s+/g, ' '));
    const fits = up === bottom && sawEarlier; // the whole answer is already on screen
    check(`${cli}: mouse wheel scrolls back to the start of the answer`, sawEarlier, fits ? 'whole answer already fits on screen, nothing to scroll' : up === bottom ? 'screen did not move' : sawEarlier ? '' : 'moved, but the early lines were not found');
    if (cli === only[0]) await shot(page, '04-c-scrolled-up');
  }
  // Resize while scrolled up, then scroll again: history must still be there.
  await resize(page, 1400, 700);
  for (const cli of only) await settle(page, tabs[cli], 900, 8000);
  await resize(page, 1900, 900);
  for (const cli of only) await settle(page, tabs[cli], 900, 8000);
  for (const cli of only) {
    const i = tabs[cli];
    await wheelUp(i, 20);
    const up = await screen(page, i);
    check(`${cli}: history still readable after a resize`, /\b([1-9]|1\d) line\b/.test(up), up.split('\n').filter((r) => r.trim()).slice(0, 4).join(' | ').slice(0, 160));
    const dupes = up.split('\n').map((r) => r.trim()).filter((r) => /^\d+ line$/.test(r));
    check(`${cli}: no duplicated lines after a resize`, new Set(dupes).size === dupes.length, `${dupes.length} numbered rows, ${new Set(dupes).size} unique`);
  }
  await shot(page, '04-d-scrolled-after-resize');
  // Back to the bottom.
  for (const cli of only) await page.evaluate((i) => window.__termdeck.app.tabs[i].term.scrollToBottom(), tabs[cli]);

  // ---- History view, read from each CLI's own session file ----
  for (const cli of only) {
    const i = tabs[cli];
    await focusTab(page, i);
    const p = await paneOf(i);
    const btn = page.locator('.pane').nth(p).locator('.pane-head button', { hasText: 'History' });
    if (!(await btn.isVisible())) {
      check(`${cli}: History button available`, false, 'the CLI is no longer running in this tab');
      continue;
    }
    await btn.click();
    const hist = page.locator('.pane').nth(p).locator('.history');
    await hist.locator('.hmsg, .history-empty').first().waitFor({ timeout: 10000 }).catch(() => {});
    await sleep(600);
    const users = await hist.locator('.hmsg.user').allInnerTexts();
    const assistants = await hist.locator('.hmsg.assistant').allInnerTexts();
    const src = await hist.locator('.src').innerText();
    check(`${cli}: History shows my prompt`, users.some((u) => /Print the numbers 1 to 60/.test(u)), `${users.length} user message(s); file: ${src.replace(/‎/g, '').slice(-70)}`);
    check(`${cli}: History shows the answer`, assistants.some((a) => new RegExp(marker(cli)).test(a)), `${assistants.length} assistant message(s)`);
  }
  await shot(page, '04-e-history');
  for (const cli of only) {
    const p = await paneOf(tabs[cli]);
    const back = page.locator('.pane').nth(p).locator('.history-bar button', { hasText: 'Back to terminal' });
    if (await back.isVisible()) await back.click();
  }

  // ---- close the app, start it again ----
  const before = await info(page);
  await app.close();
  await sleep(1500);
  app = await launch({ dataDir });
  page = app.page;
  await sleep(2500);
  st = await info(page);
  await shot(page, '04-f-restored');
  check('restart: same number of tabs', st.length === before.length, `${before.length} -> ${st.length}`);
  for (const cli of only) {
    const was = before[tabs[cli]];
    const t = st[tabs[cli]];
    check(`${cli}: tab restored in its folder with Resume offered`, t && t.cwd === was.cwd && t.cli === cli && t.resume === true, t ? `cwd ok=${t.cwd === was.cwd} cli=${t.cli} resume=${t.resume}` : 'missing');
  }
  const bars = await page.locator('.resume-bar:not([hidden])').count();
  check('restart: a Resume bar is shown in each pane', bars === only.length, `${bars} bars`);

  // Resume each with one click.
  for (const cli of only) {
    const p = await paneOf(tabs[cli]);
    const bar = page.locator('.pane').nth(p).locator('.resume-bar');
    if (!(await bar.isVisible())) continue;
    console.log(`${cli} resume command: ${(await bar.locator('.grow').innerText()).split('with:')[1]?.trim()}`);
    await bar.locator('button', { hasText: 'Resume' }).click();
  }
  for (const cli of only) {
    if (!st[tabs[cli]]?.resume) continue;
    await ensureReady(page, tabs[cli], cli, 1);
    const s = await settle(page, tabs[cli], 2000, 30000);
    const all = (await text(page, tabs[cli], 400)) + '\n' + s;
    const back = new RegExp(marker(cli)).test(all) || /\b(5\d|60) line\b/.test(all);
    check(`${cli}: Resume brings the conversation back`, back, s.split('\n').filter((r) => r.trim()).slice(-3).join(' | ').slice(0, 200));
    if (!back) console.log(`----- ${cli} tab after Resume -----\n${all.split('\n').filter((r) => r.trim()).slice(-30).map((r) => '      | ' + r).join('\n')}`);
  }
  await sleep(1500);
  await shot(page, '04-g-resumed');
  st = await info(page);
  for (const cli of only) console.log(`${cli} after resume: activity=${st[tabs[cli]].activity} status=${st[tabs[cli]].cliStatus} session=${st[tabs[cli]].session}`);
  check('no page errors', app.errors.length === 0, app.errors.slice(0, 3).join(' | '));
} finally {
  await app.close();
}
process.exit(summary() ? 1 : 0);
