// Arcadia service worker.
//
// Owns all state. Spaces are Chrome tab groups: one group per space per window, and
// switching a space collapses the others. Pinned tabs are Chrome pinned tabs that
// follow the space: the current space's are pinned, other spaces' wait inside their
// group. The sidebar is Arcadia's panel in Chrome's side panel (sidepanel/), or, if
// the user prefers, Chrome's own vertical tab strip with a spaces menu (popup/).
// Pages talk to this file through chrome.runtime messages and re-read their view
// when it broadcasts "arcadia:changed".
//
// Privacy: this file makes no network requests and keeps no record of browsing.
// Disk (chrome.storage.local) holds only what the user creates: spaces, pinned
// entries, favorites, settings and which space was last open. Tab and group ids live in session memory.

import { COLOR_NAMES, hostOf } from './lib/shared.js';

const EXT = chrome.runtime.getURL('');
const BAR_URL = chrome.runtime.getURL('bar/bar.html');
const NTP_RE = /^(chrome|edge|brave|vivaldi):\/\/(newtab|new-tab-page)/i;
const BOOT_GRACE_MS = 4000;

const DEFAULT_SETTINGS = {
  newTabOpensBar: true, // swap Chrome's new tab for the command bar
  copyUrlShortcut: true, // ⇧⌘C on pages copies the link
  shiftClickMini: true, // shift-click a link opens it in a mini window
  cleanLinks: true, // copied links drop tracking parameters
  searchHistory: true, // the command bar looks in Chrome's history and bookmarks (read only)
  externalToMini: false, // links from other apps open in a mini window (experimental)
  collapseOtherSpaces: true,
  pinsPerSpace: true, // a tab pinned in Chrome belongs to the space it was pinned in
  sidebar: 'arcadia', // 'arcadia': Arcadia's sidebar in Chrome's side panel; 'chrome': Chrome's vertical tabs
  keepPinned: true, // with Chrome's vertical tabs: a closed pinned tab reopens asleep
  panelNav: false, // back/forward/address row at the top of Arcadia's sidebar
  archiveAfterHours: 0, // 0 = never
  miniWidth: 980,
  miniHeight: 700,
};

let S = null; // persistent: spaces, pinned, favorites, settings
let T = null; // per browser session: group/tab links
let selfUntil = 0; // tabs created before this timestamp are ours

const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const getTab = (id) => chrome.tabs.get(id).catch(() => null);
const multi = () => S.spaces.length > 1;
// True when Arcadia's own sidebar is in use; it can show a pinned tab that has no tab open.
const panelMode = () => S.settings.sidebar !== 'chrome';
const spaceById = (id) => S.spaces.find((s) => s.id === id) || null;

// ---------------------------------------------------------------- state

