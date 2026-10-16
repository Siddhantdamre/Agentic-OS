'use strict';
// Steady load against a running dashboard: signed inbound customer messages, held sends approved in chat, and
// plain questions, for a set time. Fails on any 5xx, an approval that did not finish, a stuck pending row, or the
// server's memory growing more than 60 percent after warm-up.
//   node soak.js [minutes=10]        (FLOW_BASE and HARNESS_DIR as for flows.js)
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { seed, cleanup, psql } = require('./seed');

const BASE = process.env.FLOW_BASE || 'http://127.0.0.1:3011';
const WORK = process.env.HARNESS_DIR || path.join(os.tmpdir(), 'darex-harness');
const minutes = Number(process.argv[2] || 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stat = { requests: 0, ok: 0, fiveHundreds: 0, other: [], inbound: 0, asks: 0, approvals: 0, approvalsFinished: 0 };

const rssMb = () => {
  const pid = spawnSync('pgrep', ['-f', '^next-server'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)[0];
  if (!pid) return null;
  const r = spawnSync('ps', ['-o', 'rss=', '-p', pid], { encoding: 'utf8' }).stdout.trim();
  return r ? Math.round(Number(r) / 1024) : null;
};
async function hit(label, fn) {
  stat.requests++;
  try {
    const res = await fn();
    if (res.status >= 500) { stat.fiveHundreds++; stat.other.push(`${label} -> ${res.status}`); } else stat.ok++;
    return res;
  } catch (e) { stat.fiveHundreds++; stat.other.push(`${label} -> ${String(e.message).slice(0, 80)}`); return null; }
}

(async () => {
  const s = seed({ stage: 1, tag: 'soak' });
  const secret = 'whsec_soak_' + crypto.randomBytes(6).toString('hex');
  psql(`UPDATE orgs SET meta = COALESCE(meta,'{}'::jsonb) || jsonb_build_object('webhook_secret','${secret}') WHERE id='${s.orgId}' RETURNING 1`);
  fs.writeFileSync(path.join(WORK, 'scenario.json'), JSON.stringify({ reply: 'Yes, that is available. Would tomorrow at 5pm work?' }));
  const H = { 'content-type': 'application/json', cookie: `darex_session=${s.cookie}; darex_org_id=${s.orgId}` };
  const samples = []; const end = Date.now() + minutes * 60000; let n = 0; let lastSample = 0;
  console.log(`soak: ${minutes} min against ${BASE}`);
  while (Date.now() < end) {
    n++;
    const tag = Date.now() % 100000000 + n;
    const body = JSON.stringify({ event: 'message_created', message_type: 'incoming', content: `Is the 2BHK available? (${n})`, id: tag, conversation: { id: tag }, sender: { phone_number: '+9199' + String(tag).padStart(8, '0'), name: 'Soak' } });
    const sig = 'sha256=' + crypto.createHmac('sha256', process.env.CHATWOOT_WEBHOOK_SECRET || 'harness-only-webhook-secret').update(body).digest('hex');
    await hit('inbound', () => fetch(`${BASE}/api/webhooks/chatwoot`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}`, 'x-chatwoot-signature': sig }, body })); stat.inbound++;
    if (n % 3 === 0) { await hit('ask', () => fetch(`${BASE}/api/ask-ai`, { method: 'POST', headers: H, body: JSON.stringify({ prompt: 'What needs me today?' }) }).then(async (r) => { await r.text(); return r; })); stat.asks++; }
    if (n % 5 === 0) {
      const r = await hit('ask-held', () => fetch(`${BASE}/api/ask-ai`, { method: 'POST', headers: H, body: JSON.stringify({ prompt: `Email soak${n}@example.test [[call:gmail_send {"to":"soak${n}@example.test","subject":"Soak","body":"Hi"}]]` }) }));
      const text = r ? await r.text() : '';
      const ev = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const a = ev.find((e) => e.type === 'approval');
      if (a) {
        stat.approvals++;
        const ap = await hit('approve', () => fetch(`${BASE}/api/ask-ai/approve`, { method: 'POST', headers: H, body: JSON.stringify({ sessionId: a.sessionId, conversationId: a.conversationId, decisions: a.approvals.map((x) => ({ threadId: x.threadId, toolCallId: x.toolCallId, tool: x.toolName, decision: 'allow' })) }) }));
        const t = ap ? await ap.text() : '';
        if (/"type":"done"/.test(t) && !/"type":"error"/.test(t)) stat.approvalsFinished++; else stat.other.push('approval did not finish: ' + t.slice(0, 100));
      }
    }
    if (Date.now() - lastSample > 30000) { lastSample = Date.now(); samples.push({ t: Math.round((Date.now() - (end - minutes * 60000)) / 1000), rssMb: rssMb(), pgConns: Number(psql(`SELECT count(*) FROM pg_stat_activity WHERE datname='darex'`)) }); console.log('  sample', JSON.stringify(samples[samples.length - 1]), 'requests', stat.requests, '5xx', stat.fiveHundreds); }
    await sleep(1500);
  }
  await sleep(8000);
  const stuck = Number(psql(`SELECT count(*) FROM agent_pending_actions WHERE org_id='${s.orgId}' AND status='pending'`));
  const replies = Number(psql(`SELECT count(*) FROM messages WHERE org_id='${s.orgId}' AND role='assistant'`));
  cleanup(s.orgId);
  const rss = samples.map((x) => x.rssMb).filter(Boolean);
  const warm = rss[Math.min(2, rss.length - 1)]; const last = rss[rss.length - 1];
  const grew = warm && last ? (last - warm) / warm : 0;
  const checks = [
    ['no request failed with a 5xx or a dropped connection', stat.fiveHundreds === 0],
    ['every held send approved in chat finished', stat.approvals === stat.approvalsFinished],
    ['no pending approval left stuck', stuck === 0],
    ['inbound messages were answered', replies >= Math.floor(stat.inbound * 0.9)],
    [`memory stayed flat after warm-up (${warm} -> ${last} MB, ${Math.round(grew * 100)} percent)`, grew < 0.6],
  ];
  console.log(`\nsoak: ${stat.requests} requests, ${stat.inbound} inbound, ${stat.asks} questions, ${stat.approvals} approvals, ${replies} replies stored`);
  for (const [name, ok] of checks) console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
  for (const o of stat.other.slice(0, 5)) console.log('  note:', o);
  fs.writeFileSync(path.join(WORK, 'soak-report.json'), JSON.stringify({ minutes, stat, samples, stuck, replies, checks }, null, 1));
  process.exit(checks.every((c) => c[1]) ? 0 : 1);
})();
