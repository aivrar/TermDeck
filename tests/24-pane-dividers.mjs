// The dividers between panes, dragged with the real mouse:
//   - one between each pair of panes, side by side (left/right) and stacked (up/down)
//   - dragging moves only that line; the terminals take the new size
//   - each pane keeps a minimum size
//   - sizes are kept apart for side by side and stacked, and survive a restart
//   - double-click shares the area out equally again
//   - "Reset sizes" puts the sidebar, the library and the panes back to their start sizes
// usage: node 24-pane-dividers.mjs <data-dir> <work-dir>
import { launch, shot, resize, sleep, check, summary } from './harness.mjs';

const [dataDir, workDir] = process.argv.slice(2);

async function until(fn, timeout = 8000, step = 150) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) return false;
    await sleep(step);
  }
}

const look = (page) =>
  page.evaluate(() => {
    const a = window.__termdeck.app;
    const panes = [...document.querySelectorAll('#panes > .pane')].map((p) => {
      const r = p.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    const dividers = [...document.querySelectorAll('#panes > .pane-split')].map((d) => {
      const r = d.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, across: d.classList.contains('across') };
    });
    return { panes, dividers, stacked: a.stacked, sizes: a.state.paneSizes ?? null, sidebar: a.state.sidebarWidth, library: a.state.libraryWidth };
  });

async function drag(page, x, y, dx, dy) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 5 });
  await page.mouse.move(x + dx, y + dy, { steps: 5 });
  await page.mouse.up();
  await sleep(400);
}

const near = (a, b, tol = 3) => Math.abs(a - b) <= tol;
const layout = (page, v) => page.evaluate((v) => { const a = window.__termdeck.app; a.state.settings.paneLayout = v; a.applyPaneDirection(); a.scheduleSave(); }, v);

