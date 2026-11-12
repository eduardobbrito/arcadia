// The spaces menu. Dia's own sidebar lists the tabs; this is where spaces are
// switched, created and edited, and where unused tabs are cleared.

import { COLORS, ICON, tint, send } from '../lib/shared.js';
import { spaceForm } from '../lib/space-form.js';

const $ = (id) => document.getElementById(id);
const scheme = matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => (document.documentElement.dataset.theme = scheme.matches ? 'dark' : 'light');
scheme.addEventListener('change', applyTheme);
applyTheme();

const WIN = (await chrome.windows.getCurrent()).id;
let view = null;

document.querySelector('.add .plus').innerHTML = ICON.plus;

async function load() {
  const v = await send('view:get', { windowId: WIN });
  if (!v?.ok) return;
  view = v;
  render();
}

function render() {
  const windows = view.mode === 'windows';
  const current = view.spaces.find((s) => s.id === view.activeSpaceId) || null;
  tint(document.documentElement, (current || view.spaces[0]).color);
  $('spaces').replaceChildren(
    ...view.spaces.map((sp) => {
      const li = document.createElement('li');
      li.classList.toggle('current', sp.id === current?.id);
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'sp';
      go.dataset.id = sp.id;
      if (sp.id === current?.id) go.setAttribute('aria-current', 'true');
      const k = COLORS[sp.color] || COLORS.blue;
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.cssText = `--sh:${k.h};--sc:${Math.max(k.c, 0.02)}`;
      const emoji = document.createElement('span');
      emoji.className = 'emoji';
      emoji.textContent = sp.emoji;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = sp.name;
      const count = document.createElement('span');
      count.className = 'count';
      const n = view.counts?.[sp.id] || 0;
      // A space kept as a window may have no window open yet.
      count.textContent = windows && !view.hasWindow?.[sp.id] ? 'not open' : n === 1 ? '1 tab' : `${n} tabs`;
      go.append(dot, emoji, name, count);
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'edit';
      edit.dataset.edit = sp.id;
      edit.title = `Edit ${sp.name}`;
      edit.setAttribute('aria-label', `Edit ${sp.name}`);
      edit.innerHTML = ICON.edit;
      li.append(go, edit);
      return li;
    }),
  );

  const hint = $('hint');
  if (view.spaces.length < 2) {
    hint.textContent = 'Add a second space to keep, say, work and personal tabs apart. Spaces share this profile’s logins; Dia’s own profiles keep logins apart.';
  } else if (windows && !current) {
    hint.textContent = 'This window is not a space yet. Pick a space with no window to make this window that space.';
  } else if (windows && view.settings.spacesUse === 'auto') {
    hint.textContent = view.groupsMissing
      ? 'Each space is its own window, because this browser does not let extensions manage tab groups.'
      : `Each space is its own window, because the browser refused a tab-group change (${view.groupsError || 'no reason given'}).`;
  } else if (!windows && view.groupsError) {
    hint.textContent = `The browser refused a tab-group change: ${view.groupsError}. In settings, keep spaces in separate windows instead.`;
  } else hint.textContent = '';
  hint.hidden = !hint.textContent;

  $('clear').disabled = !view.clearable;
  $('clear').textContent = view.clearable ? `Clear ${view.clearable} unused ${view.clearable === 1 ? 'tab' : 'tabs'}` : 'Nothing to clear';
  ($('spaces').querySelector('[aria-current]') || $('spaces').querySelector('.sp'))?.focus();
}

async function go(id) {
  if (id !== view.activeSpaceId) await send('space:switch', { windowId: WIN, id });
  window.close();
}

function edit(space) {
  $('list').hidden = true;
  $('editor').hidden = false;
  $('editor').replaceChildren(
    spaceForm({
      space,
      spaces: view.spaces,
      windowId: WIN,
      onPreview: (color) => tint(document.documentElement, color),
      onDone: async (what) => {
        // Creating a space also moves into it, so there is nothing left to do here.
        if (what === 'save' && !space) return window.close();
        $('editor').hidden = true;
        $('editor').replaceChildren();
        $('list').hidden = false;
        await load();
      },
    }),
  );
}

$('spaces').addEventListener('click', (e) => {
  const ed = e.target.closest('[data-edit]');
  if (ed) return edit(view.spaces.find((s) => s.id === ed.dataset.edit));
  const sp = e.target.closest('.sp');
  if (sp) go(sp.dataset.id);
});
$('new').addEventListener('click', () => edit(null));
$('clear').addEventListener('click', async () => {
  await send('tabs:clear', { windowId: WIN });
  await load();
});
$('mini').addEventListener('click', async () => {
  await send('mini:new');
  window.close();
});
$('settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

document.addEventListener('keydown', (e) => {
  if (!$('editor').hidden || e.metaKey || e.ctrlKey || e.altKey) return;
  const items = [...document.querySelectorAll('#list .sp, #list .add')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') items[(i + 1) % items.length]?.focus();
  else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length]?.focus();
  else if (/^[1-9]$/.test(e.key) && view.spaces[Number(e.key) - 1]) go(view.spaces[Number(e.key) - 1].id);
  else return;
  e.preventDefault();
});

chrome.runtime.onMessage.addListener((m) => {
  if (m?.type === 'arcadia:changed' && $('editor').hidden) load();
});

load();
