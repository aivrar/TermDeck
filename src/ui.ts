type Child = Node | string | null | undefined | false;

/** Tiny element builder: h('div', { class: 'x', onclick: fn }, 'text', child). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Record<string, unknown> | null,
  ...kids: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k in el && k !== 'list') {
        (el as unknown as Record<string, unknown>)[k] = v;
      } else el.setAttribute(k, String(v));
    }
  }
  for (const kid of kids) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid);
  }
  return el;
}

export function toast(message: string, kind: 'info' | 'error' = 'info', ms = 2600): void {
  const root = document.getElementById('toasts')!;
  const el = h('div', { class: `toast ${kind === 'error' ? 'error' : ''}` }, message);
  root.append(el);
  window.setTimeout(() => el.remove(), kind === 'error' ? ms * 2 : ms);
}

export interface ModalButton {
  label: string;
  kind?: 'primary' | 'danger' | 'left';
  /** Return false to keep the dialog open. */
  onClick?: () => boolean | void | Promise<boolean | void>;
}

export function isModalOpen(): boolean {
  return document.getElementById('modal-root')!.childElementCount > 0;
}

export function modal(title: string, body: HTMLElement, buttons: ModalButton[], onClose?: () => void): () => void {
  const root = document.getElementById('modal-root')!;
  const previous = document.activeElement as HTMLElement | null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    back.remove();
    window.removeEventListener('keydown', onKey, true);
    onClose?.();
    previous?.focus?.();
  };
  const primary = buttons.find((b) => b.kind === 'primary');
  const run = async (b: ModalButton) => {
    const keep = (await b.onClick?.()) === false;
    if (!keep) close();
  };
  const onKey = (e: KeyboardEvent) => {
    // Only the dialog on top answers the keyboard. With two open — a question that
    // came up over a dialog, as when the app is closed while Settings is showing — one
    // Enter used to press the main button of both, and one Esc to cancel both.
    if (root.lastElementChild !== back) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Enter' && primary && !(e.target instanceof HTMLTextAreaElement) && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      void run(primary);
    }
  };
  const foot = h('div', { class: 'foot' });
  for (const b of buttons) {
    foot.append(
      h(
        'button',
        {
          class: `btn ${b.kind === 'primary' ? 'primary' : ''} ${b.kind === 'danger' ? 'danger' : ''} ${b.kind === 'left' || b.kind === 'danger' ? 'left' : ''}`,
          onclick: () => void run(b),
        },
        b.label,
      ),
    );
  }
  const box = h('div', { class: 'modal' }, h('h2', null, title), body, foot);
  const back = h('div', {
    class: 'modal-back',
    onmousedown: (e: MouseEvent) => {
      if (e.target === back) close();
    },
  }, box);
  root.append(back);
  window.addEventListener('keydown', onKey, true);
  const first = box.querySelector<HTMLElement>('[autofocus], input, textarea, select');
  window.setTimeout(() => first?.focus(), 0);
  return close;
}

export function confirmDialog(title: string, message: string, okLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    let answer = false;
    modal(
      title,
      h('div', { class: 'body' }, h('p', null, message)),
      [
        { label: 'Cancel' },
        {
          label: okLabel,
          kind: 'primary',
          onClick: () => {
            answer = true;
          },
        },
      ],
      () => resolve(answer),
    );
  });
}

export type MenuItem = { label: string; onClick: () => void } | null;

export function menu(x: number, y: number, items: MenuItem[]): void {
  const root = document.getElementById('menu-root')!;
  root.replaceChildren();
  const close = () => {
    root.replaceChildren();
    window.removeEventListener('mousedown', outside, true);
    window.removeEventListener('keydown', esc, true);
  };
  const outside = (e: MouseEvent) => {
    if (!el.contains(e.target as Node)) close();
  };
  const esc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  const el = h('div', { class: 'menu' });
  for (const item of items) {
    if (!item) el.append(h('hr'));
    else
      el.append(
        h('button', {
          onclick: () => {
            close();
            item.onClick();
          },
        }, item.label),
      );
  }
  root.append(el);
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
  window.setTimeout(() => {
    window.addEventListener('mousedown', outside, true);
    window.addEventListener('keydown', esc, true);
  }, 0);
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
