// Arcadia background script (Firefox).
//
// Owns all state. Every space after the first is a Firefox container, so spaces keep
// separate logins. A tab belongs to the space that was open when it appeared; tabs of
// other spaces are hidden from Firefox's own tab strip and from Ctrl+Tab. The sidebar
// (sidepanel/) is Arcadia's panel in Firefox's sidebar. Pages talk to this file
// through runtime messages and re-read their view when it broadcasts "arcadia:changed".
//
// Privacy: this file makes no network requests and keeps no record of browsing.
// Disk (storage.local) holds only what the user creates: spaces, pinned entries
// (with their site icon), settings and which space was last open. Tab ids and the
// icons of open tabs live in session memory.

import { COLOR_NAMES, hostOf } from './lib/shared.js';

const EXT = chrome.runtime.getURL('');
const BAR_URL = chrome.runtime.getURL('bar/bar.html');
const START_URL = `${BAR_URL}?mode=tab`;
const NTP_RE = /^about:(newtab|home)\b/i;
const DEFAULT_STORE = 'firefox-default';
const TAB_KEY = 'arcadia-space';
const BOOT_GRACE_MS = 4000;

// Arcadia's colour names, as Firefox container colours.
const FF_COLOR = { grey: 'toolbar', blue: 'blue', red: 'red', yellow: 'yellow', green: 'green', pink: 'pink', purple: 'purple', cyan: 'turquoise', orange: 'orange' };
// Firefox containers take one of a fixed set of icons; pick the nearest to the space's emoji.
const FF_ICON = { '💼': 'briefcase', '💰': 'dollar', '🛒': 'cart', '✈️': 'vacation', '🌿': 'tree', '🏠': 'fence', '🎮': 'chill', '🎧': 'chill', '📚': 'fruit', '❤️': 'pet', '⭐': 'gift', '🧠': 'fingerprint' };

const DEFAULT_SETTINGS = {
  newTabOpensBar: true, // swap Firefox's new tab for the command bar
  copyUrlShortcut: true, // ⇧⌘C on pages copies the link
  shiftClickMini: true, // shift-click a link opens it in a mini window
  cleanLinks: true, // copied links drop tracking parameters
  searchHistory: true, // the command bar looks in Firefox's history and bookmarks (read only)
  keepInSpace: true, // a tab opened outside Arcadia is reopened in the current space's container
  externalToMini: false, // links from other apps open in a mini window (experimental)
  archiveAfterHours: 0, // 0 = never
  miniWidth: 980,
  miniHeight: 700,
  panelNav: false, // back/forward/address row at the top of the sidebar
};

let S = null; // persistent: spaces, pinned, favorites, settings
let T = null; // per browser session: which tab is in which space, and tab ids of pinned entries
let selfUntil = 0; // tabs created before this timestamp are ours
const own = new Set(); // ids of tabs Arcadia opened itself
const icons = new Map(); // tabId -> { site, data }: site icons reported by the page script

const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const getTab = (id) => chrome.tabs.get(id).catch(() => null);
const multi = () => S.spaces.length > 1;
const spaceById = (id) => S.spaces.find((s) => s.id === id) || null;
const storeOf = (tab) => tab?.cookieStoreId || DEFAULT_STORE;
const isWeb = (url) => /^https?:/i.test(url || '');

// ---------------------------------------------------------------- state

const ready = (async () => {
  const l = await chrome.storage.local.get(['spaces', 'pinned', 'favorites', 'settings', 'lastSpace']);
  const fresh = !Array.isArray(l.spaces) || !l.spaces.length;
  S = {
    // The first space uses Firefox's ordinary cookie jar, so existing logins keep working.
    spaces: fresh ? [{ id: uid(), name: 'Personal', emoji: '🌿', color: 'blue', store: null, isolated: false }] : l.spaces,
    pinned: l.pinned || {},
    favorites: l.favorites || [],
    lastSpace: l.lastSpace || null,
    settings: { ...DEFAULT_SETTINGS, ...Object.fromEntries(Object.entries(l.settings || {}).filter(([k]) => k in DEFAULT_SETTINGS)) },
  };
  if (fresh || !l.settings) await chrome.storage.local.set({ spaces: S.spaces, settings: S.settings });
  const all = await chrome.storage.session.get(null);
  T = all.T || {
    boot: Date.now(),
    tabSpace: {}, // tabId -> spaceId
    fresh: {}, // tabId -> true while a new tab has not shown its first web address yet
    activeSpace: {}, // windowId -> spaceId
    lastTab: {}, // `${windowId}:${spaceId}` -> tabId
    live: {}, // windowId -> { itemId: tabId } for pinned entries and favorites
    mini: {}, // windowId -> true
    hist: {}, // windowId -> recently active tab ids
    relinked: {},
    tokens: {}, // one-time tokens for the in-page command bar
    frames: {}, // trusted command bar frames -> tabId
    lastNormal: null,
    unfocused: false,
    focusGainAt: 0,
  };
  for (const [k, v] of Object.entries(all)) if (k.startsWith('icon:')) icons.set(Number(k.slice(5)), v);
  if (!all.T) {
    // A fresh browser session: restored tabs carry the space they were in.
    for (const t of await chrome.tabs.query({})) {
      const sid = await chrome.sessions.getTabValue(t.id, TAB_KEY).catch(() => null);
      if (spaceById(sid)) T.tabSpace[t.id] = sid;
    }
  }
})();

const saveS = (...keys) => chrome.storage.local.set(Object.fromEntries(keys.map((k) => [k, S[k]])));

let lastT = '';
async function flushT() {
  const s = JSON.stringify(T);
  if (s === lastT) return;
  lastT = s;
  await chrome.storage.session.set({ T });
}

// Every state change runs through this queue so handlers never interleave.
let chain = Promise.resolve();
function locked(fn) {
  const run = chain.then(async () => {
    await ready;
    try {
      return await fn();
    } finally {
      await flushT().catch(() => {});
    }
  });
  chain = run.catch((e) => console.warn('[arcadia]', e));
  return run;
}

const notifyTimers = new Map();
function notify(windowId = null) {
  if (notifyTimers.has(windowId)) return;
  notifyTimers.set(
    windowId,
    setTimeout(() => {
      notifyTimers.delete(windowId);
      chrome.runtime.sendMessage({ type: 'arcadia:changed', windowId }).catch(() => {});
    }, 40),
  );
}

const reconcileTimers = new Map();
function scheduleReconcile(windowId, delay = 60) {
  clearTimeout(reconcileTimers.get(windowId));
  reconcileTimers.set(
    windowId,
    setTimeout(() => {
      reconcileTimers.delete(windowId);
      locked(() => reconcile(windowId)).catch(() => {});
    }, delay),
  );
}

// ---------------------------------------------------------------- tabs and their spaces

function assign(tabId, sid) {
  if (T.tabSpace[tabId] === sid) return;
  T.tabSpace[tabId] = sid;
  // Firefox keeps this with the tab, so it survives a restart.
  chrome.sessions.setTabValue(tabId, TAB_KEY, sid).catch(() => {});
}

function spaceOfTab(tab) {
  const sid = T.tabSpace[tab.id];
  if (spaceById(sid)) return sid;
  // Not seen before: its container says which space, else the space with no container.
  const store = storeOf(tab);
  const sp = S.spaces.find((s) => (s.store || DEFAULT_STORE) === store) || S.spaces[0];
  assign(tab.id, sp.id);
  return sp.id;
}

function rememberSpace(sid) {
  if (S.lastSpace === sid) return;
  S.lastSpace = sid;
  chrome.storage.local.set({ lastSpace: sid }).catch(() => {});
}

// An icon is tied to its site by a short hash, so no site name is kept with it.
function siteTag(url) {
  let h = 2166136261;
  for (const c of hostOf(url)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0).toString(36);
}

function iconOf(tab) {
  const i = icons.get(tab.id);
  if (i && i.site === siteTag(tab.url)) return i.data;
  return (tab.favIconUrl || '').startsWith('data:image/') ? tab.favIconUrl : '';
}

// Gives a space its Firefox container: an unused one with the same name, or a new one.
async function ensureStore(sp) {
  if (sp.store || !sp.isolated || !chrome.contextualIdentities) return sp.store || null;
  try {
    const used = new Set(S.spaces.map((s) => s.store).filter(Boolean));
    const same = (await chrome.contextualIdentities.query({ name: sp.name })).find((c) => !used.has(c.cookieStoreId));
    const c = same || (await chrome.contextualIdentities.create({ name: sp.name, color: FF_COLOR[sp.color] || 'blue', icon: FF_ICON[sp.emoji] || 'circle' }));
    sp.store = c.cookieStoreId;
    await saveS('spaces');
  } catch {
    // Containers are switched off in Firefox. The space still works, with shared logins.
  }
  return sp.store || null;
}

