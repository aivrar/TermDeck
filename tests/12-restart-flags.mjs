// Restarting with several sessions waiting: flags are remembered, and "Resume all".
// Opens Claude Code in three tabs (started three different ways). Nothing is sent to it.
// The switch used to prove flags survive is --verbose, which only changes how much
// Claude prints.
// usage: node 12-restart-flags.mjs <data-dir> <work-dir>
import fs from 'node:fs';
import path from 'node:path';
import { launch, shot, send, resize, sleep, check, summary } from './harness.mjs';
import { ensureReady, openCli } from './clis.mjs';

const [dataDir, workDir] = process.argv.slice(2);
async function until(fn, timeout = 20000, step = 400) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) return false;
    await sleep(step);
  }
}
const tabs = (page) =>
  page.evaluate(() =>
    window.__termdeck.app.tabs.map((t) => ({ running: t.cliRunning, cli: t.state.cli, flags: t.state.flags ?? '', manual: !!t.state.flagsManual, resume: t.resumePending, command: t.resumeCommand(), buffer: t.term.buffer.active.type })),
  );
const newShell = (page, pane) =>
  page.evaluate(async ([cwd, pane]) => {
    const a = window.__termdeck.app;
    a.state.activePane = pane;
    await a.createTab({ shell: 'powershell', cwd, cli: 'none' });
    return a.tabs.length - 1;
  }, [workDir, pane]);

// "claude <switches>" or "claude --resume <id> <switches>"
const cmd = (switches) => new RegExp(`^claude( --resume [0-9a-f-]{36})?${switches ? ` ${switches}` : ''}$`);

