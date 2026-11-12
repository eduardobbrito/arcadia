// Arcadia service worker (Dia).
//
// Dia has its own sidebar, command bar and profiles, so this build draws no sidebar
// and leaves ⌘T alone. It adds what Dia lacks: spaces inside a profile, mini windows,
// cleaned link copying and a Clear for unused tabs.
//
// A space is kept in one of two ways:
//   groups   one window; each space is a tab group, and switching folds the others
//   windows  each space is its own window (used when Dia will not let an extension
//            manage tab groups)
// Pinned tabs are Dia's own business and are never touched.
//
// Privacy: no network requests and no record of browsing. Disk (chrome.storage.local)
// holds only spaces, settings, which space was last open and the order of the
// spaces' windows. Tab, group and window ids live in session memory.

import { COLOR_NAMES, hostOf } from './lib/shared.js';

const EXT = chrome.runtime.getURL('');
const BAR_URL = chrome.runtime.getURL('bar/bar.html');
const START_URL = `${BAR_URL}?mode=tab`;

const DEFAULT_SETTINGS = {
  spacesUse: 'auto', // 'auto', 'groups' or 'windows'
  collapseOtherSpaces: true, // with tab groups: fold the spaces you are not in
  copyUrlShortcut: true, // ⇧⌘C on pages copies the link
  cleanLinks: true, // copied links drop tracking parameters
  shiftClickMini: true, // shift-click a link opens it in a mini window
  externalToMini: false, // links from other apps open in a mini window (experimental)
  searchHistory: true, // the command palette looks in history and bookmarks (read only)
  archiveAfterHours: 0, // 0 = never
  miniWidth: 980,
  miniHeight: 700,
};

let S = null; // persistent: spaces, settings, lastSpace, winOrder
let T = null; // per browser session: ids only
let selfUntil = 0; // tabs created before this timestamp are ours

const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const getTab = (id) => chrome.tabs.get(id).catch(() => null);
const multi = () => S.spaces.length > 1;
const spaceById = (id) => S.spaces.find((s) => s.id === id) || null;
const isWeb = (url) => /^https?:/i.test(url || '');

// Whether the browser lets an extension manage tab groups at all, and has not refused yet.
const groupsUsable = () => !!chrome.tabGroups?.query && !!chrome.tabs.group && !T.groupsFailed;
function mode() {
  if (S.settings.spacesUse === 'windows') return 'windows';
  if (S.settings.spacesUse === 'groups') return 'groups';
  return groupsUsable() ? 'groups' : 'windows';
}

// ---------------------------------------------------------------- state

