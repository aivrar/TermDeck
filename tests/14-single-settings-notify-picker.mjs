// One copy per data folder, the Settings screen, finish / needs-you notifications and
// the list of past sessions.
// Sends NO prompt to any CLI. Resumes one existing Claude Code conversation from the
// scratch folder (opened and closed again, nothing said in it).
// usage: node 14-single-settings-notify-picker.mjs <data-dir> <work-dir>
import { spawn } from 'node:child_process';
import { launch, shot, send, resize, sleep, check, summary, text, EXE } from './harness.mjs';
import { ensureReady } from './clis.mjs';

const [dataDir, workDir] = process.argv.slice(2);
async function until(fn, timeout = 20000, step = 300) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) return false;
    await sleep(step);
  }
}
const cleanEnv = (extra) => {
  const env = { ...process.env, TERMDECK_NO_FOCUS: '1', ...extra };
  for (const key of Object.keys(env)) if (/^(CLAUDE_CODE_|CLAUDECODE$|CLAUDE_PID$|CLAUDE_EFFORT$)/.test(key)) delete env[key];
  return env;
};
/** Starts the exe and reports how it ended within `ms` (or that it is still running). */
function startCopy(env, ms) {
  return new Promise((resolve) => {
    const p = spawn(EXE, [], { env: cleanEnv(env), stdio: 'ignore' });
    const timer = setTimeout(() => resolve({ running: true, proc: p }), ms);
    p.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ running: false, code });
    });
  });
}
const notices = (page) => page.evaluate(() => window.__termdeck.app.notices.map((n) => ({ ...n })));
const setting = (page, patch) =>
  page.evaluate((patch) => {
    const a = window.__termdeck.app;
    Object.assign(a.state.settings, patch);
  }, patch);
const look = (page, i = 0) =>
  page.evaluate((i) => {
    const a = window.__termdeck.app;
    const o = a.tabs[i].term.options;
    return { font: o.fontFamily, size: o.fontSize, scrollback: o.scrollback, bg: o.theme.background, cols: a.tabs[i].term.cols, saved: { ...a.state.settings }, cssBg: getComputedStyle(document.documentElement).getPropertyValue('--term-bg').trim() };
  }, i);

