// The Updates panel and the close -> update -> resume sequence.
//
// NOTHING IS INSTALLED BY THIS TEST. The app is started with TERMDECK_UPDATE_DRYRUN,
// which makes "update" ask the CLI for its version instead of running its updater.
// What does run for real: the version check (each CLI's --version, `grok update
// --check`, and two look-ups on the public npm registry).
// One CLI (default claude) is opened once, with nothing sent to it.
// usage: node 11-updates.mjs <data-dir> <work-dir> [cli]
import fs from 'node:fs';
import path from 'node:path';
import { launch, shot, send, text, resize, sleep, check, summary } from './harness.mjs';
import { ensureReady, openCli } from './clis.mjs';

const [dataDir, workDir] = process.argv.slice(2);
const cli = process.argv[4] ?? 'claude';
const DRY = { TERMDECK_UPDATE_DRYRUN: '1' };

async function until(fn, timeout = 20000, step = 400) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) return false;
    await sleep(step);
  }
}
const appState = (page) =>
  page.evaluate(() => {
    const a = window.__termdeck.app;
    return { versions: a.versions, checking: a.checking, updating: [...a.updating], last: a.lastUpdate, mode: a.state.updateMode, button: document.getElementById('btn-updates').textContent };
  });
const tabs = (page) => page.evaluate(() => window.__termdeck.app.tabs.map((t) => ({ pid: t.pid, running: t.cliRunning, resume: t.resumePending, exited: t.exited, cli: t.state.cli, procs: t.procs.map((p) => p.pid) })));