// All of Arcadia's own tab opening goes through here, so the tab lands in the right
// space and, for web pages, in that space's container.
async function createTab(props, sid = null) {
  selfUntil = Date.now() + 1500;
  const sp = spaceById(sid) || spaceById(T.activeSpace[props.windowId]) || null;
  const p = { ...props };
  if (sp && !p.cookieStoreId && (isWeb(p.url) || p.url === 'about:blank')) {
    const store = await ensureStore(sp);
    if (store) p.cookieStoreId = store;
  }
  let tab;
  try {
    tab = await chrome.tabs.create(p);
  } catch (e) {
    if (!p.cookieStoreId) throw e;
    // The container was removed in Firefox's settings: make it again and retry once.
    delete p.cookieStoreId;
    if (sp && sp.store) {
      sp.store = null;
      const store = await ensureStore(sp);
      if (store) p.cookieStoreId = store;
    }
    tab = await chrome.tabs.create(p);
  }
  own.add(tab.id);
  if ((p.url || '').startsWith(BAR_URL)) T.fresh[tab.id] = true;
  if (sp) assign(tab.id, sp.id);
  return tab;
}

// A tab that opened outside Arcadia (a bookmark, a link from another app, the address
// bar of a blank tab) starts in Firefox's default container. If its space has its own
// container, reopen it there. Returns the tab that should be used from now on.
async function settleContainer(tab) {
  if (!isWeb(tab.url)) return tab;
  delete T.fresh[tab.id];
  const sp = spaceById(T.tabSpace[tab.id]);
  if (!S.settings.keepInSpace || !sp?.isolated || storeOf(tab) !== DEFAULT_STORE || tab.pinned || T.mini[tab.windowId]) return tab;
  const store = await ensureStore(sp);
  if (!store) return tab;
  const next = await createTab({ windowId: tab.windowId, url: tab.url, index: tab.index, active: tab.active, cookieStoreId: store }, sp.id);
  await chrome.tabs.remove(tab.id).catch(() => {});
  return next;
}

// ---------------------------------------------------------------- links between entries and tabs

const liveMap = (w) => (T.live[w] ||= {});
const itemOfTab = (w, tabId) => Object.keys(liveMap(w)).find((k) => liveMap(w)[k] === tabId) || null;
function unlinkTab(tabId) {
  for (const w in T.live) for (const k in T.live[w]) if (T.live[w][k] === tabId) delete T.live[w][k];
}

// Our own pin and unpin calls, so the tabs.onUpdated handler can tell them from the user's.
const expectPin = new Map();
// Tabs just reported as unpinned, until we know whether that was a close.
const pendingUnpin = new Set();
async function setPinned(tab, pinned) {
  if (!tab || tab.pinned === pinned) return false;
  expectPin.set(tab.id, { pinned, at: Date.now() });
  try {
    await chrome.tabs.update(tab.id, { pinned });
    return true;
  } catch {
    expectPin.delete(tab.id);
    return false;
  }
}

function findItem(id) {
  let idx = S.favorites.findIndex((f) => f.id === id);
  if (idx >= 0) return { zone: 'favs', spaceId: null, arr: S.favorites, idx, item: S.favorites[idx] };
  for (const sp of S.spaces) {
    const arr = S.pinned[sp.id] || [];
    idx = arr.findIndex((p) => p.id === id);
    if (idx >= 0) return { zone: 'pinned', spaceId: sp.id, arr, idx, item: arr[idx] };
  }
  return null;
}

function activeSpace(windowId, tabs) {
  const front = tabs?.find((t) => t.active);
  if (front && !front.pinned) return (T.activeSpace[windowId] = spaceOfTab(front));
  let sid = T.activeSpace[windowId];
  if (!spaceById(sid)) sid = spaceById(S.lastSpace) ? S.lastSpace : S.spaces[0].id;
  return (T.activeSpace[windowId] = sid);
}

// After a restart tab ids are new, so pinned entries find their tabs again by address.
function relink(windowId, tabs) {
  if (T.relinked[windowId]) return;
  if (Date.now() - T.boot > 8000) T.relinked[windowId] = true;
  const map = liveMap(windowId);
  const used = new Set(Object.values(map));
  const claim = (item, cands) => {
    if (map[item.id] != null) return;
    // Nothing about where a pinned tab wandered is stored, so match on the saved link, then its site.
    const free = cands.filter((t) => !used.has(t.id));
    const host = hostOf(item.url);
    const t = free.find((x) => x.url === item.url) || (host ? free.find((x) => hostOf(x.url) === host) : null);
    if (t) {
      map[item.id] = t.id;
      used.add(t.id);
    }
  };
  for (const f of S.favorites) claim(f, tabs.filter((t) => t.pinned));
  for (const sp of S.spaces) {
    const mine = tabs.filter((t) => !t.pinned && spaceOfTab(t) === sp.id);
    for (const p of S.pinned[sp.id] || []) claim(p, mine);
  }
}

// ---------------------------------------------------------------- reconcile

// Idempotent: brings one window in line with the spaces. Tabs pinned in Firefox are
// the "every space" tiles; everything else shows only while its space is open.
async function reconcile(windowId) {
  let win;
  try {
    win = await chrome.windows.get(windowId);
  } catch {
    return;
  }
  if (win.type !== 'normal' || T.mini[windowId]) return;
  const tabs = await chrome.tabs.query({ windowId });
  relink(windowId, tabs);
  const active = activeSpace(windowId, tabs);
  const map = liveMap(windowId);

  let added = false;
  for (const t of tabs) {
    if (!t.pinned || itemOfTab(windowId, t.id) || !t.url || t.url.startsWith(BAR_URL)) continue;
    let f = S.favorites.find((x) => map[x.id] == null && x.url === t.url);
    if (!f) {
      f = { id: uid(), title: t.title || hostOf(t.url) || 'Pinned tab', url: t.url, icon: iconOf(t), home: spaceOfTab(t) };
      S.favorites.push(f);
      added = true;
    }
    map[f.id] = t.id;
  }
  if (added) await saveS('favorites');
  for (const f of S.favorites) {
    const t = tabs.find((x) => x.id === map[f.id]);
    if (t && !t.pinned && !pendingUnpin.has(t.id)) await setPinned(t, true);
  }

  // Only the current space's tabs stay visible to Firefox's tab strip and Ctrl+Tab.
  const show = [];
  const hide = [];
  for (const t of tabs) {
    if (t.pinned) continue;
    const mine = spaceOfTab(t) === active;
    if (mine && t.hidden) show.push(t.id);
    else if (!mine && !t.hidden && !t.active) hide.push(t.id);
  }
  if (show.length) await chrome.tabs.show(show).catch(() => {});
  if (hide.length) await chrome.tabs.hide(hide).catch(() => {});
  notify(windowId);
}

async function reconcileAll() {
  const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
  for (const w of wins) await reconcile(w.id);
}

// ---------------------------------------------------------------- view for the sidebar

const slim = (t) =>
  t && {
    id: t.id,
    title: t.title || '',
    url: t.url || '',
    icon: iconOf(t),
    active: t.active,
    audible: !!t.audible,
    muted: !!t.mutedInfo?.muted,
    loading: t.status === 'loading',
    discarded: !!t.discarded,
  };

async function getView(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  const active = activeSpace(windowId, tabs);
  relink(windowId, tabs);
  const map = liveMap(windowId);
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const linked = new Set(Object.values(map));
  const shape = (it) => {
    const tab = map[it.id] != null ? byId.get(map[it.id]) : null;
    return {
      id: it.id,
      url: it.url,
      title: it.renamed ? it.title : tab?.title || it.title,
      icon: (tab && iconOf(tab)) || it.icon || '',
      moved: !!tab && !!tab.url && tab.url !== it.url,
      tab: slim(tab),
    };
  };
  const today = tabs.filter((t) => !t.pinned && !linked.has(t.id) && spaceOfTab(t) === active);
  const counts = Object.fromEntries(S.spaces.map((sp) => [sp.id, 0]));
  for (const t of tabs) if (!t.pinned && !(t.url || '').startsWith(BAR_URL)) counts[spaceOfTab(t)]++;
  const front = tabs.find((t) => t.active);
  return {
    ok: true,
    windowId,
    counts,
    spaces: S.spaces,
    activeSpaceId: active,
    favorites: S.favorites.map(shape),
    pinned: (S.pinned[active] || []).map(shape),
    today: today.map(slim),
    current: slim(front),
    settings: S.settings,
  };
}

// ---------------------------------------------------------------- spaces

function uniqueName(name, exceptId = null) {
  const base = (name || '').trim().slice(0, 40) || 'Space';
  let out = base;
  let n = 2;
  while (S.spaces.some((s) => s.id !== exceptId && s.name === out)) out = `${base} ${n++}`;
  return out;
}