const ready = (async () => {
  const l = await chrome.storage.local.get(['spaces', 'pinned', 'favorites', 'settings', 'lastSpace']);
  chrome.storage.local.remove('archive').catch(() => {});
  const fresh = !Array.isArray(l.spaces) || !l.spaces.length;
  S = {
    spaces: fresh ? [{ id: uid(), name: 'Personal', emoji: '🌿', color: 'blue' }] : l.spaces,
    pinned: l.pinned || {},
    favorites: l.favorites || [],
    lastSpace: l.lastSpace || null,
    settings: { ...DEFAULT_SETTINGS, ...Object.fromEntries(Object.entries(l.settings || {}).filter(([k]) => k in DEFAULT_SETTINGS)) },
  };
  if (fresh || !l.settings) await chrome.storage.local.set({ spaces: S.spaces, settings: S.settings });
  const s = await chrome.storage.session.get('T');
  T = s.T || {
    boot: Date.now(),
    groupSpace: {}, // groupId -> spaceId
    activeSpace: {}, // windowId -> spaceId
    lastTab: {}, // `${windowId}:${spaceId}` -> tabId
    live: {}, // windowId -> { itemId: tabId } for pinned entries and favorites
    mini: {}, // windowId -> true
    hist: {}, // windowId -> recently active tab ids
    relinked: {},
    woke: {}, // itemId -> recent times a closed pinned tab was reopened
    born: {}, // tabId -> the space that was open when the tab was created
    tokens: {}, // one-time tokens for the in-page command bar
    docs: {}, // documentId -> tabId for trusted command bar frames
    lastNormal: null,
    unfocused: false,
    focusGainAt: 0,
  };
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

// ---------------------------------------------------------------- links between entries and tabs

const liveMap = (w) => (T.live[w] ||= {});
const itemOfTab = (w, tabId) => Object.keys(liveMap(w)).find((k) => liveMap(w)[k] === tabId) || null;
function unlinkTab(tabId) {
  for (const w in T.live) for (const k in T.live[w]) if (T.live[w][k] === tabId) delete T.live[w][k];
}

// Our own pin and unpin calls, so the tabs.onUpdated handler can tell them from the user's.
const expectPin = new Map();
// Tabs Chrome just reported as unpinned, until we know whether that was a close.
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

function rememberSpace(sid) {
  if (S.lastSpace === sid) return;
  S.lastSpace = sid;
  chrome.storage.local.set({ lastSpace: sid }).catch(() => {});
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

function spaceOfGroup(group) {
  const known = T.groupSpace[group.id];
  if (known && spaceById(known)) return known;
  if (!multi()) return null;
  // After a restart group ids change, so fall back to the group title.
  const sp = S.spaces.find((s) => s.name === group.title);
  if (sp) {
    T.groupSpace[group.id] = sp.id;
    return sp.id;
  }
  return null;
}

function activeSpace(windowId, tabs, groups) {
  if (!multi()) return (T.activeSpace[windowId] = S.spaces[0].id);
  const at = tabs?.find((t) => t.active);
  if (at && at.groupId !== -1) {
    const g = groups.find((x) => x.id === at.groupId);
    const sid = g && spaceOfGroup(g);
    if (sid) return (T.activeSpace[windowId] = sid);
  }
  let sid = T.activeSpace[windowId];
  if (!spaceById(sid)) sid = spaceById(S.lastSpace) ? S.lastSpace : S.spaces[0].id;
  return (T.activeSpace[windowId] = sid);
}

function relink(windowId, tabs, groups) {
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
  const pinnedTabs = tabs.filter((t) => t.pinned);
  for (const f of S.favorites) claim(f, pinnedTabs);
  for (const sp of S.spaces) {
    const gids = groups.filter((g) => spaceOfGroup(g) === sp.id).map((g) => g.id);
    const inGroup = tabs.filter((t) => !t.pinned && (!multi() || gids.includes(t.groupId)));
    for (const p of S.pinned[sp.id] || []) claim(p, [...inGroup, ...pinnedTabs]);
  }
}

// ---------------------------------------------------------------- reconcile

// Idempotent: brings one window's tab groups and pinned tabs in line with the spaces.
async function reconcile(windowId) {
  let win;
  try {
    win = await chrome.windows.get(windowId);
  } catch {
    return;
  }
  if (win.type !== 'normal' || T.mini[windowId]) return;
  let tabs = await chrome.tabs.query({ windowId });
  let groups = await chrome.tabGroups.query({ windowId });
  relink(windowId, tabs, groups);
  const active = activeSpace(windowId, tabs, groups);
  const map = liveMap(windowId);

  // A tab pinned in Chrome becomes a pinned entry: of this space, or of every space.
  let added = false;
  for (const t of tabs) {
    if (!t.pinned || itemOfTab(windowId, t.id)) continue;
    const url = t.url || t.pendingUrl;
    if (!url || url.startsWith(BAR_URL)) continue;
    let it = [...S.favorites, ...(S.pinned[active] || [])].find((x) => map[x.id] == null && x.url === url);
    if (!it) {
      it = { id: uid(), title: t.title || hostOf(url) || 'Pinned tab', url };
      (S.settings.pinsPerSpace ? (S.pinned[active] ||= []) : S.favorites).push(it);
      added = true;
    }
    map[it.id] = t.id;
  }
  if (added) await saveS('pinned', 'favorites');

  try {
    // Pinned tabs follow the space. This space's, and the ones kept everywhere, are
    // pinned in Chrome; other spaces' wait, unpinned, inside their own group.
    const byId = new Map(tabs.map((t) => [t.id, t]));
    const away = new Map();
    let moved = false;
    for (const f of S.favorites) {
      const t = byId.get(map[f.id]);
      if (t && !t.pinned && !pendingUnpin.has(t.id)) moved = (await setPinned(t, true)) || moved;
    }
    for (const sp of S.spaces) {
      for (const p of S.pinned[sp.id] || []) {
        const t = byId.get(map[p.id]);
        if (!t) continue;
        if (sp.id === active) {
          if (!t.pinned && !pendingUnpin.has(t.id)) moved = (await setPinned(t, true)) || moved;
        } else {
          if (t.pinned) moved = (await setPinned(t, false)) || moved;
          if (!away.has(sp.id)) away.set(sp.id, []);
          away.get(sp.id).push(t.id);
        }
      }
    }
    if (moved) {
      tabs = await chrome.tabs.query({ windowId });
      groups = await chrome.tabGroups.query({ windowId });
    }

    if (!multi()) {
      // One space needs no groups; undo any we made earlier.
      for (const g of groups) {
        if (!T.groupSpace[g.id]) continue;
        const ids = tabs.filter((t) => t.groupId === g.id).map((t) => t.id);
        if (ids.length) await chrome.tabs.ungroup(ids);
        delete T.groupSpace[g.id];
      }
    } else {
      const bySpace = new Map();
      for (const g of groups) {
        const sid = spaceOfGroup(g);
        if (!sid) continue;
        const sp = spaceById(sid);
        if (bySpace.has(sid)) {
          const ids = tabs.filter((t) => t.groupId === g.id).map((t) => t.id);
          if (ids.length) await chrome.tabs.group({ tabIds: ids, groupId: bySpace.get(sid).id });
          delete T.groupSpace[g.id];
          continue;
        }
        bySpace.set(sid, g);
        if (g.title !== sp.name || g.color !== sp.color) {
          await chrome.tabGroups.update(g.id, { title: sp.name, color: sp.color });
        }
      }
      const groupInto = async (sid, ids) => {
        const g = bySpace.get(sid);
        if (g) return chrome.tabs.group({ tabIds: ids, groupId: g.id });
        const gid = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId } });
        T.groupSpace[gid] = sid;
        const sp = spaceById(sid);
        await chrome.tabGroups.update(gid, { title: sp.name, color: sp.color });
        bySpace.set(sid, { id: gid, collapsed: false });
      };
      const tucked = new Set();
      for (const [sid, ids] of away) {
        const g = bySpace.get(sid);
        const need = [];
        for (const id of ids) {
          const t = tabs.find((x) => x.id === id);
          if (!t || t.pinned) continue;
          tucked.add(id);
          if (!g || t.groupId !== g.id) need.push(id);
        }
        if (need.length) await groupInto(sid, need);
      }
      // A new tab belongs to the space that was open when it appeared, even if the
      // user has switched space in the moment since.
      T.born ||= {};
      const homes = new Map();
      for (const t of tabs) {
        if (t.pinned || t.groupId !== -1 || tucked.has(t.id)) continue;
        const sid = spaceById(T.born[t.id]) && !t.active ? T.born[t.id] : active;
        if (!homes.has(sid)) homes.set(sid, []);
        homes.get(sid).push(t.id);
        delete T.born[t.id];
      }
      for (const [sid, ids] of homes) await groupInto(sid, ids);
      if (S.settings.collapseOtherSpaces) {
        for (const [sid, g] of bySpace) {
          const want = sid !== active;
          if (g.collapsed !== want) await chrome.tabGroups.update(g.id, { collapsed: want }).catch(() => {});
        }
      }
    }
    await wakeMissing(windowId, active);
  } catch (e) {
    // Chrome refuses tab edits while the user drags a tab; try again shortly.
    if (/dragging|cannot be edited|edited right now/i.test(String(e))) scheduleReconcile(windowId, 400);
    else throw e;
  }
  notify(windowId);
}

