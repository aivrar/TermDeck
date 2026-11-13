// Process control: whatever a tab starts stays the tab's — counted, and ended with it.
//   1  programs started from Git Bash stay in the tab's job: in a Git Bash tab, and run
//      through bash the way Claude Code runs its commands, also in the background with
//      their starter already gone. Shown in the tab, ended by its Kill. (Git Bash used to
//      take them out of the job, so they were counted nowhere and outlived Kill and close.)
//   2  when TermDeck itself ends unexpectedly (a crash, Task Manager's End task), its
//      crash guard ends what its tabs were running — windowless programs included
//   3  low priority holds for programs a tab starts after it was set, and "back to
//      normal" undoes it
//   4  the WSL virtual machine is shown beside the PC totals when it runs
//   5  with a running WSL distro: Linux work started in the background through Git Bash
//      ends when the app closes
//   6  a window that has hung still closes from its X, and its tabs' programs end
// usage: node 22-process-control.mjs <data-dir> <work-dir> [wsl-distro]
//
// Sends no prompt and starts none of the three CLIs. Its markers are small node
// programs with no console window (like a headless browser), started through a
// launcher that exits at once; with a running distro, `sleep` inside it. (In a Git Bash
// tab they are started as node.exe: Git Bash's own start-up file makes `node` mean
// `winpty node`, which will not run in the background.) All are ended
// at the end, whatever happens.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch, shot, send, sleep, check, summary } from './harness.mjs';

const [dataDir, workDir, distro] = process.argv.slice(2);
fs.mkdirSync(workDir, { recursive: true });
const BASH = String.raw`C:\Program Files\Git\usr\bin\bash.exe`;
const hasBash = fs.existsSync(BASH);

// The launcher starts a detached, windowless node that just waits, then exits itself.
const launcher = path.join(workDir, 'td-spawn-marker.js');
fs.writeFileSync(launcher, [
  "const { spawn } = require('child_process');",
  "const tag = 'td-marker-' + process.argv[2];",
  "spawn(process.execPath, ['-e', 'setTimeout(()=>{},600000)', tag], { detached: true, stdio: 'ignore', windowsHide: true }).unref();",
].join('\n'));
const fwd = (p) => p.replace(/\\/g, '/');
const ps = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).trim();
/** pid -> priority class of each running marker with this number. */
const markers = (n) => {
  const out = ps(`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? { $_.CommandLine -match 'td-marker-${n}\\b' } | % { '{0} {1}' -f $_.ProcessId, $_.Priority }`);
  return out ? out.split(/\r?\n/).map((l) => l.trim().split(' ').map(Number)) : [];
};
const cleanup = () => {
  try {
    ps(`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? { $_.CommandLine -match 'td-marker-\\d+' } | % { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }`);
  } catch { /* nothing to end */ }
  if (distro) {
    try { execFileSync('wsl.exe', ['-d', distro, '--', 'sh', '-c', "pkill -f 'sleep 7613' || true"]); } catch { /* distro gone */ }
  }
};
const until = async (fn, timeout = 15000, step = 250) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v || Date.now() - t0 > timeout) return v;
    await sleep(step);
  }
};
const newTab = (page, shell) => page.evaluate(async ([shell, cwd]) => {
  const a = window.__termdeck.app;
  await a.createTab({ shell, cwd, cli: 'none' });
  return a.tabs.length - 1;
}, [shell, workDir]);
const shown = (page, i) => page.evaluate((i) => (window.__termdeck.app.tabs[i].procs ?? []).map((p) => p.pid), i);

