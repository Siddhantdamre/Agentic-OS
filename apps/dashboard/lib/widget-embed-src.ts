/**
 * Public embed script body (H6). No secrets — only the caller's site key
 * (from data-site-key) and the dashboard origin from NEXT_PUBLIC_APP_URL / script src.
 */
export function widgetEmbedSrc(apiBase: string): string {
  const base = JSON.stringify(apiBase.replace(/\/$/, ''));
  return `(function () {
  if (window.__darexWidgetLoaded) return;
  window.__darexWidgetLoaded = true;

  var SCRIPT = document.currentScript || (function () {
    var list = document.getElementsByTagName('script');
    return list[list.length - 1] || null;
  })();
  if (!SCRIPT) return;

  var SITE_KEY = (SCRIPT.getAttribute('data-site-key') || SCRIPT.getAttribute('data-key') || SCRIPT.getAttribute('data-widget-key') || '').trim();
  var srcOrigin = '';
  try { srcOrigin = new URL(SCRIPT.src, window.location.href).origin; } catch (e) { srcOrigin = ''; }
  var API = (SCRIPT.getAttribute('data-api') || ${base} || srcOrigin || '').replace(/\\/$/, '');
  var TITLE = SCRIPT.getAttribute('data-title') || 'Chat with us';
  var PRIMARY = SCRIPT.getAttribute('data-primary') || '#d97706';
  var STORAGE_V = 'dxw_visitor';
  var STORAGE_S = 'dxw_session';

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'v-' + String(Date.now()) + '-' + Math.random().toString(16).slice(2);
  }

  function visitorId() {
    try {
      var existing = localStorage.getItem(STORAGE_V);
      if (existing) return existing;
      var next = uuid();
      localStorage.setItem(STORAGE_V, next);
      return next;
    } catch (e) {
      return uuid();
    }
  }

  function getSession() {
    try { return localStorage.getItem(STORAGE_S) || ''; } catch (e) { return ''; }
  }

  function setSession(id) {
    try { localStorage.setItem(STORAGE_S, id); } catch (e) {}
  }

  function apiHeaders() {
    return {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + SITE_KEY
    };
  }

  function apiUrl(path) {
    return API + path;
  }

  var root = document.createElement('div');
  root.id = 'dxw-root';
  root.innerHTML =
    '<style>' +
      '#dxw-root{all:initial;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;}' +
      '#dxw-root *{box-sizing:border-box;}' +
      '#dxw-btn{position:fixed;right:20px;bottom:20px;z-index:2147483000;width:56px;height:56px;border:0;border-radius:999px;background:' + PRIMARY + ';color:#1c1917;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.18);font-size:22px;}' +
      '#dxw-panel{position:fixed;right:20px;bottom:88px;z-index:2147483000;width:360px;max-width:calc(100vw - 24px);height:520px;max-height:calc(100vh - 120px);background:#faf9f0;border:1px solid #e7e0c9;border-radius:20px;box-shadow:0 16px 48px rgba(0,0,0,.16);display:none;flex-direction:column;overflow:hidden;}' +
      '#dxw-panel.dxw-open{display:flex;}' +
      '#dxw-head{padding:14px 16px;background:#f5f2d8;border-bottom:1px solid #e7e0c9;font-weight:700;color:#1c1917;display:flex;justify-content:space-between;align-items:center;}' +
      '#dxw-close{border:0;background:transparent;cursor:pointer;font-size:18px;color:#57534e;}' +
      '#dxw-log{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:8px;}' +
      '.dxw-msg{max-width:85%;padding:8px 10px;border-radius:12px;font-size:13px;line-height:1.4;white-space:pre-wrap;word-break:break-word;}' +
      '.dxw-user{align-self:flex-end;background:' + PRIMARY + ';color:#1c1917;}' +
      '.dxw-bot{align-self:flex-start;background:#fff;border:1px solid #e7e0c9;color:#1c1917;}' +
      '.dxw-sys{align-self:center;font-size:11px;color:#78716c;}' +
      '#dxw-form{display:flex;gap:8px;padding:12px;border-top:1px solid #e7e0c9;background:#fff;}' +
      '#dxw-input{flex:1;border:1px solid #e7e0c9;border-radius:12px;padding:10px 12px;font-size:13px;background:#faf9f0;}' +
      '#dxw-send{border:0;border-radius:12px;background:' + PRIMARY + ';color:#1c1917;font-weight:700;padding:0 14px;cursor:pointer;}' +
      '#dxw-send:disabled{opacity:.5;cursor:default;}' +
    '</style>' +
    '<button id="dxw-btn" type="button" aria-label="Open chat">💬</button>' +
    '<div id="dxw-panel" role="dialog" aria-label="Chat">' +
      '<div id="dxw-head"><span></span><button id="dxw-close" type="button" aria-label="Close">×</button></div>' +
      '<div id="dxw-log"></div>' +
      '<form id="dxw-form"><input id="dxw-input" autocomplete="off" maxlength="4000" placeholder="Type a message…"/><button id="dxw-send" type="submit">Send</button></form>' +
    '</div>';
  document.body.appendChild(root);
  root.querySelector('#dxw-head span').textContent = TITLE;

  var panel = root.querySelector('#dxw-panel');
  var log = root.querySelector('#dxw-log');
  var input = root.querySelector('#dxw-input');
  var sendBtn = root.querySelector('#dxw-send');
  var open = false;
  var busy = false;
  var pollTimer = null;
  var seen = {};

  function addMsg(role, text) {
    var el = document.createElement('div');
    el.className = 'dxw-msg ' + (role === 'user' ? 'dxw-user' : role === 'assistant' ? 'dxw-bot' : 'dxw-sys');
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }

  root.querySelector('#dxw-btn').addEventListener('click', function () {
    open = !open;
    panel.classList.toggle('dxw-open', open);
    if (open) input.focus();
  });
  root.querySelector('#dxw-close').addEventListener('click', function () {
    open = false;
    panel.classList.remove('dxw-open');
  });

  if (!SITE_KEY || !API) {
    addMsg('sys', 'Widget is missing a site key or API origin.');
    sendBtn.disabled = true;
    return;
  }

  async function ensureSession() {
    var existing = getSession();
    if (existing) return existing;
    var res = await fetch(apiUrl('/api/widget/session'), {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ visitorId: visitorId() })
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      throw new Error(data.error || ('Session failed (' + res.status + ')'));
    }
    if (!data.sessionId) throw new Error('Session failed');
    setSession(data.sessionId);
    return data.sessionId;
  }

  async function pollReplies(sessionId) {
    var res = await fetch(apiUrl('/api/widget/message?sessionId=' + encodeURIComponent(sessionId)), {
      headers: { 'Authorization': 'Bearer ' + SITE_KEY }
    });
    if (!res.ok) return;
    var data = await res.json().catch(function () { return {}; });
    var list = data.messages || [];
    for (var i = 0; i < list.length; i++) {
      var msg = list[i];
      if (!msg || !msg.id || seen[msg.id]) continue;
      seen[msg.id] = true;
      if (msg.role === 'assistant' && msg.content) addMsg('assistant', msg.content);
    }
  }

  function startPoll(sessionId) {
    if (pollTimer) clearInterval(pollTimer);
    var n = 0;
    pollTimer = setInterval(function () {
      n += 1;
      pollReplies(sessionId);
      if (n >= 40) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }, 1500);
  }

  root.querySelector('#dxw-form').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var text = (input.value || '').trim();
    if (!text || busy) return;
    busy = true;
    sendBtn.disabled = true;
    input.value = '';
    addMsg('user', text);
    try {
      var sessionId = await ensureSession();
      var res = await fetch(apiUrl('/api/widget/message'), {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({ sessionId: sessionId, content: text })
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        addMsg('sys', data.error || ('Send failed (' + res.status + ')'));
      } else {
        if (data.messageId) seen[data.messageId] = true;
        startPoll(sessionId);
      }
    } catch (err) {
      addMsg('sys', (err && err.message) ? err.message : 'Send failed');
    } finally {
      busy = false;
      sendBtn.disabled = false;
      input.focus();
    }
  });
})();`;
}
