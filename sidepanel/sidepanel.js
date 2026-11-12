// Arcadia's sidebar, shown in Firefox's sidebar. It renders the view the background
// script computes for this window and sends every change back to it.

import { ICON, hostOf, iconFor, letterIcon, tint, send } from '../lib/shared.js';
import { spaceForm } from '../lib/space-form.js';
import { mountBar } from '../bar/bar.js';

const $ = (id) => document.getElementById(id);
const isMac = /Mac/.test(navigator.platform);
let WIN = null;
let view = null;
let drag = null;
let bar = null;
let lastSpace = null;

// ---------------------------------------------------------------- setup

const scheme = matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => (document.documentElement.dataset.theme = scheme.matches ? 'dark' : 'light');
scheme.addEventListener('change', applyTheme);
applyTheme();

$('back').innerHTML = ICON.back;
$('forward').innerHTML = ICON.forward;
$('reload').innerHTML = ICON.reload;
$('copy').innerHTML = ICON.link;
$('archive').innerHTML = ICON.clock;
$('add-space').innerHTML = ICON.plus;
$('settings').innerHTML = ICON.sliders;
document.querySelector('.newtab .plus').innerHTML = ICON.plus;
$('newtab-key').textContent = isMac ? '⌘T' : 'Ctrl+T';
$('copy').title = `Copy link (${isMac ? '⇧⌘C' : 'Ctrl+Shift+C'})`;

let refreshing = false;
let again = false;
async function refresh() {
  if (refreshing) {
    again = true;
    return;
  }
  refreshing = true;
  try {
    const v = await send('view:get', { windowId: WIN });
    if (v?.ok) {
      view = v;
      render();
    }
  } finally {
    refreshing = false;
    if (again) {
      again = false;
      refresh();
    }
  }
}

chrome.runtime.onMessage.addListener((m, _sender, sendResponse) => {
  if (m?.type === 'arcadia:changed' && (m.windowId == null || m.windowId === WIN)) refresh();
  else if (m?.type === 'arcadia:toast' && (m.windowId == null || m.windowId === WIN)) toast(m.text);
  else if (m?.type === 'arcadia:bar-if-focused' && m.windowId === WIN && document.hasFocus()) {
    if (bar) closeBar();
    else openBar(m.mode);
    sendResponse({ ok: true });
  }
});

(async () => {
  WIN = (await chrome.windows.getCurrent()).id;
  await refresh();
})();
document.addEventListener('visibilitychange', () => !document.hidden && refresh());

// ---------------------------------------------------------------- render

function syncList(parent, items, keyOf, create, update) {
  const old = new Map([...parent.children].map((el) => [el.dataset.key, el]));
  let prev = null;
  for (const item of items) {
    const key = String(keyOf(item));
    let el = old.get(key);
    if (el) old.delete(key);
    else {
      el = create();
      el.dataset.key = key;
    }
    update(el, item);
    const want = prev ? prev.nextSibling : parent.firstChild;
    if (el !== want) parent.insertBefore(el, want);
    prev = el;
  }
  for (const el of old.values()) el.remove();
}

function setIcon(img, icon, url) {
  const src = iconFor(icon, url);
  if (img.dataset.src === src) return;
  img.dataset.src = src;
  img.onerror = () => {
    img.onerror = null;
    img.src = letterIcon(url);
  };
  img.src = src;
}

function makeRow() {
  const li = document.createElement('li');
  li.className = 'row';
  li.draggable = true;
  li.tabIndex = 0;
  li.innerHTML = `<img alt=""><span class="title"></span><button class="back" tabindex="-1" title="Go back to the pinned page">Back</button><button class="aud" tabindex="-1"></button><button class="x" tabindex="-1" title="Close tab" aria-label="Close tab">${ICON.x}</button>`;
  return li;
}

