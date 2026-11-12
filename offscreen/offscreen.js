// Service workers cannot touch the clipboard, so this hidden page does it.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'arcadia:offscreen-copy') return;
  const t = document.getElementById('t');
  t.value = String(msg.text ?? '');
  t.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {}
  sendResponse({ ok });
});