async function switchSpace(windowId, sid, { noCreate = false } = {}) {
  if (!spaceById(sid)) return;
  T.activeSpace[windowId] = sid;
  rememberSpace(sid);
  const tabs = await chrome.tabs.query({ windowId });
  const inSpace = tabs.filter((t) => !t.pinned && spaceOfTab(t) === sid);
  // If the tab in front is already in this space (the user just picked it), keep it.
  const front = inSpace.find((t) => t.active);
  const target = front || inSpace.find((t) => t.id === T.lastTab[`${windowId}:${sid}`]) || inSpace[inSpace.length - 1];
  if (target) {
    if (target.hidden) await chrome.tabs.show([target.id]).catch(() => {});
    if (!target.active) await chrome.tabs.update(target.id, { active: true });
  } else if (!noCreate) {
    // A window always shows a tab, so an empty space gets a start page.
    await createTab({ windowId, url: START_URL, active: true }, sid);
  }
  await reconcile(windowId);
  notify(windowId);
}

async function stepSpace(windowId, delta) {
  if (!multi()) return;
  const cur = S.spaces.findIndex((s) => s.id === T.activeSpace[windowId]);
  const next = S.spaces[(Math.max(cur, 0) + delta + S.spaces.length) % S.spaces.length];
  await switchSpace(windowId, next.id);
}

async function createSpace(windowId, { name, emoji, color }) {
  const sp = {
    id: uid(),
    name: uniqueName(name || 'New space'),
    emoji: (emoji || '').trim().slice(0, 8) || '✨',
    color: COLOR_NAMES.includes(color) ? color : COLOR_NAMES[(S.spaces.length % (COLOR_NAMES.length - 1)) + 1],
    store: null,
    isolated: true, // its own Firefox container, so its own logins
  };
  S.spaces.push(sp);
  await saveS('spaces');
  await ensureStore(sp);
  if (windowId != null) await switchSpace(windowId, sp.id);
  notify();
  return { ok: true, space: sp };
}

async function updateSpace({ id, name, emoji, color }) {
  const sp = spaceById(id);
  if (!sp) return { ok: false };
  if (name != null) sp.name = uniqueName(name, id);
  if (emoji != null) sp.emoji = emoji.trim().slice(0, 8) || sp.emoji;
  if (COLOR_NAMES.includes(color)) sp.color = color;
  await saveS('spaces');
  if (sp.store) {
    // Keep the container's name and colour in step, so Firefox's own menus match.
    await chrome.contextualIdentities
      ?.update(sp.store, { name: sp.name, color: FF_COLOR[sp.color] || 'blue', icon: FF_ICON[sp.emoji] || 'circle' })
      .catch(() => {});
  }
  notify();
  return { ok: true };
}

// The space's open tabs move to its neighbour and keep the container they were opened
// in. The Firefox container itself, with its logins, is left alone.
async function deleteSpace(id) {
  const idx = S.spaces.findIndex((s) => s.id === id);
  if (idx < 0) return { ok: false };
  if (S.spaces.length < 2) return { ok: false, error: 'Keep at least one space.' };
  const fallback = S.spaces[idx === 0 ? 1 : idx - 1].id;
  for (const t of await chrome.tabs.query({})) if (spaceOfTab(t) === id) assign(t.id, fallback);
  S.spaces.splice(idx, 1);
  for (const p of S.pinned[id] || []) for (const w in T.live) delete T.live[w][p.id];
  delete S.pinned[id];
  for (const f of S.favorites) if (f.home === id) f.home = fallback;
  for (const w in T.activeSpace) if (T.activeSpace[w] === id) T.activeSpace[w] = fallback;
  if (S.lastSpace === id) rememberSpace(fallback);
  await saveS('spaces', 'pinned', 'favorites');
  await reconcileAll();
  notify();
  return { ok: true };
}

// Moves tabs to another space. A web page has to be reopened to change container,
// so it reloads and signs in as that space. Returns old tab id -> new tab id.
async function tabsToSpace(windowId, tabIds, sid) {
  const moved = new Map();
  const dest = spaceById(sid);
  if (!dest) return moved;
  const tabs = await chrome.tabs.query({ windowId });
  const active = activeSpace(windowId, tabs);
  const moving = tabs.filter((t) => tabIds.includes(t.id) && !t.pinned && spaceOfTab(t) !== sid);
  if (!moving.length) return moved;
  const ids = moving.map((t) => t.id);
  if (sid !== active && moving.some((t) => t.active)) {
    // Stay in the current space: hand focus to a tab that is not moving.
    const stay = tabs.filter((t) => !ids.includes(t.id) && (t.pinned || spaceOfTab(t) === active));
    if (stay.length) await chrome.tabs.update(stay[stay.length - 1].id, { active: true });
  }
  const store = (await ensureStore(dest)) || DEFAULT_STORE;
  for (const t of moving) {
    unlinkTab(t.id);
    if (isWeb(t.url) && storeOf(t) !== store) {
      const props = { windowId, url: t.url, index: t.index, active: false };
      if (store !== DEFAULT_STORE) props.cookieStoreId = store;
      const next = await createTab(props, sid);
      await chrome.tabs.remove(t.id).catch(() => {});
      moved.set(t.id, next.id);
    } else {
      assign(t.id, sid);
      moved.set(t.id, t.id);
    }
  }
  await reconcile(windowId);
  return moved;
}

// ---------------------------------------------------------------- tabs, pins and favorites

async function moveTabBefore(windowId, tabId, beforeId) {
  const tabs = await chrome.tabs.query({ windowId });
  const me = tabs.find((t) => t.id === tabId);
  if (!me) return;
  let index;
  if (beforeId != null) {
    const b = tabs.find((t) => t.id === beforeId);
    if (!b) return;
    index = b.index;
    if (me.index < index) index--;
  } else {
    const same = tabs.filter((t) => !t.pinned && spaceOfTab(t) === spaceOfTab(me));
    index = same.length ? same[same.length - 1].index : -1;
  }
  if (index !== me.index) await chrome.tabs.move(tabId, { index });
}

// Moves a tab or a saved entry into the open-tabs list, the pinned list or the
// "every space" tiles. `index` counts positions with the dragged entry already taken out.
async function placeItem(windowId, src, dest) {
  const active = spaceById(T.activeSpace[windowId]) ? T.activeSpace[windowId] : S.spaces[0].id;
  let tab = null;
  let entry = null;
  if (src.kind === 'tab') {
    tab = await getTab(src.id);
    if (!tab) return;
    const linkedId = itemOfTab(windowId, tab.id);
    if (linkedId) src = { kind: 'item', id: linkedId };
  }
  if (src.kind === 'item') {
    const f = findItem(src.id);
    if (!f) return;
    entry = f.item;
    const tid = liveMap(windowId)[entry.id];
    tab = tid != null ? await getTab(tid) : null;
    f.arr.splice(f.idx, 1);
    delete liveMap(windowId)[entry.id];
  }
  const url = entry?.url || tab?.url;
  if (!url) return;

  if (dest.zone === 'today') {
    if (tab) {
      if (tab.pinned) await setPinned(tab, false);
      if (dest.beforeTabId !== undefined) await moveTabBefore(windowId, tab.id, dest.beforeTabId).catch(() => {});
    } else {
      await createTab({ windowId, url, active: false }, active);
    }
  } else {
    const item = entry || { id: uid(), title: tab?.title || hostOf(url) || url, url, icon: tab ? iconOf(tab) : '' };
    if (dest.zone === 'pinned') {
      const sid = spaceById(dest.spaceId) ? dest.spaceId : active;
      delete item.home;
      const arr = (S.pinned[sid] ||= []);
      arr.splice(clamp(dest.index ?? arr.length, 0, arr.length), 0, item);
      if (tab) {
        if (tab.pinned) await setPinned(tab, false);
        let tid = tab.id;
        if (spaceOfTab(tab) !== sid) tid = (await tabsToSpace(windowId, [tab.id], sid)).get(tab.id) ?? tab.id;
        liveMap(windowId)[item.id] = tid;
      }
    } else {
      item.home = tab ? spaceOfTab(tab) : entry?.home || findSpaceOfEntry(src) || active;
      S.favorites.splice(clamp(dest.index ?? S.favorites.length, 0, S.favorites.length), 0, item);
      if (tab) {
        liveMap(windowId)[item.id] = tab.id;
        if (!tab.pinned) await setPinned(tab, true);
      }
    }
  }
  await saveS('pinned', 'favorites');
  await reconcile(windowId);
}

// Which space a pinned entry came from, when it has no open tab to tell us.
function findSpaceOfEntry(src) {
  return src?.fromSpace && spaceById(src.fromSpace) ? src.fromSpace : null;
}

async function openItem(windowId, id) {
  const f = findItem(id);
  if (!f) return null;
  const tid = liveMap(windowId)[id];
  let tab = tid != null ? await getTab(tid) : null;
  if (tab && tab.windowId === windowId) {
    if (tab.hidden) await chrome.tabs.show([tab.id]).catch(() => {});
    await chrome.tabs.update(tab.id, { active: true });
    return tab;
  }
  if (f.zone === 'pinned' && f.spaceId !== T.activeSpace[windowId]) await switchSpace(windowId, f.spaceId, { noCreate: true });
  // An "every space" tile opens in the container of the space it was added from.
  const sid = f.zone === 'pinned' ? f.spaceId : spaceById(f.item.home) ? f.item.home : T.activeSpace[windowId];
  tab = await createTab({ windowId, url: f.item.url, active: true, pinned: f.zone === 'favs' }, sid);
  liveMap(windowId)[id] = tab.id;
  await reconcile(windowId);
  return tab;
}