function paintRow(li, { kind, id, tab, title, url, icon, moved }) {
  li.dataset.kind = kind;
  li.dataset.id = id ?? '';
  li.dataset.tab = tab?.id ?? '';
  li.dataset.url = tab?.url || url || '';
  li.classList.toggle('active', !!tab?.active);
  li.classList.toggle('asleep', !tab || (tab.discarded && !tab.active));
  li.classList.toggle('audible', !!tab?.audible && !tab?.muted);
  li.classList.toggle('muted', !!tab?.muted);
  li.classList.toggle('loading', !!tab?.loading);
  li.classList.toggle('moved', !!moved);
  setIcon(li.querySelector('img'), icon || tab?.icon, tab?.url || url);
  const label = title || hostOf(tab?.url || url) || 'New tab';
  const t = li.querySelector('.title');
  if (t && t.textContent !== label) t.textContent = label;
  li.title = `${label}\n${tab?.url || url || ''}`;
  const aud = li.querySelector('.aud');
  const want = tab?.muted ? 'muted' : 'sound';
  if (aud.dataset.icon !== want) {
    aud.dataset.icon = want;
    aud.innerHTML = ICON[want];
    aud.title = tab?.muted ? 'Unmute tab' : 'Mute tab';
  }
}

function makeTile() {
  const li = document.createElement('li');
  li.className = 'tile';
  li.draggable = true;
  li.tabIndex = 0;
  li.innerHTML = '<img alt="">';
  return li;
}

function paintTile(li, f) {
  li.dataset.kind = 'item';
  li.dataset.id = f.id;
  li.dataset.tab = f.tab?.id ?? '';
  li.dataset.url = f.tab?.url || f.url;
  li.classList.toggle('active', !!f.tab?.active);
  li.classList.toggle('asleep', !f.tab || (f.tab.discarded && !f.tab.active));
  li.classList.toggle('audible', !!f.tab?.audible && !f.tab?.muted);
  setIcon(li.querySelector('img'), f.icon, f.url);
  li.title = `${f.title}\n${f.url}`;
  li.setAttribute('aria-label', f.title);
}

function render() {
  const sp = view.spaces.find((s) => s.id === view.activeSpaceId) || view.spaces[0];
  tint(document.documentElement, sp.color);

  $('top').hidden = !view.settings.panelNav;
  const cur = view.current;
  const host = hostOf(cur?.url);
  $('host').textContent = host || 'Search or enter address';
  $('host').classList.toggle('ghost', !host);
  for (const id of ['back', 'forward', 'reload', 'copy']) $(id).disabled = !cur;

  syncList($('favs'), view.favorites, (f) => f.id, makeTile, paintTile);
  $('space-emoji').textContent = sp.emoji;
  $('space-name').textContent = sp.name;

  syncList($('pinned'), view.pinned, (p) => `p${p.id}`, makeRow, (li, p) => paintRow(li, { kind: 'item', ...p }));
  syncList($('today'), view.today, (t) => `t${t.id}`, makeRow, (li, t) => paintRow(li, { kind: 'tab', tab: t, title: t.title, url: t.url, icon: t.icon }));

  $('empty').hidden = view.today.length > 0;
  $('empty').textContent = view.pinned.length
    ? `No other tabs open in ${sp.name}.`
    : `Nothing open in ${sp.name} yet. Press ${isMac ? '⌘T' : 'Ctrl+T'} to start, or drag a tab above the line to pin it.`;
  $('clear').hidden = view.today.filter((t) => !t.active && !t.audible).length === 0;

  const many = view.spaces.length > 1;
  syncList(
    $('dots'),
    many ? view.spaces : [],
    (s) => s.id,
    () => {
      const b = document.createElement('button');
      b.className = 'dot';
      b.setAttribute('role', 'tab');
      return b;
    },
    (b, s) => {
      b.dataset.id = s.id;
      b.textContent = s.emoji;
      b.title = s.name;
      b.setAttribute('aria-label', s.name);
      b.setAttribute('aria-selected', s.id === sp.id ? 'true' : 'false');
    },
  );

  // Slide the lists in from the side the new space sits on.
  if (lastSpace && lastSpace !== sp.id && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const from = view.spaces.findIndex((s) => s.id === lastSpace);
    const to = view.spaces.findIndex((s) => s.id === sp.id);
    const dx = (to > from ? 1 : -1) * 18;
    for (const el of [$('scroll'), $('space')]) {
      el.animate([{ opacity: 0, transform: `translateX(${dx}px)` }, { opacity: 1, transform: 'none' }], { duration: 190, easing: 'ease-out' });
    }
  }
  lastSpace = sp.id;
}

// ---------------------------------------------------------------- rows: click, keys

