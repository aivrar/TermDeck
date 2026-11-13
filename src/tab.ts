import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { api, Channel, type CliKind, type Ended, type EnvInfo, type ProcUsage, type PtyEvent, type ShellKind, type TabStatus } from './api';
import { toast } from './ui';

export type Activity = 'idle' | 'working' | 'attention' | 'done' | 'exited';

/** The part of a tab that is saved and restored. */
export interface TabState {
  id: string;
  name: string;
  /** false once the user has renamed the tab by hand */
  autoName: boolean;
  shell: ShellKind;
  wslDistro?: string;
  cwd: string;
  /** CLI this tab is running (or was running when the app closed) */
  cli: CliKind;
  sessionId?: string;
  /** Switches this tab's CLI runs with, re-applied when it is resumed or restarted. */
  flags?: string;
  /** true once the flags were typed in by hand (then they are no longer read from the process). */
  flagsManual?: boolean;
  /**
   * The CLI those hand-typed flags were written for. Switches belong to one CLI: when a
   * different CLI is started in the tab they are let go (see applyStatus), instead of
   * being typed after its resume command, where it would not know them.
   */
  flagsCli?: CliKind;
}

export interface TabHost {
  env: EnvInfo;
  fontSize(): number;
  /** Something visible about the tab changed: redraw its row and header, save. */
  changed(tab: Tab): void;
  pasteInto(tab: Tab): void;
  /** Size to start a terminal at before it has ever been shown. */
  estimateSize(): { cols: number; rows: number };
  /** Looks at the processes again now, instead of waiting for the next regular look. */
  refresh(): Promise<void>;
  /** Switches the user wants on every session of this CLI. */
  defaultFlags(cli: CliKind): string;
  /** Font, colours and history length chosen in Settings. */
  look(): Look;
  /** Something the user should be told about this tab. */
  say(tab: Tab, message: string): void;
}

/**
 * Splits a flags string into words. Blanks separate; a part in "double" or 'single'
 * quotes stays together, also in the middle of a word (--name="a b" is one word).
 * The words are returned as written, quotes included — see `flagValue`.
 */
export function flagWords(text: string): string[] {
  return text.match(/(?:"(?:\\"|[^"])*"?|'[^']*'?|[^\s"'])+/g) ?? [];
}

/**
 * What a word of a flags string stands for — the text the CLI is meant to receive.
 * Quotes are taken off; inside double quotes \" is a quote; nothing else is special.
 */
export function flagValue(word: string): string {
  let out = '';
  for (const m of word.matchAll(/"((?:\\"|[^"])*)"?|'([^']*)'?|([^"']+)/g)) {
    out += m[1] !== undefined ? m[1].replace(/\\"/g, '"') : (m[2] ?? m[3] ?? '');
  }
  return out;
}

