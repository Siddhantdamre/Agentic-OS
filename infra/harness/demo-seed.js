'use strict';
// Fills a throwaway workspace with a small, clearly labelled DEMO business through the product's own API (so the
// data is what a real owner would have): listings, enquiries, a showing, money owed, two customer chats answered by
// the stand-in model and two emails held for approval. The owner signs in with the printed email and password.
// Everything here is fake and local; delete it with cleanup(orgId).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { seed, cleanup, psql } = require('./seed');

const ROOT = path.resolve(__dirname, '..', '..');
const DEMO_EMAIL = 'owner@demo.test';
const DEMO_PASSWORD = 'demo-owner-2026';

function scryptHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}
const ddmmyyyy = (daysAgo) => {
  const d = new Date(Date.now() - daysAgo * 86400000);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
};

// A call held for approval by the real gate, the way a plan step or a sweep holds one (see flows.js holdSend).
function holdSend(s, to, subject, body) {
  const code = `const x=require(${JSON.stringify(path.join(ROOT, 'services/workflows/dist/tool-executor.js'))}).executeAutonomousToolAction;` +
    `x({tool:'gmail',action:'send_email',payload:${JSON.stringify({ to, subject, body })},orgId:${JSON.stringify(s.orgId)},employeeId:${JSON.stringify(s.employeeId)},source:'plan'})` +
    `.then(r=>{console.log(JSON.stringify({status:r.status}));process.exit(0)},e=>{console.error(e);process.exit(1)})`;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: process.env });
  if (r.status !== 0) throw new Error('could not hold the demo email: ' + r.stderr.slice(0, 200));
}

