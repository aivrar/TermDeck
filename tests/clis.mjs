// Shared helpers for tests that drive the real CLIs.
import { execFileSync } from 'node:child_process';
import { screen, send, sleep } from './harness.mjs';

export const CLIS = ['claude', 'codex', 'grok'];

/** Waits until a tab's screen stops changing; returns the final screen text. */
export async function settle(page, i, quietMs = 1200, maxMs = 25000) {
  const start = Date.now();
  let last = '';
  let since = Date.now();
  while (Date.now() - start < maxMs) {
    const s = await screen(page, i);
    if (s !== last) {
      last = s;
      since = Date.now();
    } else if (Date.now() - since > quietMs) break;
    await sleep(250);
  }
  return last;
}

/**
 * Gets a freshly started CLI to its input box. Only prompts recognised here are
 * answered, and always with the choice that changes nothing on the machine
 * (skip the update, keep browser tools off) — except trusting the scratch folder.
 */
export async function toInputBox(page, i, cli) {
  // The CLI can take several seconds to print anything; wait until the app sees it running.
  await page
    .waitForFunction(([i, cli]) => window.__termdeck.app.tabs[i].cliRunning === cli, [i, cli], { timeout: 30000 })
    .catch(() => console.log(`(${cli}: never detected as running)`));
  await sleep(1500);
  for (let round = 0; round < 6; round++) {
    const s = await settle(page, i, 1300, 30000);
    if (/Esc to keep browser tools off/i.test(s)) {
      console.log(`(${cli}: browser-tools prompt -> Esc, keep off)`);
      await send(page, i, '\x1b');
    } else if (/esc\s+skip/i.test(s) && /Update (available|now)/i.test(s)) {
      console.log(`(${cli}: update prompt -> Esc, skip)`);
      await send(page, i, '\x1b');
    } else if (/trust (the files in )?this folder|trust the contents of this directory|Do you trust/i.test(s)) {
      console.log(`(${cli}: trust prompt for the scratch folder -> Enter)`);
      await send(page, i, '\r');
    } else {
      return s;
    }
    await sleep(600);
  }
  return settle(page, i);
}

/**
 * Like toInputBox, but if the CLI quit on its own during startup (Codex does this
 * when its sign-in check times out on a slow connection) it is started again.
 */
export async function ensureReady(page, i, cli, attempts = 3) {
  for (let n = 0; n < attempts; n++) {
    await toInputBox(page, i, cli);
    await sleep(2500);
    const running = await page.evaluate((i) => window.__termdeck.app.tabs[i].cliRunning, i);
    if (running === cli) return true;
    const rows = (await screen(page, i)).split('\n').filter((r) => r.trim());
    console.log(`(${cli}: not running after start, attempt ${n + 1}. Screen:\n${rows.slice(-22).map((r) => '      | ' + r).join('\n')}\n)`);
    if (n + 1 < attempts) await send(page, i, `${cli}\r`);
  }
  return false;
}

export const openCli = (page, cli, cwd, pane, shell = 'powershell') =>
  page.evaluate(
    async ([cli, cwd, pane, shell]) => {
      const app = window.__termdeck.app;
      app.state.activePane = pane;
      await app.createTab({ shell, cwd, cli });
      return app.tabs.length - 1;
    },
    [cli, cwd, pane, shell],
  );

export const focusTab = (page, i) =>
  page.evaluate((i) => {
    const app = window.__termdeck.app;
    app.showTab(app.tabs[i]);
    app.tabs[i].focus();
  }, i);

function ps(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { encoding: 'utf8' });
}

/** Puts a small test picture on the Windows clipboard. */
export function clipboardImage() {
  ps(`
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $b = New-Object System.Drawing.Bitmap 360, 200
    $g = [System.Drawing.Graphics]::FromImage($b)
    $g.Clear([System.Drawing.Color]::FromArgb(255, 24, 60, 110))
    $g.FillEllipse([System.Drawing.Brushes]::Gold, 30, 30, 140, 140)
    $g.DrawString('TermDeck paste test', (New-Object System.Drawing.Font 'Segoe UI', 14), [System.Drawing.Brushes]::White, 150, 150)
    $g.Dispose()
    [System.Windows.Forms.Clipboard]::SetImage($b)
  `);
}

export function clipboardText(text) {
  ps(`Set-Clipboard -Value @'\n${text}\n'@`);
}

export function clipboardGetText() {
  try {
    return ps('Get-Clipboard -Raw');
  } catch {
    return '';
  }
}
