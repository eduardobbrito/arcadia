// bar.html: the command bar as an in-page overlay (inside an iframe), a full tab, or a mini window.

import { mountBar } from './bar.js';
import { tint } from '../lib/shared.js';

const params = new URLSearchParams(location.search);
const embedded = window.top !== window;
const mode = ['new', 'current', 'tab', 'mini'].includes(params.get('mode')) ? params.get('mode') : 'tab';
const html = document.documentElement;
const dark = params.has('theme') ? params.get('theme') === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;

html.classList.add('ab-page');
html.dataset.theme = dark ? 'dark' : 'light';
html.dataset.mode = embedded ? 'overlay' : mode;

function dismiss() {
  if (embedded) window.parent.postMessage({ arcadia: 'close' }, '*');
  else chrome.runtime.sendMessage({ type: 'bar:dismiss' }).catch(() => {});
}

const bar = mountBar(document.getElementById('root'), {
  mode,
  token: location.hash.slice(1) || null,
  onClose: (info) => {
    if (embedded) dismiss();
    else if (info?.ran) {
      // A full-tab bar stays put after an action that did not navigate it away.
      if (info.item?.kind === 'action') bar.reset();
    } else if (!info?.dead) dismiss();
  },
  onReady: (r) => {
    // Tell the page script the bar made it, or it falls back to a full tab.
    if (embedded) window.parent.postMessage({ arcadia: 'ready' }, '*');
    if (embedded || !r.space) return;
    tint(document.body, r.space.color);
    const label = document.getElementById('ab-space');
    label.textContent = mode === 'mini' ? 'Mini window' : `${r.space.emoji} ${r.space.name}`;
    label.hidden = false;
  },
});

if (embedded) {
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.ab-bar')) dismiss();
  });
  window.addEventListener('message', (e) => {
    if (e.source === window.parent && e.data?.arcadia === 'focus') bar.focus();
  });
}
window.addEventListener('focus', () => bar.focus());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) bar.focus();
});
