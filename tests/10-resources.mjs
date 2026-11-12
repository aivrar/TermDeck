// Per-tab processor / memory readouts, low priority, and the emergency stop.
// Makes tabs busy on purpose with tests\fixtures\hog.ps1 (every hog stops by itself
// after 60 s). For about 10 seconds part D keeps 8 processor cores busy, to check the
// window still answers and the Kill button works when the PC is under real load.
// usage: node 10-resources.mjs <data-dir> <work-dir> [cli|none]   (cli default: claude,
//        started once to check Resume is offered after a kill; nothing is sent to it)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch, shot, text, send, resize, sleep, check, summary, ROOT } from './harness.mjs';
import { ensureReady, focusTab } from './clis.mjs';

const [dataDir, workDir] = process.argv.slice(2);
const cli = process.argv[4] ?? 'claude';
const HOG = path.join(ROOT, 'tests', 'fixtures', 'hog.ps1');
const hog = (args) => `powershell -NoProfile -ExecutionPolicy Bypass -File "${HOG}" ${args}\r`;

const app = await launch({ dataDir });
const { page } = app;

const tabInfo = (i) =>
  page.evaluate((i) => {
    const t = window.__termdeck.app.tabs[i];
    return { cpu: t.cpu, mem: t.mem, procs: t.procs, pid: t.pid, exited: t.exited, low: t.lowPriority, resume: t.resumePending, cli: t.state.cli, cwd: t.state.cwd, running: t.cliRunning };
  }, i);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const priority = (pid) => {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).PriorityClass`], { encoding: 'utf8' }).trim();
  } catch {
    return 'gone';
  }
};
async function until(fn, timeout = 15000, step = 300) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) return false;
    await sleep(step);
  }
}
const pidFile = (name) => path.join(dataDir, name);
const readPids = (name) => (fs.existsSync(pidFile(name)) ? fs.readFileSync(pidFile(name), 'utf8').split(/\r?\n/).map((l) => Number(l.trim())).filter(Boolean) : []);
const newTab = (pane) =>
  page.evaluate(async ([cwd, pane]) => {
    const a = window.__termdeck.app;
    a.state.activePane = pane;
    await a.createTab({ shell: 'powershell', cwd, cli: 'none' });
    return a.tabs.length - 1;
  }, [workDir, pane]);
const pct = (n) => `${n.toFixed(1)}%`;
const mb = (n) => `${Math.round(n / 1048576)} MB`;

const strays = [];
try {
  await page.evaluate(() => window.__termdeck.app.setSplit(2));
  await resize(page, 1700, 820);
  await page.evaluate(() => window.__termdeck.app.toggleLibrary(false));
  const quiet = 0;
  const busy = await newTab(1);
  await sleep(3500);

  // ---- A. readings exist, and a quiet tab reads as quiet ----
  const sys = await page.evaluate(() => window.__termdeck.app.system);
  console.log(`PC: ${sys.cores} cores, CPU ${pct(sys.cpu)}, RAM ${mb(sys.memUsed)} / ${mb(sys.memTotal)}`);
  check('whole-PC reading is present', sys.cores > 0 && sys.memTotal > 0 && sys.memUsed > 0);
  const oneCore = 100 / sys.cores;
  let q = await tabInfo(quiet);
  console.log(`quiet tab: ${q.procs.length} process(es), CPU ${pct(q.cpu)}, RAM ${mb(q.mem)}`);
  check('a quiet shell is listed with its memory', q.procs.some((p) => p.pid === q.pid && p.name === 'powershell.exe') && q.mem > 5e6);
  check('a quiet shell reads as (nearly) no CPU', q.cpu < oneCore * 0.5, pct(q.cpu));
  const sysLine = await page.locator('#sys-usage').innerText();
  check('side panel shows the whole-PC line', /CPU .*%.*RAM .* \/ .*GB/.test(sysLine), sysLine);

  // ---- B. a busy tab: two orphans (their starter quits) + one spinner under the shell ----
  await send(page, busy, hog(`-Orphans 2 -PidFile "${pidFile('b.txt')}"`));
  await until(() => readPids('b.txt').length === 2);
  const orphans = readPids('b.txt');
  strays.push(...orphans);
  await sleep(800);
  await send(page, busy, hog('-Spin'));
  await sleep(5000);
  let b = await tabInfo(busy);
  q = await tabInfo(quiet);
  console.log(`busy tab: ${b.procs.length} processes, CPU ${pct(b.cpu)} (one core = ${pct(oneCore)}), RAM ${mb(b.mem)}`);
  console.log(b.procs.map((p) => `   ${p.name.padEnd(18)} ${String(p.pid).padStart(6)}  ${pct(p.cpu).padStart(6)}  ${mb(p.mem)}`).join('\n'));
  check('busy tab shows about three cores of CPU', b.cpu > oneCore * 2 && b.cpu < oneCore * 4.5, `${pct(b.cpu)} for 3 spinners`);
  check('orphans (starter already quit) are counted in the tab', orphans.every((pid) => b.procs.some((p) => p.pid === pid)), `orphans ${orphans.join(', ')}`);
  check('each spinner reads close to one core', orphans.every((pid) => { const p = b.procs.find((x) => x.pid === pid); return p && p.cpu > oneCore * 0.6 && p.cpu < oneCore * 1.4; }));
  check('the quiet tab is not charged for its neighbour', q.cpu < oneCore * 0.5, pct(q.cpu));
  const rowUse = await page.locator('.tab').nth(busy).locator('.t-use').innerText();
  check('tab row shows the usage', /%/.test(rowUse) && /MB|GB/.test(rowUse), rowUse.replace(/\n/g, ' / '));
  const paneUse = await page.locator('.pane').nth(1).locator('.p-use').innerText();
  check('pane header shows the usage', /CPU .*% · .*(MB|GB)/.test(paneUse), paneUse);
  await shot(page, '10-a-usage');

  // process list, "End" on one process
  await page.locator('.pane').nth(1).locator('.p-use').click();
  await page.locator('.proc-list .proc-row').first().waitFor({ timeout: 5000 });
  await sleep(1200);
  const listed = await page.locator('.proc-list .proc-row').count();
  check('process list shows every process of the tab', listed === (await tabInfo(busy)).procs.length && listed >= 4, `${listed} rows`);
  await shot(page, '10-b-processes');
  const victim = orphans[0];
  await page.locator('.proc-list .proc-row', { hasText: String(victim) }).locator('button').click();
  check('"End" stops just that process', await until(() => !alive(victim), 6000), `pid ${victim}`);
  check('…and leaves the others running', alive(orphans[1]) && alive(b.pid));
  await page.locator('.modal .foot button', { hasText: 'Close' }).click();

  // low priority
  await page.evaluate((i) => window.__termdeck.app.setLowPriority(window.__termdeck.app.tabs[i], true), busy);
  await sleep(600);
  const lowNow = [b.pid, orphans[1]].map(priority);
  check('low priority reaches the shell and the orphan', lowNow.every((p) => p === 'Idle'), lowNow.join(', '));
  check('tab is marked as low priority', (await tabInfo(busy)).low && /low/.test(await page.locator('.pane').nth(1).locator('.p-use').innerText()));
  await page.evaluate((i) => window.__termdeck.app.setLowPriority(window.__termdeck.app.tabs[i], false), busy);
  await sleep(600);
  const normalNow = [b.pid, orphans[1]].map(priority);
  check('back to normal priority', normalNow.every((p) => p === 'Normal'), normalNow.join(', '));

  // ---- C. emergency stop by hotkey ----
  await focusTab(page, busy);
  await sleep(300);
  b = await tabInfo(busy);
  const before = b.procs.map((p) => p.pid);
  const quietPid = (await tabInfo(quiet)).pid;
  await page.keyboard.press('Control+Shift+K');
  await sleep(1200);
  check('one press of Ctrl+Shift+K only warns', alive(b.pid) && alive(orphans[1]) && /again/.test(await page.locator('#toasts').innerText()));
  await sleep(2600); // the warning lapses
  await page.keyboard.press('Control+Shift+K');
  await page.keyboard.press('Control+Shift+K');
  const allGone = await until(() => before.every((pid) => !alive(pid)), 8000);
  check('Ctrl+Shift+K twice ends everything the tab started', allGone, `${before.length} processes: ${before.filter(alive).length} still alive`);
  const back = await until(async () => { const t = await tabInfo(busy); return !t.exited && t.pid && t.pid !== b.pid ? t : false; }, 8000);
  check('the shell comes back by itself, in the same folder', !!back && back.cwd === b.cwd, back ? `new pid ${back.pid}` : 'no new shell');
  check('the tab says what happened', /everything in this tab was stopped/.test(await text(page, busy, 40)));
  await sleep(1500);
  await send(page, busy, 'echo BACK-OK\r');
  check('the new shell works', await until(async () => /^BACK-OK$/m.test(await text(page, busy, 20)), 8000));
  await send(page, quiet, 'echo NEIGHBOUR-OK\r');
  check('the other tab was not touched', (await tabInfo(quiet)).pid === quietPid && (await until(async () => /^NEIGHBOUR-OK$/m.test(await text(page, quiet, 20)), 8000)));

  // ---- D. real load: 8 cores busy. Does the window still answer, does Kill work? ----
  await send(page, busy, hog(`-Orphans 8 -PidFile "${pidFile('d.txt')}"`));
  await until(() => readPids('d.txt').length === 8, 20000);
  const heavy = readPids('d.txt');
  strays.push(...heavy);
  const row = page.locator('.tab').nth(busy);
  const hot = await until(async () => (await row.getAttribute('class')).includes('hot'), 12000);
  b = await tabInfo(busy);
  const sysHot = await page.evaluate(() => window.__termdeck.app.system);
  console.log(`under load: tab CPU ${pct(b.cpu)}, whole PC ${pct(sysHot.cpu)}`);
  check('a tab using most of the PC is flagged hot', !!hot && b.cpu > 50, pct(b.cpu));
  check('a Kill button appears on the hot tab', await row.locator('.t-kill').isVisible());
  await shot(page, '10-c-hot');
  // how long the window takes to answer while the PC is loaded
  const laps = [];
  for (let n = 0; n < 8; n++) {
    const t0 = Date.now();
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    laps.push(Date.now() - t0);
    await sleep(60);
  }
  check('the window still answers under load', Math.max(...laps) < 500, `frame round trips ${laps.join(', ')} ms`);
  await row.locator('.t-kill').click();
  await sleep(400);
  check('first click on Kill only asks', (await row.locator('.t-kill').innerText()) === 'Sure?' && heavy.every(alive));
  const t0 = Date.now();
  await row.locator('.t-kill').click();
  const cleared = await until(() => heavy.every((pid) => !alive(pid)), 8000, 100);
  check('second click ends all 8 at once', cleared, `${heavy.filter(alive).length} left after ${Date.now() - t0} ms`);
  const cooled = await until(async () => !(await row.getAttribute('class')).includes('hot') && (await tabInfo(busy)).cpu < oneCore, 8000);
  check('the tab cools down and the shell is back', !!cooled && !(await tabInfo(busy)).exited);

  // ---- E. memory ----
  await sleep(1500);
  const memBefore = (await tabInfo(busy)).mem;
  await send(page, busy, hog(`-AllocMB 300 -PidFile "${pidFile('e.txt')}" -Seconds 40`));
  await until(() => fs.existsSync(pidFile('e.txt')), 20000);
  await sleep(2200);
  const memAfter = (await tabInfo(busy)).mem;
  check('memory held by a program shows up on its tab', memAfter - memBefore > 250e6, `${mb(memBefore)} -> ${mb(memAfter)}`);
  await page.evaluate((i) => window.__termdeck.app.killTab(window.__termdeck.app.tabs[i]), busy);
  check('…and is released by the emergency stop', await until(async () => { const t = await tabInfo(busy); return !t.exited && t.mem < memBefore + 100e6 && t.mem > 0; }, 10000));

  // ---- F. leftovers of a tab whose shell has ended ----
  await sleep(1500);
  await send(page, busy, hog(`-Orphans 1 -PidFile "${pidFile('f.txt')}"`));
  await until(() => readPids('f.txt').length === 1, 20000);
  const [left] = readPids('f.txt');
  strays.push(left);
  await sleep(800);
  await send(page, busy, 'exit\r');
  await until(async () => (await tabInfo(busy)).exited, 8000);
  await sleep(2500);
  b = await tabInfo(busy);
  check('a program left running by an ended tab is still shown on it', b.exited && b.procs.some((p) => p.pid === left), `${b.procs.length} process(es), CPU ${pct(b.cpu)}`);
  await page.evaluate((i) => window.__termdeck.app.killTab(window.__termdeck.app.tabs[i]), busy);
  check('…and can be stopped from there', await until(() => !alive(left), 8000));

  // ---- G. a CLI is running when the tab is killed: Resume must be offered ----
  if (cli !== 'none') {
    await focusTab(page, busy);
    await page.keyboard.press('Enter'); // an ended tab starts its shell again on Enter
    await until(async () => !(await tabInfo(busy)).exited, 8000);
    await sleep(2500);
    await send(page, busy, `${cli}\r`);
    const started = await ensureReady(page, busy, cli);
    check(`${cli}: started`, started);
    if (started) {
      b = await tabInfo(busy);
      const cliPids = b.procs.filter((p) => p.name.startsWith(cli)).map((p) => p.pid);
      console.log(`${cli} tab: ${b.procs.length} processes, CPU ${pct(b.cpu)}, RAM ${mb(b.mem)}`);
      await page.evaluate((i) => window.__termdeck.app.killTab(window.__termdeck.app.tabs[i]), busy);
      check(`${cli}: ended by the emergency stop`, cliPids.length > 0 && (await until(() => cliPids.every((pid) => !alive(pid)), 8000)));
      const after = await until(async () => { const t = await tabInfo(busy); return !t.exited && t.pid !== b.pid && t.resume ? t : false; }, 10000);
      const bar = page.locator('.pane').nth(1).locator('.resume-bar');
      await sleep(800);
      check(`${cli}: the tab comes back with Resume offered`, !!after && after.cli === cli && (await bar.isVisible()), after ? (await bar.locator('.grow').innerText()).slice(0, 110) : 'no resume');
      await shot(page, '10-d-after-kill');
    }
  }
  check('no page errors', app.errors.length === 0, app.errors.slice(0, 3).join(' | '));
} finally {
  await app.close();
  // Belt and braces: nothing this test started may outlive it.
  for (const pid of strays) {
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
  }
}
process.exit(summary() ? 1 : 0);
