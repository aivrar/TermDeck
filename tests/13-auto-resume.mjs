// "Resume all of them automatically" at startup, and how it waits for the update step.
// Opens Claude twice (one with --verbose) and Codex once. Nothing is sent to any of them.
// NOTHING IS INSTALLED: started with TERMDECK_UPDATE_DRYRUN, so "update" only asks the
// CLI for its version.
// usage: node 13-auto-resume.mjs <data-dir> <work-dir>
import { launch, shot, send, resize, sleep, check, summary } from './harness.mjs';
import { ensureReady, openCli } from './clis.mjs';

const [dataDir, workDir] = process.argv.slice(2);
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
const tabs = (page) => page.evaluate(() => window.__termdeck.app.tabs.map((t) => ({ running: t.cliRunning, cli: t.state.cli, flags: t.state.flags ?? '', resume: t.resumePending })));
const appState = (page) =>
  page.evaluate(() => {
    const a = window.__termdeck.app;
    return { versions: a.versions, checking: a.checking, updating: [...a.updating], last: Object.keys(a.lastUpdate), update: a.state.updateMode, resume: a.state.resumeMode, toasts: document.getElementById('toasts').innerText };
  });
const setModes = (page, update, resume) =>
  page.evaluate(([update, resume]) => {
    const a = window.__termdeck.app;
    a.state.updateMode = update;
    a.state.resumeMode = resume;
    return a.saveNow();
  }, [update, resume]);
const newShell = (page, pane) =>
  page.evaluate(async ([cwd, pane]) => {
    const a = window.__termdeck.app;
    a.state.activePane = pane;
    await a.createTab({ shell: 'powershell', cwd, cli: 'none' });
    return a.tabs.length - 1;
  }, [workDir, pane]);

let app = await launch({ dataDir, env: DRY });
let page = app.page;
const restart = async () => {
  await app.close();
  await sleep(1500);
  app = await launch({ dataDir, env: DRY });
  page = app.page;
};
try {
  await page.evaluate(() => window.__termdeck.app.setSplit(3));
  await resize(page, 1900, 900);
  await page.evaluate(() => window.__termdeck.app.toggleLibrary(false));
  check('default: sessions wait for a click', (await appState(page)).resume === 'manual');

  const c1 = await openCli(page, 'claude', workDir, 0);
  const c2 = await newShell(page, 1);
  const cx = await newShell(page, 2);
  await sleep(2500);
  await send(page, c2, 'claude --verbose\r');
  await send(page, cx, 'codex\r');
  check('claude (plain): started', await ensureReady(page, c1, 'claude'));
  check('claude --verbose: started', await ensureReady(page, c2, 'claude'));
  const codexUp = await ensureReady(page, cx, 'codex');
  check('codex: started', codexUp);
  const mine = codexUp ? [c1, c2, cx] : [c1, c2];
  await sleep(2000);

  // ---- A. updates "do nothing" + automatic resume: everything comes back by itself ----
  await setModes(page, 'off', 'auto');
  await restart();
  let up = await until(async () => { const t = await tabs(page); return mine.every((i) => t[i].running === t[i].cli && t[i].cli !== 'none') ? t : false; }, 70000);
  check('updates off: every session resumed by itself, no click', !!up, up ? '' : JSON.stringify((await tabs(page)).map((t) => `${t.cli}:${t.running}`)));
  check('…each with its own switches', !!up && up[c1].flags === '' && up[c2].flags === '--verbose', up ? `"${up[c1].flags}" | "${up[c2].flags}"` : '');
  await shot(page, '13-a-auto-resumed');
  await sleep(2500);

  // ---- B. updates "check and tell me" + automatic resume ----
  await setModes(page, 'check', 'auto');
  await restart();
  const st = await until(async () => { const s = await appState(page); return s.versions && !s.checking ? s : false; }, 70000);
  const waiting = (st?.versions ?? []).filter((v) => v.updateAvailable).map((v) => v.cli);
  console.log(`check found an update waiting for: [${waiting.join(', ') || 'none'}]`);
  const expectRun = mine.filter((i) => !waiting.includes(i === cx ? 'codex' : 'claude'));
  const expectHeld = mine.filter((i) => waiting.includes(i === cx ? 'codex' : 'claude'));
  up = await until(async () => { const t = await tabs(page); return expectRun.every((i) => t[i].running === t[i].cli) ? t : false; }, 70000);
  check('check mode: sessions of CLIs with no update waiting resumed by themselves', !!up, `${expectRun.length} session(s)`);
  if (expectHeld.length) {
    await sleep(6000); // long enough that a wrongly resumed one would have started
    const t = await tabs(page);
    check('check mode: a session whose CLI has an update waiting is held back, still offering Resume', expectHeld.every((i) => t[i].running === 'none' && t[i].resume), expectHeld.map((i) => `${t[i].cli}: running=${t[i].running} resume=${t[i].resume}`).join('; '));
    check('…and the app says why', /update is waiting/.test((await appState(page)).toasts));
    await shot(page, '13-b-held-for-update');
    // update from the panel (dry run) -> the held session starts afterwards without a click
    const cli = waiting[0];
    await page.evaluate((cli) => window.__termdeck.app.updateCli(cli, { stop: false }), cli);
    const after = await until(async () => { const t2 = await tabs(page); return expectHeld.filter((i) => t2[i].cli === cli).every((i) => t2[i].running === cli); }, 60000);
    check('after the update the held session resumes by itself', !!after);
  } else {
    console.log('(no update is waiting for a CLI in this test, so the "held back" branch could not be exercised)');
  }
  await sleep(2500);

  // ---- C. updates "automatic" + automatic resume: update step first, then everything resumes ----
  await setModes(page, 'auto', 'auto');
  await restart();
  // nothing may be resumed while the update step is still running
  let early = false;
  const done = await until(async () => {
    const s = await appState(page);
    const t = await tabs(page);
    const busy = !s.versions || s.checking || s.updating.length > 0;
    if (busy && mine.some((i) => t[i].running !== 'none')) early = true;
    return !busy && mine.every((i) => t[i].running === t[i].cli) ? s : false;
  }, 120000, 250);
  check('automatic updates: nothing was resumed before the update step had finished', !early);
  check('automatic updates: afterwards every session resumed by itself', !!done);
  console.log(`update step ran the updater for: [${done ? done.last.join(', ') || 'none' : '?'}]`);
  check('no page errors', app.errors.length === 0, app.errors.slice(0, 3).join(' | '));
  await setModes(page, 'check', 'manual');
  // Let the just-resumed sessions finish starting before the window is closed: Claude Code
  // keeps a record of full-screen sessions that are still starting, and one that
  // disappears mid-start can be counted by it as a crash.
  await sleep(10000);
} finally {
  await app.close();
}
process.exit(summary() ? 1 : 0);
