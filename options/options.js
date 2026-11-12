import { send } from '../lib/shared.js';

const isMac = /Mac/.test(navigator.platform);
const mod = isMac ? '⌘' : 'Ctrl+';
const shift = isMac ? '⇧' : 'Shift+';
for (const el of document.querySelectorAll('.mod-t')) el.textContent = `${mod}T`;
for (const el of document.querySelectorAll('.mod-shift-c')) el.textContent = isMac ? '⇧⌘C' : 'Ctrl+Shift+C';
for (const el of document.querySelectorAll('.mod-o')) el.textContent = `${mod}O`;

const status = document.getElementById('status');
const say = (text) => (status.textContent = text);

// ---- settings

const { settings = {} } = await chrome.storage.local.get('settings');
for (const el of document.querySelectorAll('[data-key]')) {
  const key = el.dataset.key;
  if (el.type === 'checkbox') el.checked = !!settings[key];
  else el.value = String(settings[key] ?? '');
  el.addEventListener('change', () => {
    const value = el.type === 'checkbox' ? el.checked : el.dataset.kind === 'text' ? el.value : Number(el.value);
    if (el.type === 'number' && !(value >= Number(el.min) && value <= Number(el.max))) return;
    send('settings:set', { patch: { [key]: value } });
  });
}

// ---- shortcuts

const pretty = (s) =>
  !s
    ? 'Not set'
    : isMac
      ? s.replace(/Command\+?|⌘/g, '⌘').replace(/MacCtrl\+?|Ctrl\+?|⌃/g, '⌃').replace(/Alt\+?|⌥/g, '⌥').replace(/Shift\+?|⇧/g, '⇧')
      : s;
const commands = await chrome.commands.getAll();
const body = document.querySelector('#keys tbody');
for (const c of commands) {
  const tr = document.createElement('tr');
  const what = document.createElement('td');
  what.textContent = c.description || (c.name === '_execute_action' ? 'Open the spaces menu' : c.name);
  const keys = document.createElement('td');
  keys.textContent = pretty(c.shortcut);
  tr.append(what, keys);
  body.append(tr);
}
// Show each shortcut as it is really assigned, or the default it asks for.
const wanted = { _execute_action: 'Alt+Shift+S', 'mini-window': 'Alt+Shift+M' };
for (const el of document.querySelectorAll('[data-cmd]')) {
  const cmd = commands.find((c) => c.name === el.dataset.cmd);
  el.textContent = pretty(cmd?.shortcut || wanted[el.dataset.cmd] || '');
}

for (const btn of document.querySelectorAll('[data-open]')) {
  btn.addEventListener('click', () => chrome.tabs.create({ url: btn.dataset.open }));
}

// ---- export and import

document.getElementById('export').addEventListener('click', async () => {
  const r = await send('data:export');
  if (!r?.ok) return say('Export failed. Reload this page and try again.');
  const url = URL.createObjectURL(new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `arcadia-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  say('Exported your spaces and settings.');
});

const file = document.getElementById('file');
document.getElementById('import').addEventListener('click', () => file.click());
file.addEventListener('change', async () => {
  const f = file.files[0];
  file.value = '';
  if (!f) return;
  let data;
  try {
    data = JSON.parse(await f.text());
  } catch {
    return say('That file is not valid JSON. Choose a file exported from Arcadia.');
  }
  if (!confirm('Importing replaces the spaces in this profile. Open tabs stay open. Continue?')) return;
  const r = await send('data:import', { data });
  say(r?.ok ? 'Imported.' : r?.error || 'Import failed.');
});