let app = await launch({ dataDir, env: DRY });
let page = app.page;
try {
  await page.evaluate(() => window.__termdeck.app.setSplit(2));
  await resize(page, 1700, 820);
  await page.evaluate(() => window.__termdeck.app.toggleLibrary(false));

  // ---- A. first start: the default is "check and tell", and it runs by itself ----
  let st = await appState(page);
  check('default at startup is "check and tell me"', st.mode === 'check');
  st = await until(async () => { const s = await appState(page); return s.versions && !s.checking ? s : false; }, 60000);
  check('the startup check finished by itself', !!st);
  const v = Object.fromEntries((st.versions ?? []).map((x) => [x.cli, x]));
  for (const name of ['claude', 'codex', 'grok']) {
    const x = v[name];
    console.log(`${name}: installed ${x?.installed ?? '-'}, latest ${x?.latest ?? 'unknown'}, update ${x?.updateAvailable}, running on the PC ${x?.running}, command "${x?.command}"`);
    check(`${name}: installed version read`, !!x && /^\d+\.\d+/.test(x.installed ?? ''), x?.installed ?? 'none');
    check(`${name}: latest version looked up`, !!x && /^\d+\.\d+/.test(x.latest ?? ''), x?.latest ?? 'unknown (offline, or npm missing)');
  }
  const waiting = (st.versions ?? []).filter((x) => x.updateAvailable);
  check('the Updates button shows how many are waiting', waiting.length ? st.button === `Updates · ${waiting.length}` : st.button === 'Updates', `button "${st.button}", ${waiting.length} waiting`);

  // ---- B. the panel ----
  await page.locator('#btn-updates').click();
  await page.locator('.upd-row').first().waitFor({ timeout: 8000 });
  await until(async () => !(await appState(page)).checking, 60000);
  await sleep(400);
  check('panel lists the three CLIs', (await page.locator('.upd-row').count()) === 3);
  const rowText = async (name) => (await page.locator(`.upd-row[data-cli="${name}"]`).innerText()).replace(/\s+/g, ' ');
  for (const name of ['claude', 'codex', 'grok']) console.log(`   ${await rowText(name)}`);
  check('a CLI with an update is marked, one without says "up to date"', (await Promise.all(['claude', 'codex', 'grok'].map(rowText))).every((t, i) => (v[['claude', 'codex', 'grok'][i]].updateAvailable ? /available/.test(t) : /up to date|unknown/.test(t))));
  await shot(page, '11-a-updates-panel');
  // The panel has two choices: what to do about updates at startup (first), and whether to resume sessions (second).
  await page.locator('.modal select').first().selectOption('auto');
  await page.locator('.modal .foot button', { hasText: 'Close' }).click();
  await sleep(700);
  check('the startup choice is saved', JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')).updateMode === 'auto');

  // ---- C. a CLI is open in a tab: close it, "update" (dry run), resume it ----
  const i = await openCli(page, cli, workDir, 1);
  check(`${cli}: started`, await ensureReady(page, i, cli));
  await sleep(1500);
  const before = (await tabs(page))[i];
  const other = (await tabs(page))[0];
  await send(page, 0, 'echo UNTOUCHED-1\r');
  await page.locator('#btn-updates').click();
  await page.locator(`.upd-row[data-cli="${cli}"]`).waitFor({ timeout: 8000 });
  await until(async () => !(await appState(page)).checking, 60000);
  check('panel shows the CLI is open in a tab', /open in 1 tab/.test(await rowText(cli)), await rowText(cli));
  await page.locator(`.upd-row[data-cli="${cli}"] button`).click();
  const ask = page.locator('.modal', { hasText: 'is open in 1 tab' });
  await ask.waitFor({ timeout: 5000 });
  await shot(page, '11-b-open-sessions');
  check('it asks before closing an open session', await ask.locator('button', { hasText: 'Close, update, resume' }).isVisible());
  await ask.locator('button', { hasText: 'Close, update, resume' }).click();
  const closed = await until(async () => { const t = (await tabs(page))[i]; return t.running === 'none' || t.pid !== before.pid; }, 15000);
  check(`${cli}: its session was closed for the update`, !!closed);
  const ran = await until(async () => (await appState(page)).last[cli], 60000);
  check('the update command ran and reported back', !!ran && ran.ok, ran ? `"${ran.command}" -> ${String(ran.output).slice(0, 60)}` : 'no result');
  const resumed = await until(async () => { const t = (await tabs(page))[i]; return t.running === cli && !t.resume ? t : false; }, 40000);
  check(`${cli}: resumed by itself afterwards, in the same tab and shell`, !!resumed && resumed.pid === before.pid, resumed ? `shell pid ${resumed.pid}` : 'not resumed');
  await send(page, 0, 'echo UNTOUCHED-2\r');
  check('the other tab was left alone', (await tabs(page))[0].pid === other.pid && (await until(async () => /^UNTOUCHED-2$/m.test(await text(page, 0, 20)), 8000)));
  await sleep(800);
  await shot(page, '11-c-after-update');
  const closeBtn = page.locator('.modal .foot button', { hasText: 'Close' });
  if (await closeBtn.isVisible()) await closeBtn.click();
  check('no page errors', app.errors.length === 0, app.errors.slice(0, 3).join(' | '));

  // ---- D. restart with "update automatically": runs at startup, before anything is resumed ----
  await app.close();
  await sleep(1200);
  app = await launch({ dataDir, env: DRY });
  page = app.page;
  check('mode "update automatically" survived the restart', (await appState(page)).mode === 'auto');
  // Codex open in some other terminal window (nothing in this app runs it at this point)
  // must make the startup update leave Codex alone: npm cannot replace a running program.
  let sawSkip = false;
  const settled = await until(async () => {
    sawSkip ||= /was not touched/.test(await page.locator('#toasts').innerText());
    const s = await appState(page);
    return s.versions && !s.checking && !s.updating.length ? s : false;
  }, 90000, 250);
  const fresh = Object.fromEntries((settled?.versions ?? []).map((x) => [x.cli, x]));
  const codexElsewhere = (fresh.codex?.running ?? 0) > 0;
  const due = (settled?.versions ?? []).filter((x) => x.updateAvailable);
  const expected = due.filter((x) => !(x.cli === 'codex' && codexElsewhere)).map((x) => x.cli);
  console.log(`startup, automatic: update waiting for [${due.map((x) => x.cli).join(', ') || 'none'}]; Codex running in another window: ${codexElsewhere}`);
  const done = await until(async () => {
    sawSkip ||= /was not touched/.test(await page.locator('#toasts').innerText());
    const s = await appState(page);
    return expected.every((c) => s.last[c]) && !s.updating.length ? s : false;
  }, 90000, 250);
  await sleep(2500);
  sawSkip ||= /was not touched/.test(await page.locator('#toasts').innerText());
  const ranFor = Object.keys((await appState(page)).last);
  if (expected.length) check('at startup it ran the updater for each CLI with an update waiting', !!done && expected.every((c) => done.last[c].ok), expected.join(', '));
  check('at startup no other updater was run', ranFor.length === expected.length && ranFor.every((c) => expected.includes(c)), `ran for: ${ranFor.join(', ') || 'none'}`);
  if (due.some((x) => x.cli === 'codex') && codexElsewhere) {
    check('Codex is open in another window: startup left it alone and said so', sawSkip && !ranFor.includes('codex'));
  }
  const restored = (await tabs(page))[i];
  check(`${cli}: the restored tab still offers Resume after the startup update`, !!restored && restored.resume && restored.cli === cli);

  // ---- E. "do nothing" really does nothing ----
  await page.evaluate(() => { const a = window.__termdeck.app; a.state.updateMode = 'off'; return a.saveNow(); });
  await app.close();
  await sleep(1200);
  app = await launch({ dataDir, env: DRY });
  page = app.page;
  await sleep(6000);
  st = await appState(page);
  check('with "do nothing", no check is made at startup', st.mode === 'off' && st.versions === null && !st.checking);
  check('no page errors after restarts', app.errors.length === 0, app.errors.slice(0, 3).join(' | '));
} finally {
  await app.close();
}
process.exit(summary() ? 1 : 0);
