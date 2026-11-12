// Protections against lost work and stray processes, each shown on the real app:
//   A1  a closed tab no longer stays in memory
//   A3  switches are merged whole, never word by word
//   A4  a saved file that cannot be read is never overwritten without a copy
//   B3  a resume command whose typing cannot be confirmed is not run
//   B4  resume does not type into a tab that is busy, or (automatic) one you are typing in
//   B1  closing a tab or the app ends everything the tab started — after asking;
//       the emergency stop does not ask
// It starts short-lived `ping` processes (hidden, ~2 minutes at most) and ends them.
// usage: node 16-audit-fixes.mjs <data-dir> <work-dir> [cli|none]
//   cli (default claude): started once, nothing is sent to it, to check that closing its
//   tab lets the CLI quit by itself instead of ending it by force.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { launch, shot, text, send, sleep, check, summary } from './harness.mjs';
import { ensureReady } from './clis.mjs';

const [dataDir, workDir] = process.argv.slice(2);
const cli = process.argv[4] ?? 'claude';
const sub = (name) => `${dataDir}-${name}`;
for (const d of ['a4a', 'a4b', 'a4c']) fs.rmSync(sub(d), { recursive: true, force: true });

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(fn, timeout = 15000, step = 250) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) return false;
    await sleep(step);
  }
}
const strays = new Set();

// ======================================================================
// Part 1 — one app run: A1, A3, B3, B4, B1 (tabs)
// ======================================================================
let app = await launch({ dataDir });
let page = app.page;
const ev = (fn, arg) => page.evaluate(fn, arg);
const newTab = (shell = 'powershell') =>
  page.evaluate(async ([shell, cwd]) => {
    const a = window.__termdeck.app;
    await a.createTab({ shell, cwd, cli: 'none' });
    return a.tabs.length - 1;
  }, [shell, workDir]);
const tabCount = () => page.evaluate(() => window.__termdeck.app.tabs.length);
const modals = () => page.locator('.modal').count();
const toasts = () => page.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent).join(' || '));
/** Process ids the app lists for a tab, by program name. */
const procsNamed = (i, name) => page.evaluate(([i, name]) => window.__termdeck.app.tabs[i].procs.filter((p) => p.name === name).map((p) => p.pid), [i, name]);
const clickClose = async (i) => {
  await page.locator('#tablist .tab').nth(i).hover();
  await page.locator('#tablist .tab').nth(i).locator('.t-close').click();
  await sleep(450);
};

