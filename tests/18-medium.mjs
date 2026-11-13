// Process ownership, quoting, re-reading, History ids, a slow WSL, and the content policy:
//   B2  "close for update" ends the CLI and what it started — not everything in the tab
//   B5  remembered switches are quoted for the shell they are typed into
//   B7  session files are read again only when they changed        (unit tests: cargo test)
//   B8  a tab's History shows that tab's conversation or nothing; ids are checked
//   B9  the app starts even if wsl.exe never answers
//   B10 the window has a content-security policy
// usage: node 18-medium.mjs <data-dir> <work-dir> [wsl-distro]
//
// Starts none of the three CLIs and sends no prompt. In place of a CLI it uses a
// stand-in: a copy of Windows' own cmd.exe named codex-standin.exe, in a folder beside
// the data folder (the app tells a CLI by its program name). Starts hidden `ping`
// processes and ends them. Reads the lists of past conversations (read-only).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch, shot, text, send, sleep, check, summary } from './harness.mjs';

const [dataDir, workDir, wslDistro] = process.argv.slice(2);
const bin = `${dataDir}-bin`;
fs.rmSync(bin, { recursive: true, force: true });
fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(workDir, { recursive: true });

async function until(fn, timeout = 15000, step = 200) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) return false;
    await sleep(step);
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const ps = (script) => execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim();
const childrenOf = (pid) => ps(`(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}').ProcessId`).split(/\s+/).filter(Boolean).map(Number);

const started = Date.now();
const app = await launch({ dataDir });
const normalStart = Date.now() - started;
const { page } = app;
const ev = (fn, arg) => page.evaluate(fn, arg);
const newTab = (shell, extra = {}) =>
  page.evaluate(async ([shell, cwd, extra]) => {
    const a = window.__termdeck.app;
    await a.createTab({ shell, cwd, cli: 'none', ...extra });
    return a.tabs.length - 1;
  }, [shell, workDir, extra]);
const toKill = [];