function infoOf(el) {
  const node = el?.closest?.('.row, .tile');
  if (!node || !node.dataset.kind) return null;
  const zone = node.closest('#favs') ? 'favs' : node.closest('#pinned') ? 'pinned' : node.closest('#today') ? 'today' : null;
  if (!zone) return null;
  return {
    el: node,
    zone,
    kind: node.dataset.kind,
    id: node.dataset.id || null,
    tabId: node.dataset.tab ? Number(node.dataset.tab) : null,
    url: node.dataset.url,
  };
}

function activate(info) {
  if (info.kind === 'tab') chrome.tabs.update(info.tabId, { active: true }).catch(() => {});
  else send('item:open', { windowId: WIN, id: info.id });
}

function closeTab(info) {
  if (info.tabId != null) chrome.tabs.remove(info.tabId).catch(() => {});
}

$('app').addEventListener('click', (e) => {
  const info = infoOf(e.target);
  if (!info || e.target.closest('input')) return;
  if (e.target.closest('.x')) return closeTab(info);
  if (e.target.closest('.aud')) {
    const muted = info.el.classList.contains('muted');
    return chrome.tabs.update(info.tabId, { muted: !muted }).catch(() => {});
  }
  if (e.target.closest('.back')) return send('item:reset', { windowId: WIN, id: info.id });
  activate(info);
});

$('app').addEventListener('auxclick', (e) => {
  const info = infoOf(e.target);
  if (info && e.button === 1) {
    e.preventDefault();
    closeTab(info);
  }
});

$('app').addEventListener('dblclick', (e) => {
  const info = infoOf(e.target);
  if (info?.zone === 'pinned' && !e.target.closest('button')) rename(info);
});

$('app').addEventListener('keydown', (e) => {
  const info = infoOf(e.target);
  if (!info || e.target !== info.el) return;
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    activate(info);
  } else if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault();
    closeTab(info);
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const all = [...document.querySelectorAll('#app .tile, #app .row')];
    all[all.indexOf(info.el) + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
  }
});

