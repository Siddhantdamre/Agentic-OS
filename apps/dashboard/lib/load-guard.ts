/**
 * Says so on screen when a page's script files cannot be loaded.
 *
 * Without it, a page whose scripts are missing (a server started before a rebuild, an image and its files from
 * different builds, a blocked or cached file) still renders, and then nothing responds to clicks: the person cannot
 * tell a dead page from a slow one. This is written into the server-rendered HTML as a plain inline script, so it
 * runs even when every other script file is gone. <AliveBeacon /> marks the page alive once React has taken over.
 */
export const LOAD_GUARD_BANNER_ID = 'darex-load-banner';
/** Generous on purpose: a page that is merely slow on a poor connection should not be told it is broken. */
export const LOAD_GUARD_TIMEOUT_MS = 12000;

const MESSAGE = 'Part of this page failed to load, so buttons may not respond. Please reload the page (Ctrl+F5).';

export const LOAD_GUARD_SCRIPT = `(function () {
  var shown = false;
  function show() {
    if (shown || document.getElementById(${JSON.stringify(LOAD_GUARD_BANNER_ID)})) return;
    if (!document.body) { document.addEventListener('DOMContentLoaded', show); return; }
    shown = true;
    var b = document.createElement('div');
    b.id = ${JSON.stringify(LOAD_GUARD_BANNER_ID)};
    b.setAttribute('role', 'alert');
    b.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;padding:12px 16px;background:#7c2d12;color:#fff;font:14px/1.4 system-ui,sans-serif;text-align:center';
    b.appendChild(document.createTextNode(${JSON.stringify(MESSAGE)} + ' '));
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Reload';
    btn.style.cssText = 'margin-left:8px;padding:4px 12px;border:1px solid #fff;border-radius:6px;background:transparent;color:#fff;font:inherit;cursor:pointer';
    btn.onclick = function () { location.reload(); };
    b.appendChild(btn);
    document.body.appendChild(b);
  }
  addEventListener('error', function (e) {
    var t = e && e.target;
    if (!t || !t.tagName) return;
    var tag = String(t.tagName).toLowerCase();
    if (tag !== 'script' && tag !== 'link') return;
    var url = String(t.src || t.href || '');
    if (url.indexOf('/_next/') < 0) return;
    show();
  }, true);
  setTimeout(function () { if (!window.__darexAlive) show(); }, ${LOAD_GUARD_TIMEOUT_MS});
})();`;
