import { invoke, Channel } from '@tauri-apps/api/core';

export type ShellKind = 'powershell' | 'pwsh' | 'cmd' | 'gitbash' | 'wsl';
export type CliKind = 'none' | 'claude' | 'codex' | 'grok';

export interface EnvInfo {
  home: string;
  build: number;
  hasGitBash: boolean;
  hasPwsh: boolean;
  wslDistros: string[];
  modernConpty: boolean;
}

export type PtyEvent =
  | { type: 'output'; data: string; n: number }
  | { type: 'exit'; code: number | null };

export interface TabStatus {
  id: string;
  cli: CliKind | null;
  cliPid: number | null;
  sessionId: string | null;
  sessionName: string | null;
  cliStatus: string | null;
  waitingFor: string | null;
  cliCwd: string | null;
  /** What the CLI was started with (arguments, without the program name). */
  cliArgs: string[];
  childCount: number;
  /** Everything the tab has running, heaviest first. */
  procs: ProcUsage[];
  /** Totals: percent of the whole machine, and bytes. */
  cpu: number;
  mem: number;
}

export interface ProcUsage {
  pid: number;
  /** The process that started it. */
  ppid: number;
  name: string;
  cpu: number;
  mem: number;
}

export interface SystemUsage {
  cpu: number;
  memUsed: number;
  memTotal: number;
  cores: number;
}

export interface CliVersion {
  cli: Exclude<CliKind, 'none'>;
  /** null when the CLI is not installed */
  installed: string | null;
  /** null when the latest version could not be looked up */
  latest: string | null;
  updateAvailable: boolean;
  /** processes of this CLI running anywhere on the PC */
  running: number;
  command: string;
  note: string | null;
}

export interface UpdateResult {
  cli: string;
  ok: boolean;
  code: number | null;
  timedOut: boolean;
  output: string;
  command: string;
}

/** A past conversation, as found in a CLI's own session folder. */
export interface SessionInfo {
  cli: Exclude<CliKind, 'none'>;
  id: string;
  /** Folder it was held in ('' if that could not be read). */
  cwd: string;
  /** The CLI's own title, or the first thing that was said. */
  title: string;
  /** Last written, milliseconds since 1970. */
  modified: number;
  size: number;
}

export interface ClipData {
  kind: 'files' | 'text' | 'image' | 'empty';
  text: string | null;
  paths: string[];
}

export interface HistoryMsg {
  role: 'user' | 'assistant' | 'tool';
  kind: 'text' | 'call' | 'result';
  text: string;
}

export interface Transcript {
  found: boolean;
  path: string;
  title: string | null;
  sessionId: string | null;
  messages: HistoryMsg[];
  start: number;
  fileSize: number;
}

export interface SpawnArgs {
  id: string;
  shell: ShellKind;
  cwd: string;
  cols: number;
  rows: number;
  wslDistro?: string;
  /** The id the tab's previous shell ran under, when this is a restart of its shell. */
  previous?: string;
}

export const api = {
  envInfo: () => invoke<EnvInfo>('env_info'),
  dirExists: (path: string) => invoke<boolean>('dir_exists', { path }),
  openExternal: (url: string) => invoke<void>('open_external', { url }),
  dataDir: () => invoke<string>('data_dir_path'),

  ptySpawn: (args: SpawnArgs, onEvent: Channel<PtyEvent>) =>
    invoke<{ pid: number | null }>('pty_spawn', { args, onEvent }),
  ptyWrite: (id: string, data: string) => invoke<void>('pty_write', { id, data }),
  ptyResize: (id: string, cols: number, rows: number) => invoke<void>('pty_resize', { id, cols, rows }),
  ptyAck: (id: string, n: number) => invoke<void>('pty_ack', { id, n }),
  /** Closes tabs for good: everything they started is ended. Returns how many by force. */
  ptyClose: (ids: string[]) => invoke<number>('pty_close', { ids }),
  /** The same for every tab there is. */
  ptyKillAll: () => invoke<number>('pty_kill_all'),

  pollStatus: (tabs: { id: string; pty: string; pid: number; cwd: string; session: string | null; input: number | null }[]) =>
    invoke<{ tabs: TabStatus[]; system: SystemUsage }>('poll_status', { tabs }),
  /** Ends everything a tab has started, its shell included. Returns how many. */
  ptyKillTree: (id: string) => invoke<number>('pty_kill_tree', { id }),
  procKill: (id: string, pid: number) => invoke<boolean>('proc_kill', { id, pid }),
  tabPriority: (id: string, low: boolean) => invoke<number>('tab_priority', { id, low }),
  /** Ends what is running in a tab but keeps its shell. */
  ptyKillChildren: (id: string, spare: number | null = null) => invoke<number>('pty_kill_children', { id, spare }),
  /** Close for update: note the CLI, its launcher and what it started... */
  ptyCliNote: (id: string, cli: number) => invoke<number>('pty_cli_note', { id, cli }),
  /** ...then end whatever of those is still there. Everything else in the tab stays. */
  ptyCliEnd: (id: string) => invoke<number>('pty_cli_end', { id }),

  cliVersions: () => invoke<CliVersion[]>('cli_versions'),
  cliUpdate: (cli: string) => invoke<UpdateResult>('cli_update', { cli }),
  cliProcesses: () => invoke<Record<string, number>>('cli_processes'),
  sessionExists: (cli: string, sessionId: string) => invoke<boolean>('session_exists', { cli, sessionId }),
  /** Past conversations of one CLI, newest first; with a folder, only that folder's. */
  sessionsList: (cli: string, cwd: string | null, limit: number) => invoke<SessionInfo[]>('sessions_list', { cli, cwd, limit }),
  /** Flashes the taskbar button until the window is brought to the front. */
  attention: (on: boolean) => invoke<void>('attention', { on }),

  storeLoad: <T>(name: string) => invoke<T | null>('store_load', { name }),
  storeSave: (name: string, value: unknown) => invoke<void>('store_save', { name, value }),
  /** Copies a store file that could not be read to `<name>.unreadable-<time>.json`; returns that name. */
  storeKeep: (name: string) => invoke<string>('store_keep', { name }),

  clipboardRead: () => invoke<ClipData>('clipboard_read'),
  clipboardWrite: (text: string) => invoke<void>('clipboard_write', { text }),

  transcriptLoad: (cli: string, cwd: string, sessionId: string | null, end: number | null) =>
    invoke<Transcript>('transcript_load', { cli, cwd, sessionId, end, window: null }),
};

export { Channel };
