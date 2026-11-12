// The command bar widget. bar.html mounts it as a page; the sidebar mounts it inline.

import { ICON, iconFor, cachedIcon, send, tint } from '../lib/shared.js';

const GLOBE = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#8a8f98" stroke-width="1.4"><circle cx="8" cy="8" r="5.500"/><path d="M2.500 8h11M8 2.500c2 1.700 2 9.300 0 11M8 2.500c-2 1.700-2 9.300 0 11"/></svg>',
)}`;

export function mountBar(root, { mode = 'new', windowId = null, token = null, compact = false, onClose = () => {}, onReady = () => {} } = {}) {
  root.classList.add('ab-root');
  if (compact) root.dataset.compact = '';
  root.innerHTML = `
    <div class="ab-bar" role="dialog" aria-label="Command bar">
      <label class="ab-field">
        ${ICON.search}
        <input class="ab-input" type="text" spellcheck="false" autocomplete="off" autocapitalize="off"
          placeholder="Search or enter address" aria-label="Search or enter address"
          role="combobox" aria-expanded="true" aria-controls="ab-list" aria-autocomplete="list">
      </label>
      <ul class="ab-list" id="ab-list" role="listbox" aria-label="Results"></ul>
      <div class="ab-foot">
        <span class="ab-where"></span>
        <span class="ab-keys"><span><kbd>↑</kbd><kbd>↓</kbd>move</span><span><kbd>↵</kbd>open</span><span><kbd>esc</kbd>close</span></span>
      </div>
    </div>`;
  const input = root.querySelector('.ab-input');
  const list = root.querySelector('.ab-list');
  const where = root.querySelector('.ab-where');
  const ctx = { mode, windowId };
  let items = [];
  let sel = 0;
  let seq = 0;
  let alive = true;
  let timer = null;
  let stale = false;

  function render() {
    list.replaceChildren(
      ...items.map((it, i) => {
        const li = document.createElement('li');
        li.className = 'ab-row';
        li.setAttribute('role', 'option');
        li.id = `ab-opt-${i}`;
        li.dataset.i = i;
        li.setAttribute('aria-selected', i === sel ? 'true' : 'false');
        const icon = document.createElement('span');
        icon.className = 'ab-icon';
        if (it.glyph && ICON[it.glyph]) {
          icon.innerHTML = ICON[it.glyph];
        } else {
          const img = document.createElement('img');
          img.alt = '';
          const fallbacks = [cachedIcon(it.url), GLOBE].filter(Boolean);
          img.onerror = () => {
            const next = fallbacks.shift();
            if (next) img.src = next;
          };
          img.src = iconFor(it.url, it.favIconUrl) || fallbacks.pop();
          icon.append(img);
        }
        const text = document.createElement('span');
        text.className = 'ab-text';
        const title = document.createElement('span');
        title.className = 'ab-title';
        title.textContent = it.title || it.url || '';
        text.append(title);
        if (it.sub) {
          const sub = document.createElement('span');
          sub.className = 'ab-sub';
          sub.textContent = it.sub;
          text.append(sub);
        }
        const hint = document.createElement('span');
        hint.className = 'ab-hint';
        hint.textContent = it.hint || '';
        li.append(icon, text, hint);
        return li;
      }),
    );
    input.setAttribute('aria-activedescendant', items.length ? `ab-opt-${sel}` : '');
  }

  function select(i) {
    if (!items.length) return;
    sel = (i + items.length) % items.length;
    for (const li of list.children) li.setAttribute('aria-selected', Number(li.dataset.i) === sel ? 'true' : 'false');
    list.children[sel]?.scrollIntoView({ block: 'nearest' });
    input.setAttribute('aria-activedescendant', `ab-opt-${sel}`);
  }

  async function query() {
    const my = ++seq;
    const r = await send('bar:query', { ...ctx, text: input.value });
    if (!alive || my !== seq || !r?.ok) return;
    stale = false;
    items = r.items || [];
    sel = 0;
    render();
  }

  async function run(i, background = false) {
    let item = items[i];
    if (!item) {
      const text = input.value.trim();
      if (!text) return;
      item = { kind: 'search', title: text };
    }
    alive = false;
    await send('bar:run', { ...ctx, item, background });
    alive = true;
    onClose({ ran: true, item });
  }

  input.addEventListener('input', () => {
    stale = true;
    clearTimeout(timer);
    timer = setTimeout(query, 45);
  });

  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault();
      select(sel + 1);
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault();
      select(sel - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(timer);
      // ⌘↩ opens the result in a background tab.
      const background = e.metaKey || e.ctrlKey;
      // If results lag the last keystroke, fetch them before acting on the top one.
      if (stale) query().then(() => run(items.length ? 0 : -1, background));
      else run(items.length ? sel : -1, background);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose({ ran: false });
    }
  });

  list.addEventListener('mousemove', (e) => {
    const li = e.target.closest('.ab-row');
    if (li && Number(li.dataset.i) !== sel) select(Number(li.dataset.i));
  });
  list.addEventListener('click', (e) => {
    const li = e.target.closest('.ab-row');
    if (li) run(Number(li.dataset.i));
  });
  // Keep typing focus in the field when a result is clicked.
  list.addEventListener('mousedown', (e) => e.preventDefault());

  (async () => {
    const r = await send('bar:init', { ...ctx, token });
    if (!r?.ok) {
      onClose({ ran: false, dead: true });
      return;
    }
    tint(root, r.space?.color);
    const name = r.space ? `${r.space.emoji} ${r.space.name}` : '';
    where.textContent =
      mode === 'current' ? 'Replaces this page' : mode === 'mini' ? 'Opens in this mini window' : r.multi && name ? `Opens in ${name}` : 'Opens in a new tab';
    if (mode === 'current' && r.currentUrl) {
      input.value = r.currentUrl;
      input.select();
    }
    onReady(r);
    query();
  })();

  input.focus();

  return {
    focus: () => input.focus(),
    reset: () => {
      input.value = '';
      input.focus();
      query();
    },
    destroy: () => {
      alive = false;
      clearTimeout(timer);
      root.replaceChildren();
    },
  };
}