const ready = (async () => {
  const l = await chrome.storage.local.get(['spaces', 'settings', 'lastSpace', 'winOrder']);
  const fresh = !Array.isArray(l.spaces) || !l.spaces.length;
  S = {
    spaces: fresh ? [{ id: uid(), name: 'Personal', emoji: '🌿', color: 'blue' }] : l.spaces,
    lastSpace: l.lastSpace || null,
    winOrder: Array.isArray(l.winOrder) ? l.winOrder : [],
    settings: { ...DEFAULT_SETTINGS, ...Object.fromEntries(Object.entries(l.settings || {}).filter(([k]) => k in DEFAULT_SETTINGS)) },
  };
  if (fresh || !l.settings) await chrome.storage.local.set({ spaces: S.spaces, settings: S.settings });
  const s = await chrome.storage.session.get('T');
  T = s.T || {
    boot: Date.now(),
    groupSpace: {}, // groupId -> spaceId
    born: {}, // tabId -> the space that was open when the tab was created
    activeSpace: {}, // windowId -> spaceId (groups)
    lastTab: {}, // `${windowId}:${spaceId}` -> tabId
    winSpace: {}, // windowId -> spaceId (windows)
    mini: {}, // windowId -> true
    hist: {}, // windowId -> recently active tab ids
    tokens: {}, // one-time tokens for the in-page command palette
    docs: {}, // documentId -> tabId for trusted palette frames
    lastNormal: null,
    unfocused: false,
    focusGainAt: 0,
    groupsFailed: null, // why the browser refused a tab-group change, if it did
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

function rememberSpace(sid) {
  if (!sid || S.lastSpace === sid) return;
  S.lastSpace = sid;
  chrome.storage.local.set({ lastSpace: sid }).catch(() => {});
}

function createTab(props) {
  selfUntil = Date.now() + 1500;
  return chrome.tabs.create(props);
}

// ---------------------------------------------------------------- spaces as tab groups

function spaceOfGroup(group) {
  const known = T.groupSpace[group.id];
  if (known && spaceById(known)) return known;
  if (!multi()) return null;
  // After a restart group ids change, so fall back to the group's name.
  const sp = S.spaces.find((s) => s.name === group.title);
  if (sp) {
    T.groupSpace[group.id] = sp.id;
    return sp.id;
  }
  return null;
}

function activeGroupSpace(windowId, tabs, groups) {
  if (!multi()) return (T.activeSpace[windowId] = S.spaces[0].id);
  const front = tabs?.find((t) => t.active);
  if (front && front.groupId !== -1) {
    const g = groups.find((x) => x.id === front.groupId);
    const sid = g && spaceOfGroup(g);
    if (sid) return (T.activeSpace[windowId] = sid);
  }
  let sid = T.activeSpace[windowId];
  if (!spaceById(sid)) sid = spaceById(S.lastSpace) ? S.lastSpace : S.spaces[0].id;
  return (T.activeSpace[windowId] = sid);
}

// The browser refused a tab-group change for a reason other than a tab being dragged.
// Remember why; "auto" then keeps spaces in separate windows instead.
function groupsRefused(e) {
  T.groupsFailed = String(e?.message || e).slice(0, 200);
  notify();
}

// Idempotent: brings one window's tab groups in line with the spaces.
async function reconcileGroups(windowId) {
  try {
    const tabs = await chrome.tabs.query({ windowId });
    const groups = await chrome.tabGroups.query({ windowId });
    if (!multi()) {
      // One space needs no groups; undo any we made earlier.
      for (const g of groups) {
        if (!T.groupSpace[g.id]) continue;
        const ids = tabs.filter((t) => t.groupId === g.id).map((t) => t.id);
        if (ids.length) await chrome.tabs.ungroup(ids);
        delete T.groupSpace[g.id];
      }
      T.activeSpace[windowId] = S.spaces[0].id;
      return;
    }
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
      if (g.title !== sp.name || g.color !== sp.color) await chrome.tabGroups.update(g.id, { title: sp.name, color: sp.color });
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
    const active = activeGroupSpace(windowId, tabs, groups);
    // A new tab belongs to the space that was open when it appeared, even if the
    // user has switched space in the moment since.
    const homes = new Map();
    for (const t of tabs) {
      if (t.pinned || t.groupId !== -1) continue;
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
  } catch (e) {
    // Tab edits are refused while the user drags a tab; try again shortly.
    if (/dragging|cannot be edited|edited right now/i.test(String(e))) scheduleReconcile(windowId, 400);
    else groupsRefused(e);
  }
}

// ---------------------------------------------------------------- spaces as windows

const homeOf = (sid) => {
  const w = Object.keys(T.winSpace).find((k) => T.winSpace[k] === sid);
  return w == null ? null : Number(w);
};

function saveWinOrder() {
  S.winOrder = Object.keys(T.winSpace)
    .map(Number)
    .sort((a, b) => a - b)
    .map((w) => T.winSpace[w]);
  return saveS('winOrder');
}

// Drops windows that are gone, and on first look in a browser session matches the
// open windows to the spaces in the order the spaces' windows were last in. (Window
// ids change across a restart and nothing about their contents is stored.)
async function adoptWindows() {
  const wins = (await chrome.windows.getAll({ windowTypes: ['normal'] })).filter((w) => !T.mini[w.id]).sort((a, b) => a.id - b.id);
  const alive = new Set(wins.map((w) => w.id));
  for (const k of Object.keys(T.winSpace)) if (!alive.has(Number(k)) || !spaceById(T.winSpace[k])) delete T.winSpace[k];
  if (Object.keys(T.winSpace).length || !wins.length) return;
  const order = S.winOrder.filter((id, i, a) => spaceById(id) && a.indexOf(id) === i);
  const queue = order.length ? order : [spaceById(S.lastSpace) ? S.lastSpace : S.spaces[0].id];
  wins.forEach((w, i) => {
    if (queue[i]) T.winSpace[w.id] = queue[i];
  });
}

// ---------------------------------------------------------------- both ways

async function reconcile(windowId) {
  let win;
  try {
    win = await chrome.windows.get(windowId);
  } catch {
    return;
  }
  if (win.type !== 'normal' || T.mini[windowId]) return;
  if (mode() === 'groups') await reconcileGroups(windowId);
  else await adoptWindows();
  notify(windowId);
}

async function reconcileAll() {
  const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
  for (const w of wins) await reconcile(w.id);
}

// The space a window is showing, and that space's unpinned tabs in the window.
async function here(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  if (mode() === 'windows') {
    await adoptWindows();
    const active = spaceById(T.winSpace[windowId]) ? T.winSpace[windowId] : null;
    return { active, tabs, mine: tabs.filter((t) => !t.pinned), gSpace: null };
  }
  let groups = [];
  try {
    groups = await chrome.tabGroups.query({ windowId });
  } catch (e) {
    groupsRefused(e);
  }
  const gSpace = new Map();
  for (const g of groups) {
    const sid = spaceOfGroup(g);
    if (sid) gSpace.set(g.id, sid);
  }
  const active = activeGroupSpace(windowId, tabs, groups);
  const mine = tabs.filter((t) => !t.pinned && (!multi() || !gSpace.has(t.groupId) || gSpace.get(t.groupId) === active));
  return { active, tabs, mine, gSpace };
}

async function getView(windowId) {
  const m = mode();
  const { active, tabs, mine, gSpace } = await here(windowId);
  const counts = Object.fromEntries(S.spaces.map((sp) => [sp.id, 0]));
  const countable = (t) => !t.pinned && !(t.url || '').startsWith(BAR_URL);
  if (m === 'windows') {
    for (const t of await chrome.tabs.query({ windowType: 'normal' })) {
      const sid = T.winSpace[t.windowId];
      if (sid in counts && countable(t)) counts[sid]++;
    }
  } else {
    for (const t of tabs) {
      const sid = !multi() ? active : gSpace.get(t.groupId) || active;
      if (sid in counts && countable(t)) counts[sid]++;
    }
  }
  return {
    ok: true,
    windowId,
    mode: m,
    spaces: S.spaces,
    activeSpaceId: active,
    counts,
    clearable: mine.filter((t) => !t.active && !t.audible).length,
    hasWindow: m === 'windows' ? Object.fromEntries(S.spaces.map((sp) => [sp.id, homeOf(sp.id) != null])) : null,
    groupsMissing: !chrome.tabGroups?.query,
    groupsError: T.groupsFailed,
    settings: S.settings,
  };
}

function uniqueName(name, exceptId = null) {
  const base = (name || '').trim().slice(0, 40) || 'Space';
  let out = base;
  let n = 2;
  while (S.spaces.some((s) => s.id !== exceptId && s.name === out)) out = `${base} ${n++}`;
  return out;
}

async function switchSpace(windowId, sid) {
  if (!spaceById(sid)) return;
  rememberSpace(sid);
  if (mode() === 'windows') {
    await adoptWindows();
    const home = homeOf(sid);
    if (home != null) await chrome.windows.update(home, { focused: true });
    else if (windowId != null && !spaceById(T.winSpace[windowId]) && !T.mini[windowId]) T.winSpace[windowId] = sid; // this unclaimed window becomes the space
    else {
      selfUntil = Date.now() + 1500;
      const w = await chrome.windows.create({ focused: true });
      T.winSpace[w.id] = sid;
    }
    await saveWinOrder();
    notify();
    return;
  }
  if (windowId == null) return;
  T.activeSpace[windowId] = sid;
  if (multi()) {
    try {
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
      } else {
        // A window always shows a tab, so an empty space gets a start page.
        await createTab({ windowId, url: START_URL, active: true });
      }
    } catch (e) {
      groupsRefused(e);
    }
    await reconcile(windowId);
  }
  notify(windowId);
}

async function stepSpace(windowId, delta) {
  if (!multi()) return;
  const { active } = await here(windowId);
  const cur = S.spaces.findIndex((s) => s.id === active);
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
  if (mode() === 'windows') await adoptWindows(); // settle which window is which before adding one
  S.spaces.push(sp);
  await saveS('spaces');
  // With groups, existing tabs are grouped under the current space before the new one takes over.
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

// Deleting a space never closes tabs. With groups its tabs join the neighbouring
// space; with windows its window simply stops being a space.
async function deleteSpace(id) {
  const idx = S.spaces.findIndex((s) => s.id === id);
  if (idx < 0) return { ok: false };
  if (S.spaces.length < 2) return { ok: false, error: 'Keep at least one space.' };
  if (groupsUsable()) {
    // Make sure every group is mapped by id before the name disappears.
    for (const g of await chrome.tabGroups.query({}).catch(() => [])) spaceOfGroup(g);
  }
  const fallback = S.spaces[idx === 0 ? 1 : idx - 1].id;
  S.spaces.splice(idx, 1);
  for (const gid in T.groupSpace) if (T.groupSpace[gid] === id) T.groupSpace[gid] = fallback;
  for (const w in T.activeSpace) if (T.activeSpace[w] === id) T.activeSpace[w] = fallback;
  for (const w in T.winSpace) if (T.winSpace[w] === id) delete T.winSpace[w];
  if (S.lastSpace === id) rememberSpace(fallback);
  await saveS('spaces');
  await saveWinOrder();
  await reconcileAll();
  notify();
  return { ok: true };
}

async function tabsToSpace(windowId, tabIds, sid) {
  if (!spaceById(sid)) return;
  const { active, tabs, gSpace } = await here(windowId);
  if (sid === active) return;
  const moving = tabs.filter((t) => tabIds.includes(t.id) && !t.pinned);
  if (!moving.length) return;
  const ids = moving.map((t) => t.id);

  if (mode() === 'windows') {
    // The tab moves to the space's window as it is: no reload.
    const home = homeOf(sid);
    if (home != null) await chrome.tabs.move(ids, { windowId: home, index: -1 });
    else {
      selfUntil = Date.now() + 1500;
      const w = await chrome.windows.create({ tabId: ids[0], focused: false });
      T.winSpace[w.id] = sid;
      if (ids.length > 1) await chrome.tabs.move(ids.slice(1), { windowId: w.id, index: -1 });
      await saveWinOrder();
    }
    notify();
    return;
  }

  if (!multi()) return;
  try {
    if (moving.some((t) => t.active)) {
      // Stay in the current space: hand focus to a tab that is not moving.
      const stay = tabs.filter((t) => !ids.includes(t.id) && (t.pinned || gSpace.get(t.groupId) === active));
      if (stay.length) await chrome.tabs.update(stay[stay.length - 1].id, { active: true });
    }
    const groups = await chrome.tabGroups.query({ windowId });
    const g = groups.find((x) => spaceOfGroup(x) === sid);
    if (g) await chrome.tabs.group({ tabIds: ids, groupId: g.id });
    else {
      const gid = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId } });
      T.groupSpace[gid] = sid;
      const sp = spaceById(sid);
      await chrome.tabGroups.update(gid, { title: sp.name, color: sp.color });
    }
  } catch (e) {
    groupsRefused(e);
  }
  await reconcile(windowId);
}

// Closes the current space's unpinned tabs, except the one in front and any playing sound.
async function clearTabs(windowId) {
  const { mine } = await here(windowId);
  const ids = mine.filter((t) => !t.active && !t.audible).map((t) => t.id);
  if (ids.length) await chrome.tabs.remove(ids).catch(() => {});
  return { ok: true, closed: ids.length };
}

async function autoArchive() {
  const hrs = Number(S.settings.archiveAfterHours);
  if (!(hrs > 0)) return;
  const cutoff = Date.now() - hrs * 3600e3;
  const tabs = await chrome.tabs.query({ windowType: 'normal' });
  const old = tabs.filter((t) => !t.pinned && !t.active && !t.audible && t.lastAccessed && t.lastAccessed < cutoff && isWeb(t.url));
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
  const siblings = await chrome.tabs.query({ windowId: tab.windowId });
  if (siblings.length > 1) await openMini({ tabId: tab.id });
  else if (isWeb(tab.url || tab.pendingUrl)) await openMini({ url: tab.url || tab.pendingUrl });
}

function pingMini(tabId) {
  chrome.tabs.sendMessage(tabId, { type: 'arcadia:mini' }, { frameId: 0 }).catch(() => {});
}

async function miniToMain(tab) {
  if (!tab || !T.mini[tab.windowId]) return;
  const wins = (await chrome.windows.getAll({ windowTypes: ['normal'] })).filter((w) => !T.mini[w.id]);
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
    // Not every browser moves a tab out of a popup window; open the page again instead.
    await createTab({ windowId: target.id, url, active: true });
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
  await chrome.windows.update(target.id, { focused: true }).catch(() => {});
  scheduleReconcile(target.id, 20);
}

// ---------------------------------------------------------------- copy link

// A service worker cannot touch the clipboard. A hidden page does it; if the browser
// has no such page, the tab's own page script does.
async function writeClipboard(text, tab) {
  try {
    if (!chrome.offscreen) throw new Error('no offscreen pages');
    if (!(await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.createDocument({ url: 'offscreen/offscreen.html', reasons: ['CLIPBOARD'], justification: 'Copy the current tab link to the clipboard.' });
    }
    const r = await chrome.runtime.sendMessage({ type: 'arcadia:offscreen-copy', text });
    if (!r?.ok) throw new Error('offscreen copy failed');
  } catch (e) {
    const r = tab?.id != null ? await chrome.tabs.sendMessage(tab.id, { type: 'arcadia:copy', text }, { frameId: 0 }).catch(() => null) : null;
    if (!r?.ok) throw e;
  }
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
  await writeClipboard(markdown ? `[${(tab.title || url).replace(/[[\]]/g, '\\$&')}](${url})` : url, tab);
  await toast(tab, markdown ? 'Copied link as Markdown' : 'Copied link');
  return { ok: true };
}

// ---------------------------------------------------------------- command palette

const injectable = (url) =>
  /^(https?|file):/.test(url || '') && !/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/.test(url);

async function showOverlay(tabId, barMode, toggle = false) {
  const now = Date.now();
  for (const k in T.tokens) if (T.tokens[k].exp < now) delete T.tokens[k];
  const token = crypto.randomUUID();
  T.tokens[token] = { tabId, exp: now + 20000 };
  const msg = { type: 'arcadia:bar', mode: barMode, toggle, token };
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

async function openBar(windowId, barMode, { toggle = false } = {}) {
  if (windowId == null) return;
  const [tab] = await chrome.tabs.query({ windowId, active: true });
  if (tab && (tab.url || '').startsWith(BAR_URL)) return;
  if (tab && !tab.discarded && injectable(tab.url) && (await showOverlay(tab.id, barMode, toggle))) return;
  // No page to draw over (the browser's own pages): use a full-tab palette.
  await createTab({ windowId, url: START_URL, active: true });
}

const ACTIONS = [
  { id: 'mini-new', title: 'New mini window', words: 'little popup small' },
  { id: 'pop-out', title: 'Open this tab in a mini window', words: 'little popup small', needsTab: true },
  { id: 'copy-url', title: 'Copy link', words: 'url address', needsTab: true },
  { id: 'copy-md', title: 'Copy link as Markdown', words: 'url address', needsTab: true },
  { id: 'duplicate', title: 'Duplicate tab', needsTab: true },
  { id: 'mute', title: 'Mute or unmute tab', words: 'sound audio', needsTab: true },
  { id: 'close', title: 'Close tab', needsTab: true },
  { id: 'clear', title: 'Clear unused tabs in this space', words: 'close all unpinned' },
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
    const { active } = await here(windowId);
    for (const sp of S.spaces) {
      if (sp.id === active) continue;
      dyn.push({ id: `space:${sp.id}`, title: `Go to space ${sp.emoji} ${sp.name}`, words: 'switch' });
      dyn.push({ id: `move:${sp.id}`, title: `Move tab to space ${sp.emoji} ${sp.name}`, needsTab: true });
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
  hist.filter((x) => x.s >= 5).slice(0, 2).forEach((x) => push(histItem(x)));
  // Typing the start of a command means that command, not a web search for it.
  acts.filter((a) => a.title.toLowerCase().startsWith(ql)).slice(0, 3).forEach(push);
  if (!url) push(search);
  tabs.slice(0, 5).forEach((x) => push(tabItem(x.t)));
  acts.slice(0, 5).forEach(push);
  hist.slice(0, 5).forEach((x) => push(histItem(x)));
  marks.forEach((b) => push({ kind: 'url', key: `h:${b.url}`, title: b.title || b.url, sub: `Bookmark, ${hostOf(b.url)}`, url: b.url, hint: 'Open' }));
  if (url) push(search);
  return { ok: true, items: out.slice(0, 12) };
}

// Where a chosen address goes depends on how the palette was opened.
async function openUrl(url, barMode, windowId, ctxTab, selfTab, background = false) {
  if (background) return createTab({ windowId, url, active: false });
  if (barMode === 'tab' || barMode === 'mini') return chrome.tabs.update(selfTab.id, { url });
  if (barMode === 'current' && ctxTab) return chrome.tabs.update(ctxTab.id, { url });
  return createTab({ windowId, url, active: true });
}

async function barRun(m, windowId, ctxTab, selfTab) {
  const { item, mode: barMode } = m;
  const standalone = barMode === 'tab' || barMode === 'mini';
  switch (item?.kind) {
    case 'tab': {
      const t = await getTab(item.id);
      if (!t) return { ok: false };
      await chrome.tabs.update(t.id, { active: true });
      await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
      if (standalone && selfTab) await chrome.tabs.remove(selfTab.id).catch(() => {});
      return { ok: true };
    }
    case 'url':
      if (typeof item.url !== 'string') return { ok: false };
      await openUrl(item.url, barMode, windowId, ctxTab, selfTab, !!m.background && barMode !== 'mini');
      return { ok: true };
    case 'calc':
      await writeClipboard(String(item.value ?? ''), ctxTab || selfTab);
      await toast(ctxTab || selfTab, 'Copied result');
      return { ok: true };
    case 'search': {
      const text = String(item.title || '').trim();
      if (!text) return { ok: false };
      if (standalone) await chrome.search.query({ text, tabId: selfTab.id });
      else if (barMode === 'current' && ctxTab) await chrome.search.query({ text, tabId: ctxTab.id });
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
      await clearTabs(windowId);
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

// ---------------------------------------------------------------- messages

// The only messages a page script may send.
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

const frameKey = (sender) => sender.documentId || `${sender.tab.id}:${sender.frameId}`;

async function route(m, sender, fromExt) {
  const tab = sender.tab || null;
  // The palette frame inside a web page must prove Arcadia opened it.
  const embedded = fromExt && !!tab && sender.frameId > 0;
  if (embedded) {
    if (m.type === 'bar:init') {
      const t = T.tokens[m.token];
      if (!t || t.tabId !== tab.id || t.exp < Date.now()) return { ok: false };
      delete T.tokens[m.token];
      T.docs[frameKey(sender)] = tab.id;
    } else if (!T.docs[frameKey(sender)] || !m.type.startsWith('bar:')) {
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
    case 'tab:toSpace': {
      const id = m.tabId ?? ctxTab?.id;
      if (id == null) return { ok: false };
      return tabsToSpace(m.windowId, [id], m.spaceId);
    }
    case 'tab:pop':
      return popOut(await getTab(m.tabId));
    case 'tabs:clear':
      return clearTabs(m.windowId);
    case 'bar:init': {
      const { active } = windowId != null ? await here(windowId) : { active: null };
      const sp = spaceById(active) || spaceById(S.lastSpace) || S.spaces[0];
      return { ok: true, space: sp, multi: multi(), currentUrl: m.mode === 'current' ? ctxTab?.url || '' : '', empty: !ctxTab && !selfTab };
    }
    case 'bar:query':
      return barQuery(m.text, windowId, ctxTab, selfTab);
    case 'bar:run':
      return barRun(m, windowId, ctxTab, selfTab);
    case 'bar:dismiss': {
      // Escape on a full-tab palette closes it unless it is the window's last tab.
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
      if ('spacesUse' in patch && !['auto', 'groups', 'windows'].includes(patch.spacesUse)) delete patch.spacesUse;
      if ('spacesUse' in patch) T.groupsFailed = null; // a fresh choice gets a fresh try
      Object.assign(S.settings, patch);
      if ('spacesUse' in patch && mode() === 'windows' && chrome.tabGroups?.query) {
        // Spaces now live in windows, so the groups that stood for them are dissolved. No tab closes.
        for (const g of await chrome.tabGroups.query({}).catch(() => [])) {
          if (!spaceOfGroup(g)) continue;
          const ids = (await chrome.tabs.query({ groupId: g.id })).map((t) => t.id);
          if (ids.length) await chrome.tabs.ungroup(ids).catch(() => {});
        }
        T.groupSpace = {};
      }
      await saveS('settings');
      syncAlarm();
      if ('collapseOtherSpaces' in patch || 'spacesUse' in patch) await reconcileAll();
      notify();
      return { ok: true, settings: S.settings };
    }
    case 'data:export':
      return { ok: true, data: { arcadia: 1, spaces: S.spaces, settings: S.settings } };
    case 'data:import': {
      const d = m.data;
      if (!d || d.arcadia !== 1 || !Array.isArray(d.spaces) || !d.spaces.length) return { ok: false, error: 'This is not an Arcadia export file.' };
      S.spaces = d.spaces.slice(0, 30).map((s) => ({
        id: uid(),
        name: String(s.name || 'Space').slice(0, 40),
        emoji: String(s.emoji || '✨').slice(0, 8),
        color: COLOR_NAMES.includes(s.color) ? s.color : 'blue',
      }));
      S.spaces.forEach((s) => (s.name = uniqueName(s.name, s.id)));
      T.groupSpace = {};
      T.activeSpace = {};
      T.winSpace = {};
      S.winOrder = [];
      await saveS('spaces', 'winOrder');
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
    const booting = Date.now() - T.boot < 4000;
    const cameFromOutside = T.unfocused || Date.now() - (T.focusGainAt || 0) < 1500;
    if (!booting && S.settings.externalToMini && cameFromOutside && tab.openerTabId == null && isWeb(url) && Date.now() > selfUntil) {
      const siblings = await chrome.tabs.query({ windowId: w });
      if (siblings.length > 1) {
        await openMini({ tabId: tab.id });
        return;
      }
    }
    if (spaceById(T.activeSpace[w])) T.born[tab.id] = T.activeSpace[w];
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
    if (mode() !== 'groups') return notify(windowId);
    if (multi() && tab.groupId != null && tab.groupId !== -1) {
      // Going to a tab in another space (from the palette, or by opening its group in
      // the sidebar) switches to that space.
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

chrome.tabs.onUpdated.addListener((tabId, info, tab) =>
  locked(async () => {
    const w = tab.windowId;
    if (T.mini[w]) {
      if (info.status) pingMini(tabId);
      return;
    }
    if (info.pinned !== undefined || info.groupId !== undefined) scheduleReconcile(w);
  }),
);

chrome.tabs.onRemoved.addListener((tabId, info) =>
  locked(async () => {
    delete T.born[tabId];
    for (const k in T.lastTab) if (T.lastTab[k] === tabId) delete T.lastTab[k];
    for (const d in T.docs) if (T.docs[d] === tabId) delete T.docs[d];
    const h = T.hist[info.windowId];
    if (h) T.hist[info.windowId] = h.filter((id) => id !== tabId);
    if (!info.isWindowClosing) notify(info.windowId);
  }),
);

chrome.tabs.onReplaced?.addListener((added, removed) =>
  locked(async () => {
    for (const w in T.hist) T.hist[w] = T.hist[w].map((id) => (id === removed ? added : id));
    for (const k in T.lastTab) if (T.lastTab[k] === removed) T.lastTab[k] = added;
  }),
);

chrome.tabs.onAttached.addListener((_id, info) => scheduleReconcile(info.newWindowId));
chrome.tabs.onDetached.addListener((_id, info) => notify(info.oldWindowId));

if (chrome.tabGroups) {
  chrome.tabGroups.onCreated?.addListener((g) => scheduleReconcile(g.windowId));
  chrome.tabGroups.onRemoved?.addListener((g) =>
    locked(async () => {
      delete T.groupSpace[g.id];
      notify(g.windowId);
    }),
  );
  chrome.tabGroups.onUpdated?.addListener((g) =>
    locked(async () => {
      if (mode() !== 'groups') return;
      // The event carries a snapshot that may be stale by now (our own edits queue up), so read the group again.
      g = await chrome.tabGroups.get(g.id).catch(() => null);
      const sid = g && spaceOfGroup(g);
      if (!sid || !multi()) return;
      // Opening another space's group in the browser's own sidebar switches to that space.
      if (S.settings.collapseOtherSpaces && !g.collapsed && T.activeSpace[g.windowId] && T.activeSpace[g.windowId] !== sid) {
        await switchSpace(g.windowId, sid);
        return;
      }
      const sp = spaceById(sid);
      if (g.title !== sp.name || g.color !== sp.color) scheduleReconcile(g.windowId);
    }),
  );
}

chrome.windows.onCreated.addListener((w) => {
  if (w.type === 'normal') scheduleReconcile(w.id, 200);
});
chrome.windows.onRemoved.addListener((w) =>
  locked(async () => {
    for (const k of ['activeSpace', 'mini', 'hist']) delete T[k][w];
    if (T.lastNormal === w) T.lastNormal = null;
    if (T.winSpace[w]) {
      // The space stays; it just has no window until you go to it again.
      delete T.winSpace[w];
      if (Object.keys(T.winSpace).length) await saveWinOrder();
      notify();
    }
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
    if (w?.type !== 'normal' || T.mini[windowId]) return;
    T.lastNormal = windowId;
    if (mode() === 'windows') rememberSpace(T.winSpace[windowId]);
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
      case 'clear-tabs':
        if (!inMini) await clearTabs(windowId);
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

locked(async () => {
  syncAlarm();
  await reconcileAll();
});
