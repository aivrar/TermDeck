// One tab running flat out must not disturb the others.
// Floods one tab with output and measures how the other tabs and the window respond.
// usage: node 05-isolation.mjs <data-dir> <work-dir>
import { launch, shot, info, send, text, resize, sleep, check, summary } from './harness.mjs';

const [dataDir, workDir] = process.argv.slice(2);
const app = await launch({ dataDir });
const { page } = app;

const open = (pane) =>
  page.evaluate(async ([cwd, pane]) => {
    const a = window.__termdeck.app;
    a.state.activePane = pane;
    await a.createTab({ shell: 'powershell', cwd, cli: 'none' });
    return a.tabs.length - 1;
  }, [workDir, pane]);

/** Types a command in a tab and times how long until its output shows up. */
async function roundTrips(i, n, label) {
  const times = [];
  for (let k = 0; k < n; k++) {
    const token = `pong-${label}-${k}-${Math.random().toString(36).slice(2, 7)}`;
    const t0 = Date.now();
    await send(page, i, `"${token.replace('pong', 'PONG')}".ToLower()\r`);
    for (;;) {
      const t = await text(page, i, 12);
      if (t.split('\n').some((l) => l.trim() === token)) break;
      if (Date.now() - t0 > 15000) break;
      await sleep(15);
    }
    times.push(Date.now() - t0);
    await sleep(120);
  }
  times.sort((a, b) => a - b);
  return { median: times[Math.floor(times.length / 2)], max: times[times.length - 1], times };
}

/** Longest stall of the window's own event loop over a period. */
const startLagProbe = () =>
  page.evaluate(() => {
    window.__lag = { max: 0, last: performance.now(), n: 0 };
    window.__lagTimer = setInterval(() => {
      const now = performance.now();
      window.__lag.max = Math.max(window.__lag.max, now - window.__lag.last);
      window.__lag.last = now;
      window.__lag.n++;
    }, 20);
  });
const stopLagProbe = () =>
  page.evaluate(() => {
    clearInterval(window.__lagTimer);
    return Math.round(window.__lag.max);
  });

const FLOOD = `1..4000000 | ForEach-Object { "flood $_ " + ('#' * 160) }\r`;

