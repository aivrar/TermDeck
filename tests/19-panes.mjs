// Choosing which tab is shown in which pane — reported as "too random" with more than
// three tabs: a clicked tab went into whichever pane happened to have the focus.
// Now every tab row has one button per pane, a row can be dragged onto a pane, and each
// pane's number is a chooser.
// usage: node 19-panes.mjs <data-dir> <work-dir>
// Plain PowerShell tabs only: starts no CLI, sends no prompt.
import { launch, shot, resize, sleep, check, summary } from './harness.mjs';

const [dataDir, workDir] = process.argv.slice(2);
let app = await launch({ dataDir });
let page = app.page;

/** For each pane, the position (0-based) in the tab list of the tab it shows; null if empty. */
const panes = () => page.evaluate(() => {
  const a = window.__termdeck.app;
  return a.state.panes.map((id) => (id ? a.tabs.findIndex((t) => t.state.id === id) : null));
});
/** What the buttons on row i say: e.g. "1 [2] 3" = lit on 2. '' when the buttons are hidden. */
const rowButtons = (i) => page.evaluate((i) => {
  const box = document.querySelectorAll('#tablist .tab')[i].querySelector('.t-panes');
  if (!box || box.hidden) return '';
  return [...box.children].map((b) => (b.classList.contains('on') ? `[${b.textContent}]` : b.textContent)).join(' ');
}, i);
const press = async (row, pane) => {
  await page.locator('#tablist .tab').nth(row).locator('.pane-btn').nth(pane).click();
  await sleep(350);
};
const centre = async (selector, nth = 0) => {
  const b = await page.locator(selector).nth(nth).boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, box: b };
};
const dragRowTo = async (row, to) => {
  const from = await centre('#tablist .tab .t-main', row);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 12, from.y + 4, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 14 });
  await sleep(150);
  const hint = await page.evaluate(() => [...document.querySelectorAll('.pane')].map((p) => p.classList.contains('drop-here')));
  await page.mouse.up();
  await sleep(400);
  return hint;
};

