// Runs in every page. Four small jobs: the ⇧⌘C copy-link key, shift-click to a mini
// window, hosting the command bar overlay and toasts for this tab, and handing
// Arcadia the site icon the page has already loaded.

(() => {
  if (window.__arcadiaAlive?.()) return;
  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };
  window.__arcadiaAlive = alive;

  const isTop = window.top === window;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const settings = { copyUrlShortcut: true, shiftClickMini: true };
  let inMini = false;

  const send = (msg) => {
    if (!alive()) {
      teardown();
      return Promise.resolve(null);
    }
    return chrome.runtime.sendMessage(msg).catch(() => null);
  };

  try {
    chrome.storage.local.get('settings').then((r) => Object.assign(settings, r.settings || {}), () => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings?.newValue) Object.assign(settings, changes.settings.newValue);
    });
  } catch {}

  // ---- keys and clicks

  function onKey(e) {
    if (!alive()) return teardown();
    const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (!mod || e.altKey) return;
    if (settings.copyUrlShortcut && e.shiftKey && e.code === 'KeyC') {
      // Chrome would open DevTools "inspect element" here.
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) send({ type: 'copy-url' });
    } else if (inMini && !e.shiftKey && e.code === 'KeyO') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) send({ type: 'mini:toMain' });
    }
  }

  function onClick(e) {
    if (!settings.shiftClickMini || inMini) return;
    if (e.button !== 0 || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    const a = e.composedPath().find((n) => n instanceof HTMLAnchorElement && n.href);
    if (!a || !/^https?:/i.test(a.href)) return;
    if (!alive()) return teardown();
    e.preventDefault();
    e.stopImmediatePropagation();
    send({ type: 'mini:open', url: a.href });
  }

  window.addEventListener('keydown', onKey, true);
  window.addEventListener('click', onClick, true);

  function teardown() {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('message', onMessage);
    closeBar();
  }

  // ---- top-frame UI

  // A host element in the browser's top layer, so page dialogs and fullscreen video cannot cover it.
  function topLayer(css) {
    const host = document.createElement('arcadia-layer');
    host.style.cssText = `all: initial; position: fixed; margin: 0; border: 0; padding: 0; background: transparent; overflow: visible; max-width: none; max-height: none; z-index: 2147483647; color-scheme: light; ${css}`;
    const root = host.attachShadow({ mode: 'closed' });
    (document.body || document.documentElement).append(host);
    try {
      host.popover = 'manual';
      host.showPopover();
    } catch {}
    return { host, root };
  }

  let bar = null;

  function openBar({ mode, token, toggle }) {
    if (bar) {
      if (toggle) closeBar();
      else focusBar();
      return;
    }
    const prev = document.activeElement;
    const { host, root } = topLayer('inset: 0; width: 100vw; height: 100vh; display: block;');
    const frame = document.createElement('iframe');
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    frame.title = 'Arcadia command bar';
    frame.src = `${chrome.runtime.getURL('bar/bar.html')}?mode=${mode === 'current' ? 'current' : 'new'}&theme=${dark ? 'dark' : 'light'}#${token}`;
    // color-scheme must match the frame's document or Chrome paints it opaque.
    frame.style.cssText = 'position: fixed; inset: 0; width: 100vw; height: 100vh; border: 0; display: block; background: transparent; color-scheme: light;';
    frame.addEventListener('load', focusBar);
    root.append(frame);
    bar = { host, frame, prev, ready: false, timer: null };
    // Some pages refuse to host the frame. If the bar never reports in, fall back to a full tab.
    const mine = bar;
    bar.timer = setTimeout(() => {
      if (bar !== mine || mine.ready) return;
      closeBar();
      send({ type: 'bar:failed' });
    }, 2000);
    focusBar();
  }

  function focusBar() {
    if (!bar) return;
    try {
      bar.frame.focus();
      bar.frame.contentWindow?.postMessage({ arcadia: 'focus' }, '*');
    } catch {}
  }

  function closeBar() {
    if (!bar) return;
    const { host, prev, timer } = bar;
    bar = null;
    clearTimeout(timer);
    host.remove();
    try {
      prev?.focus?.({ preventScroll: true });
    } catch {}
  }

  function onMessage(e) {
    if (!bar || e.source !== bar.frame.contentWindow) return;
    if (e.data?.arcadia === 'ready') bar.ready = true;
    else if (e.data?.arcadia === 'close') closeBar();
  }

  let toastEl = null;
  function toast(text) {
    toastEl?.host.remove();
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    const layer = topLayer('left: 50%; bottom: 28px; top: auto; right: auto; transform: translateX(-50%); display: block; pointer-events: none;');
    const pill = document.createElement('div');
    pill.setAttribute('role', 'status');
    pill.textContent = text;
    pill.style.cssText = `font: 500 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 11px 16px; border-radius: 999px; white-space: nowrap; color: ${dark ? '#17181c' : '#fff'}; background: ${dark ? 'rgba(244,245,248,.96)' : 'rgba(28,29,34,.94)'}; box-shadow: 0 8px 28px rgba(0,0,0,.28); transition: opacity .25s, transform .25s; opacity: 0; transform: translateY(6px);`;
    layer.root.append(pill);
    toastEl = layer;
    requestAnimationFrame(() => {
      pill.style.opacity = '1';
      pill.style.transform = 'none';
    });
    setTimeout(() => {
      pill.style.opacity = '0';
      setTimeout(() => {
        layer.host.remove();
        if (toastEl === layer) toastEl = null;
      }, 260);
    }, 1500);
  }

  let pill = null;
  function showMiniPill() {
    inMini = true;
    if (pill?.host.isConnected) return;
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', showMiniPill, { once: true });
      return;
    }
    pill = topLayer('top: 10px; right: 12px; left: auto; bottom: auto; display: block;');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = `Open in main window (${isMac ? '⌘O' : 'Ctrl+O'})`;
    btn.innerHTML =
      '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.700" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.500 4H12v5.500M12 4 4.500 11.500"/></svg><span>Open in main window</span>';
    const style = document.createElement('style');
    style.textContent = `
      button { all: unset; display: flex; align-items: center; gap: 0; height: 30px; padding: 0 8px; border-radius: 999px; cursor: pointer;
        font: 500 12.500px/1 system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff; background: rgba(28,29,34,.72);
        box-shadow: 0 2px 10px rgba(0,0,0,.25); opacity: .55; transition: opacity .15s, gap .15s, padding .15s; }
      span { max-width: 0; overflow: hidden; white-space: nowrap; transition: max-width .18s; }
      button:hover, button:focus-visible { opacity: 1; gap: 7px; padding: 0 12px 0 10px; }
      button:hover span, button:focus-visible span { max-width: 170px; }
      button:focus-visible { outline: 2px solid #7aa7ff; outline-offset: 2px; }
      @media (prefers-reduced-motion: reduce) { button, span { transition: none; } }`;
    btn.addEventListener('click', () => send({ type: 'mini:toMain' }));
    pill.root.append(style, btn);
  }

  // ---- site icon
  // Firefox gives extensions no local icon store, and Arcadia's own pages never touch
  // the network. So the page hands over the icon it has already loaded: read strictly
  // from the browser's cache (cache: 'only-if-cached' never goes to the network) and
  // shrunk to 32px. An icon served from another host cannot be read this way and is
  // skipped; Arcadia then draws the site's initial.
  let iconSent = '';

  async function decode(blob) {
    try {
      return await createImageBitmap(blob);
    } catch {}
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function reportIcon() {
    if (!alive() || !/^https?:$/.test(location.protocol)) return;
    try {
      const links = [...document.querySelectorAll('link[rel~="icon" i][href]')];
      const pick = links.find((l) => /\b(32|48)x/.test(l.getAttribute('sizes') || '')) || links[links.length - 1];
      const href = new URL(pick ? pick.href : '/favicon.ico', location.href);
      let blob;
      if (href.protocol === 'data:') blob = await (await fetch(href)).blob();
      else {
        if (href.origin !== location.origin) return;
        const res = await fetch(href, { cache: 'only-if-cached', mode: 'same-origin', credentials: 'omit' });
        if (!res.ok) return;
        blob = await res.blob();
      }
      const picture = await decode(blob);
      const canvas = new OffscreenCanvas(32, 32);
      canvas.getContext('2d').drawImage(picture, 0, 0, 32, 32);
      const png = await canvas.convertToBlob({ type: 'image/png' });
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(png);
      });
      if (data === iconSent || data.length > 16000) return;
      iconSent = data;
      send({ type: 'icon:set', icon: data });
    } catch {}
  }

  if (isTop) {
    const later = () => {
      setTimeout(reportIcon, 1200);
      setTimeout(reportIcon, 6000);
    };
    if (document.readyState === 'complete') later();
    else window.addEventListener('load', later, { once: true });
    window.addEventListener('message', onMessage);
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      switch (msg?.type) {
        case 'arcadia:bar':
          openBar(msg);
          sendResponse({ ok: true });
          break;
        case 'arcadia:bar-focus':
          focusBar();
          sendResponse({ ok: true });
          break;
        case 'arcadia:toast':
          toast(msg.text);
          sendResponse({ ok: true });
          break;
        case 'arcadia:mini':
          showMiniPill();
          sendResponse({ ok: true });
          break;
      }
    });
  }
})();