function rename(info) {
  const title = info.el.querySelector('.title');
  if (!title) return;
  const input = document.createElement('input');
  input.className = 'rename';
  input.value = title.textContent;
  input.setAttribute('aria-label', 'Tab name');
  title.replaceWith(input);
  info.el.draggable = false;
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    input.replaceWith(title);
    info.el.draggable = true;
    if (save) send('item:rename', { id: info.id, title: input.value });
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

// ---------------------------------------------------------------- header and footer

$('back').addEventListener('click', () => view?.current && chrome.tabs.goBack(view.current.id).catch(() => {}));
$('forward').addEventListener('click', () => view?.current && chrome.tabs.goForward(view.current.id).catch(() => {}));
$('reload').addEventListener('click', () => view?.current && chrome.tabs.reload(view.current.id).catch(() => {}));
$('copy').addEventListener('click', () => send('copy-url', { windowId: WIN }));
$('addr').addEventListener('click', () => openBar('current'));
$('newtab').addEventListener('click', () => openBar('new'));
$('clear').addEventListener('click', async () => {
  const r = await send('today:clear', { windowId: WIN });
  if (r?.closed) toast(`Closed ${r.closed} ${r.closed === 1 ? 'tab' : 'tabs'}`);
});
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('add-space').addEventListener('click', () => spaceSheet(null));
$('space').addEventListener('click', () => spaceSheet(view.spaces.find((s) => s.id === view.activeSpaceId)));
$('archive').addEventListener('click', closedSheet);

$('dots').addEventListener('click', (e) => {
  const dot = e.target.closest('.dot');
  if (dot) send('space:switch', { windowId: WIN, id: dot.dataset.id });
});

// Two-finger swipe across the sidebar moves between spaces. The lists follow the
// fingers; past the threshold the neighbouring space takes over. There is no wrap
// at either end, only a little give.
const SWIPE_COMMIT = 110;
const swipe = { x: 0, done: false, timer: null };
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function pull(px) {
  if (still()) return;
  for (const el of [$('scroll'), $('space'), $('favs')]) {
    el.style.transition = 'none';
    el.style.transform = px ? `translateX(${px}px)` : '';
    el.style.opacity = px ? String(Math.max(0.35, 1 - Math.abs(px) / 220)) : '';
  }
}

function settle() {
  for (const el of [$('scroll'), $('space'), $('favs')]) {
    el.style.transition = still() ? 'none' : 'transform .18s ease-out, opacity .18s ease-out';
    el.style.transform = '';
    el.style.opacity = '';
  }
}

$('app').addEventListener(
  'wheel',
  (e) => {
    if (!view || view.spaces.length < 2 || Math.abs(e.deltaX) < Math.abs(e.deltaY) * 1.5) return;
    e.preventDefault();
    clearTimeout(swipe.timer);
    // Trackpads keep sending momentum after the fingers lift; the gesture ends when it goes quiet.
    swipe.timer = setTimeout(() => {
      if (!swipe.done) settle();
      swipe.x = 0;
      swipe.done = false;
    }, 180);
    if (swipe.done) return;
    swipe.x += e.deltaX;
    const i = view.spaces.findIndex((s) => s.id === view.activeSpaceId);
    const next = view.spaces[i + (swipe.x > 0 ? 1 : -1)];
    if (next && Math.abs(swipe.x) >= SWIPE_COMMIT) {
      swipe.done = true;
      pull(0);
      send('space:switch', { windowId: WIN, id: next.id });
      return;
    }
    pull(-(next ? swipe.x * 0.45 : Math.sign(swipe.x) * Math.min(14, Math.abs(swipe.x) * 0.12)));
  },
  { passive: false },
);

// ---------------------------------------------------------------- drag and drop

const line = $('drop-line');

function dropTarget(e) {
  const t = e.target instanceof Element ? e.target : null;
  if (!t || !drag) return null;
  const dot = t.closest('.dot');
  if (dot) return { zone: 'space', spaceId: dot.dataset.id, el: dot };

  if (t.closest('#favs, #top')) {
    const tiles = [...$('favs').children].filter((c) => c !== drag.el);
    let index = tiles.length;
    for (let i = 0; i < tiles.length; i++) {
      const r = tiles[i].getBoundingClientRect();
      if (e.clientY < r.top || (e.clientY <= r.bottom && e.clientX < r.left + r.width / 2)) {
        index = i;
        break;
      }
    }
    const at = tiles[index] || null;
    const last = tiles[tiles.length - 1];
    const box = at ? at.getBoundingClientRect() : last?.getBoundingClientRect();
    const mark = box
      ? { left: (at ? box.left : box.right) - 1 + (at ? -3 : 3), top: box.top + 4, width: 2, height: box.height - 8 }
      : (() => {
          const r = $('top').getBoundingClientRect();
          return { left: r.left, top: r.bottom + 3, width: r.width, height: 2 };
        })();
    return { zone: 'favs', index, mark };
  }

  const inPinned = t.closest('#pinned, #rule, #space');
  if (inPinned || t.closest('#scroll')) {
    const list = inPinned ? $('pinned') : $('today');
    const rows = [...list.children].filter((c) => c !== drag.el);
    let index = rows.length;
    if (!t.closest('#rule') && !t.closest('#space')) {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i].getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) {
          index = i;
          break;
        }
      }
    } else if (t.closest('#space')) index = 0;
    const at = rows[index] || null;
    const last = rows[rows.length - 1];
    const lr = list.getBoundingClientRect();
    const y = at ? at.getBoundingClientRect().top - 2 : last ? last.getBoundingClientRect().bottom + 1 : inPinned ? $('rule').getBoundingClientRect().top - 2 : lr.top;
    return {
      zone: inPinned ? 'pinned' : 'today',
      index,
      beforeTabId: at ? Number(at.dataset.tab) : null,
      mark: { left: lr.left + 4, top: y, width: lr.width - 8, height: 2 },
    };
  }
  return null;
}

function clearDropMarks() {
  line.hidden = true;
  document.querySelectorAll('.dot.over').forEach((d) => d.classList.remove('over'));
}

document.addEventListener('dragstart', (e) => {
  const info = infoOf(e.target);
  if (!info) return;
  drag = info;
  info.el.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  if (info.url) {
    e.dataTransfer.setData('text/uri-list', info.url);
    e.dataTransfer.setData('text/plain', info.url);
  }
});

