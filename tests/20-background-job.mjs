// A CLI that has answered but still has a command running in the background (a test
// run, a server): the tab is not "working" — you can talk to it — but closing it would
// end that command. So the tab says "background job", and closing asks first.
// Known for Claude Code, whose own status file says "shell" for exactly this.
// usage: node 20-background-job.mjs <data-dir> <work-dir>
// Sends ONE short prompt to Claude Code (allowed to run `ping` only): start a 45-second
// ping in the background.
import { launch, shot, send, sleep, check, summary } from './harness.mjs';
import { ensureReady } from './clis.mjs';

const [dataDir, workDir] = process.argv.slice(2);
const app = await launch({ dataDir });
const { page } = app;
const until = async (fn, timeout = 15000, step = 250) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) return false;
    await sleep(step);
  }
};

try {
  await page.evaluate(() => window.__termdeck.app.toggleLibrary(false));
  const i = 0;
  await page.evaluate((cwd) => window.__termdeck.app.tabs[0].send(`cd '${cwd}'\r`), workDir);
  await sleep(2500);
  await send(page, i, 'claude --allowedTools "Bash(ping:*)"\r');
  const up = await ensureReady(page, i, 'claude');
  check('Claude Code started', up);
  const tab = () => page.evaluate((i) => {
    const a = window.__termdeck.app;
    const t = a.tabs[i];
    return {
      activity: t.activity, status: t.cliStatus, background: t.background, programs: t.backgroundPrograms().join(','),
      asks: a.closingEnds(t), row: document.querySelectorAll('#tablist .tab')[i]?.querySelector('.st')?.textContent ?? '',
      head: document.querySelector('.pane .p-st')?.textContent ?? '', tabs: a.tabs.length,
    };
  }, i);
  const idle0 = await tab();
  check('idle, nothing in the background: the tab says nothing and closing would ask nothing', idle0.background === false && idle0.asks === null && idle0.row === '', JSON.stringify(idle0));

  await page.evaluate(([i, p]) => window.__termdeck.app.tabs[i].submit(p), [i,
    'Use the Bash tool with run_in_background set to true to run exactly this command: ping -n 45 127.0.0.1   Do not wait for it and do not check on it. As soon as it has started, reply with the single word STARTED and stop.']);
  const worked = await until(async () => (await tab()).activity === 'working', 30000);
  check('while it answers the tab shows "working"', !!worked);
  const bg = await until(async () => { const t = await tab(); return t.background && /ping/i.test(t.programs) ? t : null; }, 60000);
  check('after it has answered, with the ping still running: not "working", but marked as having a background job', !!bg && bg.activity !== 'working' && /background job/.test(bg.row) && /background job/.test(bg.head), JSON.stringify(bg || (await tab())));
  await shot(page, '20-a-background-job');
  if (bg) {
    check('closing would ask, and names the command', /^Claude Code and a background command it started: ping$/i.test(bg.asks ?? ''), String(bg.asks));
    // the tab's own ×
    await page.evaluate((i) => document.querySelectorAll('#tablist .tab')[i].querySelector('.t-close').click(), i);
    const asked = await until(() => page.locator('.modal').count(), 6000);
    const said = asked ? (await page.locator('.modal').innerText()).replace(/\s+/g, ' ') : '';
    check('× on the tab asks first', !!asked && /background command it started: ping/.test(said), said.slice(0, 240));
    await shot(page, '20-b-close-asks');
    if (asked) await page.locator('.modal .foot button', { hasText: 'Cancel' }).click();
    await sleep(500);
    // closing the app
    await page.evaluate(() => window.__TAURI__.window.getCurrentWindow().close());
    const asked2 = await until(() => page.locator('.modal').count(), 8000);
    const said2 = asked2 ? (await page.locator('.modal').innerText()).replace(/\s+/g, ' ') : '';
    check('closing the app asks first, naming the tab and the command', !!asked2 && /Close TermDeck\?/.test(said2) && /background command it started: ping/.test(said2), said2.slice(0, 260));
    if (asked2) await page.locator('.modal .foot button', { hasText: 'Cancel' }).click();
    await sleep(500);
    const still = await tab();
    check('Cancel both times: the tab, the session and the ping are all still there', still.tabs === 1 && still.background === true && /ping/i.test(still.programs), JSON.stringify(still));
    // when the ping has ended
    const after = await until(async () => { const t = await tab(); return !t.background && t.activity !== 'working' ? t : null; }, 90000, 500);
    check('once the background command has ended the mark goes, and closing asks nothing again', !!after && after.asks === null && !/background/.test(after.row), JSON.stringify(after || (await tab())));
  }
  check('no page errors', app.errors.length === 0, app.errors.join(' | ').slice(0, 300));
  await page.evaluate((i) => window.__termdeck.app.tabs[i].stopCli(), i);
  await sleep(1500);
} catch (e) {
  check('test ran to the end', false, String(e?.stack ?? e));
} finally {
  await app.close();
}
process.exit(summary() ? 1 : 0);
