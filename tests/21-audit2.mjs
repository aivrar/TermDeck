// Saving, leftover processes, dialogs, switches, typing and updates:
//   1  the saved state is written only when something in it changed (a CLI turning the
//      spinner in its window title used to cause a write, flushed to disk, every time)
//   2  programs left running by a shell that ended stay the tab's when its shell is
//      started again: shown, asked about, ended when the tab is closed
//   3  with two dialogs open, a key press goes to the one on top only
//   4  switches typed in by hand for one CLI do not follow another CLI started in the tab
//   5  a command typed by the app is not typed into a command that started meanwhile
//   6  a CLI is not started while it is being updated
//   7  a Codex conversation is found by its whole id, not by the end of one
//   8  a tab closed in the instant its shell is started leaves no shell behind
//   9  a Codex or Grok running under Claude Code does not take the tab over
// usage: node 21-audit2.mjs <data-dir> <work-dir>
//
// Sends no prompt and starts none of the three CLIs. In place of a CLI it uses stand-ins:
// copies of Windows' own cmd.exe named claude.exe and codex-standin.exe, in a folder
// beside the data folder (the app tells a CLI by its program name). Starts hidden `ping`
// processes and ends them. Reads the list of past Codex conversations (read-only).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch, shot, send, sleep, check, summary } from './harness.mjs';

const [dataDir, workDir] = process.argv.slice(2);
const bin = `${dataDir}-bin`;
fs.rmSync(bin, { recursive: true, force: true });
fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(workDir, { recursive: true });

const alive = (pid) => {
  try {
    return execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' }).includes(String(pid));
  } catch {
    return false;
  }
};
const until = async (fn, timeout = 15000, step = 200) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) return false;
    await sleep(step);
  }
};

const app = await launch({ dataDir });
const { page } = app;
const stray = [];
const shellsUnderApp = () => {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${app.proc.pid}" | ForEach-Object { "$($_.Name):$($_.ProcessId)" }`], { encoding: 'utf8' });
  return out.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^(powershell|cmd)\.exe:/i.test(l)).sort();
};
const tab = (i) => page.evaluate((i) => {
  const a = window.__termdeck.app;
  const t = a.tabs[i];
  return t ? {
    activity: t.activity, exited: t.exited, procs: t.procs.map((p) => `${p.name}:${p.pid}`), asks: a.closingEnds(t),
    cli: t.cliRunning, stateCli: t.state.cli, resume: t.resumePending,
  } : null;
}, i);
const buffer = (i) => page.evaluate((i) => window.__termdeck.app.tabs[i].bufferText(120), i);
const newTab = async (cwd, cli = 'none') => {
  await page.evaluate(([cwd, cli]) => window.__termdeck.app.createTab({ shell: 'powershell', cwd, cli }), [cwd, cli]);
  await sleep(3000);
  return page.evaluate(() => window.__termdeck.app.tabs.length - 1);
};
const closeQuietly = async (i) => {
  await page.evaluate((i) => void window.__termdeck.app.closeTab(window.__termdeck.app.tabs[i]), i);
  await sleep(700);
  if (await page.locator('.modal').count()) await page.locator('.modal .foot .btn.primary').last().click();
  await sleep(800);
};

