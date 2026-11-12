import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { listen } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { api, type CliKind, type CliVersion, type EnvInfo, type SessionInfo, type ShellKind, type SystemUsage, type UpdateResult } from './api';
import { DEFAULT_SCROLLBACK, extractSwitches, flagValue, flagWords, FONT_STACK, fromMsysPath, mergeFlags, quoteArg, quotePath, shellFlags, Tab, toWslPath, THEME_LABEL, THEMES, type Look, type TabHost, type TabState, type ThemeName } from './tab';
import { Library, type Snippet } from './library';
import { openHistory } from './history';
import { baseName, confirmDialog, h, isModalOpen, menu, modal, toast, uid } from './ui';

interface AppState {
  version: 1;
  tabs: TabState[];
  /** tab id shown in each pane, left to right */
  panes: (string | null)[];
  activePane: number;
  sidebarWidth: number;
  libraryWidth: number;
  libraryOpen: boolean;
  fontSize: number;
  recentDirs: string[];
  lastShell: ShellKind;
  lastDistro?: string;
  /** What to do about CLI updates when the app starts. */
  updateMode: UpdateMode;
  /** Switches added to every session of a CLI that this app starts or resumes. */
  cliFlags: Record<RealCli, string>;
  /** At startup: wait for a click (Resume / Resume all), or resume every session by itself. */
  resumeMode: 'manual' | 'auto';
  settings: Settings;
}

/** Everything on the Settings screen that is not already a field above. */
interface Settings {
  /** Terminal font; '' for the bundled Cascadia Mono. */
  fontFamily: string;
  /** Lines of history each tab keeps. */
  scrollback: number;
  theme: ThemeName;
  /** Flash the taskbar button when a session finishes or needs you and the app is not in front. */
  notifyFlash: boolean;
  /** Play a short tone: never, when a session needs you, or also when one finishes. */
  notifySound: 'off' | 'needs' | 'both';
  /** A tab is "heavy" (red, Kill button) at this much of the PC's processor … */
  hotCpu: number;
  /** … or this much of its memory. Percent. */
  hotMem: number;
  /**
   * Two or three panes: side by side, one above the other, or whichever suits the
   * window ('auto' — stacked when the pane area is taller than it is wide).
   */
  paneLayout: 'auto' | 'side' | 'stack';
}

const DEFAULT_SETTINGS: Settings = {
  fontFamily: '',
  scrollback: DEFAULT_SCROLLBACK,
  theme: 'dark',
  notifyFlash: true,
  notifySound: 'needs',
  hotCpu: 60,
  hotMem: 30,
  paneLayout: 'auto',
};

/** Saved settings with anything missing or out of range put right. */
function cleanSettings(raw: Partial<Settings> | undefined): Settings {
  const s = { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
  const num = (v: unknown, lo: number, hi: number, dflt: number) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? clamp(Math.round(Number(v)), lo, hi) : dflt);
  return {
    fontFamily: typeof s.fontFamily === 'string' ? s.fontFamily.trim().slice(0, 80) : '',
    scrollback: num(s.scrollback, 1000, 200_000, DEFAULT_SETTINGS.scrollback),
    theme: s.theme in THEMES ? s.theme : 'dark',
    notifyFlash: s.notifyFlash !== false,
    notifySound: s.notifySound === 'off' || s.notifySound === 'both' ? s.notifySound : 'needs',
    hotCpu: num(s.hotCpu, 5, 100, DEFAULT_SETTINGS.hotCpu),
    hotMem: num(s.hotMem, 5, 95, DEFAULT_SETTINGS.hotMem),
    paneLayout: s.paneLayout === 'side' || s.paneLayout === 'stack' ? s.paneLayout : 'auto',
  };
}

/** A finished / needs-you event that was announced. */
interface Notice {
  tab: string;
  kind: 'done' | 'needs';
  at: number;
  flashed: boolean;
  sound: boolean;
}

let audio: AudioContext | null = null;
/** A short soft tone: one note for "finished", two falling notes for "needs you". */
function beep(kind: 'done' | 'needs'): void {
  try {
    audio ??= new AudioContext();
    void audio.resume();
    const t0 = audio.currentTime + 0.02;
    const notes: [number, number][] = kind === 'needs' ? [[880, 0], [660, 0.17]] : [[660, 0]];
    for (const [freq, at] of notes) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(0.14, t0 + at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.15);
      osc.connect(gain).connect(audio.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + 0.17);
    }
  } catch {
    /* no sound device: the flash and the tab marker still tell */
  }
}

/** "just now", "12 min ago", "3 h ago", "5 d ago", then a date. */
function fmtAgo(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 14) return `${Math.round(s / 86400)} d ago`;
  return new Date(ms).toLocaleDateString();
}

function fmtSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

type UpdateMode = 'off' | 'check' | 'auto';
type RealCli = Exclude<CliKind, 'none'>;
const CLI_NAME: Record<RealCli, string> = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok' };
const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

const DEFAULT_FONT = 14;
const MIN_FONT = 8;
const MAX_FONT = 32;

const SHELL_LABEL: Record<ShellKind, string> = {
  powershell: 'PowerShell',
  pwsh: 'PowerShell 7',
  cmd: 'cmd',
  gitbash: 'Git Bash',
  wsl: 'WSL',
};

const STATUS_TEXT: Record<string, string> = {
  working: 'working',
  attention: 'needs you',
  done: 'finished',
  exited: 'ended',
  idle: '',
};

interface PaneEls {
  root: HTMLDivElement;
  dot: HTMLSpanElement;
  name: HTMLSpanElement;
  st: HTMLSpanElement;
  dir: HTMLSpanElement;
  size: HTMLSpanElement;
  use: HTMLButtonElement;
  historyBtn: HTMLButtonElement;
  resume: HTMLDivElement;
  resumeText: HTMLSpanElement;
  body: HTMLDivElement;
  empty: HTMLDivElement;
  toBottom: HTMLButtonElement;
  closeHistory: (() => void) | null;
}

interface RowEls {
  root: HTMLDivElement;
  name: HTMLDivElement;
  sub: HTMLDivElement;
  pane: HTMLSpanElement;
  use: HTMLButtonElement;
  useCpu: HTMLSpanElement;
  useMem: HTMLSpanElement;
  kill: HTMLButtonElement;
}

