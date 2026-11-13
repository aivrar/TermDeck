import { api, type HistoryMsg } from './api';
import type { Tab } from './tab';
import { h } from './ui';

/** Pages of history kept on screen at once (each is at most ~3 MB of the session file). */
const MAX_PAGES = 6;

/**
 * Read-only view of a tab's conversation, loaded from the CLI's own session file.
 * It opens on the newest page; "Load earlier" adds older pages above. At most
 * MAX_PAGES are kept: beyond that the newest ones are let go again (Refresh returns
 * to the end), so reading far back into a huge session never fills memory. Closing
 * the view frees everything.
 */
export function openHistory(paneBody: HTMLElement, tab: Tab, onClose: () => void): () => void {
  let start = 0;
  let filter = '';
  /** The pages on screen, oldest first. */
  let pages: HTMLElement[][] = [];
  const scroll = h('div', { class: 'history-scroll' });
  const src = h('span', { class: 'src' }, 'Loading…');
  const more = h('div', { class: 'more' });
  const list = h('div');
  const dropped = h('div', { class: 'more', hidden: true },
    h('span', { class: 'q-hint' }, 'Newer messages were let go to save memory — '),
    h('button', { class: 'btn small', onclick: () => void load(null) }, 'Back to the newest'));
  scroll.append(more, list, dropped);

  const search = h('input', {
    placeholder: 'Filter…',
    spellcheck: false,
    oninput: () => {
      filter = search.value.trim().toLowerCase();
      for (const el of list.children) {
        el.classList.toggle('hidden', !!filter && !(el.textContent ?? '').toLowerCase().includes(filter));
      }
    },
  });

  const close = () => {
    root.remove();
    onClose();
  };

  const root = h('div', { class: 'history' },
    h('div', { class: 'history-bar' },
      h('strong', null, 'History'),
      src,
      search,
      h('button', { class: 'btn small', title: 'Read the session file again', onclick: () => void load(null) }, 'Refresh'),
      h('button', { class: 'btn small primary', onclick: close }, 'Back to terminal'),
    ),
    scroll,
  );

  const render = (m: HistoryMsg): HTMLElement => {
    if (m.role === 'tool') {
      const el = h('div', { class: `hmsg tool ${m.kind}`, title: 'Click to expand' }, m.text);
      el.addEventListener('click', () => el.classList.toggle('open'));
      return el;
    }
    return h('div', { class: `hmsg ${m.role}` }, h('span', { class: 'who' }, m.role === 'user' ? 'You' : tab.state.cli), m.text);
  };

  /** end = null loads the newest page; a byte offset loads the page before it. */
  async function load(end: number | null): Promise<void> {
    const cli = tab.state.cli;
    try {
      const t = await api.transcriptLoad(cli, tab.state.cwd, tab.state.sessionId ?? null, end);
      if (!t.found) {
        src.textContent = '';
        // A tab that has a conversation of its own is shown that one or nothing —
        // never a different conversation that happens to be in the same folder.
        const id = tab.state.sessionId;
        const why = id
          ? `This tab's ${cli} conversation (${id}) has nothing saved yet, or its file is no longer there. ` +
            'Nothing else is shown in its place.'
          : `This tab's ${cli} conversation has not been identified yet (nothing has been sent in it, or it was started in a way TermDeck cannot follow). ` +
            'Other conversations in this folder are not shown in its place; they are listed under "Open…".';
        list.replaceChildren(h('div', { class: 'history-empty' }, why));
        more.replaceChildren();
        return;
      }
      src.textContent = `${t.title ? t.title + '  —  ' : ''}${t.path}`;
      src.title = t.path;
      const nodes = t.messages.map(render);
      if (end === null) {
        list.replaceChildren(...nodes);
        pages = [nodes];
        dropped.hidden = true;
        scroll.scrollTop = scroll.scrollHeight;
      } else {
        // Keep the reader's place while older messages are added above.
        const before = scroll.scrollHeight;
        list.prepend(...nodes);
        pages.unshift(nodes);
        scroll.scrollTop += scroll.scrollHeight - before;
        // Bounded: the newest pages, far below what is being read, are let go.
        while (pages.length > MAX_PAGES) {
          for (const el of pages.pop()!) el.remove();
          dropped.hidden = false;
        }
      }
      start = t.start;
      more.replaceChildren(
        start > 0
          ? h('button', { class: 'btn small', onclick: () => void load(start) },
              `Load earlier  (${(start / 1048576).toFixed(1)} MB of older history not loaded)`)
          : h('span', { class: 'q-hint' }, 'Start of the session'),
      );
      if (!list.childElementCount) {
        list.append(h('div', { class: 'history-empty' }, 'Nothing readable in this part of the file yet.'));
      }
      if (filter) search.dispatchEvent(new Event('input'));
    } catch (e) {
      list.replaceChildren(h('div', { class: 'history-empty' }, `Could not read the session file: ${String(e)}`));
    }
  }

  paneBody.append(root);
  void load(null);
  return close;
}
