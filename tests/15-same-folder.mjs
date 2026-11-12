// Two tabs running the SAME CLI in the SAME folder must each stay on their own
// conversation: status, session id, History and Resume must never cross over.
// For Codex and for Grok (Claude Code names its session per process, so it cannot cross).
// Sends FOUR short prompts to each CLI tested.
// usage: node 15-same-folder.mjs <data-dir> <work-dir> [cli,cli]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, shot, send, resize, sleep, check, summary } from './harness.mjs';
import { ensureReady, openCli } from './clis.mjs';

const [dataDir, workDir] = process.argv.slice(2);
const only = process.argv[4] ? process.argv[4].split(',') : ['codex', 'grok'];
const tag = Date.now().toString(36).toUpperCase();
const word = (cli, label) => `ACK-${cli.toUpperCase()}-${label}-${tag}`;

const state = (page) =>
  page.evaluate(() => window.__termdeck.app.tabs.map((t) => ({ id: t.state.sessionId ?? null, cli: t.state.cli, running: t.cliRunning, activity: t.activity, status: t.cliStatus, resume: t.resumePending, cmd: t.resumeCommand() })));
const said = async (page, cli, id) => {
  if (!id) return '';
  const t = await page.evaluate(([cli, cwd, sessionId]) => window.__TAURI__.core.invoke('transcript_load', { cli, cwd, sessionId, end: null, window: null }), [cli, workDir, id]);
  return t.messages.filter((m) => m.role === 'user').map((m) => m.text).join('\n');
};

/** Sends a prompt to tab i and watches both tabs until i has worked and stopped. */
async function ask(page, cli, i, other, label) {
  const prompt = `Do not use any tools. Print the numbers 1 to 25, one per line. Then print exactly ${word(cli, label)}`;
  await page.evaluate(([i, p]) => window.__termdeck.app.tabs[i].submit(p), [i, prompt]);
  const t0 = Date.now();
  let worked = false;
  let otherWorked = false;
  let nudged = false;
  for (;;) {
    const st = await state(page);
    if (st[i].activity === 'working') worked = true;
    if (st[other].activity === 'working') otherWorked = true;
    if (worked && st[i].activity !== 'working') break;
    if (!worked && !nudged && Date.now() - t0 > 20000) {
      nudged = true;
      console.log(`(${cli} ${label}: prompt still in the input box after 20 s; Enter pressed again)`);
      await send(page, i, '\r');
    }
    if (Date.now() - t0 > 120000) break;
    await sleep(300);
  }
  await sleep(5000); // two looks at the session files
  return { worked, otherWorked, secs: ((Date.now() - t0) / 1000).toFixed(0) };
}