try {
  await resize(page, 1900, 900);
  await page.evaluate(() => window.__termdeck.app.toggleLibrary(false));
  // five tabs, named so the screenshots can be read
  await page.evaluate(async (cwd) => {
    const a = window.__termdeck.app;
    a.tabs[0].state.name = 'tab-A';
    a.tabs[0].state.autoName = false;
    for (const n of ['tab-B', 'tab-C', 'tab-D', 'tab-E']) await a.createTab({ shell: 'powershell', cwd, cli: 'none', name: n });
  }, workDir);
  await sleep(1500);

  // ---- one pane: nothing extra on screen ----
  check('one pane: tab rows show no pane buttons, the pane no number', (await rowButtons(0)) === '' && !(await page.locator('.pane-head .p-num').first().isVisible()));

  // ---- three panes ----
  await page.evaluate(() => window.__termdeck.app.setSplit(3));
  await sleep(1200);
  const start = await panes();
  console.log('panes at start (tab positions):', JSON.stringify(start));
  const nums = await page.locator('.pane-head .p-num').allInnerTexts();
  check('three panes: each pane shows its number', nums.join(',') === '1,2,3', nums.join(','));
  const lit = await Promise.all([0, 1, 2, 3, 4].map(rowButtons));
  const expectLit = (i, at) => ['1', '2', '3'].map((n, k) => (k === at ? `[${n}]` : n)).join(' ');
  check('every tab row has buttons 1 2 3, lit for the pane the tab is in', lit.every((txt, i) => txt === expectLit(i, start.indexOf(i))), lit.join(' | '));
  await shot(page, '19-a-pane-buttons');

  // ---- a hidden tab straight into a chosen pane ----
  const hidden = [0, 1, 2, 3, 4].filter((i) => !start.includes(i));
  const h1 = hidden[0];
  await press(h1, 1);
  let now = await panes();
  check('button 2 on a hidden tab: it is shown in pane 2, whichever pane had the focus', now[1] === h1 && now[0] === start[0] && now[2] === start[2], JSON.stringify(now));
  check('…and the tab that was there is simply not shown any more', !now.includes(start[1]) && (await rowButtons(start[1])) === '1 2 3');

  // ---- a shown tab to another pane: the two swap ----
  const before = await panes();
  await press(before[2], 0);
  now = await panes();
  check('button 1 on the tab in pane 3: the two tabs swap places', now[0] === before[2] && now[2] === before[0] && now[1] === before[1], `${JSON.stringify(before)} → ${JSON.stringify(now)}`);
  await press(now[0], 0);
  check('pressing the lit button changes nothing', JSON.stringify(await panes()) === JSON.stringify(now));

  // ---- the same result three times in a row from the same clicks (not "random") ----
  {
    const runs = [];
    for (let k = 0; k < 3; k++) {
      await press(0, 0);
      await press(1, 1);
      await press(2, 2);
      // click around so the focus is somewhere else each time
      await page.locator('.pane').nth(k).click({ position: { x: 200, y: 200 } });
      await press(4, 1);
      await press(3, 2);
      runs.push(JSON.stringify(await panes()));
    }
    check('the same presses give the same layout every time, wherever the focus was', runs.every((r) => r === '[0,4,3]'), runs.join(' '));
  }

  // ---- drag a tab row onto a pane ----
  {
    const b = await panes(); // [0,4,3]
    const target = await centre('.pane', 2);
    const hint = await dragRowTo(1, target); // tab-B is hidden
    now = await panes();
    check('dragging a tab onto pane 3 shows it there', now[2] === 1 && now[0] === b[0] && now[1] === b[1], JSON.stringify(now));
    check('…and while dragging, that pane says "Show here"', hint[2] === true && !hint[0] && !hint[1], JSON.stringify(hint));
    const t2 = await centre('.pane', 0);
    await dragRowTo(4, t2); // tab-E is in pane 2 → swaps with pane 1
    const after = await panes();
    check('dragging a tab that is already shown onto another pane swaps the two', after[0] === 4 && after[1] === now[0] && after[2] === now[2], `${JSON.stringify(now)} → ${JSON.stringify(after)}`);
    check('no terminal text was selected or typed by the drag', (await page.evaluate(() => window.__termdeck.app.tabs.every((t) => !t.term.hasSelection()))));
  }

  // ---- dragging onto another row still reorders ----
  {
    const names = () => page.evaluate(() => window.__termdeck.app.tabs.map((t) => t.state.name));
    const was = await names();
    const shownBefore = await page.evaluate(() => window.__termdeck.app.state.panes.slice());
    const last = await page.locator('#tablist .tab').nth(4).boundingBox();
    await dragRowTo(0, { x: last.x + 60, y: last.y + last.height - 3 });
    const is = await names();
    const shownAfter = await page.evaluate(() => window.__termdeck.app.state.panes.slice());
    check('dragging a row onto another row still reorders the list', is.join() === [...was.slice(1), was[0]].join(), `${was.join()} → ${is.join()}`);
    check('…and reordering does not change what the panes show', shownBefore.join() === shownAfter.join());
  }

  // ---- the pane's number is a chooser ----
  {
    await page.locator('.pane-head .p-num').nth(1).click();
    await sleep(300);
    const items = await page.locator('#menu-root .menu > *').allInnerTexts();
    const want = await page.evaluate(() => {
      const a = window.__termdeck.app;
      return a.tabs.findIndex((t) => !a.state.panes.includes(t.state.id));
    });
    check('pane number: lists every tab, and says where each one is now', items.length === 5 && items.filter((t) => /now in pane/.test(t)).length === 2 && items.filter((t) => t.includes('✓')).length === 1, items.join(' | '));
    await shot(page, '19-b-pane-chooser');
    await page.locator('#menu-root .menu > *').nth(want).click();
    await sleep(400);
    now = await panes();
    check('choosing a tab there shows it in that pane', now[1] === want, JSON.stringify(now));
  }

  // ---- the right-click menu still has it, and a plain click still follows the focus ----
  {
    const b = await panes();
    const hid = [0, 1, 2, 3, 4].find((i) => !b.includes(i));
    await page.locator('.pane').nth(2).click({ position: { x: 200, y: 200 } });
    await page.locator('#tablist .tab .t-main').nth(hid).click();
    await sleep(400);
    now = await panes();
    check('a plain click on a tab still puts it in the pane that has the focus', now[2] === hid, JSON.stringify(now));
  }
  await shot(page, '19-c-arranged');

  // ---- a tall, narrow window: the panes stack instead of becoming narrow strips ----
  {
    const look = () => page.evaluate(() => {
      const a = window.__termdeck.app;
      const r = [...document.querySelectorAll('.pane')].map((p) => p.getBoundingClientRect());
      const area = document.getElementById('panes').getBoundingClientRect();
      const sameRow = r.every((x) => Math.abs(x.top - r[0].top) < 2);
      const sameCol = r.every((x) => Math.abs(x.left - r[0].left) < 2);
      return {
        how: sameRow && !sameCol ? 'side' : sameCol && !sameRow ? 'stacked' : 'mixed',
        flag: a.stacked,
        area: `${Math.round(area.width)}x${Math.round(area.height)}`,
        pane: `${Math.round(r[0].width)}x${Math.round(r[0].height)}`,
        order: r.map((x) => Math.round(x.top)).join('<'),
        cols: a.state.panes.map((id) => a.tabs.find((t) => t.state.id === id)?.term.cols ?? 0),
        rows: a.state.panes.map((id) => a.tabs.find((t) => t.state.id === id)?.term.rows ?? 0),
      };
    });
    const setLayout = async (v) => {
      await page.evaluate((v) => { const a = window.__termdeck.app; a.state.settings.paneLayout = v; a.applyPaneDirection(); }, v);
      await sleep(900);
    };
    const wide = await look();
    check('a wide window: three panes side by side', wide.how === 'side' && wide.flag === false, JSON.stringify(wide));
    await resize(page, 760, 1100);
    await sleep(1500);
    const tall = await look();
    check('a window taller than wide: the three panes are stacked, pane 1 on top', tall.how === 'stacked' && tall.flag === true, JSON.stringify(tall));
    await shot(page, '19-d-tall-window-stacked');
    // what the same window would give side by side
    await setLayout('side');
    const strips = await look();
    check('…which gives each terminal the full width instead of a narrow strip', strips.how === 'side' && tall.cols.every((c, k) => c >= strips.cols[k] * 2.5) && tall.rows.every((r) => r >= 8),
      `stacked: ${tall.cols[0]} columns × ${tall.rows[0]} rows each; side by side it would be ${strips.cols[0]} × ${strips.rows[0]}`);
    await shot(page, '19-e-tall-window-forced-side');
    await setLayout('auto');
    check('Settings: "always side by side" is obeyed in a tall window, and "automatic" stacks again', (await look()).how === 'stacked');
    // the tab buttons and dragging work the same when stacked
    const b = await panes();
    const hid = [0, 1, 2, 3, 4].find((i) => !b.includes(i));
    await press(hid, 2);
    check('stacked: button 3 puts a tab in the bottom pane', (await panes())[2] === hid);
    const typed = await page.evaluate(async () => {
      const a = window.__termdeck.app;
      const t = a.tabs.find((x) => x.state.id === a.state.panes[2]);
      t.send('echo stacked-$(40+2)\r');
      await new Promise((r) => setTimeout(r, 2500));
      return t.bufferText(12);
    });
    check('stacked: the terminal in the bottom pane works at its new size', typed.includes('stacked-42'));
    await resize(page, 1900, 900);
    await sleep(1500);
    const again = await look();
    check('made wide again, the panes go back side by side', again.how === 'side' && again.flag === false, JSON.stringify(again));
    await setLayout('stack');
    check('Settings: "always one above the other" is obeyed in a wide window', (await look()).how === 'stacked');
    await setLayout('auto');
    // one pane is never "stacked"
    await page.evaluate(() => window.__termdeck.app.setSplit(1));
    await resize(page, 760, 1100);
    await sleep(1000);
    check('a single pane in a tall window is just the pane', (await page.evaluate(() => window.__termdeck.app.stacked)) === false);
    await resize(page, 1900, 900);
    await page.evaluate(() => window.__termdeck.app.setSplit(3));
    await sleep(1200);
  }

  // ---- kept over a restart ----
  const kept = await page.evaluate(() => { const a = window.__termdeck.app; return a.state.panes.map((id) => a.tabs.find((t) => t.state.id === id)?.state.name ?? null); });
  check('no page errors', app.errors.length === 0, app.errors.join(' | ').slice(0, 300));
  await app.close();
  app = await launch({ dataDir });
  page = app.page;
  await sleep(800);
  const back = await page.evaluate(() => { const a = window.__termdeck.app; return a.state.panes.map((id) => a.tabs.find((t) => t.state.id === id)?.state.name ?? null); });
  check('after a restart every pane shows the tab it showed before', back.join() === kept.join(), `${kept.join()} → ${back.join()}`);

  // ---- two panes: two buttons ----
  await page.evaluate(() => window.__termdeck.app.setSplit(2));
  await sleep(800);
  const two = await rowButtons(0);
  check('two panes: two buttons per row', two.replace(/[\[\]]/g, '') === '1 2', two);
  // ---- the tab row keeps its name readable, however narrow the side panel ----
  // (Reported with a screenshot: at about 135 px the usage figures and the three buttons
  // left no room for the name at all. The row now has two lines.)
  await page.evaluate(() => window.__termdeck.app.setSplit(3));
  await sleep(800);
  for (const width of [230, 135, 120]) {
    await page.evaluate((w) => { const a = window.__termdeck.app; a.state.sidebarWidth = w; a.applyLayoutVars(); }, width);
    await sleep(500);
    const m = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#tablist .tab')];
      const one = (row) => {
        const r = row.getBoundingClientRect();
        const name = row.querySelector('.t-name');
        const n = name.getBoundingClientRect();
        const foot = row.querySelector('.t-foot').getBoundingClientRect();
        const btn = row.querySelector('.t-panes').getBoundingClientRect();
        const use = row.querySelector('.t-use');
        const u = use.hidden ? null : use.getBoundingClientRect();
        return {
          name: Math.round(n.width), cut: name.scrollWidth > name.clientWidth + 1, text: name.textContent,
          below: foot.top >= n.bottom - 1,
          inside: btn.left >= r.left - 1 && btn.right <= r.right + 1 && (!u || (u.left >= r.left - 1 && u.right <= r.right + 1)),
          overlap: !!u && u.right > btn.left + 1 && Math.abs(u.top - btn.top) < 6,
          overflow: row.scrollWidth - row.clientWidth, height: Math.round(r.height),
        };
      };
      return rows.map(one);
    });
    const ok = m.every((x) => x.name >= 60 && !x.cut && x.below && x.inside && !x.overlap && x.overflow <= 0 && x.height <= 66);
    check(`side panel ${width} px wide: every tab's name is shown in full, with usage and the pane buttons on the line below`, ok,
      `name ${m[0].name} px ("${m[0].text}"), row ${m[0].height} px high` + (ok ? '' : ' ' + JSON.stringify(m.find((x) => !(x.name >= 60 && !x.cut && x.below && x.inside && !x.overlap && x.overflow <= 0 && x.height <= 66)))));
    if (width === 135) await shot(page, '19-f-narrow-side-panel');
  }
  // the buttons still work down there, and the × is still reachable
  {
    const b = await panes();
    const hid = [0, 1, 2, 3, 4].find((i) => !b.includes(i));
    await press(hid, 0);
    check('narrow side panel: the pane buttons still work', (await panes())[0] === hid);
    const x = await page.evaluate(() => {
      const row = document.querySelector('#tablist .tab');
      const c = row.querySelector('.t-close').getBoundingClientRect();
      const r = row.getBoundingClientRect();
      return c.width > 10 && c.left >= r.left && c.right <= r.right + 1 && c.top >= r.top - 1;
    });
    check('…and the close × sits inside the row (top right, shown on hover)', x);
  }
} catch (e) {
  check('test ran to the end', false, String(e?.stack ?? e));
} finally {
  await app.close();
}
process.exit(summary() ? 1 : 0);