let app = await launch({ dataDir });
let page = app.page;
try {
  await resize(page, 1500, 820);
  await page.evaluate(() => window.__termdeck.app.toggleLibrary(false));

  // ================= 1. one copy per data folder =================
  const second = await startCopy({ TERMDECK_DATA_DIR: dataDir, TERMDECK_DEBUG_PORT: '9341' }, 12000);
  check('second start with the same data folder: no second window, it ends by itself', second.running === false, second.running ? 'still running after 12 s' : `exit code ${second.code}`);
  if (second.running) second.proc.kill();
  const told = await until(() => page.evaluate(() => window.__termdeck.app.secondStarts), 5000);
  check('…and the open window is told (it comes forward and says so)', told === 1, `handed over ${told || 0} time(s)`);
  check('…with a message', /already open/.test(await page.evaluate(() => document.getElementById('toasts').innerText)));
  await shot(page, '14-a-second-start');
  const tabsBefore = await page.evaluate(() => window.__termdeck.app.tabs.length);
  // a different data folder is a different TermDeck and must still start
  let other = null;
  try {
    other = await launch({ dataDir: dataDir + '-other', port: 9342 });
    check('a copy with a different data folder still starts alongside', true);
  } catch (e) {
    check('a copy with a different data folder still starts alongside', false, String(e).slice(0, 120));
  }
  if (other) await other.close();
  check('the first window was not disturbed', (await page.evaluate(() => window.__termdeck.app.tabs.length)) === tabsBefore && app.errors.length === 0);
  // once the first has closed, the folder is free again (checked at the restart further down)

  // ================= 2. settings =================
  const before = await look(page);
  check('defaults: bundled font, 10,000 lines, dark', /^"Cascadia Mono NF"/.test(before.font) && before.scrollback === 10000 && before.bg === '#0c0e12', `${before.font.slice(0, 30)}… ${before.scrollback} ${before.bg}`);
  await page.click('#btn-settings');
  await page.waitForSelector('#settings');
  await shot(page, '14-b-settings');
  const fit = await page.evaluate(() => {
    const m = document.querySelector('.modal');
    const right = m.getBoundingClientRect().right;
    return { sideways: m.scrollWidth - m.clientWidth, out: [...m.querySelectorAll('input, select, button')].filter((e) => e.getBoundingClientRect().right > right + 0.5).length };
  });
  check('the Settings dialog fits: no sideways scrolling, no control past its edge', fit.sideways <= 0 && fit.out === 0, JSON.stringify(fit));
  const fields = page.locator('#settings');
  await fields.locator('input[list="font-names"]').fill('Consolas');
  await fields.locator('input[type=number]').nth(0).fill('17'); // size
  await fields.locator('select').nth(0).selectOption('black');
  await fields.locator('input[type=number]').nth(1).fill('2500'); // history
  // Found by what it offers, not by its place: a box added before it (pane layout,
  // 2026-11-12) moved it and this line then picked the wrong one.
  await fields.locator('select:has(option[value="both"])').selectOption('both'); // sound
  await fields.locator('input[type=number]').nth(2).fill('20'); // heavy: processor
  await fields.locator('input[type=number]').nth(3).fill('12'); // heavy: memory
  await page.locator('.modal .foot button', { hasText: 'Save' }).click();
  await sleep(900);
  let now = await look(page);
  check('Save: font applied to the open terminal (built-in font kept behind it)', /^"Consolas", "Cascadia Mono NF"/.test(now.font), now.font.slice(0, 50));
  check('Save: size applied', now.size === 17, `${now.size}`);
  check('Save: colours applied (terminal and the frame around it)', now.bg === '#000000' && now.cssBg === '#000000', `${now.bg} / ${now.cssBg}`);
  check('Save: history length applied', now.scrollback === 2500, `${now.scrollback}`);
  check('Save: terminal re-fitted to the new font', now.cols !== before.cols && now.cols > 20, `${before.cols} -> ${now.cols} columns`);
  check('Save: stored', now.saved.fontFamily === 'Consolas' && now.saved.theme === 'black' && now.saved.notifySound === 'both' && now.saved.hotCpu === 20 && now.saved.hotMem === 12, JSON.stringify(now.saved));
  // text still draws and the shell still works with the new font
  await send(page, 0, 'echo settings-ok-417\r');
  check('the terminal still works after the change', !!(await until(async () => /settings-ok-417\s*\n.*settings-ok-417/s.test(await text(page, 0, 30)), 8000)));
  await shot(page, '14-c-settings-applied');
  // what counts as heavy
  const levels = await page.evaluate(() => {
    const a = window.__termdeck.app;
    const t = a.tabs[0];
    const keep = [t.cpu, t.mem];
    const out = {};
    t.mem = 0;
    t.cpu = 25; out.cpu25at20 = a.usageLevel(t);
    t.cpu = 10; out.cpu10at20 = a.usageLevel(t);
    t.cpu = 5; out.cpu5at20 = a.usageLevel(t);
    a.state.settings.hotCpu = 60;
    t.cpu = 25; out.cpu25at60 = a.usageLevel(t);
    t.cpu = 0; t.mem = (a.system?.memTotal ?? 0) * 0.13; out.mem13at12 = a.usageLevel(t);
    a.state.settings.hotCpu = 20;
    [t.cpu, t.mem] = keep;
    return out;
  });
  check('heavy threshold follows the setting', levels.cpu25at20 === 'hot' && levels.cpu10at20 === 'warm' && levels.cpu5at20 === '' && levels.cpu25at60 === 'warm' && levels.mem13at12 === 'hot', JSON.stringify(levels));
  // nonsense is put right rather than saved
  await page.click('#btn-settings');
  await page.waitForSelector('#settings');
  await page.locator('#settings input[type=number]').nth(1).fill('5');
  await page.locator('#settings input[type=number]').nth(2).fill('');
  await page.locator('.modal .foot button', { hasText: 'Save' }).click();
  await sleep(500);
  now = await look(page);
  check('out-of-range values are corrected (history 5 -> 1000; empty -> default)', now.saved.scrollback === 1000 && now.saved.hotCpu === 60, `${now.saved.scrollback}, ${now.saved.hotCpu}`);
  await setting(page, { scrollback: 2500 });
  await page.evaluate(() => { const a = window.__termdeck.app; a.applyLook(); return a.saveNow(); });

  // ================= 3. notifications =================
  await page.evaluate(() => window.__termdeck.app.setSplit(2));
  const quiet = await page.evaluate(async (cwd) => {
    const a = window.__termdeck.app;
    a.state.activePane = 1;
    await a.createTab({ shell: 'powershell', cwd, cli: 'none' });
    const i = a.tabs.length - 1;
    a.showTab(a.tabs[0]); // the tab being "looked at" is the other one
    return i;
  }, workDir);
  await sleep(2500);
  const activity = () => page.evaluate((i) => window.__termdeck.app.tabs[i].activity, quiet);
  const longJob = async () => {
    const seen = (await notices(page)).length;
    await send(page, quiet, 'ping -n 9 127.0.0.1 > $null\r');
    return until(async () => (await notices(page)).slice(seen).find((n) => n.kind === 'done'), 25000);
  };
  // -- TermDeck in front, looking at another tab --
  let seen = (await notices(page)).length;
  await send(page, quiet, 'echo quick\r');
  await sleep(4000);
  check('a quick command announces nothing', (await notices(page)).length === seen, `${(await notices(page)).length - seen} notice(s)`);
  let got = await longJob();
  check('in front, other tab: work that ends (8 s) is announced as finished', !!got, got ? '' : JSON.stringify(await notices(page)));
  check('…with a sound (set to "both") and no taskbar flash, since the app is in front', !!got && got.flashed === false && got.sound === true, JSON.stringify(got));
  check('…the tab shows "finished" and the window title counts it', (await activity()) === 'done' && /finished/.test(await page.title()), await page.title());
  await shot(page, '14-d-finished-notice');
  // the tab you are looking at announces nothing
  seen = (await notices(page)).length;
  await page.evaluate((i) => { const a = window.__termdeck.app; a.showTab(a.tabs[i]); }, quiet);
  await send(page, quiet, 'ping -n 9 127.0.0.1 > $null\r');
  await sleep(13000);
  check('the tab you are looking at announces nothing', (await notices(page)).length === seen && (await activity()) === 'idle', `${(await notices(page)).length - seen} notice(s), ${await activity()}`);
  // -- TermDeck not in front (the test tells the page so; the real window never has the keyboard in tests) --
  await page.evaluate(() => { document.hasFocus = () => false; });
  await setting(page, { notifySound: 'needs' });
  got = await longJob();
  check('not in front: finishing asks for the taskbar flash; no sound with "only when a session needs me"', !!got && got.flashed === true && got.sound === false, JSON.stringify(got));
  seen = (await notices(page)).length;
  await send(page, quiet, 'Write-Host ([char]7)\r');
  got = await until(async () => (await notices(page)).slice(seen).find((n) => n.kind === 'needs'), 12000);
  check('a tab asking for attention is announced as "needs you": flash and sound', !!got && got.sound === true && got.flashed === true, JSON.stringify(got));
  check('…and shows "needs you"', (await activity()) === 'attention');
  await shot(page, '14-e-needs-you');
  await setting(page, { notifySound: 'off', notifyFlash: false });
  await send(page, quiet, '\r');
  await sleep(1500);
  got = await longJob();
  check('flash and sound switched off: neither happens (the tab marker still shows)', !!got && got.flashed === false && got.sound === false && (await activity()) === 'done', JSON.stringify(got));
  await page.evaluate(() => { delete document.hasFocus; return window.__TAURI__.core.invoke('attention', { on: false }); });
  await setting(page, { notifySound: 'needs', notifyFlash: true });

  // ================= 4. past sessions =================
  const counts = {};
  for (const cli of ['claude', 'codex', 'grok']) {
    const t0 = Date.now();
    const all = await page.evaluate((cli) => window.__TAURI__.core.invoke('sessions_list', { cli, cwd: null, limit: 300 }), cli);
    const ms = Date.now() - t0;
    const here = await page.evaluate(([cli, cwd]) => window.__TAURI__.core.invoke('sessions_list', { cli, cwd, limit: 300 }), [cli, workDir]);
    counts[cli] = { all: all.length, here: here.length };
    const sorted = all.every((s, i) => i === 0 || all[i - 1].modified >= s.modified);
    const withFolder = all.filter((s) => s.cwd).length;
    const withTitle = all.filter((s) => s.title).length;
    console.log(`${cli}: ${all.length} conversations listed in ${ms} ms (${withFolder} with a folder, ${withTitle} with a title); ${here.length} in the scratch folder`);
    check(`${cli}: list read, newest first, every entry has an id`, all.length > 0 && sorted && all.every((s) => s.id && s.cli === cli), `${all.length} entries`);
    check(`${cli}: folder filter returns only that folder`, here.every((s) => s.cwd.toLowerCase().replace(/[\\/]+$/, '') === workDir.toLowerCase().replace(/[\\/]+$/, '')) && here.length <= all.length, `${here.length} entries`);
    check(`${cli}: quick enough to open without a wait`, ms < 4000, `${ms} ms`);
  }
  // the dialog, limited to the scratch folder so the screenshots show only test conversations
  await page.evaluate((i) => { const a = window.__termdeck.app; a.showTab(a.tabs[i]); }, quiet);
  await page.click('#btn-open');
  await page.waitForSelector('.ses-list');
  await page.locator('.ses-here input').check();
  await page.locator('.choices [data-cli="claude"]').click();
  await until(() => page.evaluate(() => !document.querySelector('.ses-list .upd-wait') || /No saved|Nothing matches/.test(document.querySelector('.ses-list').innerText)), 10000);
  const rows = await page.locator('.ses-row').count();
  check('dialog: lists the Claude Code conversations of the focused tab\'s folder', rows === counts.claude.here && rows > 0, `${rows} rows`);
  await shot(page, '14-f-past-sessions');
  const fit2 = await page.evaluate(() => { const m = document.querySelector('.modal'); return m.scrollWidth - m.clientWidth; });
  check('the Past sessions dialog fits: no sideways scrolling', fit2 <= 0, `${fit2} px`);
  await page.locator('.ses-search').fill('zzz-no-such-conversation');
  await sleep(300);
  check('dialog: search narrows the list', (await page.locator('.ses-row').count()) === 0 && /Nothing matches/.test(await page.locator('.ses-list').innerText()));
  await page.locator('.ses-search').fill('');
  await sleep(300);
  // pick the second row (not the default) to prove the selection is what gets opened
  const pickAt = Math.min(1, rows - 1);
  const wanted = await page.locator('.ses-row').nth(pickAt).getAttribute('data-id');
  await page.locator('.ses-row').nth(pickAt).click();
  // Switches can be set before the conversation is opened (it used to start at once,
  // with no chance to add one).
  {
    const preview = () => page.locator('.modal .flags-field .flag-preview').innerText();
    check('dialog: shows the command the chosen conversation will be started with', (await preview()) === `claude --resume ${wanted}`, await preview());
    const quick = page.locator('.modal .flags-field .flags-quick');
    check('dialog: one click offers the skip-permissions switch', (await quick.innerText()) === '+ --dangerously-skip-permissions');
    await quick.click();
    check('…and adds it to the command', (await preview()) === `claude --resume ${wanted} --dangerously-skip-permissions` && !(await quick.isVisible()), await preview());
    // The test itself opens the conversation with a harmless switch instead.
    await page.locator('.modal .flags-field .flags-own').fill('--verbose');
    check('dialog: switches typed in are shown in the command', (await preview()) === `claude --resume ${wanted} --verbose`, await preview());
    const fit3 = await page.evaluate(() => { const m = document.querySelector('.modal'); return m.scrollWidth - m.clientWidth; });
    check('the dialog still fits with the switches part', fit3 <= 0, `${fit3} px`);
    await shot(page, '14-f2-past-sessions-switches');
  }
  const tabCount = await page.evaluate(() => window.__termdeck.app.tabs.length);
  await page.locator('.modal .foot button', { hasText: 'Open in a new tab' }).click();
  const opened = await until(() => page.evaluate((n) => (window.__termdeck.app.tabs.length > n ? window.__termdeck.app.tabs.length - 1 : false), tabCount), 8000);
  check('Open: a new tab is made', opened !== false);
  if (opened !== false) {
    const st = await page.evaluate((i) => { const t = window.__termdeck.app.tabs[i]; return { cwd: t.state.cwd, cli: t.state.cli, id: t.state.sessionId }; }, opened);
    check('…in the conversation\'s folder, for that conversation', st.cli === 'claude' && st.id === wanted && st.cwd.toLowerCase() === workDir.toLowerCase(), JSON.stringify(st));
    const up = await ensureReady(page, opened, 'claude', 1);
    check('…and Claude Code is resumed in it', up);
    // Claude Code draws on its own full screen; the command that started it is on the shell's screen behind it.
    const typed = await page.evaluate((i) => {
      const b = window.__termdeck.app.tabs[i].term.buffer.normal;
      const out = [];
      for (let y = 0; y < b.length; y++) out.push(b.getLine(y)?.translateToString(true) ?? '');
      return out.join('\n');
    }, opened);
    check('…by the usual resume command', typed.replace(/\s+/g, '').includes(`claude--resume${wanted}`), typed.replace(/\s+/g, '').includes(`claude--resume${wanted}`) ? '' : 'command line not found on the shell screen');
    const own = await page.evaluate((i) => { const t = window.__termdeck.app.tabs[i]; return { flags: t.state.flags ?? null, manual: t.state.flagsManual === true, resume: t.resumeCommand() }; }, opened);
    check('…with the switch set in the dialog, which the tab keeps for its next Resume',
      typed.replace(/\s+/g, '').includes(`claude--resume${wanted}--verbose`) && own.flags === '--verbose' && own.manual && own.resume === `claude --resume ${wanted} --verbose`, JSON.stringify(own));
    const live = await until(() => page.evaluate(([i, id]) => window.__termdeck.app.tabs[i].state.sessionId === id && window.__termdeck.app.tabs[i].cliRunning === 'claude', [opened, wanted]), 15000);
    check('…and the tab stays on that conversation', !!live);
    await shot(page, '14-g-session-opened');
    // asking for the same one again shows the tab instead of opening it twice
    await page.click('#btn-open');
    await page.waitForSelector('.ses-list');
    await page.locator('.ses-here input').check();
    await until(() => page.locator('.ses-row').count(), 10000);
    check('dialog: marks the one that is open', /open in a tab/.test(await page.locator(`.ses-row[data-id="${wanted}"]`).innerText()));
    await page.locator(`.ses-row[data-id="${wanted}"]`).dblclick();
    await sleep(1200);
    check('opening it again shows its tab instead of a second copy', (await page.evaluate(() => window.__termdeck.app.tabs.length)) === tabCount + 1 && (await page.locator('.ses-list').count()) === 0);
    // leave Claude the gentle way (Ctrl+C), as the app does before an update
    await page.evaluate((i) => window.__termdeck.app.tabs[i].stopCli(), opened);
    await sleep(1500);
  }
  if (await page.locator('.modal').count()) await page.keyboard.press('Escape');

  // ---------- the New session dialog has the same switches part ----------
  {
    await sleep(500);
    await page.click('#btn-new');
    await page.waitForSelector('.modal .flags-field', { state: 'attached' });
    const field = page.locator('.modal .flags-field');
    const choose = (label) => page.locator('.modal .choices .choice', { hasText: label }).last().click();
    check('New session: no switches part for a plain shell', !(await field.isVisible()));
    await choose('claude');
    check('New session: choosing a CLI shows the switches part and the command', (await field.isVisible()) && (await field.locator('.flag-preview').innerText()) === 'claude');
    await field.locator('.flags-own').fill('--verbose');
    await choose('codex');
    check('New session: switches typed for one CLI are not carried over to another', (await field.locator('.flags-own').inputValue()) === '' && (await field.locator('.flag-preview').innerText()) === 'codex'
      && (await field.locator('.flags-quick').innerText()) === '+ --dangerously-bypass-approvals-and-sandbox');
    await choose('claude');
    await field.locator('.flags-own').fill('--verbose');
    await field.locator('.flags-always').check();
    check('New session: the command shows them', (await field.locator('.flag-preview').innerText()) === 'claude --verbose');
    await page.locator('.modal input').first().fill(workDir);
    const before = await page.evaluate(() => window.__termdeck.app.tabs.length);
    await page.locator('.modal .foot button', { hasText: 'Open' }).click();
    const made = await until(() => page.evaluate((n) => (window.__termdeck.app.tabs.length > n ? window.__termdeck.app.tabs.length - 1 : false), before), 8000);
    check('New session: a tab is made', made !== false);
    if (made !== false) {
      const up = await ensureReady(page, made, 'claude', 1);
      const typed = await page.evaluate((i) => {
        const b = window.__termdeck.app.tabs[i].term.buffer.normal;
        const out = [];
        for (let y = 0; y < b.length; y++) out.push(b.getLine(y)?.translateToString(true) ?? '');
        return out.join('\n');
      }, made);
      const kept = await page.evaluate(() => window.__termdeck.app.state.cliFlags.claude);
      // Two proofs: the line typed into the shell, and the switches read back from the running process.
      const seen = await until(() => page.evaluate((i) => window.__termdeck.app.tabs[i].state.flags === '--verbose', made), 8000);
      check('New session: Claude Code is started with the switch', up && seen && typed.replace(/\s+/g, '').includes('claude--verbose'),
        `started=${up} read back from the process=${seen} shell screen: ${typed.replace(/\s+/g, ' ').trim().slice(-160)}`);
      check('"Use these for every session" keeps them for that CLI', kept === '--verbose', `"${kept}"`);
      await page.evaluate((i) => window.__termdeck.app.tabs[i].stopCli(), made);
      await sleep(1500);
      // put back, so nothing later in this test is started with it
      await page.evaluate(() => { const a = window.__termdeck.app; a.state.cliFlags.claude = ''; a.scheduleSave(); });
    } else if (await page.locator('.modal').count()) await page.keyboard.press('Escape');
  }

  // ================= 5. settings survive a restart; the folder is free again =================
  await app.close();
  await sleep(1500);
  app = await launch({ dataDir });
  page = app.page;
  check('after closing, the same data folder starts normally again', true);
  now = await look(page);
  check('restart: settings kept and applied to new terminals', /^"Consolas"/.test(now.font) && now.bg === '#000000' && now.scrollback === 2500 && now.size === 17, `${now.font.slice(0, 20)} ${now.bg} ${now.scrollback} ${now.size}`);
  // Back to defaults button
  await page.click('#btn-settings');
  await page.waitForSelector('#settings');
  await page.locator('.modal .foot button', { hasText: 'Back to defaults' }).click();
  await page.locator('.modal .foot button', { hasText: 'Save' }).click();
  await sleep(900);
  now = await look(page);
  check('Back to defaults + Save restores the original look', /^"Cascadia Mono NF"/.test(now.font) && now.bg === '#0c0e12' && now.scrollback === 10000 && now.size === 14, `${now.font.slice(0, 20)} ${now.bg} ${now.scrollback} ${now.size}`);
  await shot(page, '14-h-defaults-again');
  check('no page errors', app.errors.length === 0, app.errors.slice(0, 3).join(' | '));
} finally {
  await app.close();
}
process.exit(summary() ? 1 : 0);
