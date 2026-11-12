// Diagnostic: does a command typed by the app (Resume, a CLI started with a new tab)
// always arrive whole? Covers focus reports arriving next to it, and the Resume
// moment itself: the app has just restarted, several shells are loading at once,
// and the command is given at the earliest possible instant.
// Uses plain PowerShell only; nothing is sent to any CLI.
// usage: node 09-typeahead.mjs <data-dir> <work-dir> [restarts]
import { launch, info, text, send, sleep, check, summary } from './harness.mjs';

const [dataDir, workDir] = process.argv.slice(2);
const restarts = Number(process.argv[4] ?? 6);
let app = await launch({ dataDir });
let page = app.page;
const tail = async (i, n = 14) => (await text(page, i, 60)).split('\n').filter((r) => r.trim()).slice(-n).map((r) => '      | ' + r).join('\n');
const ran = async (i, word) => new RegExp(`^${word}$`, 'm').test((await text(page, i, 80)).replace(/\r/g, ''));

try {
  await page.evaluate(() => window.__termdeck.app.setSplit(3));
  await sleep(2500);
  const modes = await page.evaluate(() => {
    const t = window.__termdeck.app.tabs[0].term;
    return { sendFocus: t.modes.sendFocusMode, bracketed: t.modes.bracketedPasteMode };
  });
  console.log(`tab 0 modes at the prompt: ${JSON.stringify(modes)}`);

  // 1. focus reports next to a command
  await send(page, 0, '\x1b[I');
  await send(page, 0, 'echo FOCUS-IN-OK\r');
  await sleep(1500);
  check('command right after a focus-in report runs whole', await ran(0, 'FOCUS-IN-OK'));
  await send(page, 0, '\x1b[O');
  await send(page, 0, 'echo FOCUS-OUT-OK\r');
  await sleep(1500);
  check('command right after a focus-out report runs whole', await ran(0, 'FOCUS-OUT-OK'));

  // 2. three more shells, one per pane, then restart the app over and over. Each time,
  //    every restored shell is given a command the way the Resume button gives one,
  //    as early as the test can manage, with a mouse click in each pane in between.
  await page.evaluate(async (cwd) => {
    const a = window.__termdeck.app;
    for (let p = 0; p < 3; p++) {
      a.state.activePane = p;
      await a.createTab({ shell: 'powershell', cwd, cli: 'none' });
    }
  }, workDir);
  await sleep(1500);

  let lost = 0;
  let given = 0;
  for (let r = 0; r < restarts; r++) {
    await app.close();
    await sleep(1000);
    app = await launch({ dataDir });
    page = app.page;
    const n = (await info(page)).length;
    for (let i = 1; i < n; i++) {
      await page.evaluate(([i, w]) => window.__termdeck.app.tabs[i].runWhenQuiet(`echo ${w}`), [i, `R${r}-TAB${i}-OK`]);
      const box = await page.locator('.pane').nth(i - 1).locator('.pane-body').boundingBox().catch(() => null);
      if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      given++;
    }
    await sleep(8000);
    for (let i = 1; i < n; i++) {
      if (!(await ran(i, `R${r}-TAB${i}-OK`))) {
        lost++;
        console.log(`restart ${r} tab ${i}: command did not run whole\n${await tail(i)}`);
      }
    }
  }
  check(`commands given to ${given} just-restored shells all ran whole`, lost === 0, `${lost} lost`);
} finally {
  await app.close();
}
process.exit(summary() ? 1 : 0);
