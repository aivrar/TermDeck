// Smaller behaviours, as far as each can be shown on the real app. (The History reader and the updater's output have unit tests
// instead: `cargo test` in src-tauri.)
//   - file paths are quoted the way the shell in front of them needs
//   - Git Bash and WSL tabs follow `cd`
//   - a second emergency stop soon after the first still brings the shell back
//   - History keeps a bounded number of pages
//   - a lost graphics context is replaced by itself
//   - the same data folder reached through a link still counts as the same folder
//   - a session id that is not an id is never typed
//   - links: only web links are accepted
// usage: node 17-polish.mjs <data-dir> <work-dir> [wsl-distro]
// Opens no browser, sends no prompt. Makes one folder link (a junction) beside its data
// folder and removes it again.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { launch, shot, text, send, sleep, check, summary, waitText, EXE } from './harness.mjs';

const [dataDir, workDir, wslDistro] = process.argv.slice(2);
async function until(fn, timeout = 15000, step = 200) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) return false;
    await sleep(step);
  }
}

const app = await launch({ dataDir });
const { page } = app;
const ev = (fn, arg) => page.evaluate(fn, arg);
const newTab = (shell, extra = {}) =>
  page.evaluate(async ([shell, cwd, extra]) => {
    const a = window.__termdeck.app;
    await a.createTab({ shell, cwd, cli: 'none', ...extra });
    return a.tabs.length - 1;
  }, [shell, workDir, extra]);
const cwdOf = (i) => ev((i) => window.__termdeck.app.tabs[i].state.cwd, i);
const link = `${dataDir}-link`;