// With Chrome's vertical tabs as the sidebar, a pinned entry with no tab anywhere
// gets one back, asleep; that strip cannot show an entry without a tab. Arcadia's
// own sidebar can, so there a closed pinned tab simply rests in the list.
async function wakeMissing(windowId, active) {
  if (panelMode() || !S.settings.keepPinned || Date.now() - T.boot < 8000) return;
  const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
  const home = wins.some((w) => w.id === T.lastNormal) ? T.lastNormal : wins[0]?.id;
  if (home !== windowId) return;
  const liveAnywhere = (id) => Object.values(T.live).some((m) => m[id] != null);
  const now = Date.now();
  T.woke ||= {};
  for (const it of [...S.favorites, ...(S.pinned[active] || [])]) {
    if (liveAnywhere(it.id) || !/^https?:/.test(it.url)) continue;
    const recent = (T.woke[it.id] || []).filter((t) => now - t < 30000);
    if (recent.length >= 3) continue; // something keeps closing it; stop fighting
    T.woke[it.id] = [...recent, now];
    const t = await createTab({ windowId, url: it.url, pinned: true, active: false });
    liveMap(windowId)[it.id] = t.id;
    sleepSoon(t.id);
  }
}

// Lets a background tab load far enough to have its title and icon, then unloads it.
// (A tab discarded before that shows up blank in the tab strip.)
const sleepers = new Map();
function sleepSoon(tabId) {
  chrome.tabs.update(tabId, { muted: true }).catch(() => {});
  const go = async () => {
    sleepers.delete(tabId);
    const t = await getTab(tabId);
    if (!t) return;
    await chrome.tabs.update(tabId, { muted: false }).catch(() => {});
    if (!t.active && !t.discarded) await chrome.tabs.discard(tabId).catch(() => {});
  };
  sleepers.set(tabId, { go, loaded: false, timer: setTimeout(go, 15000) });
}
function sleeperProgress(tabId, info) {
  const sl = sleepers.get(tabId);
  if (!sl) return;
  const again = (ms) => {
    clearTimeout(sl.timer);
    sl.timer = setTimeout(sl.go, ms);
  };
  if (info.status === 'complete' && !sl.loaded) {
    sl.loaded = true;
    again(2500);
  } else if (info.favIconUrl && sl.loaded) again(500);
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
    url: t.url || t.pendingUrl || '',
    favIconUrl: t.favIconUrl || '',
    active: t.active,
    audible: !!t.audible,
    muted: !!t.mutedInfo?.muted,
    loading: t.status === 'loading',
    discarded: !!t.discarded,
  };