async function removeItem(windowId, id) {
  const f = findItem(id);
  if (!f) return;
  const tid = liveMap(windowId)[id];
  f.arr.splice(f.idx, 1);
  for (const w in T.live) delete T.live[w][id];
  await saveS('pinned', 'favorites');
  // The tab stays open as an ordinary tab.
  if (tid != null) await setPinned(await getTab(tid), false);
  await reconcile(windowId);
}

// Closed tabs are not recorded here. Firefox keeps its own recently-closed list; this reads it.
async function recentlyClosed() {
  const sessions = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });
  const items = [];
  for (const s of sessions) {
    const at = s.lastModified > 1e11 ? s.lastModified : (s.lastModified || 0) * 1000;
    if (s.tab) {
      if ((s.tab.url || '').startsWith(EXT)) continue;
      items.push({ id: s.tab.sessionId, title: s.tab.title || s.tab.url, url: s.tab.url, at });
    } else if (s.window?.tabs?.length) {
      const first = s.window.tabs[0];
      items.push({ id: s.window.sessionId, title: `Window with ${s.window.tabs.length} tabs: ${first.title || first.url}`, url: first.url, at });
    }
  }
  return items;
}

async function clearToday(windowId) {
  const view = await getView(windowId);
  // The tab in front and anything playing sound stay open.
  const ids = view.today.filter((t) => !t.active && !t.audible).map((t) => t.id);
  if (!ids.length) return;
  await chrome.tabs.remove(ids).catch(() => {});
  return { ok: true, closed: ids.length };
}

async function autoArchive() {
  const hrs = Number(S.settings.archiveAfterHours);
  if (!(hrs > 0)) return;
  const cutoff = Date.now() - hrs * 3600e3;
  const tabs = await chrome.tabs.query({ windowType: 'normal' });
  const old = tabs.filter(
    (t) => !t.pinned && !t.active && !t.audible && t.lastAccessed && t.lastAccessed < cutoff && !itemOfTab(t.windowId, t.id) && isWeb(t.url),
  );
  if (!old.length) return;
  await chrome.tabs.remove(old.map((t) => t.id)).catch(() => {});
  notify();
}

function syncAlarm() {
  if (Number(S.settings.archiveAfterHours) > 0) chrome.alarms.create('arcadia:archive', { periodInMinutes: 10 });
  else chrome.alarms.clear('arcadia:archive');
}

// ---------------------------------------------------------------- mini windows

// A mini window opens in the container of the space it was opened from.
async function openMini({ url, tabId, sid } = {}) {
  const width = clamp(Number(S.settings.miniWidth) || 980, 420, 2400);
  const height = clamp(Number(S.settings.miniHeight) || 700, 320, 1800);
  const opts = { type: 'popup', width, height };
  try {
    const cur = await chrome.windows.getLastFocused();
    if (cur?.width) {
      opts.left = Math.round(cur.left + (cur.width - width) / 2);
      opts.top = Math.round(cur.top + Math.max(48, (cur.height - height) / 3));
    }
  } catch {}
  if (tabId != null) opts.tabId = tabId;
  else {
    opts.url = url || `${BAR_URL}?mode=mini`;
    const sp = spaceById(sid) || spaceById(T.activeSpace[T.lastNormal]) || spaceById(S.lastSpace);
    const store = url && sp ? await ensureStore(sp) : null;
    if (store) opts.cookieStoreId = store;
  }
  selfUntil = Date.now() + 1500;
  let win;
  try {
    win = await chrome.windows.create(opts);
  } catch {
    delete opts.left;
    delete opts.top;
    win = await chrome.windows.create(opts);
  }
  T.mini[win.id] = true;
  if (tabId != null) pingMini(tabId);
  return win;
}

// Opens a tab's page in a mini window. The tab moves unless it is the window's only tab.
async function popOut(tab) {
  if (!tab) return;
  const siblings = await chrome.tabs.query({ windowId: tab.windowId });
  if (siblings.length > 1) await openMini({ tabId: tab.id });
  else if (isWeb(tab.url)) await openMini({ url: tab.url, sid: spaceOfTab(tab) });
}

function pingMini(tabId) {
  chrome.tabs.sendMessage(tabId, { type: 'arcadia:mini' }, { frameId: 0 }).catch(() => {});
}

async function miniToMain(tab) {
  if (!tab || !T.mini[tab.windowId]) return;
  const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
  const target = wins.find((w) => w.id === T.lastNormal) || wins[0];
  if (!target) {
    await chrome.windows.create({ url: tab.url });
    await chrome.tabs.remove(tab.id).catch(() => {});
    return;
  }
  // Its space is the one whose container it is in, else the space open in that window.
  const sp = S.spaces.find((s) => s.store && s.store === tab.cookieStoreId) || spaceById(T.activeSpace[target.id]) || S.spaces[0];
  try {
    await chrome.tabs.move(tab.id, { windowId: target.id, index: -1 });
    assign(tab.id, sp.id);
    await chrome.tabs.update(tab.id, { active: true });
  } catch {
    // Firefox does not move a tab out of a popup window, so open the page again in the same container.
    const props = { windowId: target.id, url: tab.url, active: true };
    if (storeOf(tab) !== DEFAULT_STORE) props.cookieStoreId = tab.cookieStoreId;
    await createTab(props, sp.id);
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
  await chrome.windows.update(target.id, { focused: true }).catch(() => {});
  scheduleReconcile(target.id, 20);
}

// ---------------------------------------------------------------- copy link

// A Firefox background page may write to the clipboard directly (clipboardWrite permission).
async function writeClipboard(text) {
  await navigator.clipboard.writeText(text);
}

async function toast(tab, text) {
  let shown = false;
  if (tab?.id != null) {
    shown = await chrome.tabs
      .sendMessage(tab.id, { type: 'arcadia:toast', text }, { frameId: 0 })
      .then((r) => !!r?.ok)
      .catch(() => false);
  }
  if (!shown) {
    chrome.runtime.sendMessage({ type: 'arcadia:toast', windowId: tab?.windowId ?? null, text }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: '#2f6fed' });
    chrome.action.setBadgeText({ text: '✓' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1400);
  }
}

const TRACKING = /^(utm_[a-z0-9_]+|fbclid|gclid|gclsrc|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|igshid|igsh|yclid|twclid|ttclid|li_fat_id|_hsenc|_hsmi|hsa_[a-z]+|vero_id|oly_anon_id|oly_enc_id|s_cid|si|ref_src|ref_url|mkt_tok|_openstat|wickedid|rb_clickid|srsltid)$/i;

function cleanUrl(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || !u.search) return url;
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    const out = u.toString();
    return out.length < url.length ? out : url;
  } catch {
    return url;
  }
}

