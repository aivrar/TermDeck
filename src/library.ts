import { api, type CliKind } from './api';
import { h, modal, toast, uid } from './ui';

export type SnippetScope = 'all' | 'claude' | 'codex' | 'grok' | 'shell';

export interface Snippet {
  id: string;
  label: string;
  text: string;
  /** insert = put it in the input and wait; submit = insert and press Enter */
  mode: 'insert' | 'submit';
  /** pinned snippets appear as quick buttons under the terminal */
  pinned: boolean;
  scope: SnippetScope;
  folder: string;
}

export interface LibraryHost {
  /** Send a snippet to the focused terminal. */
  send(s: Snippet): void;
  /** CLI in the focused terminal, used to filter by scope. */
  activeCli(): CliKind;
  toggleLibrary(): void;
  libraryOpen(): boolean;
}

const SCOPE_LABEL: Record<SnippetScope, string> = {
  all: 'Everywhere',
  claude: 'Claude Code',
  codex: 'Codex',
  grok: 'Grok',
  shell: 'Plain shell',
};

function starter(): Snippet[] {
  const s = (label: string, text: string, mode: Snippet['mode'], scope: SnippetScope, folder: string, pinned = true): Snippet => ({
    id: uid(), label, text, mode, pinned, scope, folder,
  });
  return [
    s('claude', 'claude', 'submit', 'shell', 'Start a CLI'),
    s('codex', 'codex', 'submit', 'shell', 'Start a CLI'),
    s('grok', 'grok', 'submit', 'shell', 'Start a CLI'),
    s('git status', 'git status', 'submit', 'shell', 'Commands'),
    s('Summarize', 'Summarize what you changed, what you verified, and what is still left to do.', 'insert', 'all', 'Prompts'),
    s('Plan first', 'Before changing anything, explain your plan and wait for my go-ahead.', 'insert', 'all', 'Prompts'),
    s('Continue', 'Continue.', 'submit', 'all', 'Prompts', false),
  ];
}

export class Library {
  snippets: Snippet[] = [];
  private filter = '';
  private searchEl!: HTMLInputElement;
  private listEl!: HTMLDivElement;

  constructor(
    private readonly panel: HTMLElement,
    private readonly bar: HTMLElement,
    private readonly host: LibraryHost,
  ) {
    this.buildPanel();
  }

  /**
   * Set when the library file could not be read AND could not be copied aside: changes
   * are then not saved this run, so the file on disk — which may hold a library that
   * cannot be rebuilt — stays exactly as it is.
   */
  saveBlocked = false;
  private toldBlocked = false;

  async load(): Promise<void> {
    try {
      const saved = await api.storeLoad<{ snippets: Snippet[] }>('snippets');
      if (saved === null) {
        // No library yet: a first start.
        this.snippets = starter();
        this.save();
      } else if (Array.isArray(saved.snippets)) this.snippets = saved.snippets;
      else throw new Error('snippets.json is not a snippet library this version understands');
    } catch (e) {
      // A starter library is shown — and the first change to it would be saved over the
      // file that could not be read. So that file is copied aside first; if even the
      // copy fails, nothing is saved this run.
      this.snippets = starter();
      try {
        const copy = await api.storeKeep('snippets');
        toast(`Your snippet library could not be read, so the starter library is shown. Your file was kept as "${copy}" in the data folder. (${String(e)})`, 'error', 12000);
      } catch (e2) {
        this.saveBlocked = true;
        toast(`Your snippet library could not be read, and could not be copied either — so changes to the library will not be saved this time, to leave your file as it is. (${String(e)}; ${String(e2)})`, 'error', 20000);
      }
    }
    this.render();
  }

  private save(): void {
    if (this.saveBlocked) {
      if (!this.toldBlocked) toast('Not saved: the snippet library file could not be read at startup and is being left untouched. Restart TermDeck once the file is fixed.', 'error', 6000);
      this.toldBlocked = true;
      return;
    }
    void api.storeSave('snippets', { version: 1, snippets: this.snippets }).catch((e) =>
      toast(`Could not save the snippet library: ${String(e)}`, 'error'),
    );
  }