document.addEventListener('dragover', (e) => {
  const target = dropTarget(e);
  clearDropMarks();
  if (!target) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (target.zone === 'space') target.el.classList.add('over');
  else {
    Object.assign(line.style, {
      left: `${target.mark.left}px`,
      top: `${target.mark.top}px`,
      width: `${target.mark.width}px`,
      height: `${target.mark.height}px`,
    });
    line.hidden = false;
  }
});

document.addEventListener('drop', (e) => {
  const target = dropTarget(e);
  clearDropMarks();
  if (!target || !drag) return;
  e.preventDefault();
  const src = drag.kind === 'tab' ? { kind: 'tab', id: drag.tabId } : { kind: 'item', id: drag.id };
  if (target.zone === 'space') {
    if (drag.zone === 'pinned') send('item:place', { windowId: WIN, src, dest: { zone: 'pinned', spaceId: target.spaceId } });
    else if (drag.tabId != null) send('tab:toSpace', { windowId: WIN, tabId: drag.tabId, spaceId: target.spaceId });
  } else if (target.zone === 'today') {
    send('item:place', { windowId: WIN, src, dest: { zone: 'today', beforeTabId: target.beforeTabId } });
  } else {
    send('item:place', { windowId: WIN, src, dest: { zone: target.zone, index: target.index } });
  }
});

document.addEventListener('dragend', () => {
  drag?.el.classList.remove('dragging');
  drag = null;
  clearDropMarks();
});

// ---------------------------------------------------------------- right-click menus

const menu = $('menu');