try {
  await ev(() => window.__termdeck.app.toggleLibrary(false));

  // ---------- A1: closed tabs are released ----------
  {
    const cdp = await page.context().newCDPSession(page);
    const terminals = async () => {
      await sleep(2500);
      await ev(() => { const a = window.__termdeck.app; a.showTab(a.tabs[0]); a.tabs[0].focus(); });
      await sleep(1200);
      for (let i = 0; i < 4; i++) await cdp.send('HeapProfiler.collectGarbage');
      const proto = await cdp.send('Runtime.evaluate', { expression: 'window.__termdeck.app.tabs[0].term.constructor.prototype', objectGroup: 'a1' });
      const objs = await cdp.send('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId, objectGroup: 'a1' });
      const len = await cdp.send('Runtime.callFunctionOn', { objectId: objs.objects.objectId, functionDeclaration: 'function(){return this.length}', returnByValue: true });
      await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'a1' });
      return len.result.value;
    };
    const before = await terminals();
    const open = await tabCount();
    // Exactly the case that leaked: the tab is closed while it has the keyboard.
    const asked = await page.evaluate(async (cwd) => {
      const a = window.__termdeck.app;
      const pause = (ms) => new Promise((r) => setTimeout(r, ms));
      let asked = 0;
      for (let i = 0; i < 8; i++) {
        const t = await a.createTab({ shell: 'powershell', cwd, cli: 'none' });
        t.focus();
        await pause(1300);
        // A shell can run a helper for a moment while it starts; wait until it is just a shell.
        for (let n = 0; n < 40 && (t.activity !== 'idle' || t.running().length); n++) await pause(150);
        t.focus();
        const closed = a.closeTab(t);
        // Should the app ask after all, answer it rather than hang — and say so below.
        for (let n = 0; n < 10 && a.tabs.includes(t); n++) {
          await pause(100);
          const btn = document.querySelector('.modal .foot .btn.primary');
          if (btn) {
            asked++;
            btn.click();
          }
        }
        await closed;
      }
      return asked;
    }, workDir);
    const after = await terminals();
    check('A1: 8 tabs opened, focused and closed leave no terminal in memory', after === open && before === open, `open tabs ${open}; terminals alive before ${before}, after ${after}${asked ? `; the app asked before ${asked} of the closes` : ''}`);
    await cdp.detach().catch(() => {});
  }

  // ---------- A3: switches are merged whole ----------
  {
    const cases = [
      ['', '-c a=1 -c b=2', '-c a=1 -c b=2'],
      ['-c a=1', '-c a=1 -c b=2', '-c a=1 -c b=2'],
      ['--model foo', '--other foo', '--model foo --other foo'],
      ['--dangerously-skip-permissions', '--dangerously-skip-permissions --model opus', '--dangerously-skip-permissions --model opus'],
      ['--add-dir "C:\\My Work"', '--add-dir "C:\\My Work" --add-dir D:\\x', '--add-dir "C:\\My Work" --add-dir D:\\x'],
      ['  ', '', ''],
    ];
    const got = await ev((cases) => cases.map(([d, o]) => window.__termdeck.mergeFlags(d, o)), cases);
    const bad = cases.map((c, i) => (got[i] === c[2] ? null : `[${c[0]}]+[${c[1]}] gave [${got[i]}]`)).filter(Boolean);
    check('A3: a repeated switch name keeps each of its values (-c a=1 -c b=2 stays as typed)', bad.length === 0, bad.join('; ') || got[0]);
    const cmd = await ev(() => {
      const a = window.__termdeck.app;
      const t = a.tabs[0];
      const keep = { cli: t.state.cli, sessionId: t.state.sessionId, flags: t.state.flags, all: a.state.cliFlags.codex };
      a.state.cliFlags.codex = '-c a=1';
      Object.assign(t.state, { cli: 'codex', sessionId: '01a1cd46-0000-7000-8000-000000000000', flags: '-c b=2 --model x' });
      const out = t.resumeCommand();
      a.state.cliFlags.codex = keep.all;
      Object.assign(t.state, { cli: keep.cli, sessionId: keep.sessionId, flags: keep.flags });
      return out;
    });
    check('A3: the resume command carries both', cmd === 'codex resume 01a1cd46-0000-7000-8000-000000000000 -c a=1 -c b=2 --model x', cmd);
  }

  // ---------- B4: resume and a busy or typed-in tab ----------
  const b4 = await newTab();
  await sleep(3500);
  {
    const fresh = await ev((i) => { const t = window.__termdeck.app.tabs[i]; return { typed: t.userTyped, free: t.promptFree() }; }, b4);
    check('B4: a tab nobody has typed in is not taken for typed-in (the terminal\'s own replies do not count)', fresh.typed === false && fresh.free === true, JSON.stringify(fresh));
    await send(page, b4, 'ping -n 25 127.0.0.1\r');
    await sleep(2500);
    const during = await ev((i) => {
      const a = window.__termdeck.app;
      const t = a.tabs[i];
      Object.assign(t.state, { cli: 'claude', sessionId: '00000000-0000-4000-8000-00000000b4b4' });
      t.resumePending = true;
      const free = t.promptFree();
      const typedIt = a.resumeTab(t);
      return { free, typedIt, pending: t.resumePending };
    }, b4);
    await sleep(1500);
    const shown = await text(page, b4, 40);
    check('B4: Resume in a tab where a command is running types nothing and says why', during.free === false && during.typedIt === false && during.pending === true && !/claude --resume/.test(shown) && /Something is running in/.test(await toasts()), JSON.stringify(during));
    await ev((i) => window.__termdeck.app.resumeAll(undefined, false), b4);
    await sleep(1200);
    check('B4: "Resume all" leaves that tab alone too', !/claude --resume/.test(await text(page, b4, 40)) && /Not resumed/.test(await toasts()));
    await send(page, b4, '\x03');
    const back = await until(() => ev((i) => window.__termdeck.app.tabs[i].promptFree(), b4), 8000);
    check('B4: once the command has ended the tab counts as free again', back === true);
    // Automatic resume and a tab the user has started typing in.
    const typed = await ev(async (i) => {
      const a = window.__termdeck.app;
      const t = a.tabs[i];
      t.userTyped = false;
      t.term.input('dir', true); // exactly what a keystroke does
      await new Promise((r) => setTimeout(r, 400));
      const flagged = t.userTyped;
      await a.resumeAll(undefined, true);
      return { flagged, pending: t.resumePending };
    }, b4);
    await sleep(1500);
    const line = await text(page, b4, 6);
    check('B4: automatic resume does not clear and type over a line you have started', typed.flagged === true && typed.pending === true && !/claude --resume/.test(line) && /dir\s*$/.test(line), `${JSON.stringify(typed)} last line: ${line.split('\n').pop()}`);
    await send(page, b4, '\x1b');
    await ev((i) => { const t = window.__termdeck.app.tabs[i]; Object.assign(t.state, { cli: 'none', sessionId: undefined }); t.resumePending = false; }, b4);
  }

  // ---------- B3: typing that cannot be confirmed is not run ----------
  {
    await sleep(600);
    await ev((i) => {
      const t = window.__termdeck.app.tabs[i];
      window.__b3 = { notRun: false };
      t.typedSoFar = () => ''; // a shell whose echo cannot be read back
      t.runWhenQuiet('echo ("td-b3-"+"ran")', () => (window.__b3.notRun = true));
    }, b4);
    const told = await until(() => ev(() => window.__b3.notRun), 15000);
    const said = await toasts();
    await sleep(800);
    const out = await text(page, b4, 30);
    check('B3: after four unconfirmed attempts Enter is NOT pressed', told === true && !/td-b3-ran/.test(out), out.split('\n').slice(-2).join(' / '));
    check('B3: the user is told to check the line', /Enter was not pressed/.test(said), said.slice(0, 160));
    check('B3: the command is left at the prompt once, not typed on top of itself', (out.match(/echo \("td-b3-"\+"ran"\)/g) ?? []).length === 1);
    await ev((i) => { delete window.__termdeck.app.tabs[i].typedSoFar; }, b4);
    await send(page, b4, '\x1b');
    // And the normal path still runs a command.
    await sleep(500);
    await ev((i) => window.__termdeck.app.tabs[i].runWhenQuiet('echo ("td-b3-"+"ok")'), b4);
    check('B3: a command whose typing is confirmed still runs', !!(await until(async () => /td-b3-ok/.test(await text(page, b4, 30)), 8000)));
  }

  // ---------- B1: closing a tab ----------
  {
    // An idle shell and nothing else: no question.
    const idle = await newTab();
    await sleep(3000);
    const n0 = await tabCount();
    await clickClose(idle);
    check('B1: closing a tab with only an idle shell asks nothing', (await modals()) === 0 && (await tabCount()) === n0 - 1);

    // Background programs that have no terminal: these used to run on after the tab closed.
    const ps = await newTab('powershell');
    const cmdTab = await newTab('cmd');
    await sleep(3500);
    await send(page, ps, "Start-Process ping -ArgumentList '-n','120','127.0.0.1' -WindowStyle Hidden; $null = Start-Job { ping -n 120 127.0.0.1 }\r");
    await send(page, cmdTab, 'start /b ping -n 120 127.0.0.1 >nul\r');
    const psPings = await until(async () => { const p = await procsNamed(ps, 'ping.exe'); return p.length >= 2 ? p : false; }, 20000);
    const cmdPings = await until(async () => { const p = await procsNamed(cmdTab, 'ping.exe'); return p.length >= 1 ? p : false; }, 20000);
    const jobShells = await procsNamed(ps, 'powershell.exe');
    const psPid = await ev((i) => window.__termdeck.app.tabs[i].pid, ps);
    const background = [...(psPings || []), ...(cmdPings || []), ...jobShells.filter((p) => p !== psPid)];
    background.forEach((p) => strays.add(p));
    check('B1: (setup) background programs are running in two tabs', !!psPings && !!cmdPings && background.every(alive), `ids ${background.join(', ')}`);
    await sleep(1500);

    const n1 = await tabCount();
    await clickClose(ps);
    const asked = await page.locator('.modal').innerText().catch(() => '');
    check('B1: closing a tab with background programs asks first and names them', /Close this session\?/.test(asked) && /ping/.test(asked), asked.replace(/\s+/g, ' ').slice(0, 200));
    await shot(page, '16-a-close-tab-asks');
    await page.locator('.modal .foot .btn', { hasText: 'Cancel' }).click();
    await sleep(600);
    check('B1: Cancel keeps the tab and everything in it', (await tabCount()) === n1 && background.every(alive));
    await clickClose(ps);
    await page.locator('.modal .foot .btn.primary').click();
    const psGone = await until(() => (psPings || []).every((p) => !alive(p)) && jobShells.every((p) => !alive(p)) && !alive(psPid), 9000);
    check('B1: confirming ends the shell, the hidden program and the background job', psGone === true && (await tabCount()) === n1 - 1, `of that tab still alive: ${[...(psPings || []), ...jobShells].filter(alive).join(', ') || 'none'}`);
    check('B1: …and leaves the other tab\'s program alone', (cmdPings || []).every(alive));

    // The emergency stop asks nothing.
    const cmdIndex = await ev((pid) => window.__termdeck.app.tabs.findIndex((t) => t.procs.some((p) => p.pid === pid)), (cmdPings || [0])[0]);
    await ev((i) => void window.__termdeck.app.killTab(window.__termdeck.app.tabs[i]), cmdIndex);
    await sleep(500);
    const askedOnKill = await modals();
    const killed = await until(() => (cmdPings || []).every((p) => !alive(p)), 9000);
    const shellBack = await until(() => ev((i) => { const t = window.__termdeck.app.tabs[i]; return !t.exited && t.pid; }, cmdIndex), 9000);
    check('B1: the emergency stop asks nothing, ends everything, and brings the shell back', askedOnKill === 0 && killed === true && !!shellBack);
  }

  // ---------- B1: a CLI is given the time to quit by itself ----------
  if (cli !== 'none') {
    const claudeJson = path.join(os.homedir(), '.claude.json');
    const strikes = () => {
      try {
        return (fs.readFileSync(claudeJson, 'utf8').match(/"fullscreenAutoDisabled"\s*:\s*\{[^}]*\}/) ?? ['none'])[0].replace(/\s+/g, ' ');
      } catch {
        return 'unreadable';
      }
    };
    const strikesBefore = strikes();
    const i = await newTab();
    await sleep(3000);
    await send(page, i, `${cli}\r`);
    const started = await ensureReady(page, i, cli);
    const cliPids = await ev((i) => window.__termdeck.app.tabs[i].procs.map((p) => p.pid), i);
    cliPids.forEach((p) => strays.add(p));
    const forcedBefore = await ev(() => window.__termdeck.app.tabs[0].constructor.forced);
    const closedBefore = await ev(() => window.__termdeck.app.tabs[0].constructor.closed);
    // An idle CLI is not "something running" (changed 2026-11-12: four idle sessions
    // made the app warn about jobs that were not there). Working, it still is.
    await until(() => ev((i) => window.__termdeck.app.tabs[i].activity !== 'working', i), 15000);
    const verdict = await ev((i) => {
      const a = window.__termdeck.app;
      const t = a.tabs[i];
      const was = t.activity;
      const idle = a.closingEnds(t);
      t.activity = 'working';
      const busy = a.closingEnds(t);
      t.activity = 'attention';
      const waiting = a.closingEnds(t);
      t.activity = was;
      return { idle, busy, waiting, helpers: t.running().length, family: t.cliFamily().size };
    }, i);
    check(`B1: an idle ${cli} session, with the helpers it keeps running, is not counted as something running`, started && verdict.idle === null && verdict.family >= 1, JSON.stringify(verdict));
    check(`B1: the same session in the middle of work, or waiting for an answer, is`, new RegExp(cli, 'i').test(verdict.busy ?? '') && new RegExp(cli, 'i').test(verdict.waiting ?? ''), JSON.stringify(verdict));
    const t0 = Date.now();
    await clickClose(i);
    const asked = await page.locator('.modal').innerText().catch(() => '');
    await page.locator('.modal .foot .btn.primary').click().catch(() => {});
    const gone = await until(() => cliPids.every((p) => !alive(p)), 12000, 100);
    const took = Date.now() - t0;
    await until(() => ev((n) => window.__termdeck.app.tabs[0].constructor.closed > n, closedBefore), 8000);
    const forced = (await ev(() => window.__termdeck.app.tabs[0].constructor.forced)) - forcedBefore;
    check(`B1: closing a tab with an idle ${cli} asks nothing`, started && asked === '', asked.replace(/\s+/g, ' ').slice(0, 220));
    check(`B1: ${cli} and what it started quit by themselves — nothing had to be ended by force`, gone === true && forced === 0, `${cliPids.length} processes gone after ${(took / 1000).toFixed(1)} s; ended by force: ${forced}`);
    if (cli === 'claude') {
      await sleep(1500);
      check('B1: Claude Code did not record the close as a crash', strikes() === strikesBefore, `${strikesBefore} -> ${strikes()}`);
    }
  }

  // ---------- B1: closing the app ----------
  {
    const t = await newTab();
    await sleep(3000);
    await send(page, t, "Start-Process ping -ArgumentList '-n','120','127.0.0.1' -WindowStyle Hidden\r");
    const pings = await until(async () => { const p = await procsNamed(t, 'ping.exe'); return p.length ? p : false; }, 20000);
    (pings || []).forEach((p) => strays.add(p));
    const shells = await ev(() => window.__termdeck.app.tabs.map((x) => x.pid).filter(Boolean));
    await ev(() => void window.__TAURI__.window.getCurrentWindow().close());
    await sleep(900);
    const asked = await page.locator('.modal').innerText().catch(() => '');
    check('B1: closing the app with something running asks first and names it', /Close TermDeck\?|still working/.test(asked) && /ping/.test(asked) && /Close anyway/.test(asked), asked.replace(/\s+/g, ' ').slice(0, 240));
    await shot(page, '16-b-close-app-asks');
    await page.locator('.modal .foot .btn', { hasText: 'Cancel' }).click();
    await sleep(1500);
    check('B1: Cancel keeps the app and everything running', (await tabCount()) > 0 && (pings || []).every(alive) && shells.every(alive));
    check('no page errors', app.errors.length === 0, app.errors.slice(0, 3).join(' | '));
    const t0 = Date.now();
    await app.close(); // answers "Close anyway"
    const gone = await until(() => (pings || []).every((p) => !alive(p)) && shells.every((p) => !alive(p)), 6000, 100);
    check('B1: "Close anyway" ends every shell and the hidden background program', gone === true, `app gone after ${((Date.now() - t0) / 1000).toFixed(1)} s; still alive: ${[...(pings || []), ...shells].filter(alive).join(', ') || 'none'}`);
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
    check('B1: the tabs were saved before closing (they come back next time)', saved.tabs.length >= 2, `${saved.tabs.length} tabs`);
  }
} catch (e) {
  check('part 1 ran to the end', false, String(e?.stack ?? e).slice(0, 600));
  await app.close().catch(() => {});
}

