'use strict';
// Local stand-ins for everything outside the dashboard process, so the REAL agent loop, gate, approval
// flow and database can be driven with no keys and no network:
//   /v1/chat/completions   an OpenAI-compatible model whose answers are scripted by the prompt
//   /nango/connection/...  a connection broker that says "connected" with a fake token
//   /provider/<host>/...   provider APIs (Gmail, ...) that record what they were asked to do
// Everything it is asked is appended to world.log (one JSON per line) so a check can read what really happened.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.WORLD_PORT || 4999);
const WORK = process.env.HARNESS_DIR || path.join(os.tmpdir(), 'darex-harness');
fs.mkdirSync(WORK, { recursive: true });
const LOG = process.env.WORLD_LOG || path.join(WORK, 'world.log');
const SCRIPT_FILE = path.join(WORK, 'scenario.json'); // checks write the next scripted answer here
fs.writeFileSync(LOG, '');
const log = (o) => fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...o }) + '\n');

const readBody = (req) => new Promise((res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => res(Buffer.concat(c).toString('utf8'))); });
const send = (res, status, obj, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };

function scenario() {
  try { return JSON.parse(fs.readFileSync(SCRIPT_FILE, 'utf8')); } catch { return {}; }
}

// ---- the model -------------------------------------------------------------------------------------------
function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') return typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
  }
  return '';
}

function decide(body) {
  const messages = body.messages || [];
  const tools = (body.tools || []).map((t) => t.function?.name).filter(Boolean);
  const user = lastUserText(messages);
  const last = messages[messages.length - 1] || {};
  const sc = scenario();
  // after a tool result the model writes its final answer
  if (last.role === 'tool') {
    const txt = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
    return { kind: 'text', text: `Done. The tool said: ${txt.slice(0, 300)}` };
  }
  const m = user.match(/\[\[call:([a-zA-Z0-9_.\-]+)(?:\s+(\{.*\}))?\]\]/s);
  if (m) {
    let args = {};
    try { args = m[2] ? JSON.parse(m[2]) : {}; } catch { /* keep {} */ }
    return { kind: 'tool', name: m[1], args };
  }
  if (sc.reply) return { kind: 'text', text: sc.reply };
  return { kind: 'text', text: `I read your message (${user.slice(0, 80)}). Nothing else to do.`, tools };
}

function completion(body, d) {
  const id = 'chatcmpl-' + Math.random().toString(36).slice(2, 10);
  const model = body.model || 'fake-model';
  if (d.kind === 'tool') {
    return { id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_' + Math.random().toString(36).slice(2, 10), type: 'function', function: { name: d.name, arguments: JSON.stringify(d.args) } }] } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
  }
  return { id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: d.text } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
}

function streamCompletion(res, body, d) {
  const id = 'chatcmpl-' + Math.random().toString(36).slice(2, 10);
  const model = body.model || 'fake-model';
  const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model };
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const w = (delta, finish = null, extra = {}) => res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }], ...extra }) + '\n\n');
  w({ role: 'assistant', content: '' });
  if (d.kind === 'tool') {
    const callId = 'call_' + Math.random().toString(36).slice(2, 10);
    w({ tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: d.name, arguments: '' } }] });
    w({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(d.args) } }] });
    w({}, 'tool_calls');
  } else {
    const words = d.text.split(/(\s+)/);
    for (const part of words) if (part) w({ content: part });
    w({}, 'stop');
  }
  res.write('data: ' + JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}

// ---- providers --------------------------------------------------------------------------------------------
function provider(req, res, host, rest, bodyText) {
  const u = rest || '/';
  log({ kind: 'provider', host, method: req.method, url: u, body: bodyText.slice(0, 2000) });
  const sc = scenario();
  if (sc.providerStatus && sc.providerStatus[host]) return send(res, sc.providerStatus[host], { error: { message: 'scripted failure' } });
  if (host === 'gmail.googleapis.com') {
    if (/\/messages\/send/.test(u) && req.method === 'POST') return send(res, 200, { id: 'sent-' + Date.now(), threadId: 'thread-1', labelIds: ['SENT'] });
    if (/\/drafts/.test(u) && req.method === 'POST') return send(res, 200, { id: 'draft-' + Date.now(), message: { id: 'm-1' } });
    if (/\/profile/.test(u)) return send(res, 200, { emailAddress: 'owner@example.test', messagesTotal: 3 });
    if (/\/messages\?/.test(u) || /\/messages$/.test(u)) return send(res, 200, { messages: [{ id: 'm1', threadId: 't1' }, { id: 'm2', threadId: 't2' }], resultSizeEstimate: 2 });
    if (/\/messages\/m\d/.test(u)) {
      const id = (u.match(/\/messages\/(m\d+)/) || [])[1] || 'm1';
      return send(res, 200, { id, threadId: 't-' + id, snippet: 'Hi, is the flat still available?', payload: { headers: [{ name: 'From', value: 'Priya <priya@example.test>' }, { name: 'Subject', value: 'Flat viewing' }, { name: 'Date', value: 'Mon, 5 Oct 2026 10:00:00 +0000' }] } });
    }
  }
  return send(res, 200, { ok: true, note: 'generic fake provider answer', host });
}

const server = http.createServer(async (req, res) => {
  const bodyText = req.method === 'GET' ? '' : await readBody(req);
  const url = req.url || '/';
  try {
    if (url === '/__health') return send(res, 200, { ok: true });
    if (url.startsWith('/v1/chat/completions') && req.method === 'POST') {
      const body = JSON.parse(bodyText || '{}');
      const d = decide(body);
      log({ kind: 'model', stream: !!body.stream, tools: (body.tools || []).map((t) => t.function?.name), user: lastUserText(body.messages || []).slice(0, 300), lastRole: (body.messages || []).slice(-1)[0]?.role, decided: d.kind === 'tool' ? { tool: d.name, args: d.args } : { text: d.text.slice(0, 120) } });
      return body.stream ? streamCompletion(res, body, d) : send(res, 200, completion(body, d));
    }
    if (url.startsWith('/v1/models')) return send(res, 200, { object: 'list', data: [{ id: 'fake-model', object: 'model' }] });
    if (url.startsWith('/nango/connection/')) {
      log({ kind: 'nango', url, auth: String(req.headers.authorization || '').replace(/Bearer\s+.+/, 'Bearer ***') });
      const sc = scenario();
      if (sc.nango === 'revoked') return send(res, 401, { error: 'token revoked' });
      if (sc.nango === 'none') return send(res, 404, { error: 'unknown_connection' });
      return send(res, 200, { credentials: { access_token: 'fake-access-token', raw: { access_token: 'fake-access-token', scope: 'https://mail.google.com/ https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/drive' } }, connection_id: decodeURIComponent(url.split('/nango/connection/')[1].split('?')[0]), provider_config_key: 'gmail' });
    }
    const pm = url.match(/^\/provider\/([^/]+)(\/.*)?$/);
    if (pm) return provider(req, res, pm[1], pm[2], bodyText);
    log({ kind: 'unhandled', method: req.method, url });
    return send(res, 404, { error: 'not handled by fake world', url });
  } catch (e) {
    log({ kind: 'error', url, message: String(e && e.message) });
    return send(res, 500, { error: 'fake world error' });
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`fake world on ${PORT}, log ${LOG}`));
