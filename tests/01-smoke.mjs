// First look: does the window come up, does a shell run, does it draw?
import { launch, shot, info, text, send, waitText, sleep, check, summary } from './harness.mjs';

const dataDir = process.argv[2];
if (!dataDir) throw new Error('usage: node 01-smoke.mjs <data-dir>');

const app = await launch({ dataDir });
const { page } = app;
try {
  await sleep(1500);
  await shot(page, '01-startup');
  let tabs = await info(page);
  console.log(JSON.stringify(tabs, null, 1));
  check('one tab on first run', tabs.length === 1);
  check('terminal has a real size', tabs[0].cols > 40 && tabs[0].rows > 10, `${tabs[0].cols}x${tabs[0].rows}`);

  await waitText(page, 0, /PS .*>/);
  check('PowerShell prompt appears', true);

  await send(page, 0, 'Write-Output "héllo wörld ✓ → 日本語 ░▒▓ ┌─┐"\r');
  const t = await waitText(page, 0, /héllo wörld ✓ → 日本語 ░▒▓ ┌─┐\n/);
  check('Unicode round-trips without ? substitutes', !/\?{2,}/.test(t.split('\n').slice(-6).join('\n')));

  await send(page, 0, 'cd $env:TEMP\r');
  await sleep(1200);
  tabs = await info(page);
  check('directory change is tracked', /temp/i.test(tabs[0].cwd), tabs[0].cwd);

  await shot(page, '01-after-commands');
  console.log('--- screen text ---\n' + (await text(page, 0, 12)));
  check('no page errors', app.errors.length === 0, app.errors.join(' | '));
} finally {
  await app.close();
}
process.exit(summary() ? 1 : 0);