async function copyLink(tab, { markdown = false } = {}) {
  tab ||= (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  let url = tab?.url;
  if (!url) return { ok: false };
  if (S.settings.cleanLinks) url = cleanUrl(url);
  await writeClipboard(markdown ? `[${(tab.title || url).replace(/[[\]]/g, '\\$&')}](${url})` : url);
  await toast(tab, markdown ? 'Copied link as Markdown' : 'Copied link');
  return { ok: true };
}

// ---------------------------------------------------------------- command bar

// Firefox keeps extensions out of its own pages and a few Mozilla sites.
const injectable = (url) => /^(https?|file):/.test(url || '') && !/^https:\/\/(addons\.mozilla\.org|accounts\.firefox\.com|support\.mozilla\.org)\//.test(url);

const frameKey = (sender) => sender.documentId || `${sender.tab.id}:${sender.frameId}`;

async function showOverlay(tabId, mode, toggle = false) {
  const now = Date.now();
  for (const k in T.tokens) if (T.tokens[k].exp < now) delete T.tokens[k];
  const token = crypto.randomUUID();
  T.tokens[token] = { tabId, exp: now + 20000 };
  const msg = { type: 'arcadia:bar', mode, toggle, token };
  const ask = () => chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
  try {
    const r = await ask();
    if (r?.ok) return true;
  } catch {}
  try {
    // The page was open before Arcadia loaded; inject the page script now.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
    const r = await ask();
    return !!r?.ok;
  } catch {
    return false;
  }
}

async function openBar(windowId, mode, { toggle = false } = {}) {
  if (windowId == null) return;
  const r = await chrome.runtime.sendMessage({ type: 'arcadia:bar-if-focused', windowId, mode }).catch(() => null);
  if (r?.ok) return;
  const [tab] = await chrome.tabs.query({ windowId, active: true });
  if (tab && (tab.url || '').startsWith(BAR_URL)) return;
  if (tab && !tab.discarded && injectable(tab.url) && (await showOverlay(tab.id, mode, toggle))) return;
  await createTab({ windowId, url: START_URL, active: true });
}

// Firefox opened its new tab page: replace it with the command bar.
async function interceptNewTab(tab) {
  const w = tab.windowId;
  const prevId = (T.hist[w] || []).find((id) => id !== tab.id) ?? tab.openerTabId;
  const prev = prevId != null ? await getTab(prevId) : null;
  if (prev && prev.windowId === w) {
    if ((prev.url || '').startsWith(BAR_URL)) {
      await chrome.tabs.remove(tab.id).catch(() => {});
      await chrome.tabs.update(prev.id, { active: true }).catch(() => {});
      return;
    }
    if (!prev.discarded && injectable(prev.url) && (await showOverlay(prev.id, 'new'))) {
      await chrome.tabs.remove(tab.id).catch(() => {});
      await chrome.tabs.update(prev.id, { active: true }).catch(() => {});
      chrome.tabs.sendMessage(prev.id, { type: 'arcadia:bar-focus' }, { frameId: 0 }).catch(() => {});
      return;
    }
  }
  // No page to draw over (about: pages, Mozilla's add-on site): use a full-tab command bar.
  await createTab({ windowId: w, url: START_URL, index: tab.index, active: true }, T.tabSpace[tab.id]);
  await chrome.tabs.remove(tab.id).catch(() => {});
}

const ACTIONS = [
  { id: 'mini-new', title: 'New mini window', words: 'little popup small' },
  { id: 'pop-out', title: 'Open this tab in a mini window', words: 'little popup small', needsTab: true },
  { id: 'copy-url', title: 'Copy link', words: 'url address', needsTab: true },
  { id: 'copy-md', title: 'Copy link as Markdown', words: 'url address', needsTab: true },
  { id: 'pin', title: 'Pin tab to this space', needsTab: true },
  { id: 'unpin', title: 'Unpin tab', needsTab: true },
  { id: 'fav', title: 'Keep tab pinned in every space', words: 'favorite favourite all', needsTab: true },
  { id: 'duplicate', title: 'Duplicate tab', needsTab: true },
  { id: 'mute', title: 'Mute or unmute tab', words: 'sound audio', needsTab: true },
  { id: 'close', title: 'Close tab', needsTab: true },
  { id: 'clear', title: 'Close all unpinned tabs in this space', words: 'clear archive' },
  { id: 'space-new', title: 'New space', words: 'create container' },
  { id: 'settings', title: 'Open Arcadia settings', words: 'options preferences' },
  { id: 'shortcuts', title: 'Edit keyboard shortcuts', words: 'keys hotkeys' },
];

// Plain arithmetic typed into the bar: + - * / % ^ and brackets.
function calc(q) {
  const src = q.replace(/[x×]/gi, '*').replace(/÷/g, '/').replace(/,/g, '').replace(/\s+/g, '');
  if (!/^[\d.+\-*/%^()]+$/.test(src) || !/\d[+\-*/%^]+\(*-?\(*[\d.(]/.test(src)) return null;
  let i = 0;
  const peek = () => src[i];
  function primary() {
    if (peek() === '(') {
      i++;
      const v = sum();
      if (peek() !== ')') throw 0;
      i++;
      return v;
    }
    const m = /^\d*\.?\d+/.exec(src.slice(i));
    if (!m) throw 0;
    i += m[0].length;
    return parseFloat(m[0]);
  }
  function unary() {
    if (peek() === '-') return i++, -unary();
    if (peek() === '+') return i++, unary();
    return primary();
  }
  function power() {
    const b = unary();
    if (peek() === '^') return i++, b ** power();
    return b;
  }
  function product() {
    let v = power();
    for (;;) {
      const op = peek();
      if (op !== '*' && op !== '/' && op !== '%') return v;
      i++;
      const r = power();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
  }
  function sum() {
    let v = product();
    for (;;) {
      const op = peek();
      if (op !== '+' && op !== '-') return v;
      i++;
      const r = product();
      v = op === '+' ? v + r : v - r;
    }
  }
  try {
    const v = sum();
    if (i !== src.length || !Number.isFinite(v)) return null;
    return String(Math.round(v * 1e10) / 1e10);
  } catch {
    return null;
  }
}

function toUrl(q) {
  if (/\s/.test(q)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(q) || /^(about|chrome|view-source):/i.test(q)) return q;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?([/?#].*)?$/i.test(q)) return `http://${q}`;
  if (/^[^\s/@]+\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(q)) return `https://${q}`;
  return null;
}

function score(ql, tokens, title, url) {
  const t = (title || '').toLowerCase();
  const u = (url || '').toLowerCase();
  if (!tokens.every((k) => t.includes(k) || u.includes(k))) return 0;
  const host = hostOf(url).toLowerCase();
  let s = 1;
  if (host.startsWith(ql)) s += 4;
  if (t.startsWith(ql)) s += 3;
  else if (t.includes(ql)) s += 1;
  return s;
}

async function barQuery(text, windowId, ctxTab, selfTab) {
  const q = (text || '').trim();
  const ql = q.toLowerCase();
  const tokens = ql.split(/\s+/).filter(Boolean);
  const all = (await chrome.tabs.query({ windowType: 'normal' })).filter(
    (t) => !(t.url || '').startsWith(BAR_URL) && t.id !== selfTab?.id,
  );
  const tabItem = (t) => ({
    kind: 'tab',
    key: `tab:${t.id}`,
    id: t.id,
    title: t.title || t.url,
    sub: hostOf(t.url),
    url: t.url,
    icon: iconOf(t),
    hint: 'Switch to tab',
  });
  if (!q) {
    const here = T.activeSpace[windowId];
    const recent = all
      .filter((t) => t.windowId === windowId && t.id !== ctxTab?.id && (t.pinned || spaceOfTab(t) === here))
      .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))
      .slice(0, 6);
    return { ok: true, items: recent.map(tabItem) };
  }

  const openUrls = new Set(all.map((t) => t.url));
  const tabs = all
    .map((t) => ({ t, s: score(ql, tokens, t.title, t.url) }))
    .filter((x) => x.s)
    .sort((a, b) => b.s - a.s || (b.t.lastAccessed || 0) - (a.t.lastAccessed || 0));

  const saved = [];
  const addSaved = (it, label) => {
    if (liveMap(windowId)[it.id] != null) return; // already listed as a tab
    const s = score(ql, tokens, it.title, it.url);
    if (s) saved.push({ s, item: { kind: 'item', key: `item:${it.id}`, id: it.id, title: it.title, sub: label, url: it.url, icon: it.icon || '', hint: 'Open' } });
  };
  for (const f of S.favorites) addSaved(f, 'Pinned in every space');
  for (const sp of S.spaces) for (const p of S.pinned[sp.id] || []) addSaved(p, `Pinned in ${sp.name}`);
  saved.sort((a, b) => b.s - a.s);

  let hist = [];
  const local = S.settings.searchHistory;
  try {
    const rows = local ? await chrome.history.search({ text: q, maxResults: 14, startTime: 0 }) : [];
    hist = rows
      .filter((h) => h.url && !openUrls.has(h.url) && !h.url.startsWith(EXT))
      .map((h) => ({ h, s: score(ql, tokens, h.title, h.url) + Math.min(2, (h.typedCount || 0) * 0.5 + (h.visitCount || 0) * 0.05) }))
      .sort((a, b) => b.s - a.s);
  } catch {}
  const histItem = ({ h }) => ({ kind: 'url', key: `h:${h.url}`, title: h.title || h.url, sub: hostOf(h.url), url: h.url, hint: 'Open' });

  let marks = [];
  try {
    if (local) marks = (await chrome.bookmarks.search(q)).filter((b) => b.url && !openUrls.has(b.url)).slice(0, 3);
  } catch {}

  const acts = [];
  const hasTab = !!ctxTab;
  const dyn = [...ACTIONS];
  if (multi()) {
    for (const sp of S.spaces) {
      if (sp.id !== T.activeSpace[windowId]) {
        dyn.push({ id: `space:${sp.id}`, title: `Go to space ${sp.emoji} ${sp.name}`, words: 'switch' });
        dyn.push({ id: `move:${sp.id}`, title: `Move tab to space ${sp.emoji} ${sp.name}`, needsTab: true });
      }
    }
  }
  for (const a of dyn) {
    if (a.needsTab && !hasTab) continue;
    const hay = `${a.title} ${a.words || ''}`.toLowerCase();
    if (tokens.every((k) => hay.includes(k))) acts.push({ kind: 'action', key: `a:${a.id}`, id: a.id, title: a.title, glyph: 'bolt', hint: 'Run' });
  }

  const sumOf = calc(q);
  const url = sumOf == null ? toUrl(q) : null;
  const out = [];
  const seen = new Set();
  const push = (it) => {
    if (seen.has(it.key)) return;
    seen.add(it.key);
    out.push(it);
  };
  const search = { kind: 'search', key: 'search', title: q, sub: 'Search the web', glyph: 'search', hint: 'Search' };
  if (sumOf != null) push({ kind: 'calc', key: 'calc', title: `= ${sumOf}`, sub: 'Copy result', value: sumOf, glyph: 'bolt', hint: 'Copy' });
  if (url) push({ kind: 'url', key: `go:${url}`, title: q, sub: 'Go to address', url, glyph: 'globe', hint: 'Open' });
  tabs.filter((x) => x.s >= 4).slice(0, 3).forEach((x) => push(tabItem(x.t)));
  saved.filter((x) => x.s >= 4).slice(0, 2).forEach((x) => push(x.item));
  hist.filter((x) => x.s >= 5).slice(0, 2).forEach((x) => push(histItem(x)));
  if (!url) push(search);
  tabs.slice(0, 5).forEach((x) => push(tabItem(x.t)));
  acts.slice(0, 4).forEach(push);
  saved.slice(0, 3).forEach((x) => push(x.item));
  hist.slice(0, 5).forEach((x) => push(histItem(x)));
  marks.forEach((b) => push({ kind: 'url', key: `h:${b.url}`, title: b.title || b.url, sub: `Bookmark, ${hostOf(b.url)}`, url: b.url, hint: 'Open' }));
  if (url) push(search);
  return { ok: true, items: out.slice(0, 12) };
}

// Where a chosen address goes depends on how the bar was opened. A new page always
// starts in the current space's container; the bar's own tab or window cannot change
// container, so it is replaced rather than navigated.
async function openUrl(url, mode, windowId, ctxTab, selfTab, background = false) {
  if (mode === 'mini') {
    await openMini({ url });
    if (selfTab) await chrome.tabs.remove(selfTab.id).catch(() => {});
    return;
  }
  if (mode === 'current' && ctxTab && !background) return chrome.tabs.update(ctxTab.id, { url });
  const replace = mode === 'tab' && selfTab && !background;
  const sid = selfTab ? T.tabSpace[selfTab.id] : null;
  await createTab({ windowId, url, active: !background, ...(replace ? { index: selfTab.index } : {}) }, sid);
  if (replace) await chrome.tabs.remove(selfTab.id).catch(() => {});
}

const webSearch = (text, tabId) => (chrome.search.query ? chrome.search.query({ text, tabId }) : chrome.search.search({ query: text, tabId }));

async function barRun(m, windowId, ctxTab, selfTab) {
  const { item, mode } = m;
  const standalone = mode === 'tab' || mode === 'mini';
  switch (item?.kind) {
    case 'tab': {
      const t = await getTab(item.id);
      if (!t) return { ok: false };
      if (t.hidden) await chrome.tabs.show([t.id]).catch(() => {});
      await chrome.tabs.update(t.id, { active: true });
      await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
      if (standalone && selfTab) await chrome.tabs.remove(selfTab.id).catch(() => {});
      return { ok: true };
    }
    case 'item': {
      if (mode === 'mini') {
        const f = findItem(item.id);
        if (f) await openUrl(f.item.url, mode, windowId, ctxTab, selfTab);
        return { ok: true };
      }
      await openItem(windowId, item.id);
      if (mode === 'tab' && selfTab) await chrome.tabs.remove(selfTab.id).catch(() => {});
      return { ok: true };
    }
    case 'url':
      if (typeof item.url !== 'string') return { ok: false };
      await openUrl(item.url, mode, windowId, ctxTab, selfTab, !!m.background && mode !== 'mini');
      return { ok: true };
    case 'calc':
      await writeClipboard(String(item.value ?? ''));
      await toast(ctxTab || selfTab, 'Copied result');
      return { ok: true };
    case 'search': {
      const text = String(item.title || '').trim();
      if (!text) return { ok: false };
      if (mode === 'current' && ctxTab) await webSearch(text, ctxTab.id);
      else if (mode === 'mini') {
        const win = await openMini({ url: 'about:blank' });
        const [t] = win.tabs || (await chrome.tabs.query({ windowId: win.id }));
        await webSearch(text, t.id);
        if (selfTab) await chrome.tabs.remove(selfTab.id).catch(() => {});
      } else {
        // Open a blank tab in this space's container first, then search in it.
        const replace = mode === 'tab' && selfTab;
        const t = await createTab({ windowId, url: 'about:blank', active: true, ...(replace ? { index: selfTab.index } : {}) }, selfTab ? T.tabSpace[selfTab.id] : null);
        await webSearch(text, t.id);
        if (replace) await chrome.tabs.remove(selfTab.id).catch(() => {});
      }
      return { ok: true };
    }
    case 'action':
      return runAction(String(item.id), windowId, ctxTab);
    default:
      return { ok: false };
  }
}

async function runAction(id, windowId, tab) {
  if (id.startsWith('space:')) return switchSpace(windowId, id.slice(6)), { ok: true };
  if (id.startsWith('move:')) return tab ? (await tabsToSpace(windowId, [tab.id], id.slice(5)), { ok: true }) : { ok: false };
  switch (id) {
    case 'mini-new':
      await openMini();
      break;
    case 'pop-out':
      await popOut(tab);
      break;
    case 'copy-url':
      await copyLink(tab);
      break;
    case 'copy-md':
      await copyLink(tab, { markdown: true });
      break;
    case 'pin':
      if (tab) await placeItem(windowId, { kind: 'tab', id: tab.id }, { zone: 'pinned' });
      break;
    case 'fav':
      if (tab) await placeItem(windowId, { kind: 'tab', id: tab.id }, { zone: 'favs' });
      break;
    case 'unpin': {
      const linked = tab && itemOfTab(windowId, tab.id);
      if (linked) await placeItem(windowId, { kind: 'item', id: linked }, { zone: 'today' });
      else if (tab?.pinned) await setPinned(tab, false);
      break;
    }
    case 'duplicate':
      if (tab) await chrome.tabs.duplicate(tab.id);
      break;
    case 'mute':
      if (tab) await chrome.tabs.update(tab.id, { muted: !tab.mutedInfo?.muted });
      break;
    case 'close':
      if (tab) await chrome.tabs.remove(tab.id);
      break;
    case 'clear':
      await clearToday(windowId);
      break;
    case 'space-new':
      await createSpace(windowId, {});
      break;
    case 'settings':
      await chrome.runtime.openOptionsPage();
      break;
    case 'shortcuts':
      if (chrome.commands.openShortcutSettings) await chrome.commands.openShortcutSettings();
      else await chrome.runtime.openOptionsPage();
      break;
    default:
      return { ok: false };
  }
  return { ok: true };
}

async function togglePin(windowId, tab) {
  if (!tab) return;
  const id = itemOfTab(windowId, tab.id);
  if (id) await placeItem(windowId, { kind: 'item', id }, { zone: 'today' });
  else await placeItem(windowId, { kind: 'tab', id: tab.id }, { zone: 'pinned' });
}

// ---------------------------------------------------------------- messages

// The only messages a page script may send.
const FROM_PAGES = new Set(['copy-url', 'mini:open', 'mini:toMain', 'icon:set', 'bar:failed']);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || msg.type.startsWith('arcadia:')) return;
  if (sender.id !== chrome.runtime.id) return;
  const fromExt = (sender.url || '').startsWith(EXT);
  if (!fromExt && !FROM_PAGES.has(msg.type)) return;
  locked(() => route(msg, sender, fromExt)).then(
    (r) => sendResponse(r === undefined || r === null ? { ok: true } : r),
    (e) => sendResponse({ ok: false, error: String(e?.message || e) }),
  );
  return true;
});

async function route(m, sender, fromExt) {
  const tab = sender.tab || null;
  // The command bar frame inside a web page must prove Arcadia opened it.
  const embedded = fromExt && !!tab && sender.frameId > 0;
  if (embedded) {
    if (m.type === 'bar:init') {
      const t = T.tokens[m.token];
      if (!t || t.tabId !== tab.id || t.exp < Date.now()) return { ok: false };
      delete T.tokens[m.token];
      T.frames[frameKey(sender)] = tab.id;
    } else if (!T.frames[frameKey(sender)] || !m.type.startsWith('bar:')) {
      return { ok: false };
    }
  }
  const selfIsBar = fromExt && !!tab && sender.frameId === 0 && (tab.url || sender.url || '').startsWith(BAR_URL);
  const windowId = tab?.windowId ?? m.windowId ?? T.lastNormal;
  const selfTab = selfIsBar ? tab : null;
  const mini = !!tab && !!T.mini[tab.windowId];
  let ctxTab = null;
  if (embedded) ctxTab = tab;
  else if (!tab && windowId != null) [ctxTab] = await chrome.tabs.query({ windowId, active: true });

  switch (m.type) {
    case 'view:get':
      return getView(m.windowId);
    case 'space:create':
      return createSpace(m.windowId, m);
    case 'space:update':
      return updateSpace(m);
    case 'space:delete':
      return deleteSpace(m.id);
    case 'space:switch':
      return switchSpace(m.windowId, m.id);
    case 'space:step':
      return stepSpace(m.windowId, m.delta > 0 ? 1 : -1);
    case 'space:move': {
      const i = S.spaces.findIndex((s) => s.id === m.id);
      if (i < 0) return { ok: false };
      const [sp] = S.spaces.splice(i, 1);
      S.spaces.splice(clamp(m.index, 0, S.spaces.length), 0, sp);
      await saveS('spaces');
      notify();
      return;
    }
    case 'item:place':
      return placeItem(m.windowId, m.src, m.dest);
    case 'item:open':
      await openItem(m.windowId, m.id);
      return;
    case 'item:remove':
      return removeItem(m.windowId, m.id);
    case 'item:rename': {
      const f = findItem(m.id);
      if (!f) return { ok: false };
      const title = String(m.title || '').trim().slice(0, 200);
      f.item.renamed = !!title;
      if (title) f.item.title = title;
      await saveS('pinned', 'favorites');
      notify();
      return;
    }
    case 'item:seturl': {
      // Make the page the tab is on now the saved link.
      const f = findItem(m.id);
      const t = f && (await getTab(liveMap(m.windowId)[m.id]));
      if (!t?.url) return { ok: false };
      f.item.url = t.url;
      f.item.icon = iconOf(t) || f.item.icon || '';
      await saveS('pinned', 'favorites');
      notify();
      return;
    }
    case 'item:reset': {
      const f = findItem(m.id);
      const tid = f && liveMap(m.windowId)[m.id];
      if (tid == null) return { ok: false };
      await chrome.tabs.update(tid, { url: f.item.url, active: true });
      return;
    }
    case 'tab:toSpace':
      await tabsToSpace(m.windowId, [m.tabId], m.spaceId);
      return;
    case 'tab:pop':
      return popOut(await getTab(m.tabId));
    case 'tab:closeOthers': {
      const view = await getView(m.windowId);
      const ids = view.today.map((t) => t.id).filter((id) => id !== m.tabId);
      if (ids.length) await chrome.tabs.remove(ids);
      return;
    }
    case 'today:clear':
      return clearToday(m.windowId);
    case 'closed:get':
      return { ok: true, items: await recentlyClosed() };
    case 'closed:restore':
      selfUntil = Date.now() + 1500;
      await chrome.sessions.restore(String(m.id));
      return;
    case 'bar:init': {
      const sp = spaceById(T.activeSpace[windowId]) || S.spaces[0];
      return { ok: true, space: sp, multi: multi(), currentUrl: m.mode === 'current' ? ctxTab?.url || '' : '', empty: !ctxTab && !selfTab };
    }
    case 'bar:query':
      return barQuery(m.text, windowId, ctxTab, selfTab);
    case 'bar:run':
      return barRun(m, windowId, ctxTab, selfTab);
    case 'bar:dismiss': {
      // Escape on a full-tab bar closes it unless it is the window's last tab.
      if (!selfTab) return;
      const count = (await chrome.tabs.query({ windowId: selfTab.windowId })).length;
      if (mini || count > 1) await chrome.tabs.remove(selfTab.id).catch(() => {});
      return;
    }
    case 'bar:open':
      return openBar(m.windowId, m.mode || 'new');
    case 'bar:failed': {
      // The page would not show the in-page bar. Honoured once per bar Arcadia itself asked for.
      const key = tab && Object.keys(T.tokens).find((k) => T.tokens[k].tabId === tab.id && T.tokens[k].exp > Date.now());
      if (!key) return { ok: false };
      delete T.tokens[key];
      await createTab({ windowId: tab.windowId, url: START_URL, active: true }, T.tabSpace[tab.id]);
      return;
    }
    case 'icon:set': {
      // The page script read the site's icon out of Firefox's cache; keep it in memory for the lists.
      if (!tab || sender.frameId !== 0 || typeof m.icon !== 'string' || !m.icon.startsWith('data:image/') || m.icon.length > 16000) return { ok: false };
      const entry = { site: siteTag(tab.url), data: m.icon };
      icons.set(tab.id, entry);
      chrome.storage.session.set({ [`icon:${tab.id}`]: entry }).catch(() => {});
      // A pinned entry keeps its own site's icon, so it still has one while asleep.
      const id = itemOfTab(tab.windowId, tab.id);
      const it = id && findItem(id)?.item;
      if (it && siteTag(it.url) === entry.site && it.icon !== m.icon) {
        it.icon = m.icon;
        await saveS('pinned', 'favorites');
      }
      notify(tab.windowId);
      return;
    }
    case 'copy-url':
      return copyLink(tab || ctxTab, { markdown: !!m.markdown });
    case 'mini:open':
      if (!/^https?:\/\//i.test(m.url || '')) return { ok: false };
      await openMini({ url: m.url, sid: tab ? T.tabSpace[tab.id] : null });
      return;
    case 'mini:toMain':
      return miniToMain(tab);
    case 'mini:new':
      await openMini();
      return;
    case 'settings:set': {
      const patch = {};
      for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (k in (m.patch || {}) && typeof m.patch[k] === typeof DEFAULT_SETTINGS[k]) patch[k] = m.patch[k];
      }
      Object.assign(S.settings, patch);
      await saveS('settings');
      syncAlarm();
      notify();
      return { ok: true, settings: S.settings };
    }
    case 'data:export':
      return { ok: true, data: { arcadia: 1, spaces: S.spaces.map(({ store, ...sp }) => sp), pinned: S.pinned, favorites: S.favorites, settings: S.settings } };
    case 'data:import': {
      const d = m.data;
      if (!d || d.arcadia !== 1 || !Array.isArray(d.spaces) || !d.spaces.length) return { ok: false, error: 'This is not an Arcadia export file.' };
      const okIcon = (i) => (typeof i === 'string' && i.startsWith('data:image/') && i.length <= 16000 ? i : '');
      const clean = (it) => ({ id: uid(), title: String(it.title || it.url || '').slice(0, 200), url: String(it.url || ''), renamed: !!it.renamed, icon: okIcon(it.icon) });
      const okUrl = (it) => it && /^[a-z][a-z0-9+.-]*:/i.test(it.url || '');
      const ids = new Map();
      S.spaces = d.spaces.slice(0, 30).map((s, i) => {
        const id = uid();
        ids.set(s.id, id);
        return { id, name: String(s.name || 'Space').slice(0, 40), emoji: String(s.emoji || '✨').slice(0, 8), color: COLOR_NAMES.includes(s.color) ? s.color : 'blue', store: null, isolated: i > 0 };
      });
      S.spaces.forEach((s) => (s.name = uniqueName(s.name, s.id)));
      S.pinned = {};
      for (const [old, arr] of Object.entries(d.pinned || {})) {
        if (ids.has(old) && Array.isArray(arr)) S.pinned[ids.get(old)] = arr.filter(okUrl).map(clean);
      }
      S.favorites = (Array.isArray(d.favorites) ? d.favorites : []).filter(okUrl).map((f) => ({ ...clean(f), home: ids.get(f.home) || S.spaces[0].id }));
      T.tabSpace = {};
      T.activeSpace = {};
      T.live = {};
      T.relinked = {};
      await saveS('spaces', 'pinned', 'favorites');
      // Containers with matching names are picked up again; missing ones are made.
      for (const sp of S.spaces) await ensureStore(sp);
      await reconcileAll();
      notify();
      return;
    }
    default:
      return { ok: false, error: `Unknown message ${m.type}` };
  }
}

// ---------------------------------------------------------------- browser events

chrome.tabs.onCreated.addListener((tab) =>
  locked(async () => {
    const w = tab.windowId;
    if (T.mini[w]) return;
    let win;
    try {
      win = await chrome.windows.get(w);
    } catch {
      return;
    }
    if (win.type !== 'normal') return;
    const booting = Date.now() - T.boot < BOOT_GRACE_MS;
    const ours = own.has(tab.id);

    // Which space is it in? A restored tab remembers; a tab opened straight into a
    // container goes to that container's space; a tab opened from a page stays with
    // that page; anything else joins the space that is open.
    if (!spaceById(T.tabSpace[tab.id])) {
      const kept = await chrome.sessions.getTabValue(tab.id, TAB_KEY).catch(() => null);
      const byStore = storeOf(tab) !== DEFAULT_STORE ? S.spaces.find((s) => s.store === tab.cookieStoreId) : null;
      const opener = tab.openerTabId != null ? await getTab(tab.openerTabId) : null;
      const open = spaceById(T.activeSpace[w]) ? T.activeSpace[w] : S.spaces[0].id;
      assign(tab.id, spaceById(kept) ? kept : byStore ? byStore.id : opener && !opener.pinned ? spaceOfTab(opener) : open);
    }

    if (!booting && tab.active && S.settings.newTabOpensBar && NTP_RE.test(tab.url || '')) {
      await interceptNewTab(tab);
      return;
    }
    if (!ours && !booting) {
      T.fresh[tab.id] = true;
      tab = await settleContainer(tab);
    }
    const cameFromOutside = T.unfocused || Date.now() - (T.focusGainAt || 0) < 1500;
    if (!booting && !ours && Date.now() > selfUntil && S.settings.externalToMini && cameFromOutside && tab.openerTabId == null && isWeb(tab.url)) {
      const siblings = await chrome.tabs.query({ windowId: w });
      if (siblings.length > 1) {
        await openMini({ tabId: tab.id });
        return;
      }
    }
    scheduleReconcile(w, 30);
    notify(w);
  }),
);

chrome.tabs.onActivated.addListener(({ tabId, windowId }) =>
  locked(async () => {
    if (T.mini[windowId]) return;
    const before = (T.hist[windowId] || []).find((id) => id !== tabId);
    T.hist[windowId] = [tabId, ...(T.hist[windowId] || []).filter((id) => id !== tabId)].slice(0, 4);
    const tab = await getTab(tabId);
    if (!tab) return;
    // A start page you walked away from closes itself.
    const left = before != null ? await getTab(before) : null;
    if (left && left.windowId === windowId && (left.url || '').startsWith(BAR_URL)) chrome.tabs.remove(left.id).catch(() => {});
    // The front tab was just closed and the browser jumped to a tab of another space.
    // Stay in the space the user was in: its most recent tab, or its start page if it is now empty.
    // (Browsers differ on whether "closed" or "activated" is reported first, so check both.)
    const justClosed = T.closed && T.closed.w === windowId && Date.now() - T.closed.at < 600 ? T.closed.sid : null;
    const goneSid = justClosed || (before != null && !left ? T.tabSpace[before] : null);
    delete T.closed;
    if (spaceById(goneSid) && !tab.pinned && spaceOfTab(tab) !== goneSid && T.activeSpace[windowId] === goneSid) {
      const mine = (await chrome.tabs.query({ windowId })).filter((t) => !t.pinned && spaceOfTab(t) === goneSid);
      const pick = T.hist[windowId].map((id) => mine.find((t) => t.id === id)).find(Boolean) || mine[mine.length - 1];
      if (pick) {
        if (pick.hidden) await chrome.tabs.show([pick.id]).catch(() => {});
        await chrome.tabs.update(pick.id, { active: true });
      } else {
        await createTab({ windowId, url: START_URL, active: true }, goneSid);
      }
      return;
    }
    if (!tab.pinned) {
      // Going to a tab in another space (from the command bar, say) switches to that space.
      const sid = spaceOfTab(tab);
      T.lastTab[`${windowId}:${sid}`] = tabId;
      if (T.activeSpace[windowId] !== sid) {
        T.activeSpace[windowId] = sid;
        rememberSpace(sid);
        scheduleReconcile(windowId, 20);
      }
    }
    notify(windowId);
  }),
);

const VIEW_KEYS = ['title', 'url', 'favIconUrl', 'audible', 'mutedInfo', 'status', 'discarded', 'pinned', 'hidden'];

chrome.tabs.onUpdated.addListener((tabId, info, tab) =>
  locked(async () => {
    const w = tab.windowId;
    if (T.mini[w]) {
      if (info.status) pingMini(tabId);
      return;
    }
    if (info.pinned !== undefined) {
      const exp = expectPin.get(tabId);
      expectPin.delete(tabId);
      const ours = !!exp && exp.pinned === info.pinned && Date.now() - exp.at < 5000;
      const id = !ours && info.pinned === false ? itemOfTab(w, tabId) : null;
      if (id) {
        // A browser may report "unpinned" just before a pinned tab closes. Wait and see
        // whether the tab is still there before treating this as a deliberate unpin.
        pendingUnpin.add(tabId);
        setTimeout(() => {
          locked(async () => {
            pendingUnpin.delete(tabId);
            const t = await getTab(tabId);
            const f = t && !t.pinned && itemOfTab(w, tabId) === id ? findItem(id) : null;
            if (f) {
              f.arr.splice(f.idx, 1);
              delete liveMap(w)[id];
              await saveS('pinned', 'favorites');
            }
            scheduleReconcile(w, 20);
          }).catch(() => {});
        }, 150);
      }
      scheduleReconcile(w);
    }
    if (info.url) {
      // A new page in this tab: any command bar frame it hosted is gone.
      for (const k in T.frames) if (T.frames[k] === tabId) delete T.frames[k];
      if (T.fresh[tabId] && isWeb(info.url)) await settleContainer(tab);
    }
    if (VIEW_KEYS.some((k) => k in info)) notify(w);
  }),
);

chrome.tabs.onRemoved.addListener((tabId, info) =>
  locked(async () => {
    unlinkTab(tabId);
    // If this was the tab in front, remember its space briefly, so the tab that takes its
    // place can be checked against it.
    const wasFront = (T.hist[info.windowId] || [])[0] === tabId;
    if (wasFront && !info.isWindowClosing && spaceById(T.tabSpace[tabId])) T.closed = { w: info.windowId, sid: T.tabSpace[tabId], at: Date.now() };
    delete T.tabSpace[tabId];
    delete T.fresh[tabId];
    own.delete(tabId);
    expectPin.delete(tabId);
    pendingUnpin.delete(tabId);
    if (icons.delete(tabId)) chrome.storage.session.remove(`icon:${tabId}`).catch(() => {});
    for (const k in T.lastTab) if (T.lastTab[k] === tabId) delete T.lastTab[k];
    for (const k in T.frames) if (T.frames[k] === tabId) delete T.frames[k];
    const h = T.hist[info.windowId];
    if (h) T.hist[info.windowId] = h.filter((id) => id !== tabId);
    if (!info.isWindowClosing) notify(info.windowId);
  }),
);

chrome.tabs.onMoved.addListener((_id, info) => notify(info.windowId));
chrome.tabs.onDetached.addListener((tabId, info) =>
  locked(async () => {
    unlinkTab(tabId);
    notify(info.oldWindowId);
  }),
);
chrome.tabs.onAttached.addListener((_id, info) => {
  scheduleReconcile(info.newWindowId);
  notify(info.newWindowId);
});

// A container removed in Firefox's settings takes its tabs and logins with it; the
// space stays and gets a fresh container the next time it opens a page.
chrome.contextualIdentities?.onRemoved.addListener((change) =>
  locked(async () => {
    const sp = S.spaces.find((s) => s.store && s.store === change.contextualIdentity?.cookieStoreId);
    if (!sp) return;
    sp.store = null;
    await saveS('spaces');
    notify();
  }),
);

chrome.windows.onCreated.addListener((w) => {
  if (w.type === 'normal') scheduleReconcile(w.id, 200);
});
chrome.windows.onRemoved.addListener((w) =>
  locked(async () => {
    for (const k of ['activeSpace', 'mini', 'hist', 'live', 'relinked']) delete T[k][w];
    if (T.lastNormal === w) T.lastNormal = null;
  }),
);
chrome.windows.onFocusChanged.addListener((windowId) =>
  locked(async () => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
      T.unfocused = true;
      return;
    }
    if (T.unfocused) {
      T.unfocused = false;
      T.focusGainAt = Date.now();
    }
    const w = await chrome.windows.get(windowId).catch(() => null);
    if (w?.type === 'normal' && !T.mini[windowId]) T.lastNormal = windowId;
  }),
);