try {
  await ev(() => window.__termdeck.app.toggleLibrary(false));
  const env = await ev(() => window.__termdeck.app.env);

  // ---------- paths, per shell ----------
  {
    const cases = [
      // path, shell, a CLI is in front, expected
      ['C:\\Users\\me\\a.png', 'powershell', false, 'C:\\Users\\me\\a.png'],
      ['C:\\My Files\\a b.png', 'powershell', false, "'C:\\My Files\\a b.png'"],
      ['C:\\x\\$HOME`n\\it\'s.txt', 'powershell', false, "'C:\\x\\$HOME`n\\it''s.txt'"],
      ['C:\\a&b\\c.txt', 'cmd', false, '"C:\\a&b\\c.txt"'],
      ['C:\\plain\\c.txt', 'cmd', false, 'C:\\plain\\c.txt'],
      ['C:\\Users\\me\\a.png', 'gitbash', false, "'C:\\Users\\me\\a.png'"],
      ["C:\\it's here\\a.png", 'gitbash', false, "'C:\\it'\\''s here\\a.png'"],
      ['C:\\Users\\me\\a b.png', 'wsl', false, "'/mnt/c/Users/me/a b.png'"],
      ['D:\\data\\x.csv', 'wsl', false, '/mnt/d/data/x.csv'],
      ['\\\\wsl$\\Ubuntu\\home\\me\\x.txt', 'wsl', false, '/home/me/x.txt'],
      ['C:\\Users\\me\\a b.png', 'powershell', true, '"C:\\Users\\me\\a b.png"'],
      ['C:\\Users\\me\\a.png', 'wsl', true, '/mnt/c/Users/me/a.png'],
    ];
    const got = await ev((cases) => cases.map(([p, shell, cli]) => window.__termdeck.quotePath(p, shell, cli)), cases);
    const bad = cases.map((c, i) => (got[i] === c[3] ? null : `${c[1]}: ${c[0]} gave ${got[i]}, wanted ${c[3]}`)).filter(Boolean);
    check(`paths are written for the shell in front of them (${cases.length} cases)`, bad.length === 0, bad.join(' | '));
    const conv = await ev(() => [window.__termdeck.fromMsysPath('/c/Users/me'), window.__termdeck.fromMsysPath('/d'), window.__termdeck.fromMsysPath('/tmp/x'), window.__termdeck.fromMsysPath('/usr')]);
    check('Git Bash folder names are turned into Windows ones; those with no Windows form are left out', JSON.stringify(conv) === JSON.stringify(['C:\\Users\\me', 'D:\\', null, null]), JSON.stringify(conv));
  }

  // A real PowerShell prompt: the path arrives whole, `$` and all.
  {
    const dir = path.join(workDir, 'polish $HOME dir');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "it's here.txt");
    fs.writeFileSync(file, 'the-file-was-read\n');
    const i = await newTab('powershell');
    await sleep(3500);
    await send(page, i, 'Get-Content ');
    await ev(([i, f]) => window.__termdeck.app.tabs[i].insertPaths([f]), [i, file]);
    await sleep(500);
    await send(page, i, '\r');
    const out = await until(async () => /the-file-was-read/.test(await text(page, i, 20)), 8000);
    check('PowerShell: a dropped path containing $, spaces and an apostrophe opens the right file', out === true, (await text(page, i, 6)).split('\n').slice(-3).join(' / '));
  }

  // ---------- Git Bash: follows cd, and a dropped Windows path survives ----------
  if (env.hasGitBash) {
    const i = await newTab('gitbash');
    await waitText(page, i, /\$\s*$/, 25000);
    const started = await cwdOf(i);
    await send(page, i, 'cd /c/Windows\r');
    const moved = await until(async () => (await cwdOf(i)) === 'C:\\Windows', 8000);
    check('Git Bash: the tab follows cd (so a restart returns to that folder)', moved === true, `${started} -> ${await cwdOf(i)}`);
    await send(page, i, 'cd /tmp\r');
    await sleep(1500);
    check('Git Bash: a folder with no Windows form keeps the last known one', (await cwdOf(i)) === 'C:\\Windows', await cwdOf(i));
    const free = await ev((i) => window.__termdeck.app.tabs[i].promptFree(), i);
    await send(page, i, 'sleep 4\r');
    await sleep(1200);
    const busy = await ev((i) => window.__termdeck.app.tabs[i].promptFree(), i);
    const freeAgain = await until(() => ev((i) => window.__termdeck.app.tabs[i].promptFree(), i), 9000);
    check('Git Bash: "is a command running here?" is now known exactly (free, busy during sleep, free again)', free === true && busy === false && freeAgain === true, `${free} / ${busy} / ${freeAgain}`);
    const file = path.join(workDir, 'polish $HOME dir', "it's here.txt");
    await send(page, i, 'cat ');
    await ev(([i, f]) => window.__termdeck.app.tabs[i].insertPaths([f]), [i, file]);
    await sleep(500);
    await send(page, i, '\r');
    check('Git Bash: a dropped Windows path keeps its backslashes and opens the right file', (await until(async () => /the-file-was-read/.test(await text(page, i, 20)), 8000)) === true, (await text(page, i, 6)).split('\n').slice(-3).join(' / '));
    await shot(page, '17-a-gitbash-paths');
  } else console.log('(Git Bash not installed: its checks are skipped)');

  // ---------- WSL: follows cd (only into a distro that is already running) ----------
  if (wslDistro) {
    const i = await newTab('wsl', { wslDistro });
    await waitText(page, i, /[$#]\s*$/, 30000);
    await send(page, i, 'cd /tmp\r');
    const moved = await until(async () => (await cwdOf(i)) === '/tmp', 8000);
    check(`WSL (${wslDistro}): the tab follows cd`, moved === true, `folder now: ${await cwdOf(i)}`);
    await send(page, i, 'exit\r');
    await until(() => ev((i) => window.__termdeck.app.tabs[i].exited, i), 15000);
  } else console.log('(WSL not tested live: no distro is running, and starting one could boot services in it)');

  // ---------- a second emergency stop shortly before the first one's 12-second mark ----------
  {
    const i = await newTab('powershell');
    await sleep(3500);
    const result = await ev(async (i) => {
      const a = window.__termdeck.app;
      const t = a.tabs[i];
      const pause = (ms) => new Promise((r) => setTimeout(r, ms));
      const pid0 = t.pid;
      const t0 = performance.now();
      void a.killTab(t);
      for (let n = 0; n < 60 && (t.exited || !t.pid || t.pid === pid0); n++) await pause(100);
      const pid1 = t.pid;
      // The first stop set a 12-second timer. The second is pressed just before it fires,
      // so that the timer goes off while the second stop is still under way.
      await pause(Math.max(0, 11850 - (performance.now() - t0)));
      void a.killTab(t);
      await pause(4500);
      return { pid0, pid1, pid2: t.pid, exited: t.exited };
    }, i);
    check('a second emergency stop 12 s after the first still brings the shell back', !result.exited && !!result.pid2 && result.pid2 !== result.pid1 && result.pid1 !== result.pid0, JSON.stringify(result));
  }

  // ---------- History keeps a bounded number of pages ----------
  {
    const r = await ev(async () => {
      const a = window.__termdeck.app;
      const pause = (ms) => new Promise((r) => setTimeout(r, ms));
      const api = window.__termdeck.api;
      const real = api.transcriptLoad;
      // A made-up session of 10 pages, 30 messages each, in place of a real session file.
      const PAGE = 1000;
      const TOTAL = 10 * PAGE;
      let asked = 0;
      api.transcriptLoad = (_cli, _cwd, _session, wantEnd) => {
        asked++;
        const end = wantEnd ?? TOTAL;
        const start = Math.max(0, end - PAGE);
        const messages = Array.from({ length: 30 }, (_, k) => ({ role: k % 2 ? 'assistant' : 'user', kind: 'text', text: `page-${start / PAGE}-msg-${k}` }));
        return Promise.resolve({ found: true, path: 'made-up.jsonl', title: null, sessionId: null, messages, start, fileSize: TOTAL });
      };
      const t = a.activeTab;
      const keep = t.state.cli;
      t.state.cli = 'claude';
      const pane = a.state.activePane;
      a.toggleHistory(pane);
      await pause(400);
      const root = document.querySelector('.history');
      const count = () => root.querySelectorAll('.hmsg').length;
      const has = (s) => [...root.querySelectorAll('.hmsg')].some((el) => el.textContent.includes(s));
      const first = count();
      const counts = [];
      for (let n = 0; n < 9; n++) {
        root.querySelector('.history-scroll .more .btn')?.click();
        await pause(150);
        counts.push(count());
      }
      const notes = root.querySelectorAll('.history-scroll .more');
      const out = {
        first, counts, asked,
        oldestShown: has('page-0-msg-0'),
        newestGone: !has('page-9-msg-0'),
        noteShown: !notes[1].hidden,
        atStart: /Start of the session/.test(notes[0].textContent),
      };
      notes[1].querySelector('.btn').click();
      await pause(300);
      out.afterBack = { count: count(), newest: has('page-9-msg-29'), noteHidden: notes[1].hidden };
      a.toggleHistory(pane);
      t.state.cli = keep;
      api.transcriptLoad = real;
      return out;
    });
    check('History: never more than 6 pages on screen however far back you read', r.first === 30 && Math.max(...r.counts) === 180 && r.counts[8] === 180 && r.oldestShown && r.newestGone && r.atStart, JSON.stringify(r.counts));
    check('History: it says newer messages were let go, and one click returns to the newest', r.noteShown && r.afterBack.count === 30 && r.afterBack.newest && r.afterBack.noteHidden, JSON.stringify(r.afterBack));
  }

  // ---------- a lost graphics context is replaced by itself ----------
  {
    const r = await ev(async () => {
      const a = window.__termdeck.app;
      const pause = (ms) => new Promise((r) => setTimeout(r, ms));
      const t = a.activeTab;
      t.focus();
      await pause(300);
      const before = !!t.webgl;
      let lost = 0;
      for (const c of t.el.querySelectorAll('canvas')) {
        const gl = c.getContext('webgl2');
        const ext = gl?.getExtension('WEBGL_lose_context');
        if (ext) {
          ext.loseContext();
          lost++;
        }
      }
      // The renderer waits 3 s for the context to come back by itself, then gives up;
      // the app replaces it 1.5 s later.
      let dropped = false;
      let back = false;
      for (let n = 0; n < 90 && !back; n++) {
        await pause(100);
        if (!t.webgl) dropped = true;
        else if (dropped) back = true;
      }
      return { before, lost, dropped, back, stillTyping: document.activeElement === t.term.textarea };
    });
    check('a lost graphics context: the tab goes back to the fast renderer by itself, keyboard still in the terminal', r.before && r.lost >= 1 && r.dropped && r.back && r.stillTyping, JSON.stringify(r));
    const i = await ev(() => window.__termdeck.app.tabs.indexOf(window.__termdeck.app.activeTab));
    await send(page, i, 'echo after-the-context-loss\r');
    check('…and it still draws and takes input', (await until(async () => /after-the-context-loss\n/.test(await text(page, i, 12)), 6000)) === true);
  }

  // ---------- the same data folder through a link ----------
  {
    fs.rmSync(link, { recursive: true, force: true });
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, dataDir], { stdio: 'ignore' });
    const before = await ev(() => window.__termdeck.app.secondStarts);
    const copyEnv = { ...process.env, TERMDECK_DATA_DIR: link, TERMDECK_NO_FOCUS: '1' };
    for (const key of Object.keys(copyEnv)) if (/^(CLAUDE_CODE_|CLAUDECODE$|CLAUDE_PID$|CLAUDE_EFFORT$)/.test(key)) delete copyEnv[key];
    const ended = await new Promise((resolve) => {
      const p = spawn(EXE, [], { env: copyEnv, stdio: 'ignore' });
      const timer = setTimeout(() => {
        p.kill();
        resolve(false);
      }, 12000);
      p.on('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    const told = await until(() => ev((n) => window.__termdeck.app.secondStarts > n, before), 5000);
    check('the same data folder reached through a link counts as the same folder (no second copy)', ended === true && told === true, `second copy ended by itself: ${ended}; first window told: ${told}`);
  }

  // ---------- ids and links ----------
  {
    const cmds = await ev(() => {
      const a = window.__termdeck.app;
      const t = a.tabs[0];
      const keep = { cli: t.state.cli, sessionId: t.state.sessionId, flags: t.state.flags };
      const out = [];
      for (const id of ['0f3c9a1e-5b7d-4c2e-9a8f-1d2e3f4a5b6c', 'abc; calc.exe', '$(calc)', 'x', '..\\..\\evil', 'ok-id-12345678 --dangerously-skip-permissions']) {
        Object.assign(t.state, { cli: 'claude', sessionId: id, flags: undefined });
        out.push(t.resumeCommand());
      }
      Object.assign(t.state, keep);
      return out;
    });
    const plain = cmds.slice(1).every((c) => c === 'claude' || /^claude( --[\w-]+)*$/.test(c));
    check('a session id that is not an id is never typed into the shell', cmds[0] === 'claude --resume 0f3c9a1e-5b7d-4c2e-9a8f-1d2e3f4a5b6c' && plain && !cmds.slice(1).some((c) => /calc|evil|;|\$/.test(c)), cmds.join(' | '));
    const refused = await ev(async () => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const out = [];
      for (const url of ['file:///C:/Windows/win.ini', 'calc.exe', 'https://example.com/a b', 'https://example.com/"x', 'javascript:alert(1)', 'http://example.com/\nfoo']) {
        out.push(await invoke('open_external', { url }).then(() => 'OPENED', () => 'refused'));
      }
      return out;
    });
    check('links: anything but a clean web link is refused (nothing is opened by this test)', refused.every((r) => r === 'refused'), refused.join(', '));
  }

  // (Losing the graphics context on purpose makes the browser engine log that it was lost.)
  const errors = app.errors.filter((e) => !/webgl|context.?lost/i.test(e));
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('the test ran to the end', false, String(e?.stack ?? e).slice(0, 600));
} finally {
  await app.close();
  // Only the link is removed (rmdir on a junction leaves what it points at alone).
  try {
    fs.rmdirSync(link);
  } catch { /* was never made */ }
}
process.exit(summary() ? 1 : 0);