function openMenu(x, y, items) {
  menu.replaceChildren(
    ...items.filter(Boolean).map((it) => {
      if (it === '-') return document.createElement('hr');
      const b = document.createElement('button');
      b.setAttribute('role', 'menuitem');
      b.textContent = it.label;
      if (it.danger) b.className = 'danger';
      b.addEventListener('click', () => {
        closeMenu();
        it.run();
      });
      return b;
    }),
  );
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(6, Math.min(x, innerWidth - r.width - 6))}px`;
  menu.style.top = `${Math.max(6, Math.min(y, innerHeight - r.height - 6))}px`;
  menu.querySelector('button')?.focus();
}

function closeMenu() {
  menu.hidden = true;
}

document.addEventListener('mousedown', (e) => {
  if (!menu.hidden && !menu.contains(e.target)) closeMenu();
});
window.addEventListener('blur', closeMenu);
menu.addEventListener('keydown', (e) => {
  const items = [...menu.querySelectorAll('button')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') items[(i + 1) % items.length]?.focus();
  else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length]?.focus();
  else if (e.key === 'Escape') closeMenu();
  else return;
  e.preventDefault();
});

const copyText = (text) => navigator.clipboard.writeText(text).then(() => toast('Copied link'), () => {});

document.addEventListener('contextmenu', (e) => {
  if (e.target.closest('input')) return;
  e.preventDefault();
  const dot = e.target.closest('.dot');
  if (dot) {
    const sp = view.spaces.find((s) => s.id === dot.dataset.id);
    return openMenu(e.clientX, e.clientY, [{ label: `Edit ${sp.name}…`, run: () => spaceSheet(sp) }]);
  }
  const info = infoOf(e.target);
  if (!info) return;
  const place = (dest) => send('item:place', { windowId: WIN, src: info.kind === 'tab' ? { kind: 'tab', id: info.tabId } : { kind: 'item', id: info.id }, dest });
  const others = view.spaces.filter((s) => s.id !== view.activeSpaceId);
  const live = info.tabId != null;
  const sp = view.spaces.find((s) => s.id === view.activeSpaceId);
  const items = [];

  if (info.zone === 'today') {
    items.push(
      { label: `Pin to ${sp.name}`, run: () => place({ zone: 'pinned' }) },
      { label: 'Keep pinned in every space', run: () => place({ zone: 'favs' }) },
      '-',
      { label: 'Copy link', run: () => copyText(info.url) },
      { label: 'Duplicate', run: () => chrome.tabs.duplicate(info.tabId) },
      { label: 'Open in mini window', run: () => send('tab:pop', { tabId: info.tabId }) },
      ...others.map((s) => ({ label: `Move to ${s.emoji} ${s.name}`, run: () => send('tab:toSpace', { windowId: WIN, tabId: info.tabId, spaceId: s.id }) })),
      '-',
      { label: 'Close', run: () => closeTab(info) },
      view.today.length > 1 && { label: 'Close other tabs', run: () => send('tab:closeOthers', { windowId: WIN, tabId: info.tabId }) },
    );
  } else {
    const entry = (info.zone === 'favs' ? view.favorites : view.pinned).find((x) => x.id === info.id);
    items.push(
      !live && { label: 'Open', run: () => activate(info) },
      info.zone === 'pinned' && { label: 'Rename…', run: () => rename(info) },
      { label: 'Copy link', run: () => copyText(entry?.url || info.url) },
      entry?.moved && { label: 'Go back to the pinned page', run: () => send('item:reset', { windowId: WIN, id: info.id }) },
      entry?.moved && { label: 'Pin this page instead', run: () => send('item:seturl', { windowId: WIN, id: info.id }) },
      '-',
      info.zone === 'pinned' && { label: 'Keep pinned in every space', run: () => place({ zone: 'favs' }) },
      info.zone === 'favs' && { label: `Pin to ${sp.name} only`, run: () => place({ zone: 'pinned' }) },
      ...(info.zone === 'pinned' ? others.map((s) => ({ label: `Move to ${s.emoji} ${s.name}`, run: () => place({ zone: 'pinned', spaceId: s.id }) })) : []),
      { label: 'Unpin', run: () => (live ? place({ zone: 'today' }) : send('item:remove', { windowId: WIN, id: info.id })) },
      live && '-',
      live && { label: 'Close tab', run: () => closeTab(info) },
    );
  }
  openMenu(e.clientX, e.clientY, items);
});

// ---------------------------------------------------------------- sheets

const scrim = $('scrim');
const sheet = $('sheet');

function closeSheet() {
  scrim.hidden = true;
  sheet.replaceChildren();
  if (view) render();
}
scrim.addEventListener('mousedown', (e) => e.target === scrim && closeSheet());

function spaceSheet(space) {
  sheet.replaceChildren(
    spaceForm({
      space,
      spaces: view.spaces,
      windowId: WIN,
      onPreview: (color) => tint(document.documentElement, color),
      onDone: closeSheet,
    }),
  );
  scrim.hidden = false;
}

function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}

// Firefox's own recently-closed list. Arcadia keeps no record of closed tabs.
async function closedSheet() {
  const r = await send('closed:get');
  const items = r?.items || [];
  sheet.innerHTML = `
    <div class="sheet-head"><h2>Recently closed</h2></div>
    ${items.length ? '<ul class="rows"></ul>' : '<p class="note">Nothing closed recently. This list is Firefox\'s own; Arcadia keeps no record of your tabs.</p>'}`;
  const ul = sheet.querySelector('ul');
  for (const a of items) {
    const li = document.createElement('li');
    li.className = 'row';
    li.tabIndex = 0;
    li.dataset.id = a.id;
    li.title = `${a.title}\n${a.url}`;
    const img = document.createElement('img');
    img.alt = '';
    setIcon(img, '', a.url);
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = a.title;
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = a.at ? ago(a.at) : '';
    li.append(img, title, when);
    ul.append(li);
  }
  const open = async (li) => {
    await send('closed:restore', { id: li.dataset.id });
    closeSheet();
  };
  sheet.onclick = (e) => {
    const li = e.target.closest('.row');
    if (li) open(li);
  };
  sheet.onkeydown = (e) => {
    const li = e.target.closest?.('.row');
    if (li && e.key === 'Enter') open(li);
  };
  scrim.hidden = false;
}

// ---------------------------------------------------------------- command bar inside the sidebar

const barwrap = $('barwrap');

function openBar(mode) {
  if (bar) return bar.focus();
  barwrap.hidden = false;
  bar = mountBar($('barhost'), { mode, windowId: WIN, compact: true, onClose: closeBar });
}

function closeBar() {
  bar?.destroy();
  bar = null;
  barwrap.hidden = true;
}
barwrap.addEventListener('mousedown', (e) => !e.target.closest('.ab-bar') && closeBar());

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!menu.hidden) closeMenu();
  else if (!scrim.hidden) closeSheet();
});

// ---------------------------------------------------------------- toast

let toastTimer = null;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 1600);
}