try {
  await page.evaluate(() => window.__termdeck.app.setSplit(2));
  await resize(page, 1700, 850);
  const quiet = await open(0);
  const noisy = await open(1);
  const hidden = await open(1); // replaces `noisy` in pane 1; shown later
  await page.evaluate((i) => window.__termdeck.app.showTab(window.__termdeck.app.tabs[i], 1), noisy);
  await sleep(2500);

  // ---- baseline ----
  await startLagProbe();
  const base = await roundTrips(quiet, 8, 'base');
  const baseLag = await stopLagProbe();
  console.log(`baseline:              round trip median ${base.median} ms, max ${base.max} ms; longest window stall ${baseLag} ms`);

  // ---- flood in a VISIBLE neighbouring tab ----
  await send(page, noisy, FLOOD);
  await sleep(2500);
  await shot(page, '05-a-flood-visible');
  await startLagProbe();
  const vis = await roundTrips(quiet, 10, 'vis');
  const visLag = await stopLagProbe();
  let st = await info(page);
  console.log(`visible tab flooding:  round trip median ${vis.median} ms, max ${vis.max} ms; longest window stall ${visLag} ms`);
  check('quiet tab stays responsive while a visible tab floods', vis.median < 400 && vis.max < 2000, `median ${vis.median} ms, max ${vis.max} ms (baseline ${base.median}/${base.max})`);
  check('window keeps drawing while a visible tab floods', visLag < 400, `longest stall ${visLag} ms`);
  check('flooding tab is shown as working, quiet tab is not', st[noisy].activity === 'working' && st[quiet].activity !== 'working', `noisy=${st[noisy].activity} quiet=${st[quiet].activity}`);

  // ---- same flood, tab now HIDDEN (another tab shown in its pane) ----
  await page.evaluate((i) => window.__termdeck.app.showTab(window.__termdeck.app.tabs[i], 1), hidden);
  await page.evaluate((i) => window.__termdeck.app.showTab(window.__termdeck.app.tabs[i], 0), quiet);
  await sleep(1500);
  await startLagProbe();
  const hid = await roundTrips(quiet, 10, 'hid');
  const hidLag = await stopLagProbe();
  console.log(`hidden tab flooding:   round trip median ${hid.median} ms, max ${hid.max} ms; longest window stall ${hidLag} ms`);
  check('quiet tab stays responsive while a hidden tab floods', hid.median < 400 && hid.max < 2000, `median ${hid.median} ms, max ${hid.max} ms`);
  check('window keeps drawing while a hidden tab floods', hidLag < 400, `longest stall ${hidLag} ms`);

  // ---- two tabs flooding at once ----
  await send(page, hidden, FLOOD);
  await sleep(2500);
  await startLagProbe();
  const two = await roundTrips(quiet, 10, 'two');
  const twoLag = await stopLagProbe();
  console.log(`two tabs flooding:     round trip median ${two.median} ms, max ${two.max} ms; longest window stall ${twoLag} ms`);
  check('quiet tab stays responsive while two tabs flood', two.median < 500 && two.max < 2500, `median ${two.median} ms, max ${two.max} ms`);
  await shot(page, '05-b-two-floods');

  // ---- memory stays bounded ----
  st = await info(page);
  check('scrollback of a flooding tab is capped', st[noisy].scrollback <= 10000 && st[hidden].scrollback <= 10000, `noisy=${st[noisy].scrollback} hidden=${st[hidden].scrollback} lines`);
  const heap = await page.evaluate(() => Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576));
  console.log(`window script memory with two floods running: ${heap} MB`);

  // ---- stop one flood with Ctrl+C: it must recover, the other keeps going ----
  await send(page, noisy, '\x03');
  await sleep(2500);
  await send(page, noisy, '"recovered-" + (6*7)\r');
  let recovered = false;
  for (let k = 0; k < 60 && !recovered; k++) {
    recovered = /recovered-42/.test(await text(page, noisy, 8));
    await sleep(200);
  }
  check('flooded tab takes input again after Ctrl+C', recovered);

  // ---- kill a tab's shell from outside: only that tab ends ----
  const pidHidden = await page.evaluate((i) => window.__termdeck.app.tabs[i].pid, hidden);
  await send(page, quiet, `Stop-Process -Id ${pidHidden} -Force\r`);
  await page.waitForFunction((i) => window.__termdeck.app.tabs[i].exited, hidden, { timeout: 15000 }).catch(() => {});
  st = await info(page);
  check('a killed shell ends only its own tab', st[hidden].activity === 'exited' && st[quiet].activity !== 'exited' && st[noisy].activity !== 'exited', `killed=${st[hidden].activity} quiet=${st[quiet].activity} other=${st[noisy].activity}`);
  const after = await roundTrips(quiet, 4, 'after');
  check('other tabs still work after a neighbour was killed', after.max < 2000, `median ${after.median} ms`);

  // Enter restarts the ended tab.
  await page.evaluate((i) => {
    const a = window.__termdeck.app;
    a.showTab(a.tabs[i], 1);
    a.tabs[i].focus();
  }, hidden);
  await sleep(400);
  await page.keyboard.press('Enter');
  await page.waitForFunction((i) => !window.__termdeck.app.tabs[i].exited && window.__termdeck.app.tabs[i].pid, hidden, { timeout: 15000 }).catch(() => {});
  st = await info(page);
  check('pressing Enter restarts an ended tab', st[hidden].activity !== 'exited');
  await sleep(1500);
  await shot(page, '05-c-after-kill-and-restart');
  check('no page errors', app.errors.length === 0, app.errors.slice(0, 3).join(' | '));
} finally {
  await app.close();
}
process.exit(summary() ? 1 : 0);