cleanup();
let app = await launch({ dataDir, port: 9372 });
let page = app.page;
try {
  // ---- 1: programs started from Git Bash stay the tab's ----
  if (!hasBash) {
    console.log('(Git Bash is not installed: part 1 skipped)');
  } else {
    const L = fwd(launcher);
    const cases = [
      { n: 5001, shell: 'gitbash', what: 'Git Bash tab, in the background', cmd: `node.exe '${L}' 5001 &\r` },
      { n: 5002, shell: 'gitbash', what: 'Git Bash tab, in the background with its starter gone', cmd: `(node.exe '${L}' 5002 &)\r` },
      { n: 5003, shell: 'powershell', what: "PowerShell tab, bash -c '(… &)' as Claude Code runs a background command", cmd: `& '${BASH}' -c "(node '${L}' 5003 &)"\r` },
      { n: 5004, shell: 'powershell', what: 'PowerShell tab, through bash that keeps running', cmd: `& '${BASH}' -c "node '${L}' 5004; sleep 600"\r` },
      { n: 5005, shell: 'cmd', what: 'cmd tab, start /b', cmd: `start /b node "${launcher}" 5005\r` },
    ];
    for (const c of cases) c.tab = await newTab(page, c.shell);
    await sleep(3500);
    for (const c of cases) { await send(page, c.tab, c.cmd); await sleep(300); }
    for (const c of cases) c.pid = (await until(() => markers(c.n)[0]?.[0], 15000)) ?? 0;
    await sleep(2500); // a look at the processes or two
    for (const c of cases) {
      check(`1 started: ${c.what}`, c.pid > 0);
      const has = c.pid > 0 && (await until(async () => (await shown(page, c.tab)).includes(c.pid), 6000));
      check(`1 counted in its tab: ${c.what}`, has);
    }
    await shot(page, '22-process-control');
    await page.evaluate(async (tabs) => { const a = window.__termdeck.app; for (const i of tabs) await a.killTab(a.tabs[i]); }, cases.map((c) => c.tab));
    await sleep(2500);
    for (const c of cases) check(`1 ended by the tab's Kill: ${c.what}`, c.pid > 0 && markers(c.n).length === 0);
    const said = await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | '));
    check('1 Kill does not report anything it could not stop', !/could not be stopped/.test(said), said.slice(0, 200));
  }

  // ---- 3: low priority covers what is started later, and is undone ----
  {
    const i = await newTab(page, 'powershell');
    await sleep(3000);
    await page.evaluate(async (i) => { const a = window.__termdeck.app; await a.setLowPriority(a.tabs[i], true); }, i);
    const low = await page.evaluate((i) => window.__termdeck.app.tabs[i].lowPriority, i);
    check('3 the tab is marked low priority', low === true);
    await send(page, i, `node "${launcher}" 5021\r`);
    const m = await until(() => markers(5021)[0], 15000);
    // Win32_Process.Priority: 4 = idle (low), 8 = normal.
    check('3 a program started after low priority was set runs at low priority', m && m[1] === 4, JSON.stringify(m));
    await page.evaluate(async (i) => { const a = window.__termdeck.app; await a.setLowPriority(a.tabs[i], false); }, i);
    await sleep(500);
    const back = markers(5021)[0];
    check('3 back to normal puts it back to normal priority', back && back[1] === 8, JSON.stringify(back));
    await page.evaluate(async (i) => { const a = window.__termdeck.app; await a.killTab(a.tabs[i]); }, i);
    await sleep(1500);
  }

  // ---- 4: the WSL virtual machine beside the PC totals ----
  {
    const vm = ps(`@(Get-Process | ? { $_.Name -like 'vmmem*' }).Count`) !== '0';
    if (!vm) {
      console.log('(the WSL virtual machine is not running: part 4 skipped)');
    } else {
      const sys = await until(() => page.evaluate(() => window.__termdeck.app.system), 6000);
      check('4 the WSL VM is reported while it runs', sys?.wsl === true && sys.wslMem > 0, JSON.stringify(sys));
      const text = await page.evaluate(() => document.getElementById('sys-usage')?.textContent ?? '');
      check('4 and shown beside the PC totals', /WSL VM/.test(text), text);
    }
  }

  // ---- 5: Linux work started in the background through Git Bash ends with the app ----
  if (distro && hasBash) {
    const i = await newTab(page, 'powershell');
    await sleep(3000);
    await send(page, i, `& '${BASH}' -c "(wsl.exe -d '${distro}' -- sh -c 'sleep 7613' &)"\r`);
    const running = () => execFileSync('wsl.exe', ['-d', distro, '--', 'sh', '-c', "ps -eo args | grep -c '^sleep 7613' || true"], { encoding: 'utf8' }).trim();
    check('5 the Linux program started', (await until(() => running() !== '0', 15000)) === true);
    await app.close();
    await sleep(4000);
    check('5 it ended when the app closed', running() === '0');
    app = await launch({ dataDir, port: 9372 });
    page = app.page;
  } else {
    console.log('(no running WSL distro given, or no Git Bash: part 5 skipped)');
  }

  // ---- 6: the X still closes the app when the window has hung ----
  {
    const i = await newTab(page, 'powershell');
    await sleep(3000);
    await send(page, i, `node "${launcher}" 5041\r`);
    check('6 marker 5041 started', !!(await until(() => markers(5041)[0], 15000)));
    const pid = app.proc.pid;
    // The page's script is kept busy for 30 s: it cannot answer anything.
    page.evaluate(() => { const end = Date.now() + 30000; while (Date.now() < end) { /* hung */ } }).catch(() => {});
    await sleep(1000);
    // What the X does: Windows sends the window WM_CLOSE.
    ps(`Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);'; $h = (Get-Process -Id ${pid}).MainWindowHandle; [void][W.U]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)`);
    const t0 = Date.now();
    const gone = await until(() => ps(`@(Get-Process -Id ${pid} -EA SilentlyContinue).Count`) === '0', 20000, 500);
    check('6 a hung window still closes from its X', gone === true, `after ${Date.now() - t0} ms`);
    check('6 and what its tabs ran ended with it', markers(5041).length === 0);
    await app.browser.close().catch(() => {});
    app = await launch({ dataDir, port: 9372 });
    page = app.page;
  }

  // ---- 2: TermDeck ending unexpectedly takes what its tabs ran with it ----
  {
    const guards = ps(`@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${app.proc.pid}" | ? { $_.CommandLine -match '--termdeck-guard' }).Count`);
    check('2 the crash guard runs beside TermDeck', guards === '1', guards);
    const tabs = [];
    tabs.push({ n: 5031, i: await newTab(page, 'powershell'), cmd: `node "${launcher}" 5031\r` });
    if (hasBash) tabs.push({ n: 5032, i: await newTab(page, 'gitbash'), cmd: `(node.exe '${fwd(launcher)}' 5032 &)\r` });
    await sleep(3500);
    for (const t of tabs) await send(page, t.i, t.cmd);
    for (const t of tabs) check(`2 marker ${t.n} started`, !!(await until(() => markers(t.n)[0], 15000)));
    // Ended the hard way, like a crash or Task Manager's End task: nothing is closed.
    ps(`Stop-Process -Id ${app.proc.pid} -Force`);
    await app.browser.close().catch(() => {});
    await sleep(3000);
    for (const t of tabs) check(`2 a windowless program in a tab (${t.n === 5031 ? 'PowerShell' : 'Git Bash, background'}) ended with TermDeck`, markers(t.n).length === 0);
    app = null;
  }
} finally {
  if (app) await app.close().catch(() => {});
  cleanup();
  fs.rmSync(launcher, { force: true });
}
process.exit(summary() ? 1 : 0);
