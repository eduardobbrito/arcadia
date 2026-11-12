// Shared by the service worker and every extension page.

// Chrome's nine tab-group colours, mapped to an oklch hue and chroma for theming.
export const COLORS = {
  grey: { h: 265, c: 0.012 },
  blue: { h: 255, c: 0.15 },
  red: { h: 25, c: 0.17 },
  yellow: { h: 85, c: 0.14 },
  green: { h: 150, c: 0.14 },
  pink: { h: 350, c: 0.16 },
  purple: { h: 305, c: 0.16 },
  cyan: { h: 205, c: 0.11 },
  orange: { h: 55, c: 0.16 },
};
export const COLOR_NAMES = Object.keys(COLORS);

export function tint(el, color) {
  const k = COLORS[color] || COLORS.blue;
  el.style.setProperty('--h', k.h);
  el.style.setProperty('--c', k.c);
}

export function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'chrome-extension:') return '';
    return u.host.replace(/^www\./, '') || u.protocol.replace(':', '');
  } catch {
    return '';
  }
}

const FAVICON = typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL('/_favicon/') : '';

function tag(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

// Chrome's local favicon cache. `version` only makes the image reload when the icon changes.
export function cachedIcon(url, version = '') {
  if (!/^https?:/.test(url || '')) return '';
  return `${FAVICON}?pageUrl=${encodeURIComponent(url)}&size=32${version ? `&v=${tag(version)}` : ''}`;
}

// Icons never come from the network: only inline data or Chrome's local favicon cache.
export function iconFor(url, favIconUrl) {
  if (favIconUrl && favIconUrl.startsWith('data:')) return favIconUrl;
  return cachedIcon(url, favIconUrl || '');
}

export async function send(type, data = {}) {
  try {
    return await chrome.runtime.sendMessage({ type, ...data });
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

const svg = (body) =>
  `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICON = {
  back: svg('<path d="M10 3.5 5.5 8l4.5 4.5"/>'),
  forward: svg('<path d="M6 3.5 10.5 8 6 12.5"/>'),
  reload: svg('<path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.6v3h-3"/>'),
  link: svg('<path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-.7.7"/><path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 0 0 3.7 3.7l.7-.7"/>'),
  plus: svg('<path d="M8 3.5v9M3.5 8h9"/>'),
  x: svg('<path d="m4.5 4.5 7 7m0-7-7 7"/>'),
  sliders: svg('<path d="M2.5 5h5.5m3.5 0h2M2.5 11h2m3.500 0h5.5"/><circle cx="9.800" cy="5" r="1.7"/><circle cx="6.200" cy="11" r="1.7"/>'),
  clock: svg('<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.3"/>'),
  search: svg('<circle cx="7" cy="7" r="4.2"/><path d="m10.2 10.2 3.300 3.300"/>'),
  globe: svg('<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c2 1.700 2 9.300 0 11M8 2.5c-2 1.700-2 9.300 0 11"/>'),
  sound: svg('<path d="M3 6.5h2l3-2.5v8l-3-2.5H3z"/><path d="M10.5 6a3 3 0 0 1 0 4"/>'),
  muted: svg('<path d="M3 6.5h2l3-2.5v8l-3-2.5H3z"/><path d="m10.700 6.500 2.800 3m0-3-2.800 3"/>'),
  mini: svg('<rect x="2.5" y="3.500" width="11" height="9" rx="2"/><path d="M2.5 6.500h11"/>'),
  bolt: svg('<path d="M8.800 2 4 9h3.500l-.6 5L12 7H8.300z"/>'),
  out: svg('<path d="M6.500 4H12v5.500M12 4 4.500 11.500"/>'),
  edit: svg('<path d="M3 13l.700-3 7.300-7.300a1.200 1.200 0 0 1 1.700 0l.6.6a1.200 1.200 0 0 1 0 1.700L6 12.300z"/>'),
  pin: svg('<path d="M6 2.500h4l-.5 4 2 2.500h-7l2-2.500zM8 9v4.500"/>'),
};