/** "840 MB", "1.2 GB" */
function fmtMem(bytes: number): string {
  const mb = bytes / 1048576;
  if (mb < 1000) return `${Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
}

/** Percent of the whole machine: "0.4%", "37%" */
function fmtCpu(pct: number): string {
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

class App implements TabHost {
  env!: EnvInfo;
  state: AppState = {
    version: 1,
    tabs: [],
    panes: [null],
    activePane: 0,
    sidebarWidth: 230,
    libraryWidth: 280,
    libraryOpen: true,
    fontSize: DEFAULT_FONT,
    recentDirs: [],
    lastShell: 'powershell',
    updateMode: 'check',
    cliFlags: { claude: '', codex: '', grok: '' },
    resumeMode: 'manual',
    settings: { ...DEFAULT_SETTINGS },
  };
  tabs: Tab[] = [];
  private panes: PaneEls[] = [];
  private rows = new Map<string, RowEls>();
  private library!: Library;
  private saveTimer = 0;
  /** The state as it was last written to disk, to leave out writes that change nothing. */
  private savedText = '';
  private polling = false;
  /**
   * Set when the saved sessions could not be read AND could not be copied aside: nothing
   * is saved for the rest of this run, so the file on disk stays exactly as it is.
   */
  saveBlocked = false;
  /** The "close TermDeck?" question is on screen. */
  private closeAsked = false;
  /** The window is on its way out: the saved state is final, nothing more is looked at. */
  private closing = false;
  private justDragged = false;
  private lastWheelZoom = 0;
  /** Latest reading for the whole PC. */
  system: SystemUsage | null = null;
  /** Repaints the open process list, when there is one. */
  private procView: (() => void) | null = null;
  private armed: { key: string; until: number } | null = null;
  /** Installed / latest versions from the last check (null until one has run). */
  versions: CliVersion[] | null = null;
  checking = false;
  /** CLIs being updated right now; starting or resuming one of these has to wait. */
  updating = new Set<RealCli>();
  /** What each CLI's updater said the last time it ran. */
  lastUpdate: Partial<Record<RealCli, UpdateResult>> = {};
  private updatesView: (() => void) | null = null;
  /** True until the startup update step and (if set) the automatic resume have run. */
  private startingUp = true;
  /** What was announced lately (newest last). */
  notices: Notice[] = [];
  /** When each tab last began working, to tell real work from a one-second command. */
  private workSince = new Map<string, number>();
  /** How often another copy was started and handed over to this one. */
  secondStarts = 0;
  /** True once the saved tabs are back and their shells started (there may be none). */
  started = false;
  private lastPickerCli: RealCli = 'claude';

  private readonly appEl = document.getElementById('app')!;
  private readonly panesEl = document.getElementById('panes')!;
  private readonly tabList = document.getElementById('tablist')!;
  private readonly parking = document.getElementById('parking')!;
  /** True while the panes are one above the other instead of side by side. */
  stacked = false;
  /** Watches the area the panes share: when its shape changes, so may their arrangement. */
  private readonly panesObserver = new ResizeObserver(() => this.applyPaneDirection());
  private readonly resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const i = this.panes.findIndex((p) => p.body === entry.target);
      if (i >= 0) this.tabInPane(i)?.scheduleFit();
    }
  });

  // ---------- startup ----------

  async init(): Promise<void> {
    await api.ptyKillAll().catch(() => {}); // clears leftovers if the page was reloaded
    this.env = await api.envInfo();

    // True when a saved state was read: then its tabs are what the user left — also
    // when that is none at all.
    let hadSaved = false;
    try {
      const saved = await api.storeLoad<AppState>('state');
      if (saved && saved.version === 1 && Array.isArray(saved.tabs)) {
        this.state = { ...this.state, ...saved };
        hadSaved = true;
      }
      else if (saved) throw new Error('state.json is not in a form this version understands');
    } catch (e) {
      // The app starts with defaults — and defaults get saved. So before anything can be
      // written over the file that could not be read, a copy of it is put aside; and if
      // even that fails, nothing is saved this run.
      try {
        const copy = await api.storeKeep('state');
        toast(`Your saved tabs and settings could not be read, so TermDeck started fresh. The file was kept as "${copy}" in the data folder. (${String(e)})`, 'error', 12000);
      } catch (e2) {
        this.saveBlocked = true;
        toast(`Your saved tabs and settings could not be read, and could not be copied either — so nothing will be saved this time, to leave the file as it is. Close TermDeck and check state.json in the data folder. (${String(e)}; ${String(e2)})`, 'error', 20000);
      }
    }
    this.state.fontSize = clamp(this.state.fontSize || DEFAULT_FONT, MIN_FONT, MAX_FONT);
    if (!Array.isArray(this.state.panes) || !this.state.panes.length) this.state.panes = [null];
    const savedFlags = (this.state.cliFlags ?? {}) as Partial<Record<RealCli, string>>;
    this.state.cliFlags = { claude: savedFlags.claude ?? '', codex: savedFlags.codex ?? '', grok: savedFlags.grok ?? '' };
    this.state.panes = this.state.panes.slice(0, 3);
    this.state.settings = cleanSettings(this.state.settings);
    this.applyLook();

    // The terminal measures its font once; make sure the bundled font is ready first.
    await Promise.all(
      ['400', '700', 'italic 400'].map((style) => document.fonts.load(`${style} 14px "Cascadia Mono NF"`)),
    ).catch(() => {});

    this.library = new Library(document.getElementById('library')!, document.getElementById('quickbar')!, {
      send: (s) => this.sendSnippet(s),
      activeCli: () => this.activeCli(),
      toggleLibrary: () => this.toggleLibrary(),
      libraryOpen: () => this.state.libraryOpen,
    });

    this.applyLayoutVars();
    this.buildPanes();
    this.bindChrome();

    const restored = this.state.tabs;
    this.state.tabs = [];
    for (const ts of restored) {
      // An id whose conversation was never saved cannot be resumed; drop it so the
      // tab offers a fresh start of the CLI instead of a command that would fail.
      if (ts.cli !== 'none' && ts.sessionId && !(await api.sessionExists(ts.cli, ts.sessionId).catch(() => true))) {
        ts.sessionId = undefined;
      }
      const tab = this.addTab(ts);
      // A tab that had a CLI running comes back in its folder with a Resume button.
      tab.resumePending = ts.cli !== 'none';
    }
    // A starter tab only the very first time (or when the saved state could not be
    // read). Someone who closed every tab gets an empty window back, not a tab in the
    // home folder that they have to close again each time.
    if (!this.tabs.length && !hadSaved) {
      this.addTab({ id: uid(), name: '', autoName: true, shell: 'powershell', cwd: this.env.home, cli: 'none' });
      this.state.panes = [this.tabs[0].state.id];
    }
    // Drop pane entries that point at tabs which no longer exist, and fill gaps.
    this.state.panes = this.state.panes.map((id) => (id && this.tab(id) ? id : null));
    if (!this.state.panes.some(Boolean) && this.tabs.length) this.state.panes[0] = this.tabs[0].state.id;
    this.state.activePane = clamp(this.state.activePane, 0, this.state.panes.length - 1);

    this.layoutPanes();
    await Promise.all(this.tabs.map((t) => t.start()));
    this.started = true;
    this.renderAll();
    await this.library.load();
    this.focusActive();

    window.setInterval(() => void this.poll(), 1000);
    void this.poll();

    // CLI updates. At startup nothing is running yet, which is the one moment every
    // CLI can be replaced without closing anything.
    if (!['off', 'check', 'auto'].includes(this.state.updateMode)) this.state.updateMode = 'check';
    this.renderUpdatesButton();
    if (this.state.resumeMode !== 'auto') this.state.resumeMode = 'manual';
    const updateStep = this.state.updateMode !== 'off' ? this.startupUpdates(this.state.updateMode === 'auto') : Promise.resolve();
    void this.startupResume(updateStep);
    window.setInterval(() => {
      if (this.state.updateMode !== 'off' && !this.updating.size) void this.checkUpdates();
    }, 6 * 3600 * 1000);

    void getCurrentWebview().onDragDropEvent((event) => this.onDragDrop(event.payload));
    // Starting TermDeck again while it is open brings this window forward instead.
    void listen('second-start', () => {
      this.secondStarts++;
      toast('TermDeck was already open — this is it. (One copy runs per data folder, so sessions are never resumed twice.)', 'info', 5000);
    });
    void getCurrentWindow().onCloseRequested(async (event) => {
      // Closing the app ends everything its tabs started — so it asks first whenever
      // anything is running. (The emergency stop never asks; this is not that.)
      if (this.closeAsked) {
        event.preventDefault(); // the question is already on screen
        return;
      }
      this.closeAsked = true;
      await this.lookNow();
      this.closeAsked = false;
      const live = this.tabs.map((t) => ({ t, what: this.closingEnds(t) })).filter((x) => x.what);
      if (live.length) {
        this.closeAsked = true;
        const working = live.filter((x) => x.t.activity === 'working').length;
        const list = live.slice(0, 6).map((x) => `"${this.displayName(x.t)}" (${x.what})`).join(', ') + (live.length > 6 ? ` and ${live.length - 6} more` : '');
        const ok = await confirmDialog(
          'Close TermDeck?',
          `${live.length} tab${live.length > 1 ? 's still have' : ' still has'} something running: ${list}. `
            + (working ? `${working} ${working > 1 ? 'are' : 'is'} in the middle of work. ` : '')
            + 'Closing TermDeck ends all of it, background programs included. The conversations themselves can be resumed next time.',
          'Close anyway',
        );
        this.closeAsked = false;
        if (!ok) {
          event.preventDefault();
          return;
        }
      }
      await this.saveNow();
      // From here the saved state is final: tabs losing their programs while the app
      // shuts down must not be recorded as "nothing to resume".
      this.closing = true;
      document.body.classList.add('closing');
      if (live.length) toast('Closing — giving what was running a moment to finish…', 'info', 8000);
      await api.ptyKillAll().catch(() => 0);
    });
  }

  /**
   * What closing this tab would end, in a few words — or null when there is nothing but
   * an idle shell, in which case closing needs no question.
   */
  private closingEnds(tab: Tab): string | null {
    // A CLI sitting at its prompt is not a job in progress: its conversation is saved
    // and comes back with Resume. So it — with its launcher and the helpers it keeps
    // running — is not asked about. A CLI in the middle of work, or waiting for an
    // answer, is; and so is anything else in the tab (a server started before it).
    const cliBusy = tab.activity === 'working' || tab.activity === 'attention';
    // Idle, but a command it started in the background is still running: that is
    // something closing would end, so it is asked about and named.
    if (!cliBusy && tab.background) {
      const what = tab.backgroundPrograms();
      return `${CLI_NAME[tab.cliRunning as RealCli]} and a background command it started${what.length ? `: ${what.slice(0, 3).join(', ')}${what.length > 3 ? '…' : ''}` : ''}`;
    }
    const own = tab.cliRunning !== 'none' && !cliBusy ? tab.cliFamily() : new Set<number>();
    const counts = new Map<string, number>();
    for (const p of tab.running()) {
      if (own.has(p.pid)) continue;
      const name = p.name.replace(/\.exe$/i, '');
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const names = [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
    if (names.length) return names.slice(0, 4).join(', ') + (names.length > 4 ? ` and ${names.length - 4} more` : '');
    // Inside WSL the programs cannot be seen from Windows; go by what the tab shows.
    if (tab.cliRunning !== 'none') return cliBusy ? CLI_NAME[tab.cliRunning] : null;
    if (!tab.exited && tab.activity === 'working') return 'a command';
    return null;
  }

  say(tab: Tab, message: string): void {
    toast(`"${this.displayName(tab)}": ${message}`, 'error', 7000);
  }

  // ---------- TabHost ----------

  fontSize(): number {
    return this.state.fontSize;
  }

  changed(tab: Tab): void {
    this.renderTab(tab);
    this.scheduleSave();
  }

  pasteInto(tab: Tab): void {
    void (async () => {
      try {
        const clip = await api.clipboardRead();
        if (clip.kind === 'text' && clip.text) tab.insert(clip.text);
        else if (clip.kind === 'image') {
          tab.insertPaths(clip.paths);
          toast(`Image saved and its path inserted: ${baseName(clip.paths[0])}`);
        } else if (clip.kind === 'files') tab.insertPaths(clip.paths);
      } catch (e) {
        toast(`Paste failed: ${String(e)}`, 'error');
      }
    })();
  }

  refresh(): Promise<void> {
    return this.poll();
  }

  defaultFlags(cli: CliKind): string {
    return cli === 'none' ? '' : (this.state.cliFlags[cli] ?? '').trim();
  }

  look(): Look {
    const { fontFamily, scrollback, theme } = this.state.settings;
    return { fontFamily, scrollback, theme };
  }

  /** Puts the chosen font, colours and history length on every open terminal. */
  private applyLook(): void {
    const look = this.look();
    document.documentElement.style.setProperty('--term-bg', THEMES[look.theme].background);
    for (const t of this.tabs) t.applyLook(look);
  }

  estimateSize(): { cols: number; rows: number } {
    const shown = this.tabs.find((t) => t.isShown && t.term.cols > 20);
    return shown ? { cols: shown.term.cols, rows: shown.term.rows } : { cols: 120, rows: 30 };
  }

  // ---------- tabs ----------

  tab(id: string | null | undefined): Tab | undefined {
    return id ? this.tabs.find((t) => t.state.id === id) : undefined;
  }

  private tabInPane(i: number): Tab | undefined {
    return this.tab(this.state.panes[i]);
  }

  get activeTab(): Tab | undefined {
    return this.tabInPane(this.state.activePane);
  }

  private activeCli(): CliKind {
    const t = this.activeTab;
    if (!t) return 'none';
    return t.cliRunning !== 'none' ? t.cliRunning : t.resumePending ? 'none' : t.state.shell === 'wsl' ? t.state.cli : 'none';
  }

  private addTab(state: TabState): Tab {
    const tab = new Tab(state, this);
    this.tabs.push(tab);
    this.state.tabs.push(state);
    this.parking.append(tab.el);
    return tab;
  }

  /** Creates a tab, shows it in the focused pane and starts its shell. */
  async createTab(opts: { shell: ShellKind; cwd: string; cli: CliKind; name?: string; wslDistro?: string; sessionId?: string; flags?: string }): Promise<Tab> {
    // Switches chosen in the dialog are this tab's own, kept as typed.
    const own = opts.cli !== 'none' ? opts.flags?.trim() || undefined : undefined;
    const tab = this.addTab({
      id: uid(),
      name: opts.name?.trim() ?? '',
      autoName: !opts.name?.trim(),
      shell: opts.shell,
      wslDistro: opts.wslDistro,
      cwd: opts.cwd,
      cli: opts.cli,
      sessionId: opts.cli !== 'none' ? opts.sessionId : undefined,
      flags: own,
      flagsManual: own ? true : undefined,
      flagsCli: own ? opts.cli : undefined,
    });
    this.state.lastShell = opts.shell;
    this.state.lastDistro = opts.wslDistro;
    if (opts.cwd) {
      this.state.recentDirs = [opts.cwd, ...this.state.recentDirs.filter((d) => d.toLowerCase() !== opts.cwd.toLowerCase())].slice(0, 15);
    }
    this.showTab(tab);
    // The switches for every session of this CLI, plus the tab's own.
    const flags = shellFlags(tab.flags(), opts.shell);
    let launch = opts.cli !== 'none' ? `${opts.cli}${flags ? ` ${flags}` : ''}` : undefined;
    if (opts.cli !== 'none' && opts.sessionId) {
      // Reopening a past conversation: the same command Resume would type.
      launch = tab.resumeCommand() ?? launch;
    }
    if (opts.cli !== 'none' && this.updating.has(opts.cli) && opts.shell !== 'wsl') {
      // Its CLI is being replaced right now — starting it would run the half-replaced
      // program, or hold its files and make the update fail. The tab opens with Resume
      // offered instead. (A fresh start used to be typed regardless; only a reopened
      // conversation was held back.)
      tab.resumePending = true;
      launch = undefined;
      toast(`${CLI_NAME[opts.cli]} is being updated — press Resume in the new tab when that has finished.`, 'info', 6000);
    }
    await tab.start(launch);
    this.renderAll();
    this.scheduleSave();
    return tab;
  }

  /** Brings a tab into view: focuses its pane, or puts it in the focused pane. */
  showTab(tab: Tab, pane?: number): void {
    const already = this.state.panes.indexOf(tab.state.id);
    if (already >= 0 && pane === undefined) {
      this.state.activePane = already;
    } else {
      const target = pane ?? this.state.activePane;
      if (already >= 0 && already !== target) this.state.panes[already] = this.state.panes[target];
      this.state.panes[target] = tab.state.id;
      this.state.activePane = target;
      this.layoutPanes();
    }
    tab.markSeen();
    this.renderAll();
    this.focusActive();
    this.scheduleSave();
  }

  async closeTab(tab: Tab): Promise<void> {
    // Closing a tab ends everything it started, background programs included — so it
    // asks first whenever there is more in it than an idle shell. Decided on a fresh
    // look, not on one up to a second old (a program that has just ended would
    // otherwise still be named).
    await this.lookNow();
    if (!this.tabs.includes(tab)) return;
    const what = this.closingEnds(tab);
    if (what) {
      const hasCli = tab.cliRunning !== 'none';
      const ok = await confirmDialog(
        'Close this session?',
        (tab.activity === 'working' ? `"${this.displayName(tab)}" is still working (${what}).` : `"${this.displayName(tab)}" still has this running: ${what}.`)
          + ` Closing the tab ends it${hasCli ? ' — the conversation itself stays in the CLI\'s history and can be reopened from "Open…"' : ''}.`,
        'Close tab',
      );
      if (!ok || !this.tabs.includes(tab)) return;
    }
    const pane = this.state.panes.indexOf(tab.state.id);
    this.panes[pane]?.closeHistory?.();
    this.tabs = this.tabs.filter((t) => t !== tab);
    this.state.tabs = this.state.tabs.filter((t) => t.id !== tab.state.id);
    this.rows.get(tab.state.id)?.root.remove();
    this.rows.delete(tab.state.id);
    this.workSince.delete(tab.state.id);
    tab.dispose();
    if (pane >= 0) {
      const hidden = this.tabs.find((t) => !this.state.panes.includes(t.state.id));
      this.state.panes[pane] = hidden ? hidden.state.id : null;
    }
    this.layoutPanes();
    this.renderAll();
    this.focusActive();
    this.scheduleSave();
  }

  private displayName(tab: Tab): string {
    if (!tab.state.autoName && tab.state.name) return tab.state.name;
    if (tab.state.shell === 'wsl' && !tab.state.cwd) return tab.state.wslDistro || 'WSL';
    return baseName(tab.state.cwd) || SHELL_LABEL[tab.state.shell];
  }

  private statusText(tab: Tab): string {
    if (tab.resumePending && tab.activity === 'idle') return 'ready to resume';
    if (tab.activity === 'working' && tab.cliRunning === 'none' && tab.state.shell !== 'wsl') return 'running';
    if (tab.activity === 'attention' && tab.waitingFor) return `needs you: ${tab.waitingFor}`;
    // The CLI has answered, but a command it started in the background is still going.
    if (tab.background && (tab.activity === 'idle' || tab.activity === 'done')) {
      return tab.activity === 'done' ? 'finished · background job' : 'background job';
    }
    return STATUS_TEXT[tab.activity] ?? '';
  }

  // ---------- panes ----------

  private buildPanes(): void {
    for (const p of this.panes) {
      p.closeHistory?.();
      this.resizeObserver.unobserve(p.body);
    }
    for (const t of this.tabs) this.parking.append(t.el);
    this.panesEl.replaceChildren();
    this.applyPaneDirection();
    this.panesObserver.observe(this.panesEl); // (observing twice is the same as once)
    this.panes = this.state.panes.map((_, i) => this.buildPane(i));
    for (const b of document.querySelectorAll<HTMLButtonElement>('#split-seg button')) {
      b.classList.toggle('on', Number(b.dataset.n) === this.state.panes.length);
    }
  }

  /**
   * Side by side or one above the other. In a tall, narrow window (a monitor turned
   * upright) panes side by side are strips too narrow to read; stacked, each keeps the
   * full width. Automatic unless Settings says otherwise: stacked when the area the
   * panes share is taller than it is wide — with a little slack, so a window right at
   * the turning point does not flip back and forth while it is being resized.
   */
  applyPaneDirection(): void {
    const n = this.state.panes.length;
    const mode = this.state.settings.paneLayout;
    let stacked = false;
    if (n > 1) {
      if (mode === 'stack') stacked = true;
      else if (mode === 'side') stacked = false;
      else {
        const { width, height } = this.panesEl.getBoundingClientRect();
        stacked = width > 0 && height > 0 ? height > width * (this.stacked ? 0.95 : 1.05) : this.stacked;
      }
    }
    const tracks = `repeat(${n}, minmax(0, 1fr))`;
    const columns = stacked ? 'minmax(0, 1fr)' : tracks;
    const rows = stacked ? tracks : 'minmax(0, 1fr)';
    if (this.panesEl.style.gridTemplateColumns !== columns) this.panesEl.style.gridTemplateColumns = columns;
    if (this.panesEl.style.gridTemplateRows !== rows) this.panesEl.style.gridTemplateRows = rows;
    if (stacked !== this.stacked) {
      this.stacked = stacked;
      this.panesEl.classList.toggle('stacked', stacked);
    }
  }

  private buildPane(i: number): PaneEls {
    const dot = h('span', { class: 'dot' });
    const name = h('span', { class: 'p-name' });
    const st = h('span', { class: 'p-st st' });
    const dir = h('span', { class: 'p-dir' });
    const size = h('span', { class: 'p-size', title: 'Columns × rows' });
    const use = h('button', {
      class: 'p-use',
      hidden: true,
      title: 'Processor and memory used by everything in this tab — click for the list',
      onclick: () => {
        const t = this.tabInPane(i);
        if (t) this.showProcesses(t);
      },
    });
    const historyBtn = h('button', {
      class: 'btn small ghost',
      title: 'Read this conversation from the CLI session file (Ctrl+Shift+H)',
      onclick: () => this.toggleHistory(i),
    }, 'History');
    const resumeText = h('span', { class: 'grow' });
    const resume = h('div', { class: 'resume-bar', hidden: true },
      resumeText,
      h('button', { class: 'btn small primary', onclick: () => this.resume(i) }, 'Resume'),
      h('button', {
        class: 'btn small ghost',
        title: 'Switches this session is started with, e.g. --dangerously-skip-permissions',
        onclick: () => {
          const t = this.tabInPane(i);
          if (t) this.showFlags(t);
        },
      }, 'Flags…'),
      h('button', { class: 'btn small ghost', title: 'Keep this as a plain shell', onclick: () => this.dismissResume(i) }, 'Dismiss'),
    );
    const empty = h('div', { class: 'pane-empty' },
      h('div', null, 'Nothing here yet.'),
      h('button', { class: 'btn primary', onclick: () => { this.state.activePane = i; this.newTabDialog(); } }, '+ New session'),
    );
    const toBottom = h('button', {
      class: 'to-bottom',
      hidden: true,
      onclick: () => {
        const t = this.tabInPane(i);
        t?.term.scrollToBottom();
        t?.focus();
      },
    }, '↓ Latest');
    const body = h('div', { class: 'pane-body' }, empty, toBottom);
    // The pane's number — the same number as on the buttons of every tab row — and a
    // way to say from here which tab this pane shows.
    const num = h('button', {
      class: 'p-num',
      title: `Pane ${i + 1} — click to choose which tab it shows`,
      onclick: (e: MouseEvent) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        menu(r.left, r.bottom + 2, this.tabs.length
          ? this.tabs.map((t) => {
              const at = this.state.panes.indexOf(t.state.id);
              const where = at === i ? '  ✓' : at >= 0 ? `  (now in pane ${at + 1} — they swap)` : '';
              return { label: `${this.displayName(t)}${t.state.cli !== 'none' ? ` · ${t.state.cli}` : ''}${where}`, onClick: () => this.showTab(t, i) };
            })
          : [{ label: 'No tabs yet — + New session', onClick: () => { this.state.activePane = i; this.newTabDialog(); } }]);
      },
    }, String(i + 1));
    num.hidden = this.state.panes.length < 2;
    const root = h('div', { class: 'pane', 'data-pane': String(i) },
      h('div', { class: 'pane-head' }, num, dot, name, st, dir, use, size, historyBtn),
      resume,
      body,
    );
    root.addEventListener('mousedown', () => this.setActivePane(i), true);
    root.addEventListener('focusin', () => this.setActivePane(i));
    this.panesEl.append(root);
    this.resizeObserver.observe(body);
    return { root, dot, name, st, dir, size, use, historyBtn, resume, resumeText, body, empty, toBottom, closeHistory: null };
  }

  private setActivePane(i: number): void {
    if (this.state.activePane === i) {
      this.tabInPane(i)?.markSeen();
      return;
    }
    this.state.activePane = i;
    this.tabInPane(i)?.markSeen();
    this.renderAll();
    this.scheduleSave();
  }

  /** Puts each pane's tab on screen and parks every other terminal. */
  private layoutPanes(): void {
    const shown = new Set(this.state.panes.filter(Boolean) as string[]);
    for (const t of this.tabs) {
      if (!shown.has(t.state.id) && t.isShown) {
        this.parking.append(t.el);
        t.setShown(false);
      }
    }
    this.state.panes.forEach((id, i) => {
      const p = this.panes[i];
      const t = this.tab(id);
      p.empty.hidden = !!t;
      if (t && t.el.parentElement !== p.body) {
        p.closeHistory?.();
        p.body.insertBefore(t.el, p.body.firstChild);
      }
      if (t && !t.isShown) t.setShown(true);
      else t?.fitNow();
    });
  }

  setSplit(n: number): void {
    n = clamp(n, 1, 3);
    if (n === this.state.panes.length) return;
    const panes = this.state.panes.slice(0, n);
    while (panes.length < n) {
      const hidden = this.tabs.find((t) => !panes.includes(t.state.id));
      panes.push(hidden ? hidden.state.id : null);
    }
    // Keep the focused tab visible when panes are removed.
    const focused = this.state.panes[this.state.activePane];
    if (focused && !panes.includes(focused)) panes[n - 1] = focused;
    this.state.panes = panes;
    this.state.activePane = Math.max(0, focused ? panes.indexOf(focused) : 0);
    this.buildPanes();
    this.layoutPanes();
    this.renderAll();
    this.focusActive();
    this.scheduleSave();
  }

  private toggleHistory(i: number): void {
    const p = this.panes[i];
    const t = this.tabInPane(i);
    if (p.closeHistory) {
      p.closeHistory();
      return;
    }
    if (!t || t.state.cli === 'none') return;
    p.closeHistory = openHistory(p.body, t, () => {
      p.closeHistory = null;
      t.focus();
    });
  }

  private resume(i: number): void {
    const t = this.tabInPane(i);
    if (t && this.resumeTab(t)) t.focus();
  }

  /** Types the tab's resume command. False if there is nothing to resume, or it must wait. */
  private resumeTab(t: Tab): boolean {
    const cmd = t.resumeCommand();
    if (!cmd || t.exited) return false;
    const cli = t.state.cli;
    if (cli !== 'none' && this.updating.has(cli) && t.state.shell !== 'wsl') {
      toast(`${CLI_NAME[cli]} is being updated — it can be resumed as soon as that finishes.`);
      return false;
    }
    if (!t.promptFree()) {
      // Typed now, the command would go to whatever is running there, not to the shell.
      toast(`Something is running in "${this.displayName(t)}", so the resume command was not typed into it. Press Resume again once it is back at its prompt.`, 'info', 6000);
      return false;
    }
    t.resumePending = false;
    // If the command could not be confirmed as typed, it is not run: offer Resume again.
    t.runWhenQuiet(cmd, () => {
      t.resumePending = true;
      this.renderTab(t);
    });
    this.renderTab(t);
    return true;
  }

  private dismissResume(i: number): void {
    const t = this.tabInPane(i);
    if (!t) return;
    t.resumePending = false;
    t.state.cli = 'none';
    t.state.sessionId = undefined;
    t.state.flags = undefined;
    t.state.flagsManual = undefined;
    t.state.flagsCli = undefined;
    this.renderTab(t);
    this.scheduleSave();
    t.focus();
  }

  private focusActive(): void {
    window.setTimeout(() => {
      // Never pull focus out of a dialog or a text box the user is typing in
      // (renaming a tab, searching the library).
      const el = document.activeElement;
      if (isModalOpen() || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      this.activeTab?.focus();
    }, 0);
  }

  // ---------- rendering ----------

  private renderAll(): void {
    this.renderRows();
    for (const t of this.tabs) this.renderTab(t);
    this.panes.forEach((p, i) => {
      p.root.classList.toggle('active', i === this.state.activePane);
      if (!this.tabInPane(i)) this.renderPane(i, undefined);
    });
    document.getElementById('zoom-val')!.textContent = String(this.state.fontSize);
    this.library?.renderBar();
  }

  /** Keeps one sidebar row per tab, in tab order. */
  private renderRows(): void {
    this.tabs.forEach((tab, index) => {
      let row = this.rows.get(tab.state.id);
      if (!row) {
        row = this.buildRow(tab);
        this.rows.set(tab.state.id, row);
      }
      if (this.tabList.children[index] !== row.root) this.tabList.insertBefore(row.root, this.tabList.children[index] ?? null);
    });
  }

  private buildRow(tab: Tab): RowEls {
    const name = h('div', { class: 't-name' });
    const sub = h('div', { class: 't-sub' });
    // One small button per pane: press 2 and this tab is in pane 2. No guessing which
    // pane a click will land in.
    const pane = h('span', { class: 't-panes', hidden: true });
    const useCpu = h('span');
    const useMem = h('span');
    const use = h('button', {
      class: 't-use',
      hidden: true,
      onclick: (e: MouseEvent) => {
        e.stopPropagation();
        this.showProcesses(tab);
      },
    }, useCpu, useMem);
    // Shown only while the tab is running hot. Two clicks, so a slip cannot kill.
    const kill = h('button', {
      class: 't-kill',
      hidden: true,
      title: 'Stop everything this tab has started (Ctrl+Shift+K twice)',
      onclick: (e: MouseEvent) => {
        e.stopPropagation();
        if (this.confirmTwice(`kill:${tab.state.id}`)) {
          kill.textContent = 'Kill';
          void this.killTab(tab);
        } else {
          kill.textContent = 'Sure?';
          window.setTimeout(() => (kill.textContent = 'Kill'), 3000);
        }
      },
    }, 'Kill');
    // Two lines: the name and what the tab is doing get the full width; the figures
    // and the pane buttons sit underneath. (Side by side they pushed the name out of a
    // narrow side panel altogether.)
    const root = h('div', { class: 'tab' },
      h('span', { class: 'dot' }),
      h('div', { class: 't-main' }, name, sub),
      h('button', {
        class: 't-close',
        title: 'Close (Ctrl+Shift+W)',
        onclick: (e: MouseEvent) => {
          e.stopPropagation();
          void this.closeTab(tab);
        },
      }, '×'),
      h('div', { class: 't-foot' }, use, kill, pane),
    );
    root.addEventListener('click', (e) => {
      // The second click of a double-click is the rename gesture, not a tab switch.
      if (this.justDragged || e.detail > 1 || (e.target as HTMLElement).closest('input')) return;
      this.showTab(tab);
    });
    root.addEventListener('dblclick', (e) => {
      if (!(e.target as HTMLElement).closest('.t-close')) this.renameTab(tab);
    });
    root.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const items = [
        { label: 'Rename', onClick: () => this.renameTab(tab) },
        { label: 'Duplicate', onClick: () => void this.createTab({ shell: tab.state.shell, cwd: tab.state.cwd, cli: 'none', wslDistro: tab.state.wslDistro }) },
        ...this.state.panes.map((_, i) => ({ label: `Show in pane ${i + 1}`, onClick: () => this.showTab(tab, i) })),
        null,
        { label: 'CLI flags…', onClick: () => this.showFlags(tab) },
        { label: 'Processes and usage…', onClick: () => this.showProcesses(tab) },
        { label: tab.lowPriority ? 'Back to normal priority' : 'Run at low priority', onClick: () => void this.setLowPriority(tab, !tab.lowPriority) },
        { label: 'Kill everything in this tab', onClick: () => void this.killTab(tab) },
        null,
        { label: 'Close', onClick: () => void this.closeTab(tab) },
      ];
      menu(e.clientX, e.clientY, this.state.panes.length > 1 ? items : items.filter((it) => !it || !it.label.startsWith('Show in pane')));
    });
    this.bindRowDrag(root, tab);
    return { root, name, sub, pane, use, useCpu, useMem, kill };
  }

  private renderTab(tab: Tab): void {
    const row = this.rows.get(tab.state.id);
    const paneIndex = this.state.panes.indexOf(tab.state.id);
    const status = this.statusText(tab);
    const cli = tab.cliRunning !== 'none' ? tab.cliRunning : tab.state.cli;
    const topic = tab.cliRunning !== 'none' ? tab.sessionName || cleanTitle(tab.title, [cli, this.displayName(tab)]) : '';
    const detail = topic || tab.state.cwd || tab.state.wslDistro || '';

    if (row) {
      row.root.className = `tab s-${tab.activity} ${tab.background ? 'bg-job' : ''} ${paneIndex >= 0 ? 'shown' : ''} ${paneIndex === this.state.activePane ? 'focused' : ''} ${this.usageLevel(tab) === 'hot' ? 'hot' : ''}`;
      row.root.title = `${this.displayName(tab)}\n${SHELL_LABEL[tab.state.shell]}${tab.state.wslDistro ? ` (${tab.state.wslDistro})` : ''} — ${tab.state.cwd}${cli !== 'none' ? `\n${cli}${tab.state.sessionId ? ` session ${tab.state.sessionId}` : ''}` : ''}`;
      if (!row.name.querySelector('input')) row.name.textContent = this.displayName(tab);
      row.sub.replaceChildren(
        ...(status ? [h('span', { class: 'st' }, status), ' · '] : []),
        ...(cli !== 'none' ? [h('span', { class: `cli cli-${cli}` }, cli), ' · '] : []),
        detail,
      );
      const count = this.state.panes.length;
      row.pane.hidden = count < 2;
      if (row.pane.childElementCount !== count) {
        row.pane.replaceChildren(...this.state.panes.map((_, i) => h('button', {
          class: 'pane-btn',
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            this.showTab(tab, i);
          },
        }, String(i + 1))));
      }
      Array.from(row.pane.children).forEach((b, i) => {
        const on = i === paneIndex;
        b.classList.toggle('on', on);
        (b as HTMLElement).title = on ? `Shown in pane ${i + 1}` : paneIndex >= 0 ? `Move to pane ${i + 1} (swaps with what is there)` : `Show in pane ${i + 1}`;
      });
    }
    if (paneIndex >= 0) this.renderPane(paneIndex, tab);
    this.renderResumeAll();
  }

  /** "Resume all" appears above the tab list while two or more sessions are waiting. */
  private renderResumeAll(): void {
    const n = this.tabs.filter((t) => t.resumePending && !t.exited && t.state.cli !== 'none').length;
    const bar = document.getElementById('resume-all')!;
    if (bar.hidden !== n < 2) bar.hidden = n < 2;
    const text = `Resume all ${n} sessions`;
    const btn = document.getElementById('btn-resume-all')!;
    if (btn.textContent !== text) btn.textContent = text;
  }

  /**
   * Automatic resume at startup — always after the update step, so resuming can never be
   * what blocks an update:
   *   updates "automatic"  -> they have been installed by now; resume everything
   *   updates "check"      -> sessions of a CLI with an update waiting are left for the
   *                           user (who can update first); the rest are resumed
   *   updates "do nothing" -> resume everything straight away
   */
  private async startupResume(updateStep: Promise<void>): Promise<void> {
    try {
      if (this.state.resumeMode !== 'auto') return;
      // A check gets a minute; an install is waited for however long it takes (it stops itself after 15 minutes per CLI).
      await Promise.race([updateStep, sleep(this.state.updateMode === 'auto' ? 50 * 60 * 1000 : 60 * 1000)]);
      const held = new Set<CliKind>(
        this.state.updateMode === 'check' ? (this.versions ?? []).filter((v) => v.updateAvailable).map((v) => v.cli) : [],
      );
      const leave = (t: Tab) => held.has(t.state.cli) && t.state.shell !== 'wsl';
      const left = this.tabs.filter((t) => t.resumePending && !t.exited && leave(t));
      await this.resumeAll((t) => !leave(t), true);
      if (left.length) {
        const names = [...new Set(left.map((t) => CLI_NAME[t.state.cli as RealCli]))].join(', ');
        toast(`${names}: an update is waiting, so ${left.length === 1 ? 'its session was' : `those ${left.length} sessions were`} not resumed. Open "Updates" to update (they resume afterwards), or press Resume.`, 'info', 9000);
      }
    } finally {
      this.startingUp = false;
    }
  }

  /**
   * Resumes every waiting session, one after another so they do not all start in the same
   * instant. A tab with something running at its prompt is left alone — and so is, when
   * this runs by itself at startup (`auto`), a tab you have already started typing in:
   * automatic resume can come a while after the window opens (it waits for the update
   * step), and must not clear your line and type over it.
   */
  async resumeAll(only?: (t: Tab) => boolean, auto = false): Promise<void> {
    const waiting = this.tabs.filter((t) => t.resumePending && !t.exited && t.state.cli !== 'none' && (!only || only(t)));
    let started = 0;
    const skipped: Tab[] = [];
    for (const t of waiting) {
      if (!t.resumePending) continue;
      if ((auto && t.userTyped) || !t.promptFree()) {
        skipped.push(t);
        continue;
      }
      if (!this.resumeTab(t)) continue;
      started++;
      await sleep(700);
    }
    if (started) toast(`Resuming ${started} session${started === 1 ? '' : 's'}.`);
    if (skipped.length) {
      const names = skipped.slice(0, 4).map((t) => `"${this.displayName(t)}"`).join(', ') + (skipped.length > 4 ? ` and ${skipped.length - 4} more` : '');
      toast(`Not resumed: ${names} — ${auto ? 'you were already typing there, or something is running' : 'something is running there'}. Press Resume in the tab when it is at its prompt.`, 'info', 9000);
    }
    this.focusActive();
  }

  /** Switches for one tab's CLI, and the ones added to every session of each CLI. */
  showFlags(tab: Tab): void {
    if (isModalOpen()) return;
    const cli = tab.state.cli;
    const own = h('input', { value: tab.state.flags ?? '', spellcheck: false, placeholder: 'none' });
    const all: Record<RealCli, HTMLInputElement> = {
      claude: h('input', { value: this.state.cliFlags.claude, spellcheck: false, placeholder: 'none — e.g. --dangerously-skip-permissions' }),
      codex: h('input', { value: this.state.cliFlags.codex, spellcheck: false, placeholder: 'none' }),
      grok: h('input', { value: this.state.cliFlags.grok, spellcheck: false, placeholder: 'none' }),
    };
    const preview = h('code', { class: 'flag-preview' });
    const paint = () => {
      if (cli === 'none') return;
      // Shown exactly as it will be typed, quoted for this tab's shell.
      const words = shellFlags(mergeFlags(all[cli].value.trim(), own.value), tab.state.shell);
      const base = tab.state.sessionId ? { claude: `claude --resume ${tab.state.sessionId}`, codex: `codex resume ${tab.state.sessionId}`, grok: `grok --resume ${tab.state.sessionId}` }[cli] : cli;
      preview.textContent = `${base}${words ? ` ${words}` : ''}`;
    };
    for (const el of [own, ...Object.values(all)]) el.addEventListener('input', paint);
    paint();
    const body = h('div', { class: 'body' },
      cli !== 'none'
        ? h('div', { class: 'field' },
            h('label', null, `This tab (${CLI_NAME[cli]})`),
            own,
            h('p', { class: 'proc-note' }, 'Filled in by itself from how the CLI in this tab was started. Change it here and the app stops reading it from the process.'),
            h('label', null, 'This tab will be started with'),
            preview)
        : h('p', { class: 'proc-note' }, 'No CLI is associated with this tab, so it has no flags of its own.'),
      h('div', { class: 'field' }, h('label', null, 'Every Claude Code session started or resumed here'), all.claude),
      h('div', { class: 'field' }, h('label', null, 'Every Codex session'), all.codex),
      h('div', { class: 'field' }, h('label', null, 'Every Grok session'), all.grok),
      h('p', { class: 'proc-note' }, 'Applies to sessions the app starts: New session, Resume, Resume all. A CLI you start by typing its command is left exactly as you typed it — and its switches are then remembered for that tab.'),
    );
    modal('CLI flags', body, [
      { label: 'Cancel' },
      {
        label: 'Save',
        kind: 'primary',
        onClick: () => {
          for (const k of ['claude', 'codex', 'grok'] as RealCli[]) this.state.cliFlags[k] = all[k].value.trim();
          if (cli !== 'none' && own.value.trim() !== (tab.state.flags ?? '')) {
            tab.state.flags = own.value.trim() || undefined;
            tab.state.flagsManual = true;
            tab.state.flagsCli = cli;
          }
          for (const t of this.tabs) this.renderTab(t);
          this.scheduleSave();
        },
      },
    ], () => this.focusActive());
  }

  private renderPane(i: number, tab: Tab | undefined): void {
    const p = this.panes[i];
    if (!p) return;
    p.root.className = `pane ${i === this.state.activePane ? 'active' : ''} ${tab ? `s-${tab.activity}` : ''} ${tab?.background ? 'bg-job' : ''} ${p.root.classList.contains('drop-here') ? 'drop-here' : ''} ${p.root.classList.contains('drop-target') ? 'drop-target' : ''}`;
    p.dot.hidden = !tab;
    p.empty.hidden = !!tab;
    if (!tab) {
      p.name.textContent = `Pane ${i + 1}`;
      p.st.textContent = '';
      p.dir.textContent = '';
      p.size.textContent = '';
      p.use.hidden = true;
      p.historyBtn.hidden = true;
      p.resume.hidden = true;
      p.toBottom.hidden = true;
      return;
    }
    const cli = tab.cliRunning !== 'none' ? tab.cliRunning : tab.state.cli;
    p.name.textContent = this.displayName(tab);
    p.st.textContent = [this.statusText(tab), cli !== 'none' ? cli : ''].filter(Boolean).join(' · ');
    // ‎ keeps a right-to-left-clipped path reading left to right.
    p.dir.textContent = `‎${tab.state.cwd}`;
    p.dir.title = tab.state.cwd;
    p.size.textContent = `${tab.term.cols}×${tab.term.rows}`;
    p.historyBtn.hidden = cli === 'none';
    p.toBottom.hidden = !tab.scrolledUp || !!p.closeHistory;
    const cmd = tab.resumePending ? tab.resumeCommand() : null;
    const showResume = !!cmd && !tab.exited;
    if (p.resume.hidden === showResume) {
      p.resume.hidden = !showResume;
      tab.scheduleFit();
    }
    if (cmd) {
      p.resumeText.textContent = tab.state.sessionId || tab.state.shell === 'wsl'
        ? `This tab was running ${tab.state.cli}. Resume the conversation with:  ${cmd}`
        : `This tab had ${tab.state.cli} open with nothing sent yet. Start it again with:  ${cmd}`;
      p.resumeText.title = cmd;
    }
  }

  private renameTab(tab: Tab): void {
    const row = this.rows.get(tab.state.id);
    if (!row) return;
    const input = h('input', { class: 'rename', value: this.displayName(tab), spellcheck: false });
    let done = false;
    const finish = (keep: boolean) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      if (keep) {
        tab.state.name = value;
        tab.state.autoName = !value;
      }
      input.remove();
      this.renderTab(tab);
      this.scheduleSave();
      this.focusActive();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
    row.name.replaceChildren(input);
    input.focus();
    input.select();
  }

  /** Drag a row up or down to reorder. Pointer-based, so file drops keep working. */
  private bindRowDrag(root: HTMLDivElement, tab: Tab): void {
    root.addEventListener('pointerdown', (down) => {
      if (down.button !== 0 || (down.target as HTMLElement).closest('button, input')) return;
      let dragging = false;
      let target: { row: HTMLElement; after: boolean } | null = null;
      let paneTarget = -1;
      const clear = () => {
        for (const r of this.tabList.children) r.classList.remove('drop-before', 'drop-after');
        for (const p of this.panes) p.root.classList.remove('drop-here');
      };
      const move = (e: PointerEvent) => {
        if (!dragging && Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < 7) return;
        dragging = true;
        root.classList.add('dragging');
        document.body.classList.add('tab-dragging');
        clear();
        target = null;
        paneTarget = -1;
        const under = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
        // Dropped on a pane, the tab is shown in that pane.
        const pane = under?.closest<HTMLElement>('.pane');
        if (pane?.dataset.pane !== undefined) {
          paneTarget = Number(pane.dataset.pane);
          pane.classList.add('drop-here');
          return;
        }
        const over = under?.closest<HTMLElement>('.tab');
        if (over && over !== root && over.parentElement === this.tabList) {
          const r = over.getBoundingClientRect();
          const after = e.clientY > r.top + r.height / 2;
          over.classList.add(after ? 'drop-after' : 'drop-before');
          target = { row: over, after };
        }
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        root.classList.remove('dragging');
        document.body.classList.remove('tab-dragging');
        clear();
        if (!dragging) return;
        this.justDragged = true;
        window.setTimeout(() => (this.justDragged = false), 50);
        if (paneTarget >= 0 && paneTarget < this.state.panes.length && this.tabs.includes(tab)) {
          this.showTab(tab, paneTarget);
          return;
        }
        if (!target) return;
        const overId = [...this.rows.entries()].find(([, r]) => r.root === target!.row)?.[0];
        const from = this.tabs.indexOf(tab);
        // The tab being dragged, or the one it was dropped on, has gone meanwhile.
        if (from < 0 || !overId || !this.tab(overId)) return;
        this.tabs.splice(from, 1);
        let to = this.tabs.findIndex((t) => t.state.id === overId);
        if (target.after) to += 1;
        this.tabs.splice(to, 0, tab);
        this.state.tabs = this.tabs.map((t) => t.state);
        this.renderAll();
        this.scheduleSave();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  }

  // ---------- status ----------

  /** Looks at the processes now, waiting out a look that is already under way (2 s at most). */
  private async lookNow(): Promise<void> {
    for (let i = 0; i < 40 && this.polling; i++) await sleep(50);
    await this.poll();
  }

  private async poll(): Promise<void> {
    if (this.polling || this.closing) return;
    this.polling = true;
    try {
      // A tab whose shell has ended is still asked about (with no shell process):
      // something it started may be running on, and that should show up too.
      const tracked = this.tabs.filter((t) => t.procId);
      // A look that never comes back must not stop all later ones — nor hold up closing
      // the app, which waits for a fresh look. After 15 s it is given up on.
      let giveUp = 0;
      const res = await Promise.race([
        api.pollStatus(tracked.map((t) => ({
          id: t.state.id,
          pty: t.procId!,
          pid: t.exited || t.pid === null ? 0 : t.pid,
          cwd: t.state.cwd,
          session: t.state.sessionId ?? null,
          input: t.lastEnter || null,
        }))),
        new Promise<never>((_, reject) => {
          giveUp = window.setTimeout(() => reject(new Error('the look at the processes did not come back')), 15000);
        }),
      ]).finally(() => window.clearTimeout(giveUp));
      this.system = res.system;
      const byId = new Map(res.tabs.map((s) => [s.id, s]));
      let barDirty = false;
      for (const t of this.tabs) {
        const focused = document.hasFocus() && this.activeTab === t;
        const was = t.activity;
        if (t.applyStatus(byId.get(t.state.id), focused)) {
          this.renderTab(t);
          this.scheduleSave();
          if (t === this.activeTab) barDirty = true;
        }
        if (t.activity !== was) this.activityChanged(t, was);
      }
      if (barDirty) this.library.renderBar();
      this.renderUsage();
      const attention = this.tabs.filter((t) => t.activity === 'attention').length;
      const working = this.tabs.filter((t) => t.activity === 'working').length;
      const done = this.tabs.filter((t) => t.activity === 'done').length;
      const parts = [working && `${working} working`, attention && `${attention} need you`, done && `${done} finished`].filter(Boolean);
      const title = parts.length ? `TermDeck — ${parts.join(', ')}` : 'TermDeck';
      if (document.title !== title) {
        document.title = title;
        void getCurrentWindow().setTitle(title).catch(() => {});
      }
    } catch {
      /* a failed poll is retried a second later */
    } finally {
      this.polling = false;
    }
  }

  // ---------- notifications ----------

  /**
   * A tab went from one state to another. Announces "needs you", and "finished" after
   * work that lasted at least five seconds (so a quick command makes no noise) — unless
   * you are looking at that tab.
   */
  private activityChanged(tab: Tab, was: string): void {
    const id = tab.state.id;
    const now = performance.now();
    if (tab.activity === 'working') {
      if (was !== 'attention' || !this.workSince.has(id)) this.workSince.set(id, now);
      return;
    }
    const worked = now - (this.workSince.get(id) ?? now);
    if (tab.activity === 'attention') this.notify(tab, 'needs');
    else if (tab.activity === 'done' && was === 'working' && worked >= 5000) this.notify(tab, 'done');
    if (tab.activity !== 'attention') this.workSince.delete(id);
  }

  private notify(tab: Tab, kind: 'done' | 'needs'): void {
    const away = !document.hasFocus();
    if (!away && this.activeTab === tab) return;
    const set = this.state.settings;
    const flashed = set.notifyFlash && away;
    const sound = set.notifySound === 'both' || (set.notifySound === 'needs' && kind === 'needs');
    this.notices.push({ tab: tab.state.id, kind, at: Date.now(), flashed, sound });
    if (this.notices.length > 50) this.notices.shift();
    if (flashed) void api.attention(true).catch(() => {});
    if (sound) beep(kind);
    // In front but on another tab that is not in any pane: say which one.
    if (!away && !tab.isShown) toast(`${this.displayName(tab)} ${kind === 'needs' ? 'needs you' : 'has finished'}.`, 'info', 4000);
  }

  // ---------- usage, emergency stop ----------

  /** How heavy a tab is: 'hot' is the level at which it can make the whole PC drag. */
  private usageLevel(tab: Tab): '' | 'warm' | 'hot' {
    const total = this.system?.memTotal ?? 0;
    const memShare = total ? tab.mem / total : 0;
    const { hotCpu, hotMem } = this.state.settings;
    if (tab.cpu >= hotCpu || memShare * 100 >= hotMem) return 'hot';
    // "Getting heavy" (amber) starts at a little under half of that.
    if (tab.cpu >= hotCpu * 0.4 || memShare * 100 >= hotMem * 0.5) return 'warm';
    return '';
  }

  /** Refreshes the processor / memory readouts. Runs once a second, after each poll. */
  private renderUsage(): void {
    for (const tab of this.tabs) {
      const level = this.usageLevel(tab);
      const has = tab.procs.length > 0;
      const low = tab.lowPriority ? ' · low priority' : '';
      const row = this.rows.get(tab.state.id);
      if (row) {
        row.use.hidden = !has;
        row.use.className = `t-use ${level} ${tab.lowPriority ? 'low' : ''}`;
        row.useCpu.textContent = fmtCpu(tab.cpu);
        row.useMem.textContent = fmtMem(tab.mem);
        row.use.title = `${tab.procs.length} process${tab.procs.length === 1 ? '' : 'es'} · CPU ${fmtCpu(tab.cpu)} of the whole PC · RAM ${fmtMem(tab.mem)}${low}\nClick for the list`;
        row.kill.hidden = level !== 'hot';
        row.root.classList.toggle('hot', level === 'hot');
      }
      const pi = this.state.panes.indexOf(tab.state.id);
      const p = pi >= 0 ? this.panes[pi] : undefined;
      if (p) {
        p.use.hidden = !has;
        p.use.className = `p-use ${level}`;
        p.use.textContent = `${tab.lowPriority ? 'low · ' : ''}CPU ${fmtCpu(tab.cpu)} · ${fmtMem(tab.mem)}`;
      }
    }
    const sys = this.system;
    const el = document.getElementById('sys-usage')!;
    if (sys && sys.memTotal) {
      el.textContent = `PC  ·  CPU ${fmtCpu(sys.cpu)}  ·  RAM ${fmtMem(sys.memUsed)} / ${fmtMem(sys.memTotal)}`;
      el.className = `sb-sys ${sys.cpu >= 90 || sys.memUsed / sys.memTotal >= 0.9 ? 'hot' : ''}`;
    }
    this.procView?.();
  }

  /** True on the second call for the same thing within 3 seconds. */
  private confirmTwice(key: string): boolean {
    const now = performance.now();
    if (this.armed && this.armed.key === key && now < this.armed.until) {
      this.armed = null;
      return true;
    }
    this.armed = { key, until: now + 3000 };
    return false;
  }

  /** Emergency stop for one tab: everything it started is ended, the shell comes back. */
  async killTab(tab: Tab): Promise<void> {
    const name = this.displayName(tab);
    const hadCli = tab.cliRunning !== 'none';
    const n = await tab.killEverything();
    toast(n
      ? `Stopped ${n} process${n === 1 ? '' : 'es'} in "${name}".${hadCli ? ' The conversation can be resumed.' : ''}`
      : `Nothing was running in "${name}".`);
    void this.poll();
  }

  async setLowPriority(tab: Tab, low: boolean): Promise<void> {
    await tab.setLowPriority(low);
    toast(low
      ? `"${this.displayName(tab)}" now runs at low priority: it keeps working, on processor time nothing else wants.`
      : `"${this.displayName(tab)}" is back at normal priority.`);
    this.renderUsage();
  }

  /** The list of what a tab is running, updated live, with the controls to stop it. */
  showProcesses(tab: Tab): void {
    if (isModalOpen()) return;
    const summary = h('p', { class: 'proc-sum' });
    const list = h('div', { class: 'proc-list' });
    const empty = h('div', { class: 'proc-empty' }, 'Nothing is running in this tab.');
    const rows = new Map<number, { root: HTMLDivElement; cpu: HTMLSpanElement; mem: HTMLSpanElement }>();
    const paint = () => {
      const cores = this.system?.cores ?? 0;
      summary.textContent = `${tab.procs.length} process${tab.procs.length === 1 ? '' : 'es'}  ·  CPU ${fmtCpu(tab.cpu)} of the whole PC${cores ? ` (${cores} cores, so one busy core is ${fmtCpu(100 / cores)})` : ''}  ·  RAM ${fmtMem(tab.mem)}${tab.lowPriority ? '  ·  low priority' : ''}`;
      const alive = new Set(tab.procs.map((p) => p.pid));
      for (const [pid, r] of rows) {
        if (!alive.has(pid)) {
          r.root.remove();
          rows.delete(pid);
        }
      }
      for (const p of tab.procs) {
        let r = rows.get(p.pid);
        if (!r) {
          const cpu = h('span', { class: 'num' });
          const mem = h('span', { class: 'num' });
          const root = h('div', { class: 'proc-row' },
            h('span', { class: 'pn', title: p.name }, p.name),
            h('span', { class: 'num dim' }, String(p.pid)),
            cpu,
            mem,
            h('button', {
              class: 'btn small ghost danger',
              title: 'End just this process',
              onclick: async () => {
                if (tab.procId) await api.procKill(tab.procId, p.pid).catch(() => false);
                void this.poll();
              },
            }, 'End'),
          );
          r = { root, cpu, mem };
          rows.set(p.pid, r);
          list.append(root);
        }
        r.cpu.textContent = fmtCpu(p.cpu);
        r.cpu.className = `num ${p.cpu >= 60 ? 'hot' : p.cpu >= 25 ? 'warm' : ''}`;
        r.mem.textContent = fmtMem(p.mem);
      }
      // Heaviest first — but never reshuffle under the mouse, or "End" moves away
      // from the pointer just as it is clicked.
      if (!list.matches(':hover')) for (const p of tab.procs) list.append(rows.get(p.pid)!.root);
      empty.hidden = tab.procs.length > 0;
    };
    paint();
    this.procView = paint;
    const body = h('div', { class: 'body' },
      summary,
      h('div', { class: 'proc-row head' }, h('span', null, 'Process'), h('span', { class: 'num' }, 'PID'), h('span', { class: 'num' }, 'CPU'), h('span', { class: 'num' }, 'RAM'), h('span')),
      list,
      empty,
      h('p', { class: 'proc-note' },
        tab.state.shell === 'wsl'
          ? 'This is a WSL tab: programs running inside Linux are not visible from Windows, so only the WSL launcher shows here.'
          : 'Kill everything ends all of these at once, including programs whose starter has already quit, then gives you the shell back in the same folder. Low priority lets the work go on without it dragging the PC down (it does not free memory).'),
    );
    modal(`Processes — ${this.displayName(tab)}`, body, [
      { label: 'Kill everything', kind: 'danger', onClick: () => void this.killTab(tab) },
      { label: tab.lowPriority ? 'Back to normal priority' : 'Low priority', onClick: () => void this.setLowPriority(tab, !tab.lowPriority) },
      { label: 'Close' },
    ], () => {
      this.procView = null;
      this.focusActive();
    });
  }

  // ---------- CLI updates ----------

  private renderUpdatesButton(): void {
    const btn = document.getElementById('btn-updates')!;
    const n = this.versions?.filter((v) => v.updateAvailable).length ?? 0;
    btn.textContent = this.updating.size ? 'Updating…' : n ? `Updates · ${n}` : 'Updates';
    btn.classList.toggle('has', n > 0 && !this.updating.size);
    this.updatesView?.();
  }

  /** Looks up installed and latest versions. Installs nothing. */
  async checkUpdates(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    this.renderUpdatesButton();
    try {
      this.versions = await api.cliVersions();
    } catch {
      /* offline or a CLI did not answer: keep what was known */
    } finally {
      this.checking = false;
      this.renderUpdatesButton();
    }
  }

  /** Tabs of this app that have the CLI running on Windows (WSL has its own installs). */
  private tabsRunning(cli: RealCli): Tab[] {
    return this.tabs.filter((t) => t.cliRunning === cli && t.state.shell !== 'wsl' && !t.exited);
  }

  private async startupUpdates(auto: boolean): Promise<void> {
    await this.checkUpdates();
    const waiting = (this.versions ?? []).filter((v) => v.updateAvailable);
    if (!waiting.length) return;
    const list = waiting.map((v) => `${CLI_NAME[v.cli]} ${v.latest ?? ''}`.trim()).join(', ');
    if (!auto) {
      toast(`Update available: ${list}. Open "Updates" (bottom left) to install.`, 'info', 7000);
      return;
    }
    for (const v of waiting) {
      if (v.cli === 'codex' && (await this.codexRunningOutside()) > 0) {
        toast('Codex has an update, but Codex is running in another terminal window, so it was not touched. Close it there and use "Updates".', 'error', 5000);
        continue;
      }
      toast(`Updating ${CLI_NAME[v.cli]} to ${v.latest ?? 'the latest version'}…`, 'info', 5000);
      const res = await this.updateCli(v.cli, { stop: false });
      this.reportUpdate(v.cli, res, v.installed);
    }
  }

  private reportUpdate(cli: RealCli, res: UpdateResult | null, before: string | null): void {
    if (!res) return;
    const now = this.versions?.find((v) => v.cli === cli)?.installed ?? null;
    if (!res.ok) toast(`${CLI_NAME[cli]} could not be updated. Open "Updates" to see what its updater said.`, 'error', 5000);
    else if (now && before && now !== before) toast(`${CLI_NAME[cli]} updated: ${before} → ${now}`, 'info', 6000);
    else toast(`${CLI_NAME[cli]}: its updater finished; version is ${now ?? 'unknown'}.`, 'info', 5000);
  }

  /**
   * Runs the CLI's own updater. With `stop`, sessions of that CLI open in this app are
   * closed first and resumed afterwards (also when the update fails).
   */
  async updateCli(cli: RealCli, opts: { stop: boolean }): Promise<UpdateResult | null> {
    if (this.updating.has(cli)) return null;
    this.updating.add(cli);
    this.renderUpdatesButton();
    const stopped: Tab[] = [];
    try {
      if (opts.stop) {
        for (const t of this.tabsRunning(cli)) if (await t.stopCli()) stopped.push(t);
        // Wait until the app has seen each of them close (that also arms their Resume).
        for (let i = 0; i < 25 && stopped.some((t) => t.cliRunning === cli); i++) {
          await sleep(400);
          await this.poll();
        }
        if (stopped.length) await sleep(600);
      }
      const res = await api.cliUpdate(cli);
      this.lastUpdate[cli] = res;
      try {
        this.versions = await api.cliVersions();
      } catch {
        /* keep the previous reading */
      }
      return res;
    } catch (e) {
      const res: UpdateResult = { cli, ok: false, code: null, timedOut: false, output: String(e), command: '' };
      this.lastUpdate[cli] = res;
      return res;
    } finally {
      this.updating.delete(cli);
      for (const t of stopped) if (t.resumePending) this.resumeTab(t);
      // With automatic resume on, sessions that were held back for this update start now.
      // (As at startup, a tab you have started typing in is left alone: its line is
      // not cleared to type the resume command over it.)
      if (this.state.resumeMode === 'auto' && !this.startingUp) void this.resumeAll((t) => t.state.cli === cli && t.state.shell !== 'wsl', true);
      this.renderUpdatesButton();
    }
  }

  /**
   * Codex processes on the PC that do not belong to a tab of this app. Codex is replaced
   * through npm, which cannot overwrite a program that is running — and a copy running
   * in some other terminal window is one this app cannot close.
   */
  private async codexRunningOutside(): Promise<number> {
    const all = (await api.cliProcesses().catch(() => ({}) as Record<string, number>)).codex ?? 0;
    const mine = this.tabs.reduce((n, t) => n + t.procs.filter((p) => /^codex(-.*)?(\.exe)?$/.test(p.name)).length, 0);
    return Math.max(0, all - mine);
  }

  /** "Update" pressed for one CLI: sorts out open sessions first, then updates. */
  private async requestUpdate(cli: RealCli): Promise<void> {
    if (this.updating.has(cli)) return;
    const before = this.versions?.find((v) => v.cli === cli)?.installed ?? null;
    const open = this.tabsRunning(cli);
    let stop = false;
    if (open.length) {
      const choice = await this.askAboutOpenSessions(cli, open);
      if (!choice) return;
      stop = choice === 'stop';
    }
    if (cli === 'codex') {
      const outside = await this.codexRunningOutside();
      if (outside > 0) {
        const ok = await confirmDialog(
          'Codex is running outside TermDeck',
          `Codex is also running in other terminal windows (${outside} process${outside === 1 ? '' : 'es'}). It cannot be replaced while it is running, and trying can leave it half installed. Close Codex in those windows first.`,
          'Try anyway',
        );
        if (!ok) return;
      }
    }
    const res = await this.updateCli(cli, { stop });
    this.reportUpdate(cli, res, before);
  }

  private askAboutOpenSessions(cli: RealCli, open: Tab[]): Promise<'stop' | 'keep' | null> {
    return new Promise((resolve) => {
      let answer: 'stop' | 'keep' | null = null;
      const working = open.filter((t) => t.activity === 'working').length;
      const background = open.filter((t) => t.activity !== 'working' && t.background).length;
      const n = open.length;
      const body = h('div', { class: 'body' },
        h('p', null, `${CLI_NAME[cli]} is open in ${n} tab${n === 1 ? '' : 's'}: ${open.map((t) => `"${this.displayName(t)}"`).join(', ')}.`),
        h('p', null, cli === 'codex'
          ? 'Codex cannot be replaced while it is running. Its sessions will be closed, Codex updated, and each conversation resumed on the new version.'
          : `${CLI_NAME[cli]} can be updated while it runs, but open sessions stay on the old version until they are restarted.`),
        working ? h('p', { class: 'warn' }, `${working} of them ${working === 1 ? 'is' : 'are'} in the middle of work. Closing interrupts that work; the conversation itself is kept.`) : null,
        background ? h('p', { class: 'warn' }, `${background} of them ${background === 1 ? 'has' : 'have'} a background command still running (a test run, a server). Closing ends it.`) : null,
      );
      modal(`Update ${CLI_NAME[cli]}`, body, [
        { label: 'Cancel' },
        ...(cli === 'codex' ? [] : [{ label: 'Update, leave them running', onClick: () => { answer = 'keep'; } }]),
        { label: 'Close, update, resume', kind: 'primary' as const, onClick: () => { answer = 'stop'; } },
      ], () => resolve(answer));
    });
  }

  /** The Updates panel: versions, Update buttons, and what to do at startup. */
  showUpdates(): void {
    if (isModalOpen()) return;
    const list = h('div', { class: 'upd-list' });
    const paint = () => {
      const rows: HTMLElement[] = [];
      if (!this.versions) rows.push(h('div', { class: 'upd-wait' }, this.checking ? 'Checking versions…' : 'Not checked yet.'));
      for (const v of this.versions ?? []) {
        const busy = this.updating.has(v.cli);
        const open = this.tabsRunning(v.cli).length;
        const last = this.lastUpdate[v.cli];
        const state = !v.installed ? 'not installed'
          : busy ? 'updating…'
          : v.updateAvailable ? `${v.latest} available`
          : v.latest ? 'up to date'
          : 'latest version unknown';
        rows.push(h('div', { class: `upd-row ${v.updateAvailable ? 'avail' : ''}`, 'data-cli': v.cli },
          h('span', { class: `cli cli-${v.cli} upd-name` }, CLI_NAME[v.cli]),
          h('span', { class: 'upd-ver' }, v.installed ?? '—'),
          h('span', { class: 'upd-state' }, state, open ? ` · open in ${open} tab${open === 1 ? '' : 's'}` : ''),
          h('button', {
            class: `btn small ${v.updateAvailable ? 'primary' : ''}`,
            disabled: busy || !v.installed,
            title: `Runs: ${v.command}`,
            onclick: () => void this.requestUpdate(v.cli),
          }, busy ? 'Updating…' : v.updateAvailable ? 'Update' : 'Update anyway'),
        ));
        if (v.note) rows.push(h('div', { class: 'upd-note' }, v.note));
        if (last) {
          rows.push(h('details', { class: `upd-log ${last.ok ? '' : 'bad'}`, open: !last.ok },
            h('summary', null, last.ok ? `Last run of "${last.command}" finished without error` : last.timedOut ? `"${last.command}" did not finish in 15 minutes and was stopped` : `"${last.command}" failed${last.code !== null ? ` (exit code ${last.code})` : ''}`),
            h('pre', null, last.output || '(it printed nothing)'),
          ));
        }
      }
      list.replaceChildren(...rows);
    };
    const mode = h('select', {
      onchange: () => {
        this.state.updateMode = mode.value as UpdateMode;
        this.scheduleSave();
      },
    },
      h('option', { value: 'off', selected: this.state.updateMode === 'off' }, 'Do nothing'),
      h('option', { value: 'check', selected: this.state.updateMode === 'check' }, 'Check, and tell me if there is an update'),
      h('option', { value: 'auto', selected: this.state.updateMode === 'auto' }, 'Update automatically'),
    );
    const resumeMode = h('select', {
      onchange: () => {
        this.state.resumeMode = resumeMode.value as 'manual' | 'auto';
        this.scheduleSave();
      },
    },
      h('option', { value: 'manual', selected: this.state.resumeMode !== 'auto' }, 'Wait for me — Resume on each tab, or Resume all'),
      h('option', { value: 'auto', selected: this.state.resumeMode === 'auto' }, 'Resume all of them automatically'),
    );
    const body = h('div', { class: 'body' },
      list,
      h('div', { class: 'field' }, h('label', null, 'When TermDeck starts — updates'), mode),
      h('div', { class: 'field' }, h('label', null, 'When TermDeck starts — sessions that were open'), resumeMode),
      h('p', { class: 'proc-note' }, 'Automatic resume always waits for the update step. With updates on "automatic", updates are installed first and then everything resumes. With "check and tell me", sessions of a CLI that has an update waiting are left for you, so the update is not blocked; the rest resume.'),
      h('p', { class: 'proc-note' }, 'Update runs each CLI\'s own update command, exactly as if you typed it. At startup nothing is running yet, so that is when an update can never be blocked by an open session. Claude Code and Grok also update themselves in the background; Codex does not.'),
    );
    this.updatesView = paint;
    paint();
    void this.checkUpdates();
    modal('Updates and startup', body, [
      { label: 'Check again', kind: 'left', onClick: () => { void this.checkUpdates(); return false; } },
      {
        label: 'Update all',
        onClick: () => {
          void (async () => {
            for (const v of (this.versions ?? []).filter((x) => x.updateAvailable)) await this.requestUpdate(v.cli);
          })();
          return false;
        },
      },
      { label: 'Close' },
    ], () => {
      this.updatesView = null;
      this.focusActive();
    });
  }

  // ---------- past sessions ----------

  /**
   * The "switches for this session" part of the New-session and Past-sessions dialogs:
   * a box to type them in, one click for the switch people add most (run without asking
   * for permission), the option to keep them for every session of that CLI, and the
   * command exactly as it will be typed. Without it a session opened from a dialog
   * started at once, with no chance to add a switch first.
   */
  private flagsField(base: () => { cli: CliKind; shell: ShellKind; command: string }): { el: HTMLElement; paint: () => void; take: () => string | undefined } {
    const COMMON: Record<RealCli, string> = {
      claude: '--dangerously-skip-permissions',
      codex: '--dangerously-bypass-approvals-and-sandbox',
      grok: '--always-approve',
    };
    const input = h('input', { class: 'flags-own', spellcheck: false, placeholder: 'none — e.g. --dangerously-skip-permissions', oninput: () => paint() });
    const quick = h('button', { class: 'btn small ghost flags-quick', title: 'Adds the switch that lets this CLI work without asking for permission each time' });
    const always = h('input', { type: 'checkbox', class: 'flags-always' });
    const alwaysText = h('span');
    const usual = h('p', { class: 'proc-note' });
    const preview = h('code', { class: 'flag-preview' });
    const label = h('label', null, 'Switches for this session');
    const el = h('div', { class: 'field flags-field' },
      label,
      h('div', { class: 'row' }, input, quick),
      usual,
      h('label', { class: 'flags-always-row' }, always, alwaysText),
      h('label', null, 'It will be started with'),
      preview,
    );
    let shownFor: CliKind = 'none';
    const paint = () => {
      const { cli, shell, command } = base();
      el.hidden = cli === 'none';
      if (cli === 'none') return;
      if (cli !== shownFor) {
        // Switches belong to one CLI: what was typed for another is not carried over.
        if (shownFor !== 'none') input.value = '';
        always.checked = false;
        shownFor = cli;
      }
      const defaults = this.defaultFlags(cli);
      const words = flagWords(mergeFlags(defaults, input.value)).map(flagValue);
      quick.textContent = `+ ${COMMON[cli]}`;
      quick.hidden = words.includes(COMMON[cli]);
      quick.onclick = () => {
        input.value = `${input.value.trim()} ${COMMON[cli]}`.trim();
        paint();
      };
      usual.textContent = defaults ? `Every ${CLI_NAME[cli]} session already gets: ${defaults}` : '';
      usual.hidden = !defaults;
      alwaysText.textContent = `Use these for every ${CLI_NAME[cli]} session from now on`;
      const flags = shellFlags(mergeFlags(defaults, input.value), shell);
      preview.textContent = `${command}${flags ? ` ${flags}` : ''}`;
    };
    /** Called when the session is opened: what to give the new tab as its own switches. */
    const take = (): string | undefined => {
      const { cli } = base();
      const typed = input.value.trim();
      if (cli === 'none' || !typed) return undefined;
      if (always.checked) {
        // Kept for every session of this CLI; the tab then needs none of its own.
        this.state.cliFlags[cli] = mergeFlags(this.defaultFlags(cli), typed);
        this.scheduleSave();
        return undefined;
      }
      return typed;
    };
    return { el, paint, take };
  }

  /** A list of past conversations, read from the CLIs' own session folders, to reopen one. */
  showSessions(): void {
    if (isModalOpen()) return;
    const cur = this.activeTab;
    let cli: RealCli = cur && cur.state.cli !== 'none' ? cur.state.cli : this.lastPickerCli;
    const folder = cur && cur.state.shell !== 'wsl' ? cur.state.cwd : '';
    let all: SessionInfo[] = [];
    let chosen = '';
    let loading = false;
    let seq = 0;
    const search = h('input', { class: 'ses-search', placeholder: 'Search what was said, folders, ids', spellcheck: false, oninput: () => paint() });
    const here = h('input', { type: 'checkbox', disabled: !folder, onchange: () => void load() });
    const cliRow = h('div', { class: 'choices' });
    const list = h('div', { class: 'ses-list' });
    const count = h('span', { class: 'proc-note' });
    const matching = () => {
      const q = search.value.trim().toLowerCase();
      return q ? all.filter((s) => `${s.title} ${s.cwd} ${s.id}`.toLowerCase().includes(q)) : all;
    };
    const openShell = (): ShellKind => (this.state.lastShell === 'wsl' ? 'powershell' : this.state.lastShell);
    const switches = this.flagsField(() => ({
      cli,
      shell: openShell(),
      command: chosen && /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(chosen)
        ? { claude: `claude --resume ${chosen}`, codex: `codex resume ${chosen}`, grok: `grok --resume ${chosen}` }[cli]
        : cli,
    }));
    const mark = () => {
      for (const el of Array.from(list.children) as HTMLElement[]) el.classList.toggle('on', !!chosen && el.dataset.id === chosen);
      switches.paint();
    };
    const paint = () => {
      cliRow.replaceChildren(...(['claude', 'codex', 'grok'] as RealCli[]).map((c) =>
        h('button', { class: `choice ${c === cli ? 'on' : ''}`, 'data-cli': c, onclick: () => { cli = c; void load(); } }, CLI_NAME[c])));
      const rows = matching();
      if (!rows.some((s) => s.id === chosen)) chosen = rows[0]?.id ?? '';
      if (loading) list.replaceChildren(h('div', { class: 'upd-wait' }, 'Reading the session folder…'));
      else if (!rows.length) list.replaceChildren(h('div', { class: 'upd-wait' }, all.length ? 'Nothing matches the search.' : 'No saved conversations found.'));
      else {
        list.replaceChildren(...rows.map((s) => {
          const open = this.tabs.some((t) => t.state.cli === s.cli && t.state.sessionId === s.id);
          return h('div', {
            class: 'ses-row',
            'data-id': s.id,
            title: `${s.title}\n${s.cwd}\n${s.id}`,
            onclick: () => { chosen = s.id; mark(); },
            ondblclick: () => void pick(s),
          },
            h('div', { class: `ses-title ${s.title ? '' : 'none'}` }, s.title || '(nothing said yet)'),
            h('div', { class: 'ses-sub' }, `${s.cwd || 'folder unknown'}  ·  ${fmtAgo(s.modified)}  ·  ${fmtSize(s.size)}`, open ? h('span', { class: 'ses-open' }, 'open in a tab') : null),
          );
        }));
        mark();
      }
      count.textContent = loading ? '' : `${rows.length} of ${all.length} shown — newest first`;
      switches.paint();
    };
    const load = async () => {
      const mine = ++seq;
      this.lastPickerCli = cli;
      loading = true;
      paint();
      try {
        const got = await api.sessionsList(cli, here.checked && folder ? folder : null, 300);
        if (mine !== seq) return;
        all = got;
      } catch (e) {
        if (mine !== seq) return;
        all = [];
        toast(`Could not read the sessions: ${String(e)}`, 'error');
      }
      loading = false;
      paint();
    };
    const pick = async (s: SessionInfo) => {
      chosen = s.id;
      if (await this.openSession(s, switches.take)) close();
    };
    const body = h('div', { class: 'body wide' },
      h('div', { class: 'ses-top' }, cliRow, search),
      h('label', { class: 'ses-here' }, here, h('span', null, folder ? `Only conversations held in ${folder}` : 'Only this folder (the focused tab has none)')),
      list,
      count,
      switches.el,
      h('p', { class: 'proc-note' }, 'This is the CLI\'s own list of conversations, read from its session folder — nothing is copied or changed. Opening one makes a new tab in that conversation\'s folder and resumes it there, with your usual switches.'),
    );
    const close = modal('Past sessions', body, [
      { label: 'Cancel' },
      {
        label: 'Open in a new tab',
        kind: 'primary',
        onClick: async () => {
          const s = all.find((x) => x.id === chosen);
          return s ? this.openSession(s, switches.take) : false;
        },
      },
    ], () => this.focusActive());
    void load();
  }

  /** Opens a past conversation in a new tab (or shows the tab it is already in). */
  async openSession(s: SessionInfo, flags?: () => string | undefined): Promise<boolean> {
    const existing = this.tabs.find((t) => t.state.cli === s.cli && t.state.sessionId === s.id);
    if (existing) {
      this.showTab(existing);
      toast(`That conversation is already in the tab "${this.displayName(existing)}".`);
      return true;
    }
    if (!s.cwd || !(await api.dirExists(s.cwd).catch(() => false))) {
      toast(s.cwd ? `Its folder no longer exists: ${s.cwd}` : 'The folder of that conversation could not be read, so it cannot be reopened from here.', 'error');
      return false;
    }
    const shell = this.state.lastShell === 'wsl' ? 'powershell' : this.state.lastShell;
    // Read only now, when the tab is really going to be made.
    void this.createTab({ shell, cwd: s.cwd, cli: s.cli, sessionId: s.id, flags: flags?.() });
    return true;
  }

  // ---------- settings ----------

  showSettings(): void {
    if (isModalOpen()) return;
    const set = this.state.settings;
    const font = h('input', { value: set.fontFamily, spellcheck: false, list: 'font-names', placeholder: 'Cascadia Mono (comes with TermDeck)' });
    const fonts = h('datalist', { id: 'font-names' }, ...['Cascadia Code', 'Consolas', 'JetBrains Mono', 'Fira Code', 'Source Code Pro', 'Lucida Console', 'Courier New'].map((f) => h('option', { value: f })));
    const size = h('input', { type: 'number', min: String(MIN_FONT), max: String(MAX_FONT), value: String(this.state.fontSize) });
    const theme = h('select', null, ...(Object.keys(THEMES) as ThemeName[]).map((t) => h('option', { value: t, selected: t === set.theme }, THEME_LABEL[t])));
    const scroll = h('input', { type: 'number', min: '1000', max: '200000', step: '1000', value: String(set.scrollback) });
    const flash = h('input', { type: 'checkbox', checked: set.notifyFlash });
    const sound = h('select', null,
      h('option', { value: 'off', selected: set.notifySound === 'off' }, 'No sound'),
      h('option', { value: 'needs', selected: set.notifySound === 'needs' }, 'Only when a session needs me'),
      h('option', { value: 'both', selected: set.notifySound === 'both' }, 'When a session needs me, and when one finishes'),
    );
    const cpu = h('input', { type: 'number', min: '5', max: '100', value: String(set.hotCpu) });
    const mem = h('input', { type: 'number', min: '5', max: '95', value: String(set.hotMem) });
    const layout = h('select', null,
      h('option', { value: 'auto', selected: set.paneLayout === 'auto' }, 'Automatic — side by side, stacked when the window is taller than wide'),
      h('option', { value: 'side', selected: set.paneLayout === 'side' }, 'Always side by side'),
      h('option', { value: 'stack', selected: set.paneLayout === 'stack' }, 'Always one above the other'),
    );
    const update = h('select', null,
      h('option', { value: 'off', selected: this.state.updateMode === 'off' }, 'Do nothing'),
      h('option', { value: 'check', selected: this.state.updateMode === 'check' }, 'Check, and tell me if there is an update'),
      h('option', { value: 'auto', selected: this.state.updateMode === 'auto' }, 'Update automatically'),
    );
    const resume = h('select', null,
      h('option', { value: 'manual', selected: this.state.resumeMode !== 'auto' }, 'Wait for me — Resume on each tab, or Resume all'),
      h('option', { value: 'auto', selected: this.state.resumeMode === 'auto' }, 'Resume all of them automatically'),
    );
    const flags: Record<RealCli, HTMLInputElement> = {
      claude: h('input', { value: this.state.cliFlags.claude, spellcheck: false, placeholder: 'none — e.g. --dangerously-skip-permissions' }),
      codex: h('input', { value: this.state.cliFlags.codex, spellcheck: false, placeholder: 'none' }),
      grok: h('input', { value: this.state.cliFlags.grok, spellcheck: false, placeholder: 'none' }),
    };
    const dataPath = h('div', { class: 'set-path' }, '…');
    void api.dataDir().then((d) => (dataPath.textContent = d)).catch(() => {});
    const body = h('div', { class: 'body', id: 'settings' },
      h('h3', { class: 'set-h' }, 'Text'),
      h('div', { class: 'set-grid' },
        h('div', { class: 'field' }, h('label', null, 'Font (must be installed on this PC; leave empty for the built-in one)'), font, fonts),
        h('div', { class: 'field' }, h('label', null, `Size (${MIN_FONT}–${MAX_FONT}; also Ctrl + / Ctrl −)`), size),
        h('div', { class: 'field' }, h('label', null, 'Colours'), theme),
        h('div', { class: 'field' }, h('label', null, 'History kept per tab, in lines'), scroll),
        h('div', { class: 'field' }, h('label', null, 'Two or three panes are shown'), layout),
      ),
      h('p', { class: 'proc-note' }, 'History costs memory in every tab: roughly 10–20 MB per 10,000 lines of a wide terminal once it has filled up. The conversation itself is never lost by a short history — "History" on a tab reads it from the CLI\'s own files.'),
      h('h3', { class: 'set-h' }, 'When a session finishes or needs you'),
      h('div', { class: 'set-grid' },
        h('label', { class: 'set-check' }, flash, h('span', null, 'Flash the taskbar button when TermDeck is not in front')),
        h('div', { class: 'field' }, h('label', null, 'Sound'), h('div', { class: 'row' }, sound, h('button', { class: 'btn', onclick: () => beep('needs') }, 'Test'))),
      ),
      h('h3', { class: 'set-h' }, 'What counts as a heavy tab (red, with a Kill button)'),
      h('div', { class: 'set-grid' },
        h('div', { class: 'field' }, h('label', null, 'Processor: percent of the whole PC'), cpu),
        h('div', { class: 'field' }, h('label', null, 'Memory: percent of the whole PC'), mem),
      ),
      h('h3', { class: 'set-h' }, 'When TermDeck starts'),
      h('div', { class: 'set-grid' },
        h('div', { class: 'field' }, h('label', null, 'Updates of the CLIs'), update),
        h('div', { class: 'field' }, h('label', null, 'Sessions that were open'), resume),
      ),
      h('h3', { class: 'set-h' }, 'Switches added to every session the app starts or resumes'),
      h('div', { class: 'set-grid' },
        h('div', { class: 'field span2' }, h('label', null, 'Claude Code'), flags.claude),
        h('div', { class: 'field' }, h('label', null, 'Codex'), flags.codex),
        h('div', { class: 'field' }, h('label', null, 'Grok'), flags.grok),
      ),
      h('h3', { class: 'set-h' }, 'Where TermDeck keeps its own files'),
      dataPath,
    );
    const fill = (v: Settings) => {
      font.value = v.fontFamily;
      theme.value = v.theme;
      scroll.value = String(v.scrollback);
      flash.checked = v.notifyFlash;
      sound.value = v.notifySound;
      cpu.value = String(v.hotCpu);
      mem.value = String(v.hotMem);
      layout.value = v.paneLayout;
    };
    modal('Settings', body, [
      {
        label: 'Back to defaults',
        kind: 'left',
        onClick: () => {
          fill(DEFAULT_SETTINGS);
          size.value = String(DEFAULT_FONT);
          return false; // shown, not saved until Save
        },
      },
      { label: 'Cancel' },
      {
        label: 'Save',
        kind: 'primary',
        onClick: () => {
          this.state.settings = cleanSettings({
            fontFamily: font.value,
            scrollback: scroll.value as unknown as number,
            theme: theme.value as ThemeName,
            notifyFlash: flash.checked,
            notifySound: sound.value as Settings['notifySound'],
            hotCpu: cpu.value as unknown as number,
            hotMem: mem.value as unknown as number,
            paneLayout: layout.value as Settings['paneLayout'],
          });
          this.state.updateMode = update.value as UpdateMode;
          this.state.resumeMode = resume.value as 'manual' | 'auto';
          for (const k of ['claude', 'codex', 'grok'] as RealCli[]) this.state.cliFlags[k] = flags[k].value.trim();
          this.applyLook();
          this.applyPaneDirection();
          if (Number.isFinite(Number(size.value)) && size.value !== '') this.setFontSize(Number(size.value));
          for (const t of this.tabs) this.renderTab(t);
          this.renderUsage();
          this.scheduleSave();
        },
      },
    ], () => this.focusActive());
  }

  // ---------- snippets, paste, drop ----------

  private sendSnippet(s: Snippet): void {
    const tab = this.activeTab;
    if (!tab || tab.exited) {
      toast('Open a session first.', 'error');
      return;
    }
    if (s.mode === 'submit') tab.submit(s.text);
    else tab.insert(s.text);
    tab.focus();
  }

  private paneAt(x: number, y: number): number {
    const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest('.pane');
    return this.panes.findIndex((p) => p.root === el);
  }

  private onDragDrop(payload: { type: string; paths?: string[]; position?: { x: number; y: number } }): void {
    for (const p of this.panes) p.root.classList.remove('drop-target');
    if (payload.type === 'leave' || !payload.position) return;
    const scale = window.devicePixelRatio || 1;
    let i = this.paneAt(payload.position.x / scale, payload.position.y / scale);
    if (i < 0) i = this.state.activePane;
    if (payload.type === 'drop') this.dropFiles(payload.paths ?? [], i);
    else this.panes[i]?.root.classList.add('drop-target');
  }

  /** Inserts dropped file paths into a pane's input. */
  dropFiles(paths: string[], pane = this.state.activePane): void {
    const tab = this.tabInPane(pane);
    if (!tab || tab.exited || !paths.length) return;
    this.setActivePane(pane);
    tab.insertPaths(paths);
    tab.focus();
  }

  // ---------- zoom, layout ----------

  setFontSize(px: number): void {
    px = clamp(Math.round(px), MIN_FONT, MAX_FONT);
    if (px === this.state.fontSize) return;
    this.state.fontSize = px;
    for (const t of this.tabs) t.setFontSize(px);
    document.getElementById('zoom-val')!.textContent = String(px);
    for (const t of this.tabs) if (t.isShown) this.renderTab(t);
    this.scheduleSave();
  }

  private applyLayoutVars(): void {
    this.appEl.style.setProperty('--sb-w', `${this.state.sidebarWidth}px`);
    this.appEl.style.setProperty('--lib-w', `${this.state.libraryWidth}px`);
    this.appEl.classList.toggle('lib-closed', !this.state.libraryOpen);
  }

  toggleLibrary(open = !this.state.libraryOpen): void {
    this.state.libraryOpen = open;
    this.applyLayoutVars();
    this.library.renderBar();
    this.scheduleSave();
  }

  private bindHandle(el: HTMLElement, side: 'left' | 'right'): void {
    el.addEventListener('pointerdown', (down) => {
      el.setPointerCapture(down.pointerId);
      el.classList.add('dragging');
      const startX = down.clientX;
      const start = side === 'left' ? this.state.sidebarWidth : this.state.libraryWidth;
      const move = (e: PointerEvent) => {
        const delta = e.clientX - startX;
        const max = Math.max(160, window.innerWidth * 0.45);
        if (side === 'left') this.state.sidebarWidth = clamp(start + delta, 120, max);
        else this.state.libraryWidth = clamp(start - delta, 160, max);
        this.applyLayoutVars();
      };
      const up = () => {
        el.classList.remove('dragging');
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        this.scheduleSave();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  }

  // ---------- chrome and keys ----------

  private bindChrome(): void {
    document.getElementById('btn-new')!.addEventListener('click', () => this.newTabDialog());
    document.getElementById('btn-updates')!.addEventListener('click', () => this.showUpdates());
    document.getElementById('btn-settings')!.addEventListener('click', () => this.showSettings());
    document.getElementById('btn-open')!.addEventListener('click', () => this.showSessions());
    document.getElementById('btn-resume-all')!.addEventListener('click', () => void this.resumeAll());
    document.getElementById('zoom-in')!.addEventListener('click', () => this.setFontSize(this.state.fontSize + 1));
    document.getElementById('zoom-out')!.addEventListener('click', () => this.setFontSize(this.state.fontSize - 1));
    document.getElementById('zoom-val')!.addEventListener('dblclick', () => this.setFontSize(DEFAULT_FONT));
    for (const b of document.querySelectorAll<HTMLButtonElement>('#split-seg button')) {
      b.addEventListener('click', () => this.setSplit(Number(b.dataset.n)));
    }
    this.bindHandle(document.getElementById('h-left')!, 'left');
    this.bindHandle(document.getElementById('h-right')!, 'right');

    window.addEventListener('keydown', (e) => this.onKey(e), true);
    window.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      const now = performance.now();
      if (now - this.lastWheelZoom < 40) return;
      this.lastWheelZoom = now;
      this.setFontSize(this.state.fontSize + (e.deltaY < 0 ? 1 : -1));
    }, { capture: true, passive: false });
    window.addEventListener('contextmenu', (e) => {
      if (!(e.target as HTMLElement).closest('input, textarea, .history-scroll')) e.preventDefault();
    });
    window.addEventListener('focus', () => this.activeTab?.markSeen());
  }

  private onKey(e: KeyboardEvent): void {
    const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
    const key = e.key.toLowerCase();
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const inTerminal = !!(e.target as HTMLElement | null)?.closest?.('.xterm');

    // Ctrl+Shift+R is the browser engine's "reload the page". The terminal has no use
    // for the key and so would let it through — and a reload ends every session. It is
    // stopped here, everywhere; the key still reaches whatever has the keyboard.
    if (ctrl && e.shiftKey && key === 'r') e.preventDefault();

    if (isModalOpen()) {
      if (ctrl && 'rfgpsoujnhd'.includes(key) && key.length === 1) e.preventDefault();
      if (e.key === 'F5') e.preventDefault();
      return;
    }
    if (ctrl && (e.key === '=' || e.key === '+')) return handled(), this.setFontSize(this.state.fontSize + 1);
    if (ctrl && !e.shiftKey && e.key === '-') return handled(), this.setFontSize(this.state.fontSize - 1);
    if (ctrl && !e.shiftKey && e.key === '0') return handled(), this.setFontSize(DEFAULT_FONT);
    if (ctrl && e.shiftKey && key === 't') return handled(), this.newTabDialog();
    if (ctrl && e.shiftKey && key === 'w') return handled(), void (this.activeTab && this.closeTab(this.activeTab));
    if (ctrl && e.shiftKey && key === 'p') {
      handled();
      this.toggleLibrary(true);
      this.library.focusSearch();
      return;
    }
    if (ctrl && e.shiftKey && key === 'h') return handled(), this.toggleHistory(this.state.activePane);
    if (ctrl && e.shiftKey && key === 'o') return handled(), this.showSessions();
    // Emergency stop for the focused tab. Twice within 3 seconds, so it cannot happen by a slip.
    if (ctrl && e.shiftKey && key === 'k') {
      handled();
      const t = this.activeTab;
      if (!t) return;
      if (this.confirmTwice(`kill:${t.state.id}`)) void this.killTab(t);
      else toast(`Press Ctrl+Shift+K again to stop everything in "${this.displayName(t)}".`, 'error', 1500);
      return;
    }
    if (ctrl && e.key === 'Tab') {
      handled();
      if (!this.tabs.length) return;
      const cur = this.activeTab ? this.tabs.indexOf(this.activeTab) : -1;
      const next = (cur + (e.shiftKey ? -1 : 1) + this.tabs.length) % this.tabs.length;
      this.showTab(this.tabs[next]);
      return;
    }
    // Ctrl+Alt+1..9 (as in Windows Terminal). Plain Ctrl+digit is left for the CLI.
    if (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && /^Digit[1-9]$/.test(e.code)) {
      const t = this.tabs[Number(e.code.slice(5)) - 1];
      handled();
      if (t) this.showTab(t);
      return;
    }
    // Outside a terminal, stop the browser engine's own reload / find / print keys.
    if (!inTerminal) {
      if (e.key === 'F5' || e.key === 'F3' || e.key === 'F7') e.preventDefault();
      if (ctrl && key.length === 1 && 'rfgpsoujnhd'.includes(key)) e.preventDefault();
    }
  }

  // ---------- new session dialog ----------

  newTabDialog(): void {
    if (isModalOpen()) return;
    const current = this.activeTab;
    let shell: ShellKind = this.state.lastShell;
    let cli: CliKind = 'none';
    const shells: ShellKind[] = ['powershell', ...(this.env.hasPwsh ? ['pwsh' as const] : []), 'cmd', ...(this.env.hasGitBash ? ['gitbash' as const] : []), ...(this.env.wslDistros.length ? ['wsl' as const] : [])];
    if (!shells.includes(shell)) shell = 'powershell';

    const dir = h('input', {
      value: current && current.state.shell !== 'wsl' ? current.state.cwd : this.state.recentDirs[0] ?? this.env.home,
      spellcheck: false,
      list: 'recent-dirs',
      placeholder: 'Folder to open the session in',
    });
    const recents = h('datalist', { id: 'recent-dirs' }, ...this.state.recentDirs.map((d) => h('option', { value: d })));
    const distro = h('select', null, ...this.env.wslDistros.map((d) => h('option', { value: d, selected: d === this.state.lastDistro }, d)));
    const distroField = h('div', { class: 'field' }, h('label', null, 'WSL distro'), distro);
    const name = h('input', { placeholder: 'Optional — defaults to the folder name', spellcheck: false });
    const dirHint = h('label', null, 'Folder');

    const shellRow = h('div', { class: 'choices' });
    const cliRow = h('div', { class: 'choices' });
    const switches = this.flagsField(() => ({ cli, shell, command: cli }));
    const paint = () => {
      shellRow.replaceChildren(...shells.map((s) => h('button', { class: `choice ${s === shell ? 'on' : ''}`, onclick: () => { shell = s; paint(); } }, SHELL_LABEL[s])));
      cliRow.replaceChildren(...(['none', 'claude', 'codex', 'grok'] as CliKind[]).map((c) =>
        h('button', { class: `choice ${c === cli ? 'on' : ''}`, onclick: () => { cli = c; paint(); } }, c === 'none' ? 'Just the shell' : c)));
      distroField.hidden = shell !== 'wsl';
      dirHint.textContent = shell === 'wsl' ? 'Folder (a Windows path or a Linux path such as ~/project)' : 'Folder';
      switches.paint();
    };
    paint();

    const body = h('div', { class: 'body' },
      h('div', { class: 'field' }, dirHint,
        h('div', { class: 'row' }, dir, h('button', {
          class: 'btn',
          onclick: async () => {
            const picked = await openDialog({ directory: true, defaultPath: dir.value || this.env.home });
            if (typeof picked === 'string') dir.value = picked;
          },
        }, 'Browse…')), recents),
      h('div', { class: 'field' }, h('label', null, 'Shell'), shellRow),
      distroField,
      h('div', { class: 'field' }, h('label', null, 'Start'), cliRow),
      switches.el,
      h('div', { class: 'field' }, h('label', null, 'Tab name'), name),
    );

    modal('New session', body, [
      { label: 'Cancel' },
      {
        label: 'Open',
        kind: 'primary',
        onClick: async () => {
          const cwd = dir.value.trim().replace(/^"|"$/g, '');
          if (shell !== 'wsl' && !(await api.dirExists(cwd))) {
            toast(`That folder does not exist: ${cwd}`, 'error');
            return false;
          }
          void this.createTab({ shell, cwd, cli, name: name.value, wslDistro: shell === 'wsl' ? distro.value : undefined, flags: switches.take() });
          return true;
        },
      },
    ], () => this.focusActive());
  }

  // ---------- saving ----------

  scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = 0;
      void this.saveNow();
    }, 400);
  }

  async saveNow(): Promise<void> {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    if (this.saveBlocked || this.closing) return;
    this.state.tabs = this.tabs.map((t) => t.state);
    // Written only when something in it has changed. Much of what asks for a save
    // changes nothing that is saved — above all a CLI turning the little spinner in its
    // window title while it works, about once a second. Measured 2026-11-12: 35
    // identical writes of state.json (each one flushed to disk) in 33 seconds of work.
    const text = JSON.stringify(this.state);
    if (text === this.savedText) return;
    try {
      await api.storeSave('state', this.state);
      this.savedText = text;
    } catch (e) {
      toast(`Could not save sessions: ${String(e)}`, 'error');
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** CLIs put a spinner or marker glyph in front of the window title; drop it. */
function cleanTitle(title: string, boring: string[] = []): string {
  const t = title.replace(/^[^\p{L}\p{N}]+/u, '').trim();
  // A bare program name, folder name or exe path says nothing the row doesn't already.
  if (/\\|\.exe$/i.test(t) || boring.some((b) => b.toLowerCase() === t.toLowerCase())) return '';
  return t;
}

const app = new App();
(window as unknown as { __termdeck: unknown }).__termdeck = { app, api, FONT_STACK, extractSwitches, mergeFlags, flagWords, flagValue, quoteArg, shellFlags, quotePath, fromMsysPath, toWslPath };
app.init().catch((e) => {
  document.body.append(h('pre', { style: 'padding:20px;color:#ff9a90;white-space:pre-wrap' }, `TermDeck failed to start:\n${String(e)}\n${(e as Error)?.stack ?? ''}`));
});