for (const cli of only) {
  let app = await launch({ dataDir: `${dataDir}-${cli}` });
  let page = app.page;
  try {
    await page.evaluate(() => window.__termdeck.app.setSplit(2));
    await resize(page, 1800, 860);
    await page.evaluate(() => window.__termdeck.app.toggleLibrary(false));
    // Started one straight after the other, so their start-ups overlap: the hard case.
    const a = await openCli(page, cli, workDir, 0);
    const b = await openCli(page, cli, workDir, 1);
    const upA = await ensureReady(page, a, cli);
    const upB = await ensureReady(page, b, cli);
    check(`${cli}: both started in the same folder`, upA && upB);
    if (!upA || !upB) continue;
    await sleep(6000);
    let st = await state(page);
    console.log(`${cli} before any prompt: A=${st[a].id} B=${st[b].id}`);
    check(`${cli}: before any prompt the two tabs do not share a session`, !st[a].id || st[a].id !== st[b].id);
    const first = { a: st[a].id, b: st[b].id };
    if (cli === 'grok') {
        // Grok writes down itself which of its processes is on which session. The app
        // must agree with that, tab by tab — whichever of the two made its session first.
        const pids = await page.evaluate(() => window.__termdeck.app.tabs.map((t) => t.cliPid));
        let said = [];
        try {
            said = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.grok', 'active_sessions.json'), 'utf8'));
        } catch {
            /* an older Grok keeps no such list */
        }
        const of = (i) => said.find((e) => e.pid === pids[i])?.session_id ?? null;
        if (of(a) && of(b)) {
            check('grok: each tab is on the session Grok itself names for that tab\'s process', st[a].id === of(a) && st[b].id === of(b),
                `A: app ${st[a].id?.slice(-6)} / Grok ${of(a).slice(-6)}   B: app ${st[b].id?.slice(-6)} / Grok ${of(b).slice(-6)}   (A's session was made ${of(a) < of(b) ? 'first' : 'second'})`);
        } else console.log('(grok keeps no list of running sessions here — check skipped)');
    }

    // ---- A speaks ----
    let r = await ask(page, cli, a, b, 'A1');
    st = await state(page);
    check(`${cli}: A answers and shows "working" meanwhile`, r.worked, `${r.secs} s`);
    check(`${cli}: B never shows "working" while only A is busy`, !r.otherWorked);
    check(`${cli}: A has a session, and B is not on it`, !!st[a].id && st[a].id !== st[b].id, `A=${st[a].id} B=${st[b].id}`);
    if (first.a) check(`${cli}: A is still on the session it started with`, st[a].id === first.a);
    const idA = st[a].id;

    // ---- B speaks ----
    r = await ask(page, cli, b, a, 'B1');
    st = await state(page);
    check(`${cli}: B answers and shows "working" meanwhile`, r.worked, `${r.secs} s`);
    check(`${cli}: A never shows "working" while only B is busy`, !r.otherWorked);
    check(`${cli}: B has its own session; A kept its one`, !!st[b].id && st[b].id !== idA && st[a].id === idA, `A=${st[a].id} B=${st[b].id}`);
    if (first.b) check(`${cli}: B is still on the session it started with`, st[b].id === first.b);
    const idB = st[b].id;

    // ---- A again: its file is now the newest in the folder (what used to pull B over) ----
    r = await ask(page, cli, a, b, 'A2');
    st = await state(page);
    check(`${cli}: after A speaks again nothing has moved`, st[a].id === idA && st[b].id === idB && !r.otherWorked, `A=${st[a].id} B=${st[b].id} B worked=${r.otherWorked}`);
    await shot(page, `15-${cli}-a-two-in-one-folder`);

    // ---- the proof: what each session's own file says was asked in it ----
    let inA = await said(page, cli, idA);
    let inB = await said(page, cli, idB);
    check(`${cli}: A's session holds A's two prompts and not B's`, inA.includes(word(cli, 'A1')) && inA.includes(word(cli, 'A2')) && !inA.includes(word(cli, 'B1')), `A1=${inA.includes(word(cli, 'A1'))} A2=${inA.includes(word(cli, 'A2'))} B1=${inA.includes(word(cli, 'B1'))}`);
    check(`${cli}: B's session holds B's prompt and not A's`, inB.includes(word(cli, 'B1')) && !inB.includes(word(cli, 'A1')) && !inB.includes(word(cli, 'A2')), `B1=${inB.includes(word(cli, 'B1'))} A1=${inB.includes(word(cli, 'A1'))}`);

    // ---- restart, Resume all ----
    await app.close();
    await sleep(1500);
    app = await launch({ dataDir: `${dataDir}-${cli}` });
    page = app.page;
    await sleep(2500);
    st = await state(page);
    check(`${cli}: after a restart each tab offers its own session`, st[a].resume && st[b].resume && st[a].cmd.includes(idA) && st[b].cmd.includes(idB), `${st[a].cmd} | ${st[b].cmd}`);
    await page.evaluate(() => window.__termdeck.app.resumeAll());
    const upA2 = await ensureReady(page, a, cli, 1);
    const upB2 = await ensureReady(page, b, cli, 1);
    check(`${cli}: Resume all brings both back`, upA2 && upB2);
    await sleep(10000);
    st = await state(page);
    check(`${cli}: resumed, each tab is on its own session (named on its command line)`, st[a].id === idA && st[b].id === idB, `A=${st[a].id} B=${st[b].id}`);
    if (upA2 && upB2) {
      r = await ask(page, cli, b, a, 'B2');
      st = await state(page);
      check(`${cli}: resumed B answers; A never shows "working"`, r.worked && !r.otherWorked, `${r.secs} s`);
      check(`${cli}: still nothing has moved`, st[a].id === idA && st[b].id === idB, `A=${st[a].id} B=${st[b].id}`);
      inA = await said(page, cli, st[a].id);
      inB = await said(page, cli, st[b].id);
      check(`${cli}: the new prompt went into B's session only`, inB.includes(word(cli, 'B2')) && !inA.includes(word(cli, 'B2')));
      await shot(page, `15-${cli}-b-resumed`);
    }
    check(`${cli}: no page errors`, app.errors.length === 0, app.errors.slice(0, 3).join(' | '));
    // leave the CLIs the gentle way
    await page.evaluate(([a, b]) => Promise.all([window.__termdeck.app.tabs[a].stopCli(), window.__termdeck.app.tabs[b].stopCli()]), [a, b]);
    await sleep(1500);
  } finally {
    await app.close();
    await sleep(1500);
  }
}
process.exit(summary() ? 1 : 0);