chrome.commands.onCommand.addListener((command, tab) =>
  locked(async () => {
    const win = await chrome.windows.getLastFocused().catch(() => null);
    const windowId = tab?.windowId ?? win?.id;
    const inMini = windowId != null && !!T.mini[windowId];
    tab ||= (await chrome.tabs.query({ active: true, windowId }))[0];
    switch (command) {
      case 'command-bar':
        if (!inMini) await openBar(windowId, 'new', { toggle: true });
        break;
      case 'command-bar-current':
        if (!inMini) await openBar(windowId, 'current', { toggle: true });
        break;
      case 'copy-url':
        await copyLink(tab);
        break;
      case 'copy-url-markdown':
        await copyLink(tab, { markdown: true });
        break;
      case 'mini-window':
        await openMini();
        break;
      case 'pop-out':
        if (inMini) await miniToMain(tab);
        else await popOut(tab);
        break;
      case 'next-space':
        if (!inMini) await stepSpace(windowId, 1);
        break;
      case 'previous-space':
        if (!inMini) await stepSpace(windowId, -1);
        break;
      case 'toggle-pin':
        if (!inMini) await togglePin(windowId, tab);
        break;
    }
  }),
);

chrome.contextMenus.onClicked.addListener((info, tab) =>
  locked(async () => {
    if (info.menuItemId === 'arcadia-mini-link' && /^https?:/i.test(info.linkUrl || '')) await openMini({ url: info.linkUrl, sid: tab ? T.tabSpace[tab.id] : null });
    if (info.menuItemId === 'arcadia-mini-page') await popOut(tab);
  }),
);

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'arcadia:archive') locked(autoArchive);
});

// The toolbar button shows or hides the sidebar. Firefox requires this to happen
// directly in the click handler.
chrome.action.onClicked.addListener(() => {
  chrome.sidebarAction?.toggle();
});

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'arcadia-mini-link', title: 'Open link in mini window', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'arcadia-mini-page', title: 'Open this page in a mini window', contexts: ['page'] });
  });
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

locked(async () => {
  syncAlarm();
  await reconcileAll();
});