try {
  await ev(() => window.__termdeck.app.toggleLibrary(false));
  const env = await ev(() => window.__termdeck.app.env);

  // ================= B5: switches, quoted per shell =================
  {
    const cases = [
      // value, shell, expected
      ['--dangerously-skip-permissions', 'powershell', '--dangerously-skip-permissions'],
      ['--model=opus', 'powershell', '--model=opus'],
      ['--model=claude-x.5', 'powershell', "'--model=claude-x.5'"], // unquoted, PowerShell splits at the dot
      ['a,b', 'powershell', "'a,b'"], // unquoted: a list
      ['$HOME', 'powershell', "'$HOME'"],
      ["it's", 'powershell', "'it''s'"],
      ['say "hi"', 'powershell', `'say \\"hi\\"'`], // Windows PowerShell 5.1 does not escape them itself
      ['say "hi"', 'pwsh', `'say "hi"'`],
      ['C:\\my dir\\', 'powershell', "'C:\\my dir\\\\'"],
      ['C:\\Users\\me', 'powershell', 'C:\\Users\\me'],
      ['a b', 'cmd', '"a b"'],
      ['x&y', 'cmd', '"x&y"'],
      ['say "hi"', 'cmd', '"say \\"hi\\""'],
      ['C:\\my dir\\', 'cmd', '"C:\\my dir\\\\"'],
      ['--model=claude-x.5', 'cmd', '--model=claude-x.5'],
      ['C:\\Users\\me', 'gitbash', "'C:\\Users\\me'"], // unquoted, bash eats the backslashes
      ["it's", 'gitbash', `'it'\\''s'`],
      ['$HOME', 'wsl', "'$HOME'"],
      ['--model=claude-x.5', 'wsl', '--model=claude-x.5'],
      ['~', 'gitbash', "'~'"],
      ['', 'gitbash', "''"],
    ];
    const got = await ev((cases) => cases.map(([v, s]) => window.__termdeck.quoteArg(v, s)), cases);
    const bad = cases.map((c, k) => (got[k] === c[2] ? null : `${c[1]} ${JSON.stringify(c[0])}: wanted ${c[2]}  got ${got[k]}`)).filter(Boolean);
    check(`switches: each of ${cases.length} values is quoted the way its shell needs`, bad.length === 0, bad.join(' | '));

    const words = await ev(() => {
      const T = window.__termdeck;
      const line = `--verbose --name="a b" -c 'x y' --add-dir "C:\\my dir" plain`;
      return {
        words: T.flagWords(line),
        values: T.flagWords(line).map(T.flagValue),
        ps: T.shellFlags(line, 'powershell'),
        cmd: T.shellFlags(line, 'cmd'),
        bash: T.shellFlags(line, 'gitbash'),
        kept: T.extractSwitches('claude', ['--model', 'my model', '--name=say "hi" now', '--dir=C:\\my dir\\', '--verbose']),
        same: T.mergeFlags(`--add-dir "C:\\my dir"`, `--add-dir 'C:\\my dir' --verbose`),
        // A switch written inside quotes is still a switch of its own, not the value of the one before.
        quoted: T.mergeFlags('--verbose', `--verbose "--name=a b"`),
      };
    });
    check('switches: a line is split into words, quoted parts kept together — also inside a word',
      words.words.length === 7 && JSON.stringify(words.values) === JSON.stringify(['--verbose', '--name=a b', '-c', 'x y', '--add-dir', 'C:\\my dir', 'plain']),
      JSON.stringify(words.values));
    check('switches: the same line, as typed into PowerShell', words.ps === `--verbose '--name=a b' -c 'x y' --add-dir 'C:\\my dir' plain`, words.ps);
    check('switches: the same line, as typed into cmd', words.cmd === `--verbose "--name=a b" -c "x y" --add-dir "C:\\my dir" plain`, words.cmd);
    check('switches: the same line, as typed into Git Bash', words.bash === `--verbose '--name=a b' -c 'x y' --add-dir 'C:\\my dir' plain`, words.bash);
    const back = await ev((kept) => window.__termdeck.flagWords(kept).map(window.__termdeck.flagValue), words.kept);
    check('switches: a value with blanks or quotes read from a running CLI is remembered and read back unchanged',
      JSON.stringify(back) === JSON.stringify(['--model', 'my model', '--name=say "hi" now', '--dir=C:\\my dir\\', '--verbose']),
      `${words.kept}  →  ${JSON.stringify(back)}`);
    check('switches: "a b" and \'a b\' count as the same switch', words.same === `--add-dir "C:\\my dir" --verbose`, words.same);
    check('switches: a repeated switch is left out also when the next one is written in quotes', words.quoted === `--verbose "--name=a b"`, words.quoted);
  }

  // The real thing: each shell is typed a command with the quoted values, and a program
  // writes down what it actually received.
  {
    const values = ['--model=claude-x.5', 'a b', "it's", '$HOME', '$env:USERPROFILE', '50%', 'a;b', 'x&y|z', 'C:\\dir with space\\', 'say "hi"', 'a,b', '@file', '*.none', '(paren)', 'back`tick', '--flag', 'plain', '<in>out', '^caret', '!bang', '#hash', '~', '-Dkey=a.b'];
    const script = path.join(bin, 'args.js');
    fs.writeFileSync(script, `require('fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\n`);
    const shells = ['powershell', 'cmd'];
    if (env.hasPwsh) shells.push('pwsh');
    if (env.hasGitBash) shells.push('gitbash');
    if (wslDistro) shells.push('wsl');
    for (const shell of shells) {
      const i = await newTab(shell, shell === 'wsl' ? { wslDistro } : {});
      await sleep(shell === 'wsl' ? 5000 : 3000);
      const out = path.join(bin, `got-${shell}.bin`);
      const line = await ev(([shell, script, out, values]) => {
        const T = window.__termdeck;
        const q = (v) => T.quoteArg(v, shell);
        const flags = values.map(q).join(' ');
        // Inside WSL there may be no node: bash's own printf writes the words down.
        return shell === 'wsl' ? `printf '%s\\0' ${flags} > ${q(T.toWslPath(out))}` : `node ${q(script)} ${q(out)} ${flags}`;
      }, [shell, script, out, values]);
      await send(page, i, `${line}\r`);
      const done = await until(() => fs.existsSync(out) && fs.statSync(out).size > 0, 20000);
      await sleep(300);
      let got = [];
      if (done) {
        const raw = fs.readFileSync(out, 'utf8');
        got = shell === 'wsl' ? raw.split('\0').slice(0, -1) : JSON.parse(raw);
      }
      const diff = values.map((v, k) => (got[k] === v ? null : `${JSON.stringify(v)} arrived as ${JSON.stringify(got[k])}`)).filter(Boolean);
      check(`switches, ${shell}: ${values.length} awkward values typed into the shell arrive at the program unchanged`, done && got.length === values.length && diff.length === 0,
        done ? diff.join(' | ') || `${got.length} values` : `nothing was written; screen: ${(await text(page, i, 6)).replace(/\s+/g, ' ').slice(-300)}`);
    }
    await shot(page, '18-a-switches');
  }

  // ================= B8: this tab's conversation, or nothing =================
  {
    const unknown = '0f0f0f0f-1111-4222-8333-444444444444';
    const r = await ev(async ([cwd, unknown]) => {
      const api = window.__termdeck.api;
      const out = {};
      for (const cli of ['claude', 'codex', 'grok']) {
        const list = (await api.sessionsList(cli, null, 40)).filter((s) => s.id);
        const real = list[0];
        const byId = real ? await api.transcriptLoad(cli, 'C:\\no\\such\\folder', real.id, null) : null;
        const miss = await api.transcriptLoad(cli, real?.cwd || cwd, unknown, null);
        const noId = await api.transcriptLoad(cli, real?.cwd || cwd, null, null);
        out[cli] = {
          has: !!real,
          byIdFound: byId?.found ?? null,
          byIdRight: byId ? byId.path.includes(real.id) : null,
          missFound: miss.found,
          noIdFound: noId.found,
          exists: real ? await api.sessionExists(cli, real.id) : null,
          existsUnknown: await api.sessionExists(cli, unknown),
          existsBad: await api.sessionExists(cli, '..\\..\\..\\Windows\\win'),
        };
      }
      return out;
    }, [workDir, unknown]);
    for (const cli of ['claude', 'codex', 'grok']) {
      const c = r[cli];
      if (!c.has) {
        check(`${cli}: (no saved conversation on this PC to look up — skipped)`, true);
        continue;
      }
      check(`${cli}: a conversation is found by its id alone, whatever folder is named`, c.byIdFound === true && c.byIdRight === true, JSON.stringify(c));
      // `real` is a conversation in that very folder, so there is one to wrongly show.
      check(`${cli}: an id that is not there shows nothing — not another conversation from the same folder`, c.missFound === false,
        `unknown id found: ${c.missFound}`);
      check(`${cli}: no id yet shows nothing either — no guessing with the folder's newest conversation`, c.noIdFound === false,
        `found without an id: ${c.noIdFound}`);
      check(`${cli}: "is there a saved conversation" — no for an unknown id, no for something that is not an id`, c.existsUnknown === false && c.existsBad === false, JSON.stringify(c));
    }

    // What the History panel says then.
    const said = await ev(async (unknown) => {
      const a = window.__termdeck.app;
      const pause = (ms) => new Promise((r) => setTimeout(r, ms));
      const t = a.activeTab;
      const keep = [t.state.cli, t.state.sessionId];
      t.state.cli = 'claude';
      t.state.sessionId = unknown;
      a.toggleHistory(a.state.activePane);
      await pause(900);
      const root = document.querySelector('.history');
      const out = { empty: root?.querySelector('.history-empty')?.textContent ?? null, shown: root?.querySelectorAll('.hmsg').length ?? -1 };
      a.toggleHistory(a.state.activePane);
      [t.state.cli, t.state.sessionId] = keep;
      return out;
    }, unknown);
    check('History for a tab whose conversation cannot be found says so, names the id and shows no messages',
      !!said.empty && said.empty.includes(unknown) && said.empty.includes('Nothing else is shown') && said.shown === 0, JSON.stringify(said));
  }

  // ================= B10: content-security policy (the parts that cause no errors) =================
  let policy = '';
  {
    const r = await ev(async () => {
      const res = await fetch(location.href);
      const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '';
      return {
        header: res.headers.get('content-security-policy') ?? '',
        meta,
        font: document.fonts.check('14px "Cascadia Mono NF"'),
        canvas: document.querySelectorAll('.xterm canvas').length,
      };
    });
    policy = r.header || r.meta;
    check('the window has a content-security policy', /script-src 'self'/.test(policy) && /default-src 'self'/.test(policy) && !/script-src[^;]*unsafe/.test(policy), policy.slice(0, 400) || '(none)');
    check('under it the bundled font is loaded and the terminals are drawn', r.font && r.canvas > 0, JSON.stringify({ font: r.font, canvases: r.canvas }));
    // Dialogs and panels build their content in script; none of that may be refused.
    for (const id of ['btn-settings', 'btn-new', 'btn-open']) {
      await ev((id) => document.getElementById(id).click(), id);
      await sleep(900);
      await ev(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const btn = [...document.querySelectorAll('.modal .foot .btn')].find((b) => /^(Cancel|Close)$/.test(b.textContent.trim()));
        btn?.click();
      });
      await sleep(400);
    }
    await ev(() => window.__termdeck.app.toggleLibrary(true));
    await sleep(500);
    await ev(() => window.__termdeck.app.toggleLibrary(false));
    check('nothing the app does itself is refused by the policy (no errors so far)', app.errors.length === 0, app.errors.join(' | ').slice(0, 600));
  }

  // ================= B2: close for update =================
  {
    const standin = path.join(bin, 'codex-standin.exe');
    fs.copyFileSync(path.join(process.env.SystemRoot, 'System32', 'cmd.exe'), standin);
    const i = await newTab('powershell');
    await sleep(3000);
    // Something started in the tab BEFORE the CLI: must survive the update.
    await send(page, i, `$bg = Start-Process ping -ArgumentList '-n 600 127.0.0.1' -WindowStyle Hidden -PassThru; "BG=$($bg.Id)="\r`);
    const bgSeen = await until(async () => /BG=(\d+)=/.exec(await text(page, i, 20)), 15000);
    const bg = bgSeen ? Number(bgSeen[1]) : 0;
    if (bg) toKill.push(bg);
    // The stand-in CLI, which starts a program of its own that ignores Ctrl+C.
    await send(page, i, `& '${standin}' /k "start /b ping -n 600 127.0.0.1 >nul"\r`);
    const tab = () => ev((i) => {
      const t = window.__termdeck.app.tabs[i];
      return { running: t.cliRunning, pid: t.cliPid, exited: t.exited, resume: t.resumePending };
    }, i);
    const seen = await until(async () => {
      const t = await tab();
      return t.running === 'codex' && t.pid ? t : null;
    }, 20000);
    check('stand-in CLI: the tab takes it for a running CLI', !!seen, JSON.stringify(await tab()));
    if (seen && bg) {
      const cli = seen.pid;
      const started = childrenOf(cli);
      toKill.push(cli, ...started);
      check('stand-in CLI: it has started a program of its own, and one was started in the tab before it', started.length >= 1 && alive(bg), `CLI ${cli}, its own: ${started.join(',')}, before it: ${bg}`);
      // The close question (2026-11-12): the idle CLI and what it started are not named;
      // the program started in the tab before it is.
      const q = await ev((i) => { const a = window.__termdeck.app; return a.closingEnds(a.tabs[i]); }, i);
      check('close question: an idle CLI and its own programs are not named, the program started before it is', /^ping$/i.test(q ?? ''), `"${q}"`);
      const began = Date.now();
      await ev((i) => window.__termdeck.app.tabs[i].stopCli(), i);
      const took = Date.now() - began;
      const atOnce = await tab();
      await until(async () => (await tab()).running === 'none', 5000);
      const after = await tab();
      check('close for update: the tab shows at once that its CLI has gone', atOnce.running === 'none', JSON.stringify(atOnce));
      check('close for update: the CLI is ended (it ignored Ctrl+C, so by force)', !alive(cli), `${took} ms`);
      check('close for update: what the CLI had started is ended with it', started.every((p) => !alive(p)), started.map((p) => `${p}:${alive(p) ? 'alive' : 'gone'}`).join(' '));
      check('close for update: the program started in the tab before the CLI is still running', alive(bg), `pid ${bg}`);
      check('close for update: the shell is still there, back at its prompt', after.exited === false && after.running === 'none', JSON.stringify(after));
      await send(page, i, 'echo still-$(20+22)\r');
      check('close for update: the shell still takes commands', !!(await until(async () => (await text(page, i, 12)).includes('still-42'), 10000)));
      await shot(page, '18-b-closed-for-update');
    }
  }

  // ================= B10: what the policy refuses (this causes errors on purpose) =================
  {
    const before = app.errors.length;
    const r = await ev(async () => {
      const seen = [];
      const note = (e) => seen.push(e.effectiveDirective || e.violatedDirective);
      document.addEventListener('securitypolicyviolation', note);
      // 1. script text put into the page (what an injected <script> would be)
      const s = document.createElement('script');
      s.textContent = 'window.__cspProbe = 1;';
      document.body.appendChild(s);
      s.remove();
      // 2. a connection to anywhere but the app itself (an unused local address)
      let connected = 'refused';
      try {
        await fetch('http://127.0.0.1:9/probe', { mode: 'no-cors' });
        connected = 'allowed';
      } catch {
        /* expected */
      }
      // 3. a picture from elsewhere
      const img = new Image();
      img.src = 'http://127.0.0.1:9/probe.png';
      await new Promise((r) => setTimeout(r, 600));
      document.removeEventListener('securitypolicyviolation', note);
      return { ran: window.__cspProbe === 1, connected, seen };
    });
    check('policy: script text put into the page does not run', r.ran === false && r.seen.some((d) => d.startsWith('script-src')), JSON.stringify(r));
    check('policy: the page cannot connect to anything but the app itself', r.connected === 'refused' && r.seen.some((d) => d.startsWith('connect-src')), JSON.stringify(r));
    check('policy: a picture from elsewhere is not fetched', r.seen.some((d) => d.startsWith('img-src')), JSON.stringify(r.seen));
    check('each refusal is reported (and nothing else was)', app.errors.length - before >= 2 && before === 0, `${app.errors.length - before} reports, ${before} before`);
  }
} catch (e) {
  check('test ran to the end', false, String(e?.stack ?? e));
} finally {
  await app.close();
  for (const pid of toKill) {
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
  }
}