try {
  await page.evaluate(() => window.__termdeck.app.toggleLibrary(false));
  await page.evaluate(() => {
    const api = window.__termdeck.api;
    const real = api.storeSave;
    window.__saves = 0;
    api.storeSave = (name, value) => {
      if (name === 'state') window.__saves++;
      return real(name, value);
    };
  });
  const saves = () => page.evaluate(() => window.__saves);
  await send(page, 0, `cd '${workDir}'\r`);
  await sleep(2500);

  // ---- 1. writes of the saved state ----
  const s0 = await saves();
  await send(page, 0, '1..80 | % { $host.UI.RawUI.WindowTitle = "spin $_"; Start-Sleep -Milliseconds 100 }\r');
  await sleep(9500);
  const s1 = await saves();
  const titleNow = await page.evaluate(() => window.__termdeck.app.tabs[0].title);
  check('a program changing the window title 80 times causes no write of the saved state', /spin 80/.test(titleNow) && s1 - s0 === 0, `title "${titleNow}", ${s1 - s0} writes (20 before the fix)`);
  await page.evaluate(() => window.__termdeck.app.setFontSize(15));
  await sleep(900);
  const s2 = await saves();
  await page.evaluate(() => window.__termdeck.app.setFontSize(14));
  await sleep(900);
  const s3 = await saves();
  check('a real change is still saved, each time', s2 - s1 === 1 && s3 - s2 === 1, `${s2 - s1} and ${s3 - s2} writes`);

  // ---- 2. what a shell that ended left running ----
  await send(page, 0, "Start-Process ping -ArgumentList '-n','240','127.0.0.1' -WindowStyle Hidden\r");
  const withPing = await until(async () => { const t = await tab(0); return t.procs.find((p) => /^ping/i.test(p)) ? t : null; });
  const pingPid = withPing ? Number(withPing.procs.find((p) => /^ping/i.test(p)).split(':')[1]) : 0;
  if (pingPid) stray.push(pingPid);
  await send(page, 0, 'exit\r');
  await until(async () => (await tab(0)).exited);
  await sleep(1200);
  await page.evaluate(() => window.__termdeck.app.refresh());
  const ended = await tab(0);
  check('the shell has ended (exit); the hidden ping it started is still listed under the tab', !!pingPid && ended.exited && ended.procs.some((p) => p.endsWith(`:${pingPid}`)), JSON.stringify(ended));
  await page.evaluate(() => window.__termdeck.app.tabs[0].start());
  await sleep(3500);
  await page.evaluate(() => window.__termdeck.app.refresh());
  const again = await tab(0);
  check('the shell is started again: the ping is still listed under the tab, beside the new shell', !again.exited && again.procs.some((p) => p.endsWith(`:${pingPid}`)) && again.procs.some((p) => /^powershell/i.test(p)), JSON.stringify(again));
  check('closing the tab would ask, and names it', /ping/i.test(again.asks ?? ''), String(again.asks));
  await page.evaluate(() => void window.__termdeck.app.closeTab(window.__termdeck.app.tabs[0]));
  const asked = await until(() => page.locator('.modal').count(), 6000);
  const said = asked ? (await page.locator('.modal').innerText()).replace(/\s+/g, ' ') : '';
  if (asked) await page.locator('.modal .foot .btn.primary').click();
  const gone = await until(() => !alive(pingPid), 12000, 400);
  check('the tab is closed after the question, and the ping is ended with it', !!asked && /ping/i.test(said) && gone && (await page.evaluate(() => window.__termdeck.app.tabs.length)) === 0, `asked: ${said.slice(0, 120)} · ping gone: ${gone}`);

  // ---- 3. two dialogs, one key ----
  const c = await newTab(workDir);
  await send(page, c, 'ping -n 60 127.0.0.1\r');
  await sleep(2500);
  await page.evaluate(() => window.__termdeck.app.showSettings());
  await sleep(400);
  const lines0 = await page.evaluate(() => window.__termdeck.app.state.settings.scrollback);
  await page.evaluate(() => { document.querySelector('#settings input[type=number][step="1000"]').value = '7000'; });
  await page.evaluate((i) => void window.__termdeck.app.closeTab(window.__termdeck.app.tabs[i]), c);
  const two = await until(() => page.locator('.modal').count().then((n) => n === 2), 6000);
  await shot(page, '21-a-two-dialogs');
  const tabsThen = await page.evaluate(() => window.__termdeck.app.tabs.length);
  await page.keyboard.press('Enter');
  await sleep(1500);
  const afterEnter = {
    dialogs: await page.locator('.modal').count(),
    title: await page.locator('.modal h2').first().innerText().catch(() => ''),
    lines: await page.evaluate(() => window.__termdeck.app.state.settings.scrollback),
    tabs: await page.evaluate(() => window.__termdeck.app.tabs.length),
  };
  check('Settings open with "Close this session?" on top: both are on screen', !!two);
  check('one Enter answers the question on top only — the tab is closed; Settings stays open and is not saved',
    afterEnter.dialogs === 1 && afterEnter.title === 'Settings' && afterEnter.lines === lines0 && afterEnter.tabs === tabsThen - 1, JSON.stringify(afterEnter));
  await page.keyboard.press('Escape');
  await sleep(500);
  check('Esc then closes Settings, unsaved', (await page.locator('.modal').count()) === 0 && (await page.evaluate(() => window.__termdeck.app.state.settings.scrollback)) === lines0);
  await sleep(4000);

  // ---- 4. hand-typed switches belong to one CLI ----
  const d = await newTab(workDir);
  const flags = await page.evaluate((i) => {
    const t = window.__termdeck.app.tabs[i];
    // What the once-a-second look reports, made up here: a CLI running, or none.
    const st = (cli, args) => ({ id: t.state.id, cli, cliPid: cli ? 4242 : null, sessionId: null, sessionName: null, cliStatus: null, waitingFor: null, cliCwd: null, childCount: 0, cliArgs: args, procs: [], cpu: 0, mem: 0 });
    const now = () => ({ cli: t.state.cli, flags: t.state.flags ?? null, manual: !!t.state.flagsManual, of: t.state.flagsCli ?? null, cmd: t.resumeCommand() });
    const out = {};
    t.state.flags = '--dangerously-skip-permissions';
    t.state.flagsManual = true;
    t.state.flagsCli = 'claude';
    t.applyStatus(st('claude', ['--verbose']), false);
    out.sameCli = now();
    t.applyStatus(st(null, []), false);
    out.closed = now();
    t.applyStatus(st('claude', []), false);
    out.sameCliAgain = now();
    t.applyStatus(st(null, []), false);
    t.applyStatus(st('codex', ['-m', 'gpt-6.1']), false);
    out.otherCli = now();
    t.applyStatus(st(null, []), false);
    // A tab saved before the CLI was noted beside its hand-typed switches.
    t.state.flags = '--dangerously-skip-permissions';
    t.state.flagsManual = true;
    t.state.flagsCli = undefined;
    t.applyStatus(st('claude', []), false);
    t.applyStatus(st(null, []), false);
    out.legacyNoted = now();
    t.applyStatus(st('grok', []), false);
    out.legacyOther = now();
    t.applyStatus(st(null, []), false);
    return out;
  }, d);
  check('typed in by hand for Claude Code: kept while Claude Code runs (not read from the process), and offered for Resume after it is closed',
    flags.sameCli.flags === '--dangerously-skip-permissions' && flags.sameCli.manual && flags.closed.flags === '--dangerously-skip-permissions' && flags.closed.cli === 'claude', JSON.stringify([flags.sameCli, flags.closed]));
  check('Claude Code started again in the tab: its Resume has them', /^claude --dangerously-skip-permissions$/.test(flags.sameCliAgain.cmd ?? ''), String(flags.sameCliAgain.cmd));
  check('Codex started in the tab instead: they are let go, and Codex is remembered with its own', !flags.otherCli.manual && !/dangerously/.test(flags.otherCli.cmd ?? '') && /^codex -m /.test(flags.otherCli.cmd ?? ''), JSON.stringify(flags.otherCli));
  check('a tab saved before this: the CLI is noted when it closes, and another CLI then starts clean', flags.legacyNoted.of === 'claude' && flags.legacyOther.cmd === 'grok', JSON.stringify([flags.legacyNoted, flags.legacyOther]));

  // ---- 5. a command the app types, and a command that started meanwhile ----
  await page.evaluate((i) => window.__termdeck.app.tabs[i].runWhenQuiet('echo audit2-did-run'), d);
  const ran = await until(async () => ((await buffer(d)).match(/audit2-did-run/g) ?? []).length >= 2, 8000);
  check('at a free prompt the command is typed and run', !!ran);
  await page.evaluate((i) => {
    const t = window.__termdeck.app.tabs[i];
    window.__notRun = false;
    t.runWhenQuiet('echo audit2-must-not-run', () => { window.__notRun = true; });
    t.send('Start-Sleep 6\r'); // started in the same instant, before the app has typed
  }, d);
  await sleep(3000);
  const toasts = await page.evaluate(() => document.getElementById('toasts').innerText);
  await sleep(6000);
  const text5 = await buffer(d);
  check('a command started before the app could type: nothing is typed into it, and the tab says so',
    (await page.evaluate(() => window.__notRun)) === true && !/audit2-must-not-run/.test(text5) && /a command was started here/.test(toasts), toasts.replace(/\s+/g, ' ').slice(0, 160));
  await page.evaluate((i) => window.__termdeck.app.tabs[i].runWhenQuiet('echo audit2-ran-after'), d);
  check('back at its prompt, the tab takes a typed command again', !!(await until(async () => ((await buffer(d)).match(/audit2-ran-after/g) ?? []).length >= 2, 8000)));

  // ---- 6. no start of a CLI that is being updated ----
  const f = await page.evaluate(async (cwd) => {
    const a = window.__termdeck.app;
    a.updating.add('claude');
    const t = await a.createTab({ shell: 'powershell', cwd, cli: 'claude' });
    a.updating.delete('claude');
    return a.tabs.indexOf(t);
  }, workDir);
  await sleep(3500);
  const held = await tab(f);
  const text6 = await buffer(f);
  check('"New session" with a CLI that is being updated: the tab opens with Resume offered, and nothing is typed', held.resume === true && held.stateCli === 'claude' && held.cli === 'none' && !/claude/i.test(text6), `${JSON.stringify(held)} · ${text6.trim().split('\n').pop()}`);
  check('its Resume would start it', (await page.evaluate((i) => window.__termdeck.app.tabs[i].resumeCommand(), f)) === 'claude');
  await closeQuietly(f);

  // ---- 7. a Codex conversation is found by its whole id ----
  const codex = await page.evaluate(() => window.__termdeck.api.sessionsList('codex', null, 5));
  const one = codex.find((s) => s.id.length === 36 && /\d/.test(s.id.slice(-12)));
  if (one) {
    const found = await page.evaluate((id) => Promise.all([
      window.__termdeck.api.sessionExists('codex', id),
      window.__termdeck.api.sessionExists('codex', id.slice(-12)),
      window.__termdeck.api.sessionExists('codex', id.slice(-23)),
    ]), one.id);
    check('a Codex conversation is found by its id', found[0] === true);
    check('the last 12 or 23 characters of that id find nothing (they used to find it)', found[1] === false && found[2] === false, JSON.stringify(found));
  } else console.log('(no Codex conversation on this PC to look up — part 7 not run)');

  // ---- 8. tabs closed in the instant their shell is started ----
  const before = shellsUnderApp();
  await page.evaluate(async () => {
    const a = window.__termdeck.app;
    for (let i = 0; i < 25; i++) {
      const t = a.addTab({ id: `race-${i}-${Date.now()}`, name: '', autoName: true, shell: i % 2 ? 'cmd' : 'powershell', cwd: a.env.home, cli: 'none' });
      void t.start();
      a.tabs = a.tabs.filter((x) => x !== t);
      a.state.tabs = a.state.tabs.filter((x) => x.id !== t.state.id);
      t.dispose();
      await new Promise((r) => setTimeout(r, i % 5 === 0 ? 0 : 15));
    }
  });
  await sleep(9000);
  const after = shellsUnderApp();
  check('25 tabs closed in the instant their shell was started: no shell is left behind', after.join() === before.join(), `before ${before.join(', ')} · after ${after.join(', ')}`);

  // ---- 9. Codex running under Claude Code ----
  const cmdExe = path.join(process.env.SystemRoot, 'System32', 'cmd.exe');
  const claudeLike = path.join(bin, 'claude.exe');
  const codexLike = path.join(bin, 'codex-standin.exe');
  fs.copyFileSync(cmdExe, claudeLike);
  fs.copyFileSync(cmdExe, codexLike);
  await send(page, d, `& '${claudeLike}' /k "${codexLike} /k"\r`);
  const seen = [];
  await until(async () => (await tab(d)).procs.some((p) => /^codex-standin/i.test(p)), 10000);
  for (let n = 0; n < 6; n++) {
    await sleep(900);
    const t = await tab(d);
    seen.push(`${t.cli}/${t.stateCli}`);
  }
  const both = await tab(d);
  check('a stand-in "claude" with a stand-in "codex" running under it: both are in the tab', both.procs.some((p) => /^claude\.exe/i.test(p)) && both.procs.some((p) => /^codex-standin/i.test(p)), JSON.stringify(both.procs));
  check('the tab is Claude Code\'s throughout — not handed to the Codex under it', seen.every((s) => s === 'claude/claude'), seen.join(' '));
  await send(page, d, 'exit\r');
  await sleep(700);
  await send(page, d, 'exit\r');
  await until(async () => (await tab(d)).cli === 'none', 8000);

  check('no page errors', app.errors.length === 0, app.errors.join(' | ').slice(0, 300));
} catch (e) {
  check('test ran to the end', false, String(e?.stack ?? e));
} finally {
  await app.close();
  for (const pid of stray) {
    if (alive(pid)) {
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' });
      } catch { /* already gone */ }
    }
  }
  fs.rmSync(bin, { recursive: true, force: true });
}
process.exit(summary() ? 1 : 0);