/** The reverse: one value written as a word of a flags string. */
function flagWord(value: string): string {
  if (value !== '' && !/[\s"']/.test(value)) return value;
  if (!value.includes('"') && !value.endsWith('\\')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replace(/"/g, '\\"')}"`;
}

/**
 * One value written so that the shell in front of it hands exactly that value to the
 * program — each shell by its own rules, because one way of quoting does not fit all:
 *
 *   PowerShell  single quotes (inside double ones `$name` and back-ticks are expanded).
 *               Also quoted: a word with a dot, comma, semicolon, @ … — unquoted,
 *               PowerShell splits `-Dkey=a.b` at the dot and turns `a,b` into a list.
 *               Windows PowerShell 5.1 hands quotes inside a value on unescaped, so
 *               they are escaped here the way Windows programs read them.
 *   cmd         double quotes, with \" for a quote. (%NAME% is still expanded by cmd
 *               even inside quotes; there is no way to switch that off on a typed line.)
 *   bash        single quotes; a Windows path would otherwise lose its backslashes.
 *
 * The result is always one word to the shell, whatever the value holds — a value is
 * never read as a second command, a redirection or a variable.
 */
export function quoteArg(value: string, shell: ShellKind): string {
  // How a Windows program reads its command line: \" is a quote, and backslashes
  // count double only directly in front of one (or of the closing quote).
  const forWindows = (v: string, quoted: boolean): string => {
    const s = v.replace(/(\\*)"/g, '$1$1\\"');
    return quoted ? s.replace(/(\\+)$/, '$1$1') : s;
  };
  switch (shell) {
    case 'powershell':
    case 'pwsh': {
      if (/^[\w\-=/\\]+$/.test(value) || /^[\w/\\][\w\-=/\\:]*$/.test(value)) return value;
      // PowerShell 7.3 and later escape for the program themselves.
      const v = shell === 'powershell' ? forWindows(value, /\s/.test(value)) : value;
      return `'${v.replace(/'/g, "''")}'`;
    }
    case 'gitbash':
    case 'wsl':
      return /^[\w.\-/:=@%+,]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
    default: // cmd
      return /^[\w.\-/\\:=@+,~]+$/.test(value) ? value : `"${forWindows(value, true)}"`;
  }
}

/** A flags string as it is typed into a tab's shell: each word quoted for that shell. */
export function shellFlags(flags: string, shell: ShellKind): string {
  return flagWords(flags).map((w) => quoteArg(flagValue(w), shell)).join(' ');
}

/**
 * Joins the switches set for every session of a CLI with a tab's own, leaving out what
 * the tab merely repeats. It compares whole switches — a switch together with the value
 * words after it — never single words: in `-c a=1 -c b=2` two different switches share
 * the word `-c`, and dropping the second `-c` would hand `b=2` to the CLI as a prompt.
 * Nothing is ever reordered, and a switch is only left out when it is identical to one
 * already there.
 */
export function mergeFlags(defaults: string, own: string): string {
  const switches = (text: string): string[] => {
    const out: string[] = [];
    for (const word of flagWords(text)) {
      // Judged by what the word stands for: "--name=a b" is a switch, quotes and all.
      if (flagValue(word).startsWith('-') || !out.length) out.push(word);
      else out[out.length - 1] += ` ${word}`;
    }
    return out;
  };
  // Compared by what they stand for, so "a b" and 'a b' count as the same.
  const means = (s: string) => flagWords(s).map(flagValue).join('\u0000');
  const kept: string[] = [];
  for (const s of [...switches(defaults), ...switches(own)]) if (!kept.some((k) => means(k) === means(s))) kept.push(s);
  return kept.join(' ');
}

/**
 * Data the terminal sends by itself, not the user: answers to status queries (CSI … R /
 * c / n / t / $y), focus in/out, mouse reports, and OSC / DCS replies.
 */
const TERMINAL_REPLY =
  // eslint-disable-next-line no-control-regex
  /^(?:\x1b\[[?>]?[\d;]*(?:R|c|n|t|\$y)|\x1b\[[IO]|\x1b\[<[\d;]+[Mm]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\)+$/;

/** `/c/Users/me` → `C:\Users\me`. Null for a Git Bash folder that has no drive letter. */
export function fromMsysPath(p: string): string | null {
  const m = /^\/([A-Za-z])(\/.*)?$/.exec(p);
  return m ? `${m[1].toUpperCase()}:${(m[2] ?? '/').replace(/\//g, '\\')}` : null;
}

/** `C:\Users\me\a.png` → `/mnt/c/Users/me/a.png`, for a program running inside WSL. */
export function toWslPath(p: string): string {
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (drive) return `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`;
  // A file that is already inside a distro: \\wsl$\Ubuntu\home\me → /home/me
  const inside = /^\\\\wsl(?:\$|\.localhost)\\[^\\]+(\\.*)?$/i.exec(p);
  if (inside) return (inside[1] ?? '\\').replace(/\\/g, '/');
  return p;
}

/**
 * A file path written so the shell in front of it reads it as one word and changes
 * nothing in it. Each shell has its own rules: PowerShell expands `$name` and back-ticks
 * inside double quotes (not inside single ones); bash treats a bare backslash as an
 * escape, so an unquoted Windows path loses its separators there.
 */
export function quotePath(path: string, shell: ShellKind, forCli: boolean): string {
  const p = shell === 'wsl' ? toWslPath(path) : path;
  // A CLI's input box is not a shell: it takes the path as text. Quotes only to keep
  // a path with spaces together, as the CLIs expect from a dropped file.
  if (forCli) return /[\s&()^;,=]/.test(p) ? `"${p}"` : p;
  switch (shell) {
    case 'powershell':
    case 'pwsh':
      return /[^\w.\\/:~-]/.test(p) ? `'${p.replace(/'/g, "''")}'` : p;
    case 'gitbash':
    case 'wsl':
      return /[^\w./:~-]/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p;
    default: // cmd
      return /[\s&()^;,=<>|]/.test(p) ? `"${p}"` : p;
  }
}

/** Ids as the three CLIs make them. Anything else is never typed into a shell. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

/** Processes every console tab has that are not something the user started. */
const PLUMBING = ['conhost.exe', 'openconsole.exe'];
const SHELL_HELPERS: Partial<Record<ShellKind, string[]>> = {
  gitbash: ['bash.exe'],
  wsl: ['wsl.exe', 'wslhost.exe', 'wslrelay.exe'],
};

// Switches that pick a conversation or make the CLI print and exit: never carried over.
const NOT_KEPT: Record<Exclude<CliKind, 'none'>, string[]> = {
  claude: ['--resume', '-r', '--continue', '-c', '--print', '-p', '--fork-session', '--teleport', '--from-pr', '--session-id', '--version', '-v', '--help', '-h'],
  codex: ['--last', '--all', '--version', '-V', '--help', '-h'],
  grok: ['--resume', '-r', '--continue', '-c', '--fork-session', '--session-id', '-s', '--version', '-v', '--help', '-h'],
};
// Switches known to take a value as the next word; kept together with it.
const TAKES_VALUE: Record<Exclude<CliKind, 'none'>, string[]> = {
  claude: ['--permission-mode', '--model'],
  codex: ['--sandbox', '-s', '--ask-for-approval', '-a', '--model', '-m'],
  grok: ['--permission-mode', '--model', '-m'],
};

/**
 * From the arguments a CLI was started with, the switches worth bringing back on resume.
 * Deliberately cautious: a word that is not a switch is never kept, because it could be
 * a prompt, and a prompt must never be sent again by a restart. So:
 *   --dangerously-skip-permissions            kept
 *   --model=opus                              kept
 *   --permission-mode plan                    kept (known to take a value)
 *   --some-new-flag value                     dropped, both words (cannot tell value from prompt)
 *   --resume <id>, --continue, -p             dropped
 */
export function extractSwitches(cli: CliKind, args: string[]): string {
  if (cli === 'none') return '';
  const out: string[] = [];
  const quote = flagWord;
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === '--') break;
    if (!t.startsWith('-') || t === '-') continue;
    const name = t.split('=')[0];
    const next = args[i + 1];
    if (NOT_KEPT[cli].includes(name)) continue;
    if (t.includes('=')) out.push(quote(t));
    else if (TAKES_VALUE[cli].includes(name)) {
      if (next !== undefined && !next.startsWith('-')) {
        out.push(t, quote(next));
        i++;
      }
    } else if (next === undefined || next.startsWith('-')) out.push(t);
  }
  return out.join(' ');
}

export const FONT_STACK =
  '"Cascadia Mono NF", "Cascadia Mono", Consolas, "Segoe UI Symbol", "Segoe UI Emoji", monospace';

/** Lines of scrollback kept per tab unless changed in Settings. Bounded so memory use is bounded. */
export const DEFAULT_SCROLLBACK = 10_000;

/** The bundled font stays in the list behind a chosen one, so symbols it lacks still draw. */
export function fontStack(family: string): string {
  const f = family.trim().replace(/["\\;{}<>]/g, '');
  return f ? `"${f}", ${FONT_STACK}` : FONT_STACK;
}

const THEME = {
  background: '#0c0e12',
  foreground: '#d4d7dd',
  cursor: '#d4d7dd',
  cursorAccent: '#0c0e12',
  selectionBackground: '#2d4f7c',
  selectionInactiveBackground: '#26364d',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
};

const ONE_DARK = {
  background: '#21252b',
  foreground: '#abb2bf',
  cursor: '#abb2bf',
  cursorAccent: '#21252b',
  selectionBackground: '#3e4451',
  selectionInactiveBackground: '#353b45',
  black: '#1e2127',
  red: '#e06c75',
  green: '#98c379',
  yellow: '#d19a66',
  blue: '#61afef',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#abb2bf',
  brightBlack: '#5c6370',
  brightRed: '#e06c75',
  brightGreen: '#98c379',
  brightYellow: '#e5c07b',
  brightBlue: '#61afef',
  brightMagenta: '#c678dd',
  brightCyan: '#56b6c2',
  brightWhite: '#ffffff',
};

const LIGHT = {
  background: '#fafafa',
  foreground: '#2a2c33',
  cursor: '#2a2c33',
  cursorAccent: '#fafafa',
  selectionBackground: '#bcd4f5',
  selectionInactiveBackground: '#d9e2ee',
  black: '#000000',
  red: '#c91b00',
  green: '#00823b',
  yellow: '#946800',
  blue: '#0451a5',
  magenta: '#a626a4',
  cyan: '#0b7f8c',
  white: '#6b6f78',
  brightBlack: '#5c6370',
  brightRed: '#e0321c',
  brightGreen: '#0c9a4a',
  brightYellow: '#a87a00',
  brightBlue: '#1a6fd4',
  brightMagenta: '#bc3fbc',
  brightCyan: '#1193a3',
  brightWhite: '#383a42',
};

export type ThemeName = 'dark' | 'black' | 'soft' | 'light';
export const THEMES: Record<ThemeName, typeof THEME> = {
  dark: THEME,
  black: { ...THEME, background: '#000000', foreground: '#ececec', cursor: '#ececec', cursorAccent: '#000000' },
  soft: ONE_DARK,
  light: LIGHT,
};
export const THEME_LABEL: Record<ThemeName, string> = {
  dark: 'Dark (default)',
  black: 'Black — strongest contrast',
  soft: 'Soft dark',
  light: 'Light',
};

export interface Look {
  /** '' for the bundled font. */
  fontFamily: string;
  scrollback: number;
  theme: ThemeName;
}

/** What each CLI accepts as "new line without sending". */
const NEWLINE_KEY: Record<CliKind, string> = {
  none: '\r',
  claude: '\x1b\r',
  codex: '\n',
  grok: '\x1b\r',
};

/**
 * Shift+Enter as a Windows key event (win32-input-mode: vk 13, scan 28, char 13,
 * down/up, Shift held). PowerShell's line editor reads it as "add a line, don't run".
 */
const PS_ADD_LINE = '\x1b[13;28;13;1;16;1_\x1b[13;28;13;0;16;1_';

let spawnSeq = 0;

export class Tab {
  readonly el: HTMLDivElement;
  readonly term: Terminal;
  private readonly fit = new FitAddon();
  private webgl: WebglAddon | null = null;
  private opened = false;
  private shown = false;

  ptyId: string | null = null;
  /**
   * Id the tab's processes are tracked under. Same as ptyId while the shell runs, and
   * kept after the shell ends so anything it left running can still be seen and stopped.
   */
  procId: string | null = null;
  pid: number | null = null;
  /** What the tab's processes are using: percent of the whole machine, and bytes. */
  cpu = 0;
  mem = 0;
  procs: ProcUsage[] = [];
  /** Everything in the tab has been put on low priority by the user. */
  lowPriority = false;
  /** Set when the CLI is closed on purpose (to update it): what to offer afterwards. */
  private held: { cli: CliKind; sessionId?: string } | null = null;
  /** Set by an emergency stop: what to offer once the shell is back. */
  private afterKill: { cli: CliKind; sessionId?: string } | null = null;
  exited = false;
  exitCode: number | null = null;

  activity: Activity = 'idle';
  /** CLI seen running under this tab right now. */
  cliRunning: CliKind = 'none';
  private cliSeen = false;
  /** Process id of the CLI running in this tab, when one is. */
  cliPid: number | null = null;
  cliStatus: string | null = null;
  /** What the CLI says it is waiting on (a permission, an answer), when it says. */
  waitingFor: string | null = null;
  sessionName: string | null = null;
  /** Title the running program set for the terminal window. */
  title = '';
  /** Restored from a previous run with a CLI session that can be resumed. */
  resumePending = false;
  scrolledUp = false;

  private outTimes: number[] = [];
  private lastInput = 0;
  /**
   * When Enter last went to this tab (clock time, 0 if never). A Codex or Grok session
   * file that appears right after it is put down to this tab, not to another tab that
   * happens to be in the same folder.
   */
  lastEnter = 0;
  /**
   * Enter has gone to the shell and it has not shown a prompt since: a command is
   * running there (only known for PowerShell and cmd, which report each prompt).
   */
  private enterPending = false;
  /** The user has typed in this tab since its shell started. */
  userTyped = false;
  lastOutput = 0;
  /** When the current shell first printed anything. */
  private firstOutput = 0;
  /** Prompts the current shell has shown (PowerShell and cmd report each one). */
  private prompts = 0;
  private bell = false;
  /** Until this time, output is treated as a redraw rather than as work. */
  private muteUntil = 0;
  private ackBytes = 0;
  private ackTimer = 0;
  private fitTimer = 0;
  private disposed = false;

  constructor(
    readonly state: TabState,
    private readonly host: TabHost,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'term-host';
    this.el.dataset.tab = state.id;

    const look = host.look();
    this.term = new Terminal({
      allowProposedApi: true,
      fontFamily: fontStack(look.fontFamily),
      fontSize: host.fontSize(),
      lineHeight: 1.1,
      cursorBlink: true,
      cursorInactiveStyle: 'outline',
      scrollback: look.scrollback,
      // Tells the terminal view which ConPTY is on the other end. The old one built
      // into Windows 10 re-wraps lines itself on resize, so the view must not (both
      // doing it duplicates and breaks lines). The bundled current one expects the
      // view to re-wrap, which is what a build number of 22621+ selects.
      windowsPty: {
        backend: 'conpty',
        buildNumber: host.env.modernConpty ? Math.max(host.env.build, 22621) : host.env.build,
      },
      theme: THEMES[look.theme],
      drawBoldTextInBrightColors: false,
      rescaleOverlappingGlyphs: true,
      altClickMovesCursor: false,
      rightClickSelectsWord: false,
    });

    this.term.loadAddon(this.fit);
    const unicode = new Unicode11Addon();
    this.term.loadAddon(unicode);
    this.term.unicode.activeVersion = '11';
    this.term.loadAddon(new WebLinksAddon((_e, uri) => void api.openExternal(uri).catch(() => {})));

    this.term.onData((d) => this.onUserData(d));
    this.term.onBell(() => {
      this.bell = true;
    });
    this.term.onTitleChange((t) => {
      this.title = t;
      this.host.changed(this);
    });
    this.term.onScroll(() => this.checkScroll());

    // OSC 9;9;<path> — the shell reporting its current directory.
    this.term.parser.registerOscHandler(9, (data) => {
      if (data.startsWith('9;')) {
        this.prompts++;
        this.enterPending = false;
        let cwd = data.slice(2).replace(/^"|"$/g, '');
        // Git Bash names folders its own way (/c/Users/me); the tab is started again
        // with a Windows path. A folder with no Windows form (/tmp, /usr) is not kept.
        if (this.state.shell === 'gitbash') cwd = fromMsysPath(cwd) ?? '';
        if (cwd && cwd !== this.state.cwd && this.cliRunning === 'none') {
          this.state.cwd = cwd;
          this.host.changed(this);
        }
        return true;
      }
      if (data.startsWith('4;')) return true; // progress reports
      this.bell = true; // any other OSC 9 is a notification
      return true;
    });

    this.term.attachCustomKeyEventHandler((e) => this.onKey(e));
    this.el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // A CLI that has asked for mouse events gets the right-click itself; hold
      // Shift to use the terminal's own copy/paste instead.
      if (this.term.modes.mouseTrackingMode !== 'none' && !e.shiftKey) return;
      if (this.term.hasSelection()) this.copySelection();
      else this.host.pasteInto(this);
    });
  }

  // ---------- process ----------

  async start(launch?: string): Promise<void> {
    // The new shell gets a new job. What the previous shell left running stays this
    // tab's: the backend carries it over to the new id (see `previous` below).
    const previous = this.procId ?? undefined;
    const id = `${this.state.id}-${++spawnSeq}`;
    this.procId = id;
    this.lowPriority = false;
    const channel = new Channel<PtyEvent>();
    channel.onmessage = (ev) => {
      if (this.ptyId === id && !this.disposed) this.onPtyEvent(id, ev);
    };
    this.ptyId = id;
    this.exited = false;
    this.exitCode = null;
    this.activity = 'idle';
    this.firstOutput = 0;
    this.lastOutput = 0;
    this.prompts = 0;
    this.enterPending = false;
    this.userTyped = false;
    // A shell starting up prints its banner and prompt; that is not work.
    this.muteUntil = performance.now() + 4000;
    this.outTimes = [];

    let cols = this.term.cols;
    let rows = this.term.rows;
    const fitted = this.proposed();
    if (fitted) ({ cols, rows } = fitted);
    else if (!this.opened) ({ cols, rows } = this.host.estimateSize());
    if (cols !== this.term.cols || rows !== this.term.rows) this.term.resize(cols, rows);

    try {
      const info = await api.ptySpawn(
        { id, shell: this.state.shell, cwd: this.state.cwd, cols, rows, wslDistro: this.state.wslDistro, previous },
        channel,
      );
      this.pid = info.pid;
      if (info.pid && !info.tracked && !this.disposed) {
        // Rare (Windows refused a job): said once, so usage and Kill are not trusted blindly.
        this.term.write('\r\n\x1b[33m[TermDeck could not give this shell a job of its own: programs it starts are followed only while their parent runs, and may not be counted or stopped with the tab]\x1b[0m\r\n');
      }
    } catch (e) {
      this.ptyId = null;
      this.exited = true;
      this.activity = 'exited';
      if (!this.disposed) this.term.write(`\r\n\x1b[31mCould not start ${this.state.shell}: ${String(e)}\x1b[0m\r\n`);
    }
    if (this.disposed) {
      // The tab was closed while its shell was being started: the shell that has just
      // come up belongs to no tab any more, and is closed like any other.
      void api.ptyClose([id]).catch(() => {});
      return;
    }
    this.host.changed(this);
    if (launch && this.ptyId) this.runWhenQuiet(launch);
  }

  /**
   * Types a command once the shell is at its prompt, and runs it only after the
   * shell has shown it back complete (see typeChecked).
   * PowerShell and cmd tell the app each time they show a prompt, so that is the
   * signal there; other shells are judged by their output going quiet.
   */
  runWhenQuiet(command: string, onNotRun?: () => void): void {
    const began = performance.now();
    const ptyId = this.ptyId;
    const timer = window.setInterval(() => {
      const now = performance.now();
      const settled = now - this.lastOutput > 350;
      const quiet = this.reportsPrompt
        ? this.prompts > 0 && settled
        : this.firstOutput > 0 && now - this.firstOutput > 1500 && settled;
      if (quiet || now - began > 20000) {
        window.clearInterval(timer);
        if (this.disposed || this.exited || this.ptyId !== ptyId) return;
        // The prompt was free when this was asked for. If a command has been started
        // there since (Enter pressed, no prompt back yet), typing now would go to that
        // program — so it is not typed.
        if (this.commandRunning()) {
          onNotRun?.();
          this.host.say(this, 'a command was started here before the app could type its own, so nothing was typed. Try again when the tab is back at its prompt.');
          return;
        }
        void this.typeChecked(command).then((ran) => {
          if (ran || this.disposed || this.exited || this.ptyId !== ptyId) return;
          onNotRun?.();
          this.host.say(this, 'could not confirm that the command was typed correctly, so Enter was not pressed. Check the line at the prompt and press Enter yourself — or clear it and try again.');
        });
      }
    }, 100);
  }

  /**
   * PowerShell and cmd tell the app each time they show a prompt. bash (Git Bash, WSL)
   * is asked to as well, but its start-up files can switch that off — so there it only
   * counts once a first report has actually arrived.
   */
  private get reportsPrompt(): boolean {
    return this.state.shell === 'powershell' || this.state.shell === 'pwsh' || this.state.shell === 'cmd' || this.prompts > 0;
  }

  /**
   * False when something is running at this tab's prompt, as far as can be told — a
   * command typed there now would go to that program instead of the shell.
   * PowerShell and cmd: Enter was pressed and no prompt has come back since.
   * Git Bash and WSL do not report their prompt, so there it is judged by output.
   */
  promptFree(): boolean {
    if (this.exited || this.cliRunning !== 'none') return false;
    if (this.reportsPrompt) return !this.commandRunning();
    return this.activity !== 'working';
  }

  /**
   * True when it is known that a command is running at the shell's prompt: Enter was
   * pressed and the shell has not shown a prompt since. Only shells that report their
   * prompt can say; for the others this is always false.
   */
  private commandRunning(): boolean {
    return this.reportsPrompt && this.prompts > 0 && this.enterPending;
  }

  /**
   * True while the CLI has finished its turn but a command it started in the background
   * is still running (a test run, a server). You can talk to it meanwhile, so the tab
   * is not "working" — but closing it would end that command.
   * Known for Claude Code only: its own status file says "shell" for exactly this
   * (seen 2026-11-12, Claude Code 2.1.322: "busy" until it answered, "shell" for as
   * long as a background `ping` ran, then "idle"). Codex and Grok record nothing like it.
   */
  get background(): boolean {
    return this.cliRunning !== 'none' && this.cliStatus === 'shell';
  }

  /**
   * The programs of that background command, by name. A CLI runs a command through a
   * shell, so these are the programs that have a shell between them and the CLI; what
   * the CLI runs directly (its own helpers) is not listed, nor are the shells.
   */
  backgroundPrograms(): string[] {
    if (!this.background) return [];
    const own = this.cliFamily();
    const shells = ['bash.exe', 'sh.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe', 'wsl.exe'];
    const skip = [...shells, 'env.exe', 'conhost.exe', 'openconsole.exe', 'wslhost.exe'];
    const byPid = new Map(this.procs.map((p) => [p.pid, p]));
    const underShell = (pid: number): boolean => {
      for (let at = byPid.get(pid)?.ppid ?? 0, n = 0; at && at !== this.cliPid && own.has(at) && n < 24; n++) {
        const parent = byPid.get(at);
        if (!parent) return false;
        if (shells.includes(parent.name.toLowerCase())) return true;
        at = parent.ppid;
      }
      return false;
    };
    const names = this.procs
      .filter((p) => own.has(p.pid) && p.pid !== this.cliPid && !skip.includes(p.name.toLowerCase()) && underShell(p.pid))
      .map((p) => p.name.replace(/\.exe$/i, '').toLowerCase());
    return [...new Set(names)];
  }

  /**
   * The CLI's own processes: the CLI, the launcher between the shell and it (the
   * `cmd` / `node` that started it), and everything the CLI has started — the helpers
   * it keeps running the whole time it is open (MCP servers and the like).
   */
  cliFamily(): Set<number> {
    const own = new Set<number>();
    if (this.cliRunning === 'none' || !this.cliPid) return own;
    const parent = new Map(this.procs.map((p) => [p.pid, p.ppid]));
    for (let pid = this.cliPid, n = 0; pid && pid !== this.pid && !own.has(pid) && n < 16; n++) {
      own.add(pid);
      pid = parent.get(pid) ?? 0;
    }
    for (let grew = true; grew; ) {
      grew = false;
      for (const p of this.procs) {
        if (!own.has(p.pid) && p.pid !== this.pid && own.has(p.ppid)) {
          own.add(p.pid);
          grew = true;
        }
      }
    }
    return own;
  }

  /** What the tab has running, besides its own shell and the console's plumbing. */
  running(): ProcUsage[] {
    const skip = [...PLUMBING, ...(SHELL_HELPERS[this.state.shell] ?? [])];
    return this.procs.filter((p) => p.pid !== this.pid && !skip.includes(p.name.toLowerCase()));
  }

  /**
   * Types a command, waits for the shell to echo it back whole, then presses Enter.
   * A shell that has printed its prompt can still be loading its line editor, and a
   * character typed in that moment is sometimes lost (measured: about 1 in 24 for
   * PowerShell right after the app restarts, giving "cho" for "echo"). Waiting longer
   * only makes that rarer, so the echo is checked instead; a damaged line is cleared
   * and typed again.
   */
  private async typeChecked(command: string): Promise<boolean> {
    const want = command.replace(/\s+/g, '');
    const clearLine = this.state.shell === 'gitbash' || this.state.shell === 'wsl' ? '\x15' : '\x1b';
    const pause = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
    const ptyId = this.ptyId;
    const gone = () => this.exited || this.disposed || this.ptyId !== ptyId;
    for (let attempt = 0; attempt < 4; attempt++) {
      // Also given up when a command has started running at the prompt meanwhile: the
      // next attempt would clear and type into that program.
      if (gone() || this.commandRunning()) return false;
      // Start from an empty line: anything already typed at the prompt would
      // otherwise end up in front of the command. Sent on its own, with a pause,
      // so the Esc is not read together with the next key as Alt+key.
      this.send(clearLine);
      await pause(attempt === 0 ? 150 : 400);
      if (gone()) return false;
      this.send(command);
      for (let waited = 0; waited < 1500; waited += 50) {
        await pause(50);
        if (gone()) return false;
        if (this.typedSoFar(command.length).endsWith(want)) {
          this.send('\r');
          return true;
        }
      }
    }
    // The echo could not be read back, four times. Whatever is on that line is not
    // known to be the command, so Enter is NOT pressed: the last attempt stays at the
    // prompt for the user to look at.
    return false;
  }

  /** The text just before the cursor, without spaces: what the shell shows as typed. */
  private typedSoFar(chars: number): string {
    const b = this.term.buffer.active;
    const y = b.baseY + b.cursorY;
    const rows = Math.ceil(chars / Math.max(1, this.term.cols)) + 1;
    let s = '';
    for (let r = Math.max(0, y - rows); r < y; r++) s += b.getLine(r)?.translateToString(true) ?? '';
    s += b.getLine(y)?.translateToString(false, 0, b.cursorX) ?? '';
    return s.replace(/\s+/g, '');
  }

  private onPtyEvent(id: string, ev: PtyEvent): void {
    if (ev.type === 'output') {
      const now = performance.now();
      this.lastOutput = now;
      if (!this.firstOutput) this.firstOutput = now;
      // Output right after a keystroke is just the echo, and output right after a
      // resize or a CLI starting up is just a redraw — neither is the program working.
      const redraw = now < this.muteUntil && this.activity !== 'working';
      if (now - this.lastInput > 300 && !redraw) {
        this.outTimes.push(now);
        if (this.outTimes.length > 60) this.outTimes.splice(0, 30);
      }
      this.term.write(ev.data, () => this.ack(id, ev.n));
    } else {
      this.exited = true;
      this.exitCode = ev.code;
      this.ptyId = null;
      this.pid = null;
      this.activity = 'exited';
      this.cliRunning = 'none';
      const stopped = this.afterKill;
      this.afterKill = null;
      if (stopped && !this.disposed) {
        // An emergency stop: bring the shell straight back in the same folder, and
        // offer the conversation that was open (it lives in the CLI's own files).
        this.term.write('\r\n\x1b[91m[everything in this tab was stopped]\x1b[0m\r\n');
        this.cliSeen = false;
        this.state.cli = stopped.cli;
        this.state.sessionId = stopped.sessionId;
        this.resumePending = stopped.cli !== 'none';
        this.dropUnsavedSession();
        void this.start();
        return;
      }
      this.term.write('\r\n\x1b[90m[process ended — press Enter to start it again]\x1b[0m\r\n');
      this.host.changed(this);
    }
  }

  /** Tells the backend how much output has been drawn (backpressure). */
  private ack(id: string, n: number): void {
    this.ackBytes += n;
    const flush = () => {
      this.ackTimer = 0;
      const bytes = this.ackBytes;
      this.ackBytes = 0;
      if (bytes > 0) void api.ptyAck(id, bytes).catch(() => {});
    };
    if (this.ackBytes >= 65_536) {
      window.clearTimeout(this.ackTimer);
      flush();
    } else if (!this.ackTimer) {
      this.ackTimer = window.setTimeout(flush, 30);
    }
  }

  private onUserData(data: string): void {
    if (this.exited) {
      if (data === '\r') void this.start();
      return;
    }
    // Not everything that arrives here was typed: the terminal also answers questions
    // the program asks it (cursor position, device type, colours), and reports focus
    // and mouse. Those go to the process like keys, but say nothing about the user.
    if (!TERMINAL_REPLY.test(data)) this.userTyped = true;
    this.send(data);
  }

  /** Raw bytes to the process. */
  send(data: string): void {
    if (!this.ptyId) return;
    this.lastInput = performance.now();
    if (data.includes('\r') || data.includes('\n')) {
      this.lastEnter = Date.now();
      this.enterPending = true;
    }
    this.bell = false;
    if (this.activity === 'done' || this.activity === 'attention') {
      this.activity = 'idle';
      this.host.changed(this);
    }
    void api.ptyWrite(this.ptyId, data).catch((e) => {
      // Refused because far too much input is waiting for a program that reads none.
      const now = performance.now();
      if (String(e).includes('stopped reading') && now - this.toldStuck > 15000) {
        this.toldStuck = now;
        this.host.say(this, 'the program here has stopped reading its input, and a great deal is already waiting for it — what you just sent was not passed on.');
      }
    });
  }
  private toldStuck = -Infinity;

  /** Inserts text at the input without submitting it. */
  insert(text: string): void {
    if (!this.ptyId) return;
    const normalized = text.replace(/\r\n/g, '\n');
    const lines = normalized.split('\n');
    if (this.term.modes.bracketedPasteMode || lines.length === 1) {
      // The terminal wraps this as one pasted block when the program asked for that.
      this.term.paste(normalized);
    } else if (this.cliRunning !== 'none') {
      // The program has not asked for pasted blocks, so Enter would send each line
      // separately. Use the CLI's own "new line" key between lines instead.
      this.send(lines.join(NEWLINE_KEY[this.cliRunning]));
    } else if (this.state.shell === 'powershell' || this.state.shell === 'pwsh') {
      // Same idea at a PowerShell prompt: Shift+Enter between lines.
      this.send(lines.join(PS_ADD_LINE));
    } else {
      // cmd and other shells have no multi-line input: each line runs as it arrives,
      // exactly as when pasting into any terminal.
      this.term.paste(normalized);
    }
    this.term.scrollToBottom();
  }

  insertPaths(paths: string[]): void {
    // Inside WSL the programs cannot be seen from Windows; a tab that had a CLI started
    // there counts as "a CLI is in front".
    const forCli = this.cliRunning !== 'none';
    this.insert(paths.map((p) => quotePath(p, this.state.shell, forCli)).join(' ') + ' ');
  }

  submit(text: string): void {
    const sentAt = performance.now();
    const ptyId = this.ptyId;
    this.insert(text);
    // Enter goes separately, once the CLI has drawn the pasted block and gone quiet;
    // sent too close behind it, some CLIs read it as part of the paste instead of
    // "send". Never sooner than 250 ms, never later than 1.5 s.
    const timer = window.setInterval(() => {
      const now = performance.now();
      const waited = now - sentAt;
      const drawn = this.lastOutput > sentAt && now - this.lastOutput > 200;
      if ((waited >= 250 && drawn) || waited > 1500) {
        window.clearInterval(timer);
        if (this.ptyId === ptyId && !this.exited) this.send('\r');
      }
    }, 50);
  }

  /**
   * Closes the tab's terminal for good and ends everything it started, background
   * programs included. Console programs get a few seconds to finish by themselves.
   */
  kill(): void {
    const ids = [...new Set([this.ptyId, this.procId].filter((id): id is string => !!id))];
    if (!ids.length) return;
    const name = this.title || this.state.cwd;
    void api.ptyClose(ids).then((res) => {
      Tab.closed++;
      Tab.forced += res.targeted;
      if (res.survivors.length) {
        Tab.survivors.push(...res.survivors);
        toast(`The tab "${name}" was closed, but ${survivorText(res.survivors)} could not be ended (Windows refused — it may be running as administrator). End it from Task Manager.`, 'error', 12000);
      }
    }).catch(() => {});
  }

  /** Names of programs that closing or Kill could not end (for tests and diagnosis). */
  static survivors: string[] = [];

  /** Tabs closed so far, and how many processes had to be ended by force in all (for tests and diagnosis). */
  static closed = 0;
  static forced = 0;

  /**
   * Emergency stop: ends every process this tab has started — the CLI, whatever it
   * launched, and leftovers whose parent already quit — then brings the shell back
   * in the same folder with Resume offered. Says how many processes were ended, and
   * names any that are still running afterwards.
   */
  async killEverything(): Promise<Ended> {
    if (!this.procId) return { targeted: 0, survivors: [] };
    const id = this.procId;
    let ended = 0;
    if (!this.exited) {
      const cli = this.cliRunning !== 'none' ? this.cliRunning : this.resumePending ? this.state.cli : 'none';
      const armed = { cli, sessionId: cli !== 'none' ? this.state.sessionId : undefined };
      this.afterKill = armed;
      // If the shell somehow survives, do not leave the restart armed for later. Only
      // this stop's own arming is withdrawn: a second stop pressed meanwhile has its own.
      window.setTimeout(() => {
        if (this.afterKill === armed) this.afterKill = null;
      }, 12000);
      if (this.cliRunning !== 'none' && this.cliPid) {
        // First, at once and by force, everything the CLI started — that is what is
        // eating the machine. Then the CLI itself gets a moment to quit normally.
        ended += await api.ptyKillChildren(id, this.cliPid).catch(() => 0);
        await this.quitCli(1800);
      }
    }
    try {
      const res = await api.ptyKillTree(id);
      if (res.survivors.length && !this.disposed) {
        Tab.survivors.push(...res.survivors);
        this.term.write(`\r\n\x1b[91m[could not be stopped, still running: ${survivorText(res.survivors)} — Windows refused; it may be running as administrator]\x1b[0m\r\n`);
      }
      return { targeted: ended + res.targeted, survivors: res.survivors };
    } catch {
      this.afterKill = null;
      return { targeted: ended, survivors: [] };
    }
  }

  /**
   * A CLI that was open with nothing sent yet has no saved conversation. Forget its id,
   * so the tab offers a fresh start instead of a resume command that would fail.
   */
  private dropUnsavedSession(): void {
    const cli = this.state.cli;
    const sid = this.state.sessionId;
    if (cli === 'none' || !sid) return;
    void api.sessionExists(cli, sid).then((ok) => {
      if (!ok && this.state.sessionId === sid) {
        this.state.sessionId = undefined;
        this.host.changed(this);
      }
    }).catch(() => {});
  }

  /**
   * Asks the CLI to quit the way you would: Ctrl+C until it leaves. A CLI that is
   * ended by force can count that as a crash — Claude Code turns its full-screen mode
   * off after two — so force is kept for whatever has not left by itself.
   * Returns true once the CLI has gone.
   */
  private async quitCli(maxMs: number): Promise<boolean> {
    const pause = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
    const began = performance.now();
    // The first Ctrl+C may only stop running work or clear the input; the next two quit.
    for (let n = 0; n < 4 && this.cliRunning !== 'none' && performance.now() - began < maxMs; n++) {
      this.send('\x03');
      await pause(350);
      await this.host.refresh();
    }
    while (this.cliRunning !== 'none' && performance.now() - began < maxMs) {
      await pause(200);
      await this.host.refresh();
    }
    return this.cliRunning === 'none';
  }

  /**
   * Closes the CLI running in this tab (not the shell), so it can be updated. The tab
   * then shows its Resume bar; the conversation is in the CLI's own files.
   */
  async stopCli(): Promise<boolean> {
    if (this.cliRunning === 'none' || !this.procId || this.exited) return false;
    this.held = { cli: this.cliRunning, sessionId: this.state.sessionId };
    const id = this.procId;
    // Noted while the CLI is still there: itself, its launcher, what it started.
    if (this.cliPid) await api.ptyCliNote(id, this.cliPid).catch(() => 0);
    await this.quitCli(5000);
    // Whatever of those is still there is ended. What else runs in the tab — a dev
    // server or a job started before the CLI — is not part of the update and stays.
    const ended = await api.ptyCliEnd(id).catch(() => 0);
    // So the tab shows at once that its CLI has gone, not a second later.
    if (ended) await this.host.refresh().catch(() => {});
    return true;
  }

  /** Low priority: the tab's work continues, but only on CPU nothing else wants. */
  async setLowPriority(low: boolean): Promise<boolean> {
    if (!this.procId) return false;
    const changed = await api.tabPriority(this.procId, low).catch(() => 0);
    // Shown as low only if it took; "back to normal" always clears the mark.
    this.lowPriority = low && changed > 0;
    this.host.changed(this);
    return changed > 0;
  }

  // ---------- keys ----------

  private onKey(e: KeyboardEvent): boolean {
    if (e.type !== 'keydown') return true;
    const key = e.key.toLowerCase();
    const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;

    if ((ctrl && key === 'v') || (e.shiftKey && !e.ctrlKey && e.key === 'Insert')) {
      e.preventDefault();
      this.host.pasteInto(this);
      return false;
    }
    if (ctrl && key === 'c' && (e.shiftKey || this.term.hasSelection())) {
      e.preventDefault();
      this.copySelection();
      return false;
    }
    if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && this.cliRunning !== 'none') {
      e.preventDefault();
      this.send(NEWLINE_KEY[this.cliRunning]);
      return false;
    }
    return true;
  }

  copySelection(): void {
    const text = this.term.getSelection();
    if (text) void api.clipboardWrite(text).catch(() => {});
    this.term.clearSelection();
  }

  // ---------- drawing ----------

  /** Called when the tab is placed into a pane (true) or parked out of sight (false). */
  setShown(shown: boolean): void {
    if (this.disposed) return;
    this.shown = shown;
    if (!shown) {
      // Hidden tabs keep parsing output but hold no GPU context.
      this.dropRenderer();
      return;
    }
    if (!this.opened) {
      this.term.open(this.el);
      this.opened = true;
    }
    this.attachRenderer();
    this.fitNow();
    this.term.refresh(0, this.term.rows - 1);
    this.checkScroll();
  }

  get isShown(): boolean {
    return this.shown;
  }

  /**
   * Gives up the GPU renderer. The keyboard is taken off the terminal first: the
   * renderer (@xterm/addon-webgl 0.19) runs a cursor-blink timer while the terminal has
   * the keyboard and does not stop it when it is disposed, and that timer then keeps
   * the renderer, the terminal and its whole scroll-back in memory for good. Measured:
   * every tab closed while focused stayed in memory; with this, none do.
   */
  private dropRenderer(): void {
    if (!this.webgl) return;
    this.term.blur();
    this.webgl.dispose();
    this.webgl = null;
  }

  /** When the graphics context was lost lately (a driver reset, the PC waking up). */
  private glLost: number[] = [];

  /** Gives a visible terminal its GPU renderer; without one the built-in renderer draws. */
  private attachRenderer(): void {
    if (this.webgl || !this.shown || !this.opened || this.disposed) return;
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => {
        if (this.webgl !== gl) return;
        // The slower built-in renderer takes over at once, and the keyboard stays where
        // it was. Then a new GPU renderer is tried — a tab left on the slow one used to
        // stay there until it was hidden and shown again. Not more than three tries a
        // minute, so a graphics driver that keeps failing is left in peace.
        const typing = document.activeElement === this.term.textarea;
        this.dropRenderer();
        if (typing) this.term.focus();
        const now = performance.now();
        this.glLost = this.glLost.filter((t) => now - t < 60_000);
        this.glLost.push(now);
        if (this.glLost.length <= 3) {
          window.setTimeout(() => {
            this.attachRenderer();
            if (this.webgl) this.term.refresh(0, this.term.rows - 1);
          }, 1500);
        }
      });
      this.term.loadAddon(gl);
      this.webgl = gl;
    } catch {
      this.webgl = null; // the built-in renderer takes over
    }
  }

  private proposed(): { cols: number; rows: number } | null {
    if (!this.opened || !this.shown || this.el.clientWidth < 40 || this.el.clientHeight < 30) return null;
    const d = this.fit.proposeDimensions();
    if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows)) return null;
    return { cols: Math.max(20, d.cols), rows: Math.max(4, d.rows) };
  }

  /** Matches the grid to the space available, and tells the process. */
  fitNow(): void {
    window.clearTimeout(this.fitTimer);
    this.fitTimer = 0;
    const d = this.proposed();
    if (!d) return;
    if (d.cols === this.term.cols && d.rows === this.term.rows) return;
    // The view and the process are always resized together, in one step.
    this.term.resize(d.cols, d.rows);
    this.muteUntil = performance.now() + 1500;
    if (this.ptyId) void api.ptyResize(this.ptyId, d.cols, d.rows).catch(() => {});
    this.host.changed(this);
  }

  /** Resizes after the layout has settled, so a drag sends few resizes, not hundreds. */
  scheduleFit(): void {
    if (this.fitTimer) window.clearTimeout(this.fitTimer);
    this.fitTimer = window.setTimeout(() => this.fitNow(), 45);
  }

  setFontSize(px: number): void {
    if (this.term.options.fontSize === px) return;
    this.term.options.fontSize = px;
    if (this.shown) this.fitNow();
  }

  /** Applies font, colours and history length from Settings to a terminal that is already open. */
  applyLook(look: Look): void {
    const o = this.term.options;
    const family = fontStack(look.fontFamily);
    const refit = o.fontFamily !== family;
    if (refit) o.fontFamily = family;
    if (o.scrollback !== look.scrollback) o.scrollback = look.scrollback;
    o.theme = THEMES[look.theme];
    if (refit && this.shown) this.fitNow();
  }

  focus(): void {
    if (this.opened) this.term.focus();
  }

  private checkScroll(): void {
    const b = this.term.buffer.active;
    const up = b.viewportY < b.baseY;
    if (up !== this.scrolledUp) {
      this.scrolledUp = up;
      this.host.changed(this);
    }
  }

  // ---------- status ----------

  private recentOutput(now: number): boolean {
    const recent = this.outTimes.filter((t) => now - t < 2500);
    return recent.length >= 3 && now - recent[recent.length - 1] < 1500;
  }

  /**
   * Output that has kept coming for several seconds (a spinner while a model works),
   * as opposed to a short burst from typing or redrawing the input box.
   */
  private sustainedOutput(now: number): boolean {
    const recent = this.outTimes.filter((t) => now - t < 6000);
    return recent.length >= 6 && now - recent[recent.length - 1] < 1500 && recent[recent.length - 1] - recent[0] > 3500;
  }

  /** Folds in the latest look at the process tree. Returns true if anything changed. */
  applyStatus(st: TabStatus | undefined, focused: boolean): boolean {
    this.cpu = st?.cpu ?? 0;
    this.mem = st?.mem ?? 0;
    this.procs = st?.procs ?? [];
    this.cliPid = st?.cliPid ?? null;
    if (this.exited) return false;
    const key = () => `${this.activity}|${this.cliRunning}|${this.cliStatus}|${this.waitingFor}|${this.sessionName}|${this.state.cli}|${this.state.sessionId}|${this.state.flags}`;
    const before = key();
    const now = performance.now();
    const inspectable = this.state.shell !== 'wsl'; // Linux processes are not visible from Windows

    if (inspectable) {
      if (st?.cli) {
        if (this.cliRunning !== st.cli) {
          // Just started: its first screens are drawing, not work.
          this.muteUntil = now + 4000;
          this.outTimes = [];
        }
        this.cliRunning = st.cli;
        this.cliSeen = true;
        this.resumePending = false;
        this.state.cli = st.cli;
        if (st.sessionId) this.state.sessionId = st.sessionId;
        // Flags typed in by hand for another CLI do not carry over to this one.
        if (this.state.flagsManual && this.state.flagsCli && this.state.flagsCli !== st.cli) {
          this.state.flagsManual = undefined;
          this.state.flagsCli = undefined;
          this.state.flags = undefined;
        }
        // Remember the switches it is running with, so Resume brings it back the same way.
        if (!this.state.flagsManual && st.cliArgs) this.state.flags = extractSwitches(st.cli, st.cliArgs) || undefined;
      } else {
        this.cliRunning = 'none';
        if (this.cliSeen && this.held) {
          // Closed by the app in order to update it: keep what is needed to resume.
          this.cliSeen = false;
          this.state.cli = this.held.cli;
          this.state.sessionId = this.held.sessionId;
          this.resumePending = true;
          this.held = null;
          this.dropUnsavedSession();
        } else if (this.cliSeen) {
          // The CLI was running and has been closed: nothing to resume later.
          this.cliSeen = false;
          // Hand-typed flags stay for the next time that CLI is started here — noted
          // as that CLI's (tabs saved before this was recorded have no note yet).
          if (this.state.flagsManual && !this.state.flagsCli && this.state.cli !== 'none') this.state.flagsCli = this.state.cli;
          this.state.cli = 'none';
          this.state.sessionId = undefined;
          if (!this.state.flagsManual) this.state.flags = undefined;
        }
      }
    } else {
      this.cliRunning = this.resumePending ? 'none' : this.state.cli;
    }
    this.cliStatus = st?.cliStatus ?? null;
    this.waitingFor = st?.waitingFor ?? null;
    this.sessionName = st?.sessionName ?? null;

    let working: boolean;
    let attention = this.bell;
    if (this.cliRunning !== 'none' && this.cliStatus) {
      // The CLI records its own state in its session files; trust that over guesswork.
      // A beep from the CLI (often just "I'm done") is not a request for input here.
      working = this.cliStatus === 'busy';
      attention = /wait|block|permission|input/i.test(this.cliStatus);
      this.bell = false;
    } else if (this.cliRunning !== 'none') {
      // No state from the CLI's files. On Windows that means no conversation has
      // started yet, so it is idle (screen activity is not trusted: start-up
      // screens and typing would read as work). Inside WSL the files are out of
      // reach, so steady output is the only signal available.
      working = inspectable ? false : this.sustainedOutput(now);
    } else if (!inspectable || this.state.shell === 'gitbash') {
      working = this.recentOutput(now);
    } else {
      // A plain shell: a program is running under it, or it is printing steadily
      // (a shell loop or pipeline has no separate process).
      working = (st?.childCount ?? 0) > 0 || this.recentOutput(now);
    }

    const prev = this.activity;
    let next: Activity;
    if (attention && !working) next = 'attention';
    else if (working) next = 'working';
    else if (prev === 'working') next = focused ? 'idle' : 'done';
    else if (prev === 'done' || prev === 'attention') next = prev === 'attention' && !attention ? 'idle' : prev;
    else next = 'idle';
    if (working) this.bell = false;
    this.activity = next;

    return before !== key();
  }

  /** The user is looking at this tab: a "finished" marker has done its job. */
  markSeen(): void {
    if (this.activity === 'done') {
      this.activity = 'idle';
      this.host.changed(this);
    }
  }

  /**
   * The command that brings this tab's CLI back.
   * - A known conversation is reopened by its id.
   * - No id means no conversation was ever saved (the CLI was open but nothing had
   *   been sent), so the CLI is simply started again.
   * - WSL tabs cannot be inspected from Windows, so they reopen the latest
   *   conversation in the folder.
   */
  resumeCommand(): string | null {
    const cli = this.state.cli;
    if (cli === 'none') return null;
    // The id is typed into a shell: only ever one that looks like a CLI's own id.
    const id = this.state.sessionId && SAFE_ID.test(this.state.sessionId) ? this.state.sessionId : undefined;
    // Remembered as plain words; quoted here for the shell they are typed into.
    const flags = shellFlags(this.flags(), this.state.shell);
    const tail = flags ? ` ${flags}` : '';
    if (id) return { claude: `claude --resume ${id}`, codex: `codex resume ${id}`, grok: `grok --resume ${id}` }[cli] + tail;
    if (this.state.shell === 'wsl') return { claude: 'claude --continue', codex: 'codex resume --last', grok: 'grok --continue' }[cli] + tail;
    return cli + tail;
  }

  /**
   * The switches this tab's CLI is started with: the ones set for every session of that
   * CLI, plus this tab's own (read from how it was started, or typed in by hand).
   */
  flags(): string {
    const cli = this.state.cli;
    if (cli === 'none') return '';
    return mergeFlags(this.host.defaultFlags(cli), this.state.flags ?? '');
  }

  /** Plain text of the screen and scrollback (used by tests and search). */
  bufferText(lastLines = 200): string {
    const b = this.term.buffer.active;
    let end = b.length;
    while (end > 0 && !(b.getLine(end - 1)?.translateToString(true) ?? '')) end--; // skip blank rows below the output
    const out: string[] = [];
    for (let i = Math.max(0, end - lastLines); i < end; i++) {
      out.push(b.getLine(i)?.translateToString(true) ?? '');
    }
    return out.join('\n');
  }

  dispose(): void {
    this.disposed = true;
    this.kill();
    window.clearTimeout(this.fitTimer);
    window.clearTimeout(this.ackTimer);
    this.dropRenderer();
    this.term.dispose();
    this.el.remove();
  }
}

/** "chrome.exe", "chrome.exe ×3 and node.exe": names of processes, counted. */
export function survivorText(names: string[]): string {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  const parts = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n));
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] ?? '';
}