// ======================================================================
// Part 2 — A4: a saved file that cannot be read
// ======================================================================
const valid = (marker) => JSON.stringify({ version: 1, fontSize: 17, tabs: [{ id: 'keepme01', name: marker, autoName: false, shell: 'powershell', cwd: workDir, cli: 'none' }], panes: ['keepme01'], activePane: 0 }, null, 2);
const library = (label) => JSON.stringify({ version: 1, snippets: [{ id: 'mine0001', label, text: 'my own text', mode: 'insert', pinned: true, scope: 'all', folder: 'Mine' }] }, null, 2);
const copies = (dir, name) => fs.readdirSync(dir).filter((f) => f.startsWith(`${name}.unreadable-`) && f.endsWith('.json'));

// (a) state.json damaged; the library is fine.
try {
  const dir = sub('a4a');
  fs.mkdirSync(dir, { recursive: true });
  const damaged = valid('precious tab').slice(0, 140); // cut off in the middle
  fs.writeFileSync(path.join(dir, 'state.json'), damaged);
  fs.writeFileSync(path.join(dir, 'snippets.json'), library('My own snippet'));
  app = await launch({ dataDir: dir });
  page = app.page;
  await sleep(1500);
  const kept = copies(dir, 'state');
  const said = await page.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent).join(' || '));
  check('A4: a damaged state.json is copied aside before anything is saved', kept.length === 1 && fs.readFileSync(path.join(dir, kept[0]), 'utf8') === damaged, kept.join(', '));
  check('A4: the app says so, naming the copy', kept.length === 1 && said.includes(kept[0]), said.slice(0, 200));
  await shot(page, '16-c-unreadable-state');
  check('A4: the library beside it is untouched and loaded', await page.evaluate(() => window.__termdeck.app.library.snippets.some((s) => s.label === 'My own snippet')));
  await app.close();
  await sleep(500);
  let ok = false;
  try {
    ok = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).version === 1;
  } catch { /* stays false */ }
  check('A4: the app then works and saves normally; the copy is still there', ok && copies(dir, 'state').length === 1);
} catch (e) {
  check('A4 (a) ran to the end', false, String(e?.stack ?? e).slice(0, 400));
  await app.close().catch(() => {});
}