  private matchesScope(s: Snippet): boolean {
    if (s.scope === 'all') return true;
    const cli = this.host.activeCli();
    return s.scope === 'shell' ? cli === 'none' : s.scope === cli;
  }

  private buildPanel(): void {
    this.searchEl = h('input', {
      placeholder: 'Search…  (Ctrl+Shift+P)',
      spellcheck: false,
      oninput: () => {
        this.filter = this.searchEl.value.trim().toLowerCase();
        this.renderList();
      },
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          const first = this.visible()[0];
          if (first) {
            this.host.send(first);
            this.searchEl.value = '';
            this.filter = '';
            this.renderList();
          }
        } else if (e.key === 'Escape') {
          this.searchEl.value = '';
          this.filter = '';
          this.renderList();
          this.searchEl.blur();
        }
      },
    });
    this.listEl = h('div', { class: 'lib-list' });
    this.panel.replaceChildren(
      h('div', { class: 'lib-head' },
        h('span', { class: 'title' }, 'Library'),
        h('button', { class: 'btn small', onclick: () => this.edit() }, '+ New'),
        h('button', { class: 'btn small ghost', title: 'Hide the library', onclick: () => this.host.toggleLibrary() }, '✕'),
      ),
      h('div', { class: 'lib-search' }, this.searchEl),
      this.listEl,
    );
  }

  focusSearch(): void {
    this.searchEl.focus();
    this.searchEl.select();
  }

  private visible(): Snippet[] {
    const f = this.filter;
    return this.snippets.filter(
      (s) => !f || s.label.toLowerCase().includes(f) || s.text.toLowerCase().includes(f) || s.folder.toLowerCase().includes(f),
    );
  }

  render(): void {
    this.renderList();
    this.renderBar();
  }

  private renderList(): void {
    const items = this.visible();
    this.listEl.replaceChildren();
    if (!items.length) {
      this.listEl.append(h('div', { class: 'lib-empty' }, this.snippets.length ? 'Nothing matches.' : 'No snippets yet. Use + New.'));
      return;
    }
    const folders = [...new Set(items.map((s) => s.folder || 'General'))];
    for (const folder of folders) {
      this.listEl.append(h('div', { class: 'lib-folder' }, folder));
      for (const s of items.filter((x) => (x.folder || 'General') === folder)) {
        this.listEl.append(
          h('div', {
            class: 'snip',
            title: `${s.mode === 'submit' ? 'Insert and press Enter' : 'Insert'} — ${SCOPE_LABEL[s.scope]}\n\n${s.text}`,
            onclick: () => this.host.send(s),
          },
            h('div', { class: 's-main' },
              h('div', { class: 's-label' }, s.label, s.mode === 'submit' ? h('span', { class: 'mode' }, ' ↵') : null),
              h('div', { class: 's-prev' }, s.text.replace(/\s+/g, ' ')),
            ),
            h('button', {
              class: `s-act ${s.pinned ? 'pinned' : ''}`,
              title: s.pinned ? 'Remove from the quick bar' : 'Add to the quick bar',
              onclick: (e: MouseEvent) => {
                e.stopPropagation();
                s.pinned = !s.pinned;
                this.save();
                this.render();
              },
            }, s.pinned ? '★' : '☆'),
            h('button', {
              class: 's-act',
              title: 'Edit',
              onclick: (e: MouseEvent) => {
                e.stopPropagation();
                this.edit(s);
              },
            }, '✎'),
          ),
        );
      }
    }
  }

  /** The row of quick buttons under the terminal. */
  renderBar(): void {
    const scroll = h('div', { class: 'q-scroll' });
    const pinned = this.snippets.filter((s) => s.pinned && this.matchesScope(s));
    for (const s of pinned) {
      scroll.append(
        h('button', {
          class: `qbtn ${s.mode === 'submit' ? 'submit' : ''}`,
          title: `${s.mode === 'submit' ? 'Insert and press Enter' : 'Insert'}\n\n${s.text}`,
          onclick: () => this.host.send(s),
          oncontextmenu: (e: MouseEvent) => {
            e.preventDefault();
            this.edit(s);
          },
        }, s.label),
      );
    }
    if (!pinned.length) scroll.append(h('span', { class: 'q-hint' }, 'No quick buttons for this session. Star a snippet in the library to pin it here.'));
    // A horizontal strip: let the mouse wheel move it sideways.
    scroll.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && e.deltaY) scroll.scrollLeft += e.deltaY;
    }, { passive: true });
    this.bar.replaceChildren(
      scroll,
      h('button', { class: 'btn small', title: 'New snippet', onclick: () => this.edit() }, '+'),
      h('button', { class: 'btn small', title: 'Show or hide the snippet library', onclick: () => this.host.toggleLibrary() },
        this.host.libraryOpen() ? 'Library ›' : '‹ Library'),
    );
  }

  edit(existing?: Snippet): void {
    const draft: Snippet = existing
      ? { ...existing }
      : { id: uid(), label: '', text: '', mode: 'insert', pinned: true, scope: 'all', folder: '' };

    const label = h('input', { value: draft.label, placeholder: 'Shown on the button', spellcheck: false });
    const text = h('textarea', { value: draft.text, placeholder: 'The prompt or command to insert', spellcheck: false });
    const folder = h('input', { value: draft.folder, placeholder: 'Optional group name', spellcheck: false, list: 'folder-list' });
    const folders = h('datalist', { id: 'folder-list' }, ...[...new Set(this.snippets.map((s) => s.folder).filter(Boolean))].map((f) => h('option', { value: f })));
    const pinned = h('input', { type: 'checkbox', checked: draft.pinned });

    const choice = <T extends string>(options: [T, string][], get: () => T, set: (v: T) => void) => {
      const row = h('div', { class: 'choices' });
      const paint = () => {
        row.replaceChildren(
          ...options.map(([value, text]) =>
            h('button', {
              class: `choice ${get() === value ? 'on' : ''}`,
              onclick: () => {
                set(value);
                paint();
              },
            }, text),
          ),
        );
      };
      paint();
      return row;
    };

    const body = h('div', { class: 'body' },
      h('div', { class: 'field' }, h('label', null, 'Button label'), label),
      h('div', { class: 'field' }, h('label', null, 'Text'), text),
      h('div', { class: 'field' }, h('label', null, 'When clicked'),
        choice<Snippet['mode']>([['insert', 'Insert only'], ['submit', 'Insert and press Enter']], () => draft.mode, (v) => (draft.mode = v))),
      h('div', { class: 'field' }, h('label', null, 'Show for'),
        choice<SnippetScope>(Object.entries(SCOPE_LABEL) as [SnippetScope, string][], () => draft.scope, (v) => (draft.scope = v))),
      h('div', { class: 'field' }, h('label', null, 'Group'), folder, folders),
      h('label', { class: 'check' }, pinned, 'Show as a quick button under the terminal'),
    );

    const save = () => {
      draft.text = text.value;
      draft.label = label.value.trim() || draft.text.trim().split('\n')[0].slice(0, 28);
      draft.folder = folder.value.trim();
      draft.pinned = pinned.checked;
      if (!draft.text.trim()) {
        toast('The snippet has no text.', 'error');
        return false;
      }
      const i = this.snippets.findIndex((s) => s.id === draft.id);
      if (i >= 0) this.snippets[i] = draft;
      else this.snippets.push(draft);
      this.save();
      this.render();
      return true;
    };

    modal(existing ? 'Edit snippet' : 'New snippet', body, [
      ...(existing
        ? [{
            label: 'Delete',
            kind: 'danger' as const,
            onClick: () => {
              this.snippets = this.snippets.filter((s) => s.id !== existing.id);
              this.save();
              this.render();
            },
          }]
        : []),
      { label: 'Cancel' },
      { label: 'Save', kind: 'primary', onClick: save },
    ]);
  }
}