async function getView(windowId) {
  const [tabs, groups] = await Promise.all([chrome.tabs.query({ windowId }), chrome.tabGroups.query({ windowId })]);
  const gSpace = new Map();
  for (const g of groups) {
    const sid = spaceOfGroup(g);
    if (sid) gSpace.set(g.id, sid);
  }
  const active = activeSpace(windowId, tabs, groups);
  relink(windowId, tabs, groups);
  const map = liveMap(windowId);
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const linked = new Set(Object.values(map));
  const shape = (it) => {
    const tab = map[it.id] != null ? byId.get(map[it.id]) : null;
    return {
      id: it.id,
      url: it.url,
      title: it.renamed ? it.title : tab?.title || it.title,
      moved: !!tab && !!tab.url && tab.url !== it.url,
      tab: slim(tab),
    };
  };
  const today = tabs.filter(
    (t) => !t.pinned && !linked.has(t.id) && (!multi() || !gSpace.has(t.groupId) || gSpace.get(t.groupId) === active),
  );
  const activeTab = tabs.find((t) => t.active);
  const counts = Object.fromEntries(S.spaces.map((sp) => [sp.id, 0]));
  for (const t of tabs) {
    if ((t.url || '').startsWith(BAR_URL)) continue;
    const sid = !multi() ? active : gSpace.get(t.groupId) || (S.favorites.some((f) => map[f.id] === t.id) ? null : active);
    if (sid) counts[sid]++;
  }
  return {
    ok: true,
    windowId,
    counts,
    spaces: S.spaces,
    activeSpaceId: active,
    favorites: S.favorites.map(shape),
    pinned: (S.pinned[active] || []).map(shape),
    today: today.map(slim),
    current: slim(activeTab),
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
  if (multi()) {
    const tabs = await chrome.tabs.query({ windowId });
    const groups = await chrome.tabGroups.query({ windowId });
    const g = groups.find((x) => spaceOfGroup(x) === sid);
    const inSpace = g ? tabs.filter((t) => t.groupId === g.id) : [];
    // If the tab in front is already in this space (the user just picked it), keep it.
    const front = inSpace.find((t) => t.active);
    const target = front || inSpace.find((t) => t.id === T.lastTab[`${windowId}:${sid}`]) || inSpace[inSpace.length - 1];
    if (target) {
      if (g.collapsed) await chrome.tabGroups.update(g.id, { collapsed: false }).catch(() => {});
      await chrome.tabs.update(target.id, { active: true });
    } else if (!noCreate) {
      // A window always shows a tab, so an empty space gets a start page.
      await createTab({ windowId, url: `${BAR_URL}?mode=tab`, active: true });
    }
    await reconcile(windowId);
  }
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
  };
  // Group existing tabs under the current space before the new one takes over.
  S.spaces.push(sp);
  await saveS('spaces');
  await reconcileAll();
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
  await reconcileAll();
  notify();
  return { ok: true };
}

async function deleteSpace(id) {
  const idx = S.spaces.findIndex((s) => s.id === id);
  if (idx < 0) return { ok: false };
  if (S.spaces.length < 2) return { ok: false, error: 'Keep at least one space.' };
  // Make sure every group is mapped by id before the name disappears.
  for (const g of await chrome.tabGroups.query({})) spaceOfGroup(g);
  const fallback = S.spaces[idx === 0 ? 1 : idx - 1].id;
  S.spaces.splice(idx, 1);
  // Its pinned tabs stay open as ordinary tabs of the space that takes over.
  for (const p of S.pinned[id] || []) for (const w in T.live) delete T.live[w][p.id];
  delete S.pinned[id];
  if (S.lastSpace === id) rememberSpace(fallback);
  for (const gid in T.groupSpace) if (T.groupSpace[gid] === id) T.groupSpace[gid] = fallback;
  for (const w in T.activeSpace) if (T.activeSpace[w] === id) T.activeSpace[w] = fallback;
  await saveS('spaces', 'pinned');
  await reconcileAll();
  notify();
  return { ok: true };
}

async function tabsToSpace(windowId, tabIds, sid) {
  if (!multi() || !spaceById(sid)) return;
  const tabs = await chrome.tabs.query({ windowId });
  const groups = await chrome.tabGroups.query({ windowId });
  const active = activeSpace(windowId, tabs, groups);
  if (sid === active) return;
  const moving = tabs.filter((t) => tabIds.includes(t.id) && !t.pinned);
  if (!moving.length) return;
  const ids = moving.map((t) => t.id);
  if (moving.some((t) => t.active)) {
    // Stay in the current space: hand focus to a tab that is not moving.
    const ag = groups.find((g) => spaceOfGroup(g) === active);
    const stay = tabs.filter((t) => !ids.includes(t.id) && ((ag && t.groupId === ag.id) || t.pinned));
    if (stay.length) await chrome.tabs.update(stay[stay.length - 1].id, { active: true });
  }
  for (const id of ids) unlinkTab(id);
  const g = groups.find((x) => spaceOfGroup(x) === sid);
  if (g) {
    await chrome.tabs.group({ tabIds: ids, groupId: g.id });
  } else {
    const gid = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId } });
    T.groupSpace[gid] = sid;
    const sp = spaceById(sid);
    await chrome.tabGroups.update(gid, { title: sp.name, color: sp.color });
  }
  await reconcile(windowId);
}