// ================= B9: wsl.exe never answers =================
{
  // In place of wsl.exe: a script that answers nothing for 27 seconds.
  const never = path.join(bin, 'never-answers.cmd');
  fs.writeFileSync(never, '@echo off\r\nping -n 27 127.0.0.1 >nul\r\n');
  const data2 = `${dataDir}-b9`;
  fs.rmSync(data2, { recursive: true, force: true });
  const began = Date.now();
  let app2;
  try {
    app2 = await launch({ dataDir: data2, env: { TERMDECK_TEST_WSL: never } });
    const took = Date.now() - began;
    const env2 = await app2.page.evaluate(() => window.__termdeck.app.env);
    check('with a WSL that never answers the app still starts — the question is given up after 4 seconds', took < 12000 && env2.wslDistros.length === 0,
      `ready after ${took} ms (a normal start took ${normalStart} ms; the stand-in would have held it 27 s); distros listed: ${env2.wslDistros.length}`);
    check('...and the rest was still found out', env2.build > 9000 && typeof env2.home === 'string' && env2.home.length > 2, JSON.stringify({ build: env2.build, hasPwsh: env2.hasPwsh, hasGitBash: env2.hasGitBash }));
    await send(app2.page, 0, 'echo ok-$(40+2)\r');
    check('...and its first tab works', !!(await until(async () => (await text(app2.page, 0, 12)).includes('ok-42'), 15000)));
    // Loading the page again with the error log attached from the first moment:
    // anything the policy refused while the page loads would show here.
    await app2.page.reload();
    await app2.page.waitForFunction(() => window.__termdeck?.app?.tabs?.length > 0 && window.__termdeck.app.tabs.every((t) => t.pid || t.exited), null, { timeout: 30000 });
    await sleep(1500);
    check('loading the page under the policy reports no error', app2.errors.length === 0, app2.errors.join(' | ').slice(0, 600));
    await shot(app2.page, '18-c-no-wsl-answer');
  } catch (e) {
    check('start with a WSL that never answers', false, String(e?.stack ?? e));
  } finally {
    await app2?.close();
    // The stand-in's own ping would otherwise idle on for the rest of its 27 seconds.
    try {
      ps(`Get-CimInstance Win32_Process -Filter "Name='PING.EXE'" | Where-Object { $_.CommandLine -like '*-n 27 127.0.0.1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`);
    } catch {
      /* none left */
    }
  }
}

fs.rmSync(bin, { recursive: true, force: true });
process.exit(summary() ? 1 : 0);