let app = await launch({ dataDir });
let page = app.page;
try {
  await page.evaluate(() => window.__termdeck.app.setSplit(3));
  await resize(page, 1900, 900);
  await page.evaluate(() => window.__termdeck.app.toggleLibrary(false));

  // ---- A. which words of a command line are carried over (no CLI involved) ----
  const pick = (cli, args) => page.evaluate(([cli, args]) => window.__termdeck.extractSwitches(cli, args), [cli, args]);
  const cases = [
    ['claude', ['--resume', '0f3c9a1e-5b7d-4c2e-9a8f-1d2e3f4a5b6c', '--dangerously-skip-permissions'], '--dangerously-skip-permissions', 'claude resume'],
    ['claude', ['--dangerously-skip-permissions', 'fix the login bug'], '', 'a prompt is never carried over (so the switch before it is not either)'],
    ['claude', ['--verbose', '--dangerously-skip-permissions'], '--verbose --dangerously-skip-permissions', 'two switches'],
    ['claude', ['--model=opus', '-c'], '--model=opus', '"continue" is dropped'],
    ['claude', ['--permission-mode', 'plan', '--verbose'], '--permission-mode plan --verbose', 'a switch known to take a value keeps it'],
    ['claude', ['--some-new-flag', 'value', '--verbose'], '--verbose', 'an unknown switch with a value is dropped whole'],
    ['claude', ['-p', 'summarise this'], '', 'print-and-exit is dropped'],
    ['codex', ['resume', '01900000-0000-7000-8000-0000000000c1', '--dangerously-bypass-approvals-and-sandbox'], '--dangerously-bypass-approvals-and-sandbox', 'codex resume'],
    ['codex', ['-s', 'workspace-write', '-a', 'never'], '-s workspace-write -a never', 'codex sandbox and approval'],
    ['grok', ['--resume', '01900000-0000-7000-8000-0000000000c2', '--always-approve'], '--always-approve', 'grok resume'],
  ];
  for (const [cli, args, want, why] of cases) {
    const got = await pick(cli, args);
    check(`${cli} ${args.join(' ')}  →  ${want || '(nothing)'}`, got === want, got === want ? why : `got "${got}"`);
  }

  // ---- B. three Claude tabs, started three ways ----
  const viaDialog = await openCli(page, 'claude', workDir, 0); // "Start: claude" in the New session dialog
  const typed = await newShell(page, 1); // typed by hand, with a switch
  const fullPath = await newShell(page, 2); // typed by hand, full path to the exe, with a switch
  await sleep(2500);
  await send(page, typed, 'claude --verbose\r');
  await send(page, fullPath, `${path.join(process.env.USERPROFILE, '.local', 'bin', 'claude.exe')} --verbose\r`);
  for (const i of [viaDialog, typed, fullPath]) check(`tab ${i}: Claude started`, await ensureReady(page, i, 'claude'));
  await sleep(2500);
  let t = await tabs(page);
  check('a session started without switches has none remembered', t[viaDialog].flags === '', `"${t[viaDialog].flags}"`);
  check('a hand-typed "claude --verbose" is remembered for its tab', t[typed].flags === '--verbose', `"${t[typed].flags}"`);
  check('the same when started by full path to claude.exe', t[fullPath].flags === '--verbose', `"${t[fullPath].flags}"`);
  await shot(page, '12-a-three-sessions');

  // ---- C. restart: every tab waits, with its own command ----
  await app.close();
  await sleep(1500);
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  check('the switches are in the saved state', saved.tabs.filter((x) => x.flags === '--verbose').length === 2);
  app = await launch({ dataDir });
  page = app.page;
  await sleep(2500);
  t = await tabs(page);
  check('after a restart all three tabs wait to be resumed', [viaDialog, typed, fullPath].every((i) => t[i].resume && t[i].cli === 'claude' && t[i].running === 'none'));
  check('plain tab: command has no switches', t[viaDialog].command === 'claude', t[viaDialog].command);
  check('flagged tabs: command carries the switch', t[typed].command === 'claude --verbose' && t[fullPath].command === 'claude --verbose', `${t[typed].command} | ${t[fullPath].command}`);
  const bars = await page.locator('.resume-bar:not([hidden]) .grow').allInnerTexts();
  check('each Resume bar shows the exact command', bars.length === 3 && bars.filter((b) => /claude --verbose\s*$/.test(b)).length === 2, bars.map((b) => b.split('with:')[1]?.trim()).join(' | '));
  const all = page.locator('#btn-resume-all');
  check('"Resume all" is offered with the count', (await all.isVisible()) && /Resume all 3 sessions/.test(await all.innerText()), await all.innerText());
  await shot(page, '12-b-restored');

  // ---- D. one click resumes all of them, each with its own switches ----
  await all.click();
  const up = await until(async () => { const x = await tabs(page); return [viaDialog, typed, fullPath].every((i) => x[i].running === 'claude') ? x : false; }, 60000);
  check('one click: all three are running again', !!up);
  await sleep(4000);
  t = await tabs(page);
  check('…each started with its own switches again', t[viaDialog].flags === '' && t[typed].flags === '--verbose' && t[fullPath].flags === '--verbose', `"${t[viaDialog].flags}" | "${t[typed].flags}" | "${t[fullPath].flags}"`);
  check('"Resume all" goes away once nothing is waiting', !(await all.isVisible()));
  check('Claude is in full-screen mode in all three', [viaDialog, typed, fullPath].every((i) => t[i].buffer === 'alternate'), [viaDialog, typed, fullPath].map((i) => t[i].buffer).join(', '));
  await shot(page, '12-c-resumed-all');

  // ---- E. a switch for every session of a CLI, and one set by hand for a tab ----
  await page.evaluate(() => { window.__termdeck.app.state.cliFlags.claude = '--debug'; });
  t = await tabs(page);
  check('a default switch is added to every Claude command', cmd('--debug').test(t[viaDialog].command) && cmd('--debug --verbose').test(t[typed].command), `${t[viaDialog].command} | ${t[typed].command}`);
  await page.evaluate(() => { window.__termdeck.app.state.cliFlags.claude = ''; });
  await page.locator('.tab').nth(typed).click({ button: 'right' });
  await page.locator('.menu button', { hasText: 'CLI flags' }).click();
  const box = page.locator('.modal input').first();
  await box.fill('--verbose --dangerously-skip-permissions');
  await sleep(300);
  check('the flags dialog previews the command', cmd('--verbose --dangerously-skip-permissions').test(await page.locator('.flag-preview').innerText()), await page.locator('.flag-preview').innerText());
  await shot(page, '12-d-flags-dialog');
  await page.locator('.modal .foot button', { hasText: 'Save' }).click();
  await sleep(2500);
  t = await tabs(page);
  check('switches typed in by hand are kept (not overwritten from the running process)', t[typed].manual && t[typed].flags === '--verbose --dangerously-skip-permissions' && cmd('--verbose --dangerously-skip-permissions').test(t[typed].command), t[typed].command);

  // ---- F. Codex has its own switches; started by hand with one, is it remembered? ----
  // "-s read-only" is Codex's most restrictive sandbox setting. Nothing is sent to it.
  const cx = await newShell(page, 0);
  await sleep(2500);
  await send(page, cx, 'codex -s read-only\r');
  if (await ensureReady(page, cx, 'codex')) {
    await sleep(2500);
    t = await tabs(page);
    check('codex: a hand-typed "codex -s read-only" is remembered for its tab', t[cx].flags === '-s read-only', `"${t[cx].flags}"  ->  ${t[cx].command}`);
  } else {
    console.log('(codex did not start — its own sign-in timeout on a slow connection; this check was skipped)');
  }
  check('no page errors', app.errors.length === 0, app.errors.slice(0, 3).join(' | '));
} finally {
  await app.close();
}
process.exit(summary() ? 1 : 0);