// ---------------------------------------------------------------- tabs, pins and favorites

function createTab(props) {
  selfUntil = Date.now() + 1500;
  return chrome.tabs.create(props);
}

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
    const same = tabs.filter((t) => !t.pinned && t.groupId === me.groupId);
    index = same.length ? same[same.length - 1].index : -1;
  }
  if (index !== me.index) await chrome.tabs.move(tabId, { index });
  if (me.groupId !== -1) {
    const after = await getTab(tabId);
    if (after && after.groupId !== me.groupId) {
      await chrome.tabs.group({ tabIds: [tabId], groupId: me.groupId }).catch(() => {});
    }
  }
}

// Moves a tab or a saved entry into the today list, the pinned list or the favorites.
// `index` counts positions with the dragged entry already taken out.
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
  const url = entry?.url || tab?.url || tab?.pendingUrl;
  if (!url) return;

  if (dest.zone === 'today') {
    if (tab) {
      if (tab.pinned) await setPinned(tab, false);
      if (dest.beforeTabId !== undefined) await moveTabBefore(windowId, tab.id, dest.beforeTabId).catch(() => {});
    } else {
      await createTab({ windowId, url, active: false });
    }
  } else {
    const item = entry || { id: uid(), title: tab?.title || hostOf(url) || url, url };
    if (dest.zone === 'pinned') {
      const sid = spaceById(dest.spaceId) ? dest.spaceId : active;
      const arr = (S.pinned[sid] ||= []);
      arr.splice(clamp(dest.index ?? arr.length, 0, arr.length), 0, item);
      if (tab) {
        if (sid !== active) {
          await setPinned(tab, false);
          await tabsToSpace(windowId, [tab.id], sid);
        }
        liveMap(windowId)[item.id] = tab.id; // reconcile pins it in Chrome when its space is open
      }
    } else {
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

async function openItem(windowId, id) {
  const f = findItem(id);
  if (!f) return null;
  const tid = liveMap(windowId)[id];
  let tab = tid != null ? await getTab(tid) : null;
  if (tab && tab.windowId === windowId) {
    await chrome.tabs.update(tab.id, { active: true });
    return tab;
  }
  if (f.zone === 'pinned' && multi() && f.spaceId !== T.activeSpace[windowId]) {
    await switchSpace(windowId, f.spaceId, { noCreate: true });
  }
  tab = await createTab({ windowId, url: f.item.url, active: true, pinned: f.zone === 'favs' });
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

// Closed tabs are not recorded here. Chrome keeps its own recently-closed list; this reads it.
async function recentlyClosed() {
  const sessions = await chrome.sessions.getRecentlyClosed({ maxResults: 25 });
  const items = [];
  for (const s of sessions) {
    const at = (s.lastModified || 0) * 1000;
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
    (t) =>
      !t.pinned &&
      !t.active &&
      !t.audible &&
      t.lastAccessed &&
      t.lastAccessed < cutoff &&
      !itemOfTab(t.windowId, t.id) &&
      /^https?:/.test(t.url || ''),
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

async function openMini({ url, tabId } = {}) {
  const width = clamp(Number(S.settings.miniWidth) || 980, 420, 2400);
  const height = clamp(Number(S.settings.miniHeight) || 700, 320, 1800);
  const opts = { type: 'popup', width, height, focused: true };
  try {
    const cur = await chrome.windows.getLastFocused();
    if (cur?.width) {
      opts.left = Math.round(cur.left + (cur.width - width) / 2);
      opts.top = Math.round(cur.top + Math.max(48, (cur.height - height) / 3));
    }
  } catch {}
  if (tabId != null) opts.tabId = tabId;
  else opts.url = url || `${BAR_URL}?mode=mini`;
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
  const url = tab.url || tab.pendingUrl;
  const siblings = await chrome.tabs.query({ windowId: tab.windowId });
  if (siblings.length > 1) await openMini({ tabId: tab.id });
  else if (/^https?:/.test(url || '')) await openMini({ url });
}

function pingMini(tabId) {
  chrome.tabs.sendMessage(tabId, { type: 'arcadia:mini' }, { frameId: 0 }).catch(() => {});
}

async function miniToMain(tab) {
  if (!tab || !T.mini[tab.windowId]) return;
  const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
  const target = wins.find((w) => w.id === T.lastNormal) || wins[0];
  const url = tab.url || tab.pendingUrl;
  if (!target) {
    await chrome.windows.create({ url });
    await chrome.tabs.remove(tab.id).catch(() => {});
    return;
  }
  try {
    await chrome.tabs.move(tab.id, { windowId: target.id, index: -1 });
    await chrome.tabs.update(tab.id, { active: true });
  } catch {
    // Chrome only moves tabs between normal windows on some versions; reopen instead.
    await createTab({ windowId: target.id, url, active: true });
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
  await chrome.windows.update(target.id, { focused: true }).catch(() => {});
  scheduleReconcile(target.id, 20);
}

// ---------------------------------------------------------------- copy link

async function writeClipboard(text) {
  const has = await chrome.offscreen.hasDocument();
  if (!has) {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['CLIPBOARD'],
      justification: 'Copy the current tab link to the clipboard.',
    });
  }
  const r = await chrome.runtime.sendMessage({ type: 'arcadia:offscreen-copy', text });
  if (!r?.ok) throw new Error('Clipboard write failed');
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
  let url = tab?.url || tab?.pendingUrl;
  if (!url) return { ok: false };
  if (S.settings.cleanLinks) url = cleanUrl(url);
  await writeClipboard(markdown ? `[${(tab.title || url).replace(/[[\]]/g, '\\$&')}](${url})` : url);
  await toast(tab, markdown ? 'Copied link as Markdown' : 'Copied link');
  return { ok: true };
}

// ---------------------------------------------------------------- command bar

const injectable = (url) =>
  /^(https?|file):/.test(url || '') && !/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/.test(url);

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
    // The page was open before Arcadia loaded; inject the content script now.
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
  await createTab({ windowId, url: `${BAR_URL}?mode=tab`, active: true });
}

// Chrome opened its new tab page: replace it with the command bar.
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
  // No page to draw over (chrome:// pages, the Web Store): use a full-tab command bar.
  await createTab({ windowId: w, url: `${BAR_URL}?mode=tab`, index: tab.index, active: true });
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
  { id: 'space-new', title: 'New space', words: 'create' },
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
    favIconUrl: t.favIconUrl,
    hint: 'Switch to tab',
  });
  if (!q) {
    const recent = all
      .filter((t) => t.windowId === windowId && t.id !== ctxTab?.id)
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
  const liveIds = new Set(Object.values(liveMap(windowId)));
  const addSaved = (it, label) => {
    if (liveMap(windowId)[it.id] != null && liveIds.has(liveMap(windowId)[it.id])) return; // already listed as a tab
    const s = score(ql, tokens, it.title, it.url);
    if (s) saved.push({ s, item: { kind: 'item', key: `item:${it.id}`, id: it.id, title: it.title, sub: label, url: it.url, hint: 'Open' } });
  };
  for (const f of S.favorites) addSaved(f, 'Favorite');
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

// Where a chosen address goes depends on how the bar was opened.
async function openUrl(url, mode, windowId, ctxTab, selfTab, background = false) {
  if (background) return createTab({ windowId, url, active: false });
  if (mode === 'tab' || mode === 'mini') return chrome.tabs.update(selfTab.id, { url });
  if (mode === 'current' && ctxTab) return chrome.tabs.update(ctxTab.id, { url });
  return createTab({ windowId, url, active: true });
}

async function barRun(m, windowId, ctxTab, selfTab) {
  const { item, mode } = m;
  const standalone = mode === 'tab' || mode === 'mini';
  switch (item?.kind) {
    case 'tab': {
      const t = await getTab(item.id);
      if (!t) return { ok: false };
      await chrome.tabs.update(t.id, { active: true });
      await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
      if (standalone && selfTab) await chrome.tabs.remove(selfTab.id).catch(() => {});
      return { ok: true };
    }
    case 'item': {
      if (mode === 'mini') {
        const f = findItem(item.id);
        if (f) await chrome.tabs.update(selfTab.id, { url: f.item.url });
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
      if (standalone) await chrome.search.query({ text, tabId: selfTab.id });
      else if (mode === 'current' && ctxTab) await chrome.search.query({ text, tabId: ctxTab.id });
      else {
        selfUntil = Date.now() + 1500;
        await chrome.search.query({ text, disposition: 'NEW_TAB' });
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
      const id = tab && itemOfTab(windowId, tab.id);
      if (id) await placeItem(windowId, { kind: 'item', id }, { zone: 'today' });
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
      await createTab({ url: 'chrome://extensions/shortcuts' });
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

const FROM_PAGES = new Set(['copy-url', 'mini:open', 'mini:toMain']);

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

async function route(m, sender) {
  const tab = sender.tab || null;
  // The command bar frame inside a web page must prove Arcadia opened it.
  const embedded = !!tab && sender.frameId > 0;
  if (embedded) {
    if (m.type === 'bar:init') {
      const t = T.tokens[m.token];
      if (!t || t.tabId !== tab.id || t.exp < Date.now()) return { ok: false };
      delete T.tokens[m.token];
      T.docs[sender.documentId] = tab.id;
    } else if (!T.docs[sender.documentId] || !m.type.startsWith('bar:')) {
      return { ok: false };
    }
  }
  const selfIsBar = !!tab && sender.frameId === 0 && (tab.url || sender.url || '').startsWith(BAR_URL);
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
      return tabsToSpace(m.windowId, [m.tabId], m.spaceId);
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
    case 'copy-url':
      return copyLink(tab || ctxTab, { markdown: !!m.markdown });
    case 'mini:open':
      if (!/^https?:\/\//i.test(m.url || '')) return { ok: false };
      await openMini({ url: m.url });
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
      if ('sidebar' in patch && !['arcadia', 'chrome'].includes(patch.sidebar)) delete patch.sidebar;
      Object.assign(S.settings, patch);
      await saveS('settings');
      syncAlarm();
      await syncIcon();
      if (['collapseOtherSpaces', 'keepPinned', 'pinsPerSpace', 'sidebar'].some((k) => k in patch)) await reconcileAll();
      notify();
      return { ok: true, settings: S.settings };
    }
    case 'data:export':
      return { ok: true, data: { arcadia: 1, spaces: S.spaces, pinned: S.pinned, favorites: S.favorites, settings: S.settings } };
    case 'data:import': {
      const d = m.data;
      if (!d || d.arcadia !== 1 || !Array.isArray(d.spaces) || !d.spaces.length) return { ok: false, error: 'This is not an Arcadia export file.' };
      const clean = (it) => ({ id: uid(), title: String(it.title || it.url || '').slice(0, 200), url: String(it.url || ''), renamed: !!it.renamed });
      const okUrl = (it) => it && /^[a-z][a-z0-9+.-]*:/i.test(it.url || '');
      const ids = new Map();
      S.spaces = d.spaces.slice(0, 30).map((s) => {
        const id = uid();
        ids.set(s.id, id);
        return { id, name: String(s.name || 'Space').slice(0, 40), emoji: String(s.emoji || '✨').slice(0, 8), color: COLOR_NAMES.includes(s.color) ? s.color : 'blue' };
      });
      S.spaces.forEach((s) => (s.name = uniqueName(s.name, s.id)));
      S.pinned = {};
      for (const [old, arr] of Object.entries(d.pinned || {})) {
        if (ids.has(old) && Array.isArray(arr)) S.pinned[ids.get(old)] = arr.filter(okUrl).map(clean);
      }
      S.favorites = (Array.isArray(d.favorites) ? d.favorites : []).filter(okUrl).map(clean);
      T.groupSpace = {};
      T.activeSpace = {};
      T.live = {};
      T.relinked = {};
      await saveS('spaces', 'pinned', 'favorites');
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
    const url = tab.pendingUrl || tab.url || '';
    const booting = Date.now() - T.boot < BOOT_GRACE_MS;
    if (!booting && tab.active && S.settings.newTabOpensBar && NTP_RE.test(url)) {
      await interceptNewTab(tab);
      return;
    }
    const cameFromOutside = T.unfocused || Date.now() - (T.focusGainAt || 0) < 1500;
    if (!booting && S.settings.externalToMini && cameFromOutside && tab.openerTabId == null && /^https?:/.test(url) && Date.now() > selfUntil) {
      const siblings = await chrome.tabs.query({ windowId: w });
      if (siblings.length > 1) {
        await openMini({ tabId: tab.id });
        return;
      }
    }
    if (spaceById(T.activeSpace[w])) (T.born ||= {})[tab.id] = T.activeSpace[w];
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
    if (multi() && tab.groupId !== -1) {
      const g = await chrome.tabGroups.get(tab.groupId).catch(() => null);
      const sid = g && spaceOfGroup(g);
      if (sid) {
        T.lastTab[`${windowId}:${sid}`] = tabId;
        if (T.activeSpace[windowId] !== sid) {
          T.activeSpace[windowId] = sid;
          rememberSpace(sid);
          scheduleReconcile(windowId, 20);
        }
      }
    } else if (!tab.pinned && T.activeSpace[windowId]) {
      T.lastTab[`${windowId}:${T.activeSpace[windowId]}`] = tabId;
    }
    notify(windowId);
  }),
);

const VIEW_KEYS = ['title', 'url', 'favIconUrl', 'audible', 'mutedInfo', 'status', 'discarded', 'pinned', 'groupId'];

chrome.tabs.onUpdated.addListener((tabId, info, tab) =>
  locked(async () => {
    const w = tab.windowId;
    if (T.mini[w]) {
      if (info.status) pingMini(tabId);
      return;
    }
    sleeperProgress(tabId, info);
    if (info.pinned !== undefined) {
      const exp = expectPin.get(tabId);
      expectPin.delete(tabId);
      const ours = !!exp && exp.pinned === info.pinned && Date.now() - exp.at < 5000;
      const id = !ours && info.pinned === false ? itemOfTab(w, tabId) : null;
      if (id) {
        // Chrome also reports "unpinned" just before a pinned tab closes. Wait and see
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
    }
    if (info.pinned !== undefined || info.groupId !== undefined) scheduleReconcile(w);
    if (VIEW_KEYS.some((k) => k in info)) notify(w);
  }),
);

chrome.tabs.onRemoved.addListener((tabId, info) =>
  locked(async () => {
    const pinnedId = itemOfTab(info.windowId, tabId);
    unlinkTab(tabId);
    if (T.born) delete T.born[tabId];
    expectPin.delete(tabId);
    pendingUnpin.delete(tabId);
    clearTimeout(sleepers.get(tabId)?.timer);
    sleepers.delete(tabId);
    if (pinnedId && !info.isWindowClosing && !panelMode()) {
      if (S.settings.keepPinned) scheduleReconcile(info.windowId, 150); // comes back asleep
      else {
        const f = findItem(pinnedId);
        if (f) {
          f.arr.splice(f.idx, 1);
          await saveS('pinned', 'favorites');
        }
      }
    }
    for (const k in T.lastTab) if (T.lastTab[k] === tabId) delete T.lastTab[k];
    for (const d in T.docs) if (T.docs[d] === tabId) delete T.docs[d];
    const h = T.hist[info.windowId];
    if (h) T.hist[info.windowId] = h.filter((id) => id !== tabId);
    if (!info.isWindowClosing) notify(info.windowId);
  }),
);

chrome.tabs.onReplaced.addListener((added, removed) =>
  locked(async () => {
    for (const w in T.live) for (const k in T.live[w]) if (T.live[w][k] === removed) T.live[w][k] = added;
    for (const w in T.hist) T.hist[w] = T.hist[w].map((id) => (id === removed ? added : id));
    for (const k in T.lastTab) if (T.lastTab[k] === removed) T.lastTab[k] = added;
    notify();
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

chrome.tabGroups.onCreated.addListener((g) => scheduleReconcile(g.windowId));
chrome.tabGroups.onRemoved.addListener((g) =>
  locked(async () => {
    delete T.groupSpace[g.id];
    notify(g.windowId);
  }),
);
chrome.tabGroups.onUpdated.addListener((g) =>
  locked(async () => {
    // The event carries a snapshot that may be stale by now (our own edits queue up), so read the group again.
    g = await chrome.tabGroups.get(g.id).catch(() => null);
    const sid = g && spaceOfGroup(g);
    if (!sid || !multi()) return;
    // Expanding another space's group in Chrome's tab strip switches to that space.
    if (S.settings.collapseOtherSpaces && !g.collapsed && T.activeSpace[g.windowId] && T.activeSpace[g.windowId] !== sid) {
      await switchSpace(g.windowId, sid);
      return;
    }
    const sp = spaceById(sid);
    if (g.title !== sp.name || g.color !== sp.color) scheduleReconcile(g.windowId);
  }),
);

chrome.windows.onCreated.addListener((w) => {
  if (w.type === 'normal') scheduleReconcile(w.id, 200);
});
chrome.windows.onRemoved.addListener((w) =>
  locked(async () => {
    for (const k of ['activeSpace', 'mini', 'hist', 'live', 'relinked']) delete T[k][w];
    if (T.lastNormal === w) T.lastNormal = null;
    for (const other of await chrome.windows.getAll({ windowTypes: ['normal'] })) scheduleReconcile(other.id, 300);
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
    if (info.menuItemId === 'arcadia-mini-link' && /^https?:/i.test(info.linkUrl || '')) await openMini({ url: info.linkUrl });
    if (info.menuItemId === 'arcadia-mini-page') await popOut(tab);
  }),
);

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'arcadia:archive') locked(autoArchive);
});

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'arcadia-mini-link', title: 'Open link in mini window', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'arcadia-mini-page', title: 'Open this page in a mini window', contexts: ['page'] });
  });
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

// The toolbar icon shows or hides Arcadia's sidebar; with Chrome's vertical tabs as the
// sidebar it opens the spaces menu instead.
async function syncIcon() {
  const panel = panelMode();
  await chrome.action.setPopup({ popup: panel ? '' : 'popup/popup.html' }).catch(() => {});
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: panel }).catch(() => {});
}

locked(async () => {
  syncAlarm();
  await syncIcon();
  await reconcileAll();
  // Once session restore has settled, bring back any pinned tab that did not come back with it.
  const wait = 9000 - (Date.now() - T.boot);
  if (wait > 0) setTimeout(() => locked(reconcileAll).catch(() => {}), wait);
});