let app = await launch({ dataDir });
let page = app.page;
try {
  await resize(page, 1900, 900);
  await page.evaluate(() => window.__termdeck.app.setSplit(3));
  // a terminal in every pane, to see each one take its new size
  for (let p = 1; p < 3; p++) {
    await page.evaluate(async ([cwd, p]) => {
      const a = window.__termdeck.app;
      a.state.activePane = p;
      await a.createTab({ shell: 'powershell', cwd, cli: 'none' });
    }, [workDir, p]);
  }
  await layout(page, 'side');
  await sleep(800);

  // ---------- side by side ----------
  let s = await look(page);
  check('three panes side by side have two dividers', s.dividers.length === 2 && !s.stacked && s.dividers.every((d) => !d.across), JSON.stringify(s.dividers));
  check('each divider sits on the line between two panes', s.dividers.every((d, i) => near(d.x, s.panes[i + 1].x, 2)), JSON.stringify({ d: s.dividers.map((d) => d.x), p: s.panes.map((p) => p.x) }));
  const colsBefore = await page.evaluate(() => window.__termdeck.app.tabs.map((t) => t.term.cols));
  await shot(page, '24-a-side-equal');

  await drag(page, s.dividers[0].x, s.dividers[0].y, 220, 0);
  let t = await look(page);
  check('dragging the first divider right widens pane 1 by as much', near(t.panes[0].w, s.panes[0].w + 220, 4), `${Math.round(s.panes[0].w)} -> ${Math.round(t.panes[0].w)}`);
  check('…pane 2 gives the room, pane 3 stays as it was', near(t.panes[1].w, s.panes[1].w - 220, 4) && near(t.panes[2].w, s.panes[2].w, 2), t.panes.map((p) => Math.round(p.w)).join(' / '));
  check('…and the divider moved with the line', near(t.dividers[0].x, t.panes[1].x, 2));
  const colsGrew = await until(async () => {
    const c = await page.evaluate(() => window.__termdeck.app.tabs.map((t) => t.term.cols));
    return c[0] > colsBefore[0] + 10 && c[1] < colsBefore[1] - 10 && c;
  });
  check('the terminals take their new widths', !!colsGrew, `${colsBefore.join(',')} -> ${colsGrew ? colsGrew.join(',') : 'unchanged'}`);

  await drag(page, t.dividers[1].x, t.dividers[1].y, -60, 0);
  const u = await look(page);
  check('the second divider moves the line between panes 2 and 3', near(u.panes[2].w, t.panes[2].w + 60, 4) && near(u.panes[0].w, t.panes[0].w, 2), u.panes.map((p) => Math.round(p.w)).join(' / '));
  await shot(page, '24-b-side-dragged');

  await drag(page, u.dividers[0].x, u.dividers[0].y, -3000, 0);
  const v = await look(page);
  check('a pane cannot be dragged smaller than its minimum', v.panes[0].w >= 155 && v.panes[0].w < 200, `pane 1 is ${Math.round(v.panes[0].w)} px`);
  await drag(page, v.dividers[0].x, v.dividers[0].y, 400, 0);
  const sideSaved = (await look(page)).sizes?.side;
  check('the side-by-side sizes are kept', Array.isArray(sideSaved) && sideSaved.length === 3, JSON.stringify(sideSaved));
  const sideWidths = (await look(page)).panes.map((p) => p.w);

  // ---------- stacked ----------
  await layout(page, 'stack');
  await sleep(500);
  s = await look(page);
  check('stacked, the dividers run across', s.stacked && s.dividers.length === 2 && s.dividers.every((d) => d.across), JSON.stringify(s.dividers));
  check('stacked panes start out equal (side-by-side sizes are separate)', s.panes.every((p) => near(p.h, s.panes[0].h, 2)), s.panes.map((p) => Math.round(p.h)).join(' / '));
  check('each divider sits on the line between two panes', s.dividers.every((d, i) => near(d.y, s.panes[i + 1].y, 2)));
  const rowsBefore = await page.evaluate(() => window.__termdeck.app.tabs.map((t) => t.term.rows));
  await drag(page, s.dividers[1].x, s.dividers[1].y, 0, -110);
  t = await look(page);
  check('dragging the lower divider up makes pane 3 taller and pane 2 shorter', near(t.panes[2].h, s.panes[2].h + 110, 4) && near(t.panes[1].h, s.panes[1].h - 110, 4) && near(t.panes[0].h, s.panes[0].h, 2), t.panes.map((p) => Math.round(p.h)).join(' / '));
  const rowsChanged = await until(async () => {
    const r = await page.evaluate(() => window.__termdeck.app.tabs.map((t) => t.term.rows));
    return r[2] > rowsBefore[2] && r[1] < rowsBefore[1] && r;
  });
  check('the terminals take their new heights', !!rowsChanged, `${rowsBefore.join(',')} -> ${rowsChanged ? rowsChanged.join(',') : 'unchanged'}`);
  await shot(page, '24-c-stacked-dragged');
  check('the side-by-side sizes were left alone', JSON.stringify((await look(page)).sizes?.side) === JSON.stringify(sideSaved));

  // double-click: equal again (stacked only)
  await page.mouse.dblclick(t.dividers[0].x, t.dividers[0].y);
  await sleep(400);
  const e = await look(page);
  check('double-click on a divider makes the panes equal again', e.panes.every((p) => near(p.h, e.panes[0].h, 2)) && !e.sizes?.stack && Array.isArray(e.sizes?.side), e.panes.map((p) => Math.round(p.h)).join(' / '));

  // ---------- survives a restart ----------
  await layout(page, 'side');
  await sleep(1500); // the state is saved shortly after a change
  check('no page errors', app.errors.length === 0, app.errors.slice(0, 3).join(' | '));
  await app.close();
  app = await launch({ dataDir });
  page = app.page;
  await resize(page, 1900, 900);
  await sleep(1000);
  const r = await look(page);
  check('after a restart the panes have the sizes they were dragged to', r.panes.length === 3 && r.panes.every((p, i) => near(p.w, sideWidths[i], 4)), `${sideWidths.map(Math.round).join(' / ')} -> ${r.panes.map((p) => Math.round(p.w)).join(' / ')}`);

  // ---------- Reset sizes ----------
  const left = await page.locator('#h-left').boundingBox();
  await drag(page, left.x + left.width / 2, left.y + 200, 90, 0);
  const right = await page.locator('#h-right').boundingBox();
  await drag(page, right.x + right.width / 2, right.y + 200, -70, 0);
  const moved = await look(page);
  check('the sidebar and library dividers move too', near(moved.sidebar, 320, 1) && near(moved.library, 350, 1), `sidebar ${moved.sidebar}, library ${moved.library}`);
  await shot(page, '24-d-before-reset');
  await page.locator('#btn-reset-sizes').click();
  await sleep(500);
  const z = await look(page);
  check('"Reset sizes" puts the sidebar and library back', z.sidebar === 230 && z.library === 280, `sidebar ${z.sidebar}, library ${z.library}`);
  check('…and makes the panes equal', z.sizes === null && z.panes.every((p) => near(p.w, z.panes[0].w, 2)), z.panes.map((p) => Math.round(p.w)).join(' / '));
  check('…with the dividers on the new lines', z.dividers.every((d, i) => near(d.x, z.panes[i + 1].x, 2)));
  await shot(page, '24-e-after-reset');

  // one pane: no divider
  await page.evaluate(() => window.__termdeck.app.setSplit(1));
  await sleep(300);
  check('a single pane has no divider', (await look(page)).dividers.length === 0);
  await page.evaluate(() => window.__termdeck.app.setSplit(3));
  await sleep(300);
  check('back to three panes: two dividers again', (await look(page)).dividers.length === 2);
  await page.evaluate(() => { const a = window.__termdeck.app; a.state.settings.paneLayout = 'auto'; a.applyPaneDirection(); });
  check('no page errors after the restart', app.errors.length === 0, app.errors.slice(0, 3).join(' | '));
} finally {
  await app.close();
}
process.exit(summary() ? 1 : 0);
