// Drives the real TermDeck window through WebView2's debugging port with Playwright.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const OUT = path.join(ROOT, 'tests', 'out');
export const EXE = process.env.TERMDECK_EXE ?? path.join(ROOT, 'src-tauri', 'target', 'debug', 'termdeck.exe');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ dataDir, port = 9333, env: extra = {} }) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  // These tests are themselves started from inside a Claude Code session. Remove its
  // markers so a CLI opened in the app behaves as it would when you start it yourself.
  // TERMDECK_NO_FOCUS: the test window opens without taking the keyboard, so typing in
  // another program while tests run does not land in it.
  const env = { ...process.env, TERMDECK_DATA_DIR: dataDir, TERMDECK_DEBUG_PORT: String(port), TERMDECK_NO_FOCUS: '1', ...extra };
  for (const key of Object.keys(env)) {
    if (/^(CLAUDE_CODE_|CLAUDECODE$|CLAUDE_PID$|CLAUDE_EFFORT$)/.test(key)) delete env[key];
  }
  const proc = spawn(EXE, [], { env, stdio: 'ignore' });
  let exited = false;
  proc.on('exit', () => (exited = true));

  let browser;
  for (let i = 0; i < 80 && !browser; i++) {
    await sleep(250);
    if (exited) throw new Error('TermDeck exited during startup');
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      /* not up yet */
    }
  }
  if (!browser) throw new Error('could not connect to the app');
  let page;
  for (let i = 0; i < 40 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('tauri.localhost'));
    if (!page) await sleep(250);
  }
  if (!page) throw new Error('app page not found');
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  // "started" rather than "has a tab": an app whose every tab was closed starts with none.
  await page.waitForFunction(() => window.__termdeck?.app?.started === true && window.__termdeck.app.tabs.every((t) => t.pid || t.exited), null, { timeout: 20000 });

  const app = {
    proc, browser, page, errors,
    /**
     * Asks the window to close the normal way (state is saved), then waits. When tabs
     * still have something running the app asks first; that question is answered
     * "Close anyway", as a user closing the app would. Closing then ends what the tabs
     * were running, which can take a few seconds.
     */
    async close() {
      await page.evaluate(() => window.__TAURI__.window.getCurrentWindow().close()).catch(() => {});
      for (let i = 0; i < 80 && !exited; i++) {
        await sleep(250);
        if (exited) break;
        await page.evaluate(() => {
          const btn = [...document.querySelectorAll('.modal .foot .btn.primary')].find((b) => b.textContent === 'Close anyway');
          if (btn) btn.click();
        }).catch(() => {});
      }
      if (!exited) proc.kill();
      await browser.close().catch(() => {});
    },
    kill() {
      proc.kill();
    },
  };
  return app;
}

export async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

export const resize = (page, w, h) =>
  page.evaluate(([w, h]) => {
    const T = window.__TAURI__;
    return T.window.getCurrentWindow().setSize(new T.dpi.LogicalSize(w, h));
  }, [w, h]);

export const info = (page) =>
  page.evaluate(() =>
    window.__termdeck.app.tabs.map((t, i) => ({
      i,
      name: t.state.name,
      shell: t.state.shell,
      cwd: t.state.cwd,
      cli: t.state.cli,
      running: t.cliRunning,
      cliStatus: t.cliStatus,
      activity: t.activity,
      session: t.state.sessionId ?? null,
      resume: t.resumePending,
      cols: t.term.cols,
      rows: t.term.rows,
      shown: t.isShown,
      title: t.title,
      bracketed: t.term.modes.bracketedPasteMode,
      scrollback: t.term.buffer.active.baseY,
      altScreen: t.term.buffer.active.type,
    })),
  );

export const text = (page, i, lines = 60) => page.evaluate(([i, lines]) => window.__termdeck.app.tabs[i].bufferText(lines), [i, lines]);

/** Only the rows currently on screen. */
export const screen = (page, i) =>
  page.evaluate((i) => {
    const t = window.__termdeck.app.tabs[i].term;
    const b = t.buffer.active;
    const out = [];
    for (let y = b.viewportY; y < b.viewportY + t.rows; y++) out.push(b.getLine(y)?.translateToString(true, 0, t.cols) ?? '');
    return out.join('\n');
  }, i);

/** The rows on screen as arrays with exactly one entry per cell. */
export const screenCells = (page, i) =>
  page.evaluate((i) => {
    const t = window.__termdeck.app.tabs[i].term;
    const b = t.buffer.active;
    const rows = [];
    for (let y = b.viewportY; y < b.viewportY + t.rows; y++) {
      const line = b.getLine(y);
      const row = [];
      for (let x = 0; x < t.cols; x++) {
        const cell = line?.getCell(x);
        row.push(!cell ? ' ' : cell.getWidth() === 0 ? '' : cell.getChars() || ' ');
      }
      rows.push(row);
    }
    return rows;
  }, i);

export const send = (page, i, data) => page.evaluate(([i, data]) => window.__termdeck.app.tabs[i].send(data), [i, data]);

export async function waitText(page, i, pattern, timeout = 20000, lines = 80) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  const start = Date.now();
  for (;;) {
    const t = await text(page, i, lines);
    if (re.test(t)) return t;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${re} in tab ${i}. Last text:\n${t.slice(-1500)}`);
    await sleep(200);
  }
}

export async function waitFor(page, fn, arg, timeout = 20000) {
  await page.waitForFunction(fn, arg, { timeout });
}

const results = [];
export function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
export function summary() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  for (const f of failed) console.log(`  FAILED: ${f.name}  ${f.detail}`);
  return failed.length;
}