// (b) files that are valid JSON but not what this version writes.
try {
  const dir = sub('a4b');
  fs.mkdirSync(dir, { recursive: true });
  const future = JSON.stringify({ version: 2, tabs: [], somethingNew: true });
  const oddLibrary = JSON.stringify({ version: 1, snippets: 'not a list' });
  fs.writeFileSync(path.join(dir, 'state.json'), future);
  fs.writeFileSync(path.join(dir, 'snippets.json'), oddLibrary);
  app = await launch({ dataDir: dir });
  page = app.page;
  await sleep(1500);
  const s = copies(dir, 'state');
  const l = copies(dir, 'snippets');
  check('A4: a state file from another version is copied aside, not silently replaced', s.length === 1 && fs.readFileSync(path.join(dir, s[0]), 'utf8') === future, s.join(', '));
  check('A4: a snippet file in an unknown form is copied aside before the starter library can replace it', l.length === 1 && fs.readFileSync(path.join(dir, l[0]), 'utf8') === oddLibrary, l.join(', '));
  await app.close();
} catch (e) {
  check('A4 (b) ran to the end', false, String(e?.stack ?? e).slice(0, 400));
  await app.close().catch(() => {});
}

// (c) the audit's scenario: the files cannot be read for a moment (another program holds
// them), so no copy can be made either. Nothing may be written over them.
let locker;
try {
  const dir = sub('a4c');
  fs.mkdirSync(dir, { recursive: true });
  const state = valid('precious tab');
  const lib = library('Irreplaceable snippet');
  const sp = path.join(dir, 'state.json');
  const lp = path.join(dir, 'snippets.json');
  fs.writeFileSync(sp, state);
  fs.writeFileSync(lp, lib);
  locker = spawn('powershell.exe', ['-NoProfile', '-Command',
    `$a=[IO.File]::Open('${sp}','Open','ReadWrite','None'); $b=[IO.File]::Open('${lp}','Open','ReadWrite','None'); Start-Sleep 90`], { stdio: 'ignore' });
  const locked = await until(() => {
    try {
      fs.closeSync(fs.openSync(sp, 'r'));
      return false;
    } catch {
      return true;
    }
  }, 15000);
  app = await launch({ dataDir: dir });
  page = app.page;
  await sleep(1500);
  const blocked = await page.evaluate(() => ({ state: window.__termdeck.app.saveBlocked, library: window.__termdeck.app.library.saveBlocked }));
  const said = await page.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent).join(' || '));
  check('A4: (setup) both files were locked by another program while the app started', locked === true);
  check('A4: unreadable and uncopyable → saving is switched off for this run, for both files', blocked.state === true && blocked.library === true, JSON.stringify(blocked));
  check('A4: the app says nothing will be saved', /nothing will be saved/.test(said) && /will not be saved/.test(said), said.slice(0, 220));
  locker.kill();
  await sleep(1200);
  // The file is free again. Everything that normally saves is now done: none of it may land.
  await page.evaluate(async () => {
    const a = window.__termdeck.app;
    a.setFontSize(19);
    await a.createTab({ shell: 'powershell', cwd: a.env.home, cli: 'none' });
    a.library.snippets.push({ id: 'zzz', label: 'x', text: 'x', mode: 'insert', pinned: false, scope: 'all', folder: '' });
    a.library.save();
    await a.saveNow();
  });
  await sleep(1200);
  await app.close();
  await sleep(600);
  check('A4: state.json is byte-for-byte what it was', fs.readFileSync(sp, 'utf8') === state);
  check('A4: snippets.json is byte-for-byte what it was', fs.readFileSync(lp, 'utf8') === lib);
  // Next start, with the files readable: everything is back.
  app = await launch({ dataDir: dir });
  page = app.page;
  await sleep(1200);
  const back = await page.evaluate(() => ({ tab: window.__termdeck.app.tabs.some((t) => t.state.name === 'precious tab'), snippet: window.__termdeck.app.library.snippets.some((s) => s.label === 'Irreplaceable snippet'), font: window.__termdeck.app.state.fontSize }));
  check('A4: next start the tabs, settings and library are all back', back.tab && back.snippet && back.font === 17, JSON.stringify(back));
  await app.close();
} catch (e) {
  check('A4 (c) ran to the end', false, String(e?.stack ?? e).slice(0, 400));
  await app?.close().catch(() => {});
} finally {
  try {
    locker?.kill();
  } catch { /* already gone */ }
}

// Nothing this test started may be left running.
await sleep(500);
const left = [...strays].filter(alive);
for (const pid of left) {
  try {
    process.kill(pid);
  } catch { /* gone meanwhile */ }
}
check('nothing the test started is left running', left.length === 0, left.length ? `had to end: ${left.join(', ')}` : '');
process.exit(summary() ? 1 : 0);