async function seedDemo({ base, workDir }) {
  const work = workDir || process.env.HARNESS_DIR || path.join(os.tmpdir(), 'darex-harness');
  // A demo left from an earlier run uses the same sign-in email.
  const old = psql(`SELECT org_id FROM users WHERE email='${DEMO_EMAIL}' LIMIT 1`);
  if (old) cleanup(old);

  const s = seed({ stage: 1, tag: 'demo' });
  psql(`UPDATE orgs SET name='Sharma Realty (demo)' WHERE id='${s.orgId}' RETURNING 1`);
  psql(`UPDATE users SET email='${DEMO_EMAIL}', password_hash='${scryptHash(DEMO_PASSWORD)}', terms_accepted_at=now() WHERE id='${s.userId}' RETURNING 1`);
  // Signing in through the form checks that onboarding is finished.
  psql(`UPDATE org_onboarding SET wizard_step='done', provisioning_completed_at=now() WHERE org_id='${s.orgId}' RETURNING 1`);
  const secret = 'whsec_demo_' + crypto.randomBytes(6).toString('hex');
  psql(`UPDATE orgs SET meta = COALESCE(meta,'{}'::jsonb) || jsonb_build_object('webhook_secret','${secret}') WHERE id='${s.orgId}' RETURNING 1`);

  const H = { 'content-type': 'application/json', cookie: `darex_session=${s.cookie}; darex_org_id=${s.orgId}` };
  const post = async (url, body) => {
    const res = await fetch(base + url, { method: 'POST', headers: H, body: JSON.stringify(body) });
    if (res.status >= 300) console.log(`  demo seed: ${url} answered ${res.status}`);
    return res;
  };
  const scenario = (reply) => fs.writeFileSync(path.join(work, 'scenario.json'), JSON.stringify({ reply }));

  await post('/api/listings', { sourceRef: 'DEMO-BANER-2BHK', title: '2BHK, Baner', locality: 'Baner', city: 'Pune', bhk: 2, list_price: 8800000 });
  await post('/api/listings', { sourceRef: 'DEMO-WAKAD-3BHK', title: '3BHK, Wakad', locality: 'Wakad', city: 'Pune', bhk: 3, list_price: 11500000 });
  await post('/api/inquiries', { contact: 'Rahul Verma', bhk: 2, budget_max: 9000000, locality: 'Baner', city: 'Pune', channel: 'whatsapp' });
  await post('/api/inquiries', { contact: 'Anita Rao', bhk: 3, budget_max: 12000000, locality: 'Wakad', city: 'Pune', channel: 'whatsapp' });
  await post('/api/inquiries', { contact: 'Karan Mehta', bhk: 1, budget_max: 4500000, locality: 'Hinjewadi', city: 'Pune', channel: 'email' });
  // The showings API refuses to book while no calendar is connected (it cannot know about conflicts), which is the
  // right behaviour, so the demo viewing is written straight into the table.
  const tomorrow = new Date(Date.now() + 86400000); tomorrow.setUTCHours(5, 30, 0, 0);
  const end = new Date(tomorrow.getTime() + 30 * 60000);
  psql(`INSERT INTO re_showings (org_id, listing_id, inquiry_id, status, starts_at, ends_at, duration_minutes, timezone, notes)
        VALUES ('${s.orgId}',
                (SELECT id FROM re_listings WHERE org_id='${s.orgId}' AND source_ref='DEMO-BANER-2BHK' LIMIT 1),
                (SELECT id FROM re_inquiries WHERE org_id='${s.orgId}' AND contact_id='Rahul Verma' LIMIT 1),
                'booked', '${tomorrow.toISOString()}', '${end.toISOString()}', 30, 'Asia/Kolkata', 'Viewing: 2BHK Baner with Rahul Verma') RETURNING 1`);
  await post('/api/dues', {
    text: [
      ['Rahul Verma', 'INV-1042', '85000', ddmmyyyy(75), '30', '9800000001'],
      ['Anita Rao', 'INV-1051', '42000', ddmmyyyy(20), '30', '9800000002'],
      ['Karan Mehta', 'INV-1060', '120000', ddmmyyyy(5), '45', '9800000003'],
    ].map((r) => r.join('\t')).join('\n'),
  });

  // Two customer chats, answered by the stand-in model with a fixed, sensible reply.
  scenario('Yes, the 2BHK in Baner is available. Would tomorrow at 11am work for a viewing?');
  for (const [n, who, text] of [[1, 'Rahul Verma', 'Hi, is the 2BHK in Baner still available?'], [2, 'Anita Rao', 'What is the price of the 3BHK in Wakad?']]) {
    const tag = (Date.now() % 100000000) + n;
    const body = JSON.stringify({ event: 'message_created', message_type: 'incoming', content: text, id: tag, conversation: { id: tag }, sender: { phone_number: '+9198000000' + n + '0', name: who } });
    const sig = 'sha256=' + crypto.createHmac('sha256', process.env.CHATWOOT_WEBHOOK_SECRET || 'harness-only-webhook-secret').update(body).digest('hex');
    await fetch(base + '/api/webhooks/chatwoot', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}`, 'x-chatwoot-signature': sig }, body });
  }
  // Wait for both customer chats to be answered before the model's scripted reply is changed below.
  for (let i = 0; i < 60; i++) {
    if (Number(psql(`SELECT count(*) FROM messages WHERE org_id='${s.orgId}'`)) >= 4) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  holdSend(s, 'rahul.verma@example.test', 'Your viewing tomorrow at 11am', 'Hi Rahul, your viewing of the 2BHK in Baner is confirmed for tomorrow at 11am. See you there.');
  holdSend(s, 'anita.rao@example.test', 'Invoice INV-1051: a gentle reminder', 'Hi Anita, a friendly reminder that invoice INV-1051 for Rs 42,000 is due. Please let me know if you have any questions.');

  // What the owner's own questions in the chat are answered with.
  scenario('Here is what needs you today: 2 emails are waiting for your approval, 3 new enquiries came in, and you have 1 viewing tomorrow at 11am. Rahul Verma is 75 days late on INV-1042 (Rs 85,000).');
  return { ...s, email: DEMO_EMAIL, password: DEMO_PASSWORD, secret };
}

module.exports = { seedDemo, DEMO_EMAIL, DEMO_PASSWORD, cleanup };
