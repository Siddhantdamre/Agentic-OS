#!/usr/bin/env node
/**
 * MULTI-TURN SUITE — can the agent hold a conversation?
 *
 * WHY THIS EXISTS
 * Every other suite sends ONE message and reads ONE reply. Completion, quality,
 * reliability ×20 — all single-turn. But no customer talks that way:
 *
 *   "I want to cancel my order" -> "which one?" -> "the sofa, ordered Monday"
 *
 * The agent loads the last 10 messages of a conversation, so the capability
 * probably exists. It has never once been verified. That makes threading the
 * largest untested surface in the product, and it is where customers actually
 * live.
 *
 * WHAT IS ASSERTED
 * Threading is not "did it reply again". The failures that matter are:
 *   - re-asking something the customer already answered (the classic bot tell)
 *   - losing the subject between turns and answering the wrong thing
 *   - never converging — asking forever instead of committing to an answer
 *
 * Every turn in a scenario shares ONE chatwoot conversation id, so the webhook
 * threads them into a single conversation row and the agent sees the history.
 *
 * Usage: node infra/scripts/multiturn-suite.js
 */
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client; }

const { scoreQuality } = require('./quality-rules.js');


/**
 * The interim acknowledgement is NOT an answer.
 *
 * WorkItemWorkflow now sends "still working" at 30s and the real reply when
 * it lands, so the FIRST new assistant message is no longer necessarily the
 * answer. Polling for "any new message" scored the acknowledgement as the
 * reply and reported two false product failures on the first run after it
 * shipped. Keep waiting past it; every other canned reply IS terminal.
 */
const INTERIM_ACK = require(path.join(__dirname, "../../services/workflows/dist/reply-gate.js")).INTERIM_ACK_REPLY;
const isInterim = (t) => String(t || "").trim() === String(INTERIM_ACK || "").trim();

const BASE = process.env.DASHBOARD_URL || 'http://127.0.0.1:3000';
const SECRET = process.env.CHATWOOT_WEBHOOK_SECRET || 'darex-chatwoot-webhook-secret-dev';
const REPLY_TIMEOUT_MS = parseInt(process.env.REPLY_TIMEOUT_MS || '180000', 10);
const STATE = path.join(__dirname, '.harden-state');
fs.mkdirSync(STATE, { recursive: true });

const sign = (b) => `sha256=${crypto.createHmac('sha256', SECRET).update(b).digest('hex')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

/** Same knowledge the completion suite uses — the facts must be reachable. */
const KNOWLEDGE = [
  { kind: 'policy', title: 'Cancellation policy',
    body: 'Orders can be cancelled free of charge within 48 hours of placing them. '
      + 'After 48 hours a restocking fee of 15% applies. Custom-made furniture cannot '
      + 'be cancelled once production has started, usually 5 working days after order.' },
  { kind: 'faq', title: 'Pricing and consultation',
    body: 'An initial design consultation costs 2500 rupees, which is fully credited '
      + 'against any order above 50000 rupees. Standard installation is charged at '
      + '8% of order value. We do not charge for delivery within Bengaluru city limits.' },
  { kind: 'sop', title: 'Booking a showroom viewing',
    body: 'Showroom viewings are booked in 45 minute slots. Saturday morning slots at '
      + '10am, 11am and 12pm are the most requested and should be confirmed at least '
      + 'two days ahead. Customers should bring room measurements if they have them.' },
  { kind: 'faq', title: 'Delivery times',
    body: 'In-stock items are delivered within 3 to 5 working days. Custom orders take '
      + '4 to 6 weeks from design sign-off. We deliver across Karnataka; outside '
      + 'Bengaluru a delivery charge of 1200 rupees applies.' },
];

/**
 * Each scenario is a real conversation. `expect` runs against the reply to that
 * turn; `mustNotRepeat` guards the specific bot behaviour of asking again for
 * something the customer just supplied.
 */
const SCENARIOS = [
  {
    id: 'cancel_thread',
    why: 'the customer supplies the timing in turn 2 — the agent must apply the 48h rule to it, not re-ask',
    turns: [
      { say: 'I want to cancel an order I placed.' },
      {
        say: 'I placed it last Monday, so about 5 days ago.',
        // Past 48 hours: the 15% restocking fee is the correct answer.
        expect: [/15\s*%/, /restocking/i],
        mustNotRepeat: [/when did you (?:place|order)/i, /how long ago/i, /what date/i],
      },
    ],
  },
  {
    id: 'booking_thread',
    why: 'day and time arrive in separate turns; the agent must accumulate them',
    turns: [
      { say: "I'd like to visit your showroom." },
      { say: 'Saturday would suit me.', mustNotRepeat: [/which day|what day/i] },
      {
        say: '11am please.',
        expect: [/11\s*am/i, /confirm|booked|book/i],
        // Both facts were given. Asking for either again is the failure.
        mustNotRepeat: [/which day|what day/i, /what time would you like|which time slot/i],
      },
    ],
  },
  {
    id: 'topic_carry',
    why: 'turn 2 has no subject of its own — it only makes sense if the thread is held',
    turns: [
      { say: 'How much is a design consultation?', expect: [/2[,.]?500/] },
      // No noun. "And how long is the wait?" is meaningless without context.
      { say: 'And how long is the wait for a custom one?', expect: [/4\s*(?:to|-|–)\s*6\s*weeks?|\b6\s*weeks?/i] },
    ],
  },
  {
    id: 'correction_thread',
    why: 'the customer corrects themselves — the agent must use the correction, not the original',
    turns: [
      { say: 'How long does delivery take outside Bengaluru?' },
      {
        say: "Sorry, I meant an in-stock item, not custom.",
        expect: [/3\s*(?:to|-|–)\s*5/i],
        // 4-6 weeks is the custom answer. Repeating it means the correction was ignored.
        mustNotRepeat: [/4\s*(?:to|-|–)\s*6\s*weeks/i],
      },
    ],
  },
];

let pass = 0, fail = 0;
const ok = (m, d = '') => { pass++; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d = '') => { fail++; console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };

async function makeTenant() {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `mt_${stamp}@example.com`, password: `Pw-${stamp}-Aa1!` }),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.orgId) throw new Error(`register failed HTTP ${res.status}`);
  const token = `orgsecret-${stamp}`;
  await db.query(
    `UPDATE orgs SET name='Bright Leaf Interiors',
       meta = COALESCE(meta,'{}'::jsonb) || jsonb_build_object('webhook_secret',$2::text) WHERE id=$1`,
    [body.orgId, token]);
  await db.query(
    `INSERT INTO ai_employees (org_id, name, role, persona, tool_allowlist, status)
     VALUES ($1,'Sarah','support',$2::jsonb, ARRAY['database_query']::text[], 'active')`,
    [body.orgId, JSON.stringify({ tone: 'warm, concise. Answer from company knowledge.' })]);
  for (const k of KNOWLEDGE) {
    await db.query(
      `INSERT INTO org_memory (org_id, kind, title, body, source, source_ref, content_hash)
       VALUES ($1,$2,$3,$4,'pack','multiturn-suite',$5)`,
      [body.orgId, k.kind, k.title, k.body,
       crypto.createHash('sha256').update(k.title + k.body).digest('hex')]);
  }
  return { orgId: body.orgId, token };
}

/** Send one turn INTO AN EXISTING THREAD and wait for that thread's next reply. */
async function say(tenant, chatwootConvId, text) {
  // Count replies already in this conversation so we wait for a NEW one.
  const conv = await db.query(
    `SELECT c.id FROM conversations c WHERE c.org_id=$1 ORDER BY c.created_at DESC LIMIT 1`,
    [tenant.orgId]).catch(() => ({ rows: [] }));
  const convRow = conv.rows[0]?.id || null;
  const before = convRow
    ? (await db.query(
        `SELECT COUNT(*)::int AS n FROM messages WHERE org_id=$1 AND conversation_id=$2 AND role='assistant'`,
        [tenant.orgId, convRow])).rows[0].n
    : 0;

  const payload = JSON.stringify({
    event: 'message_created', message_type: 'incoming', content: text,
    id: Date.now() + Math.floor(Math.random() * 1000),
    // SAME conversation id every turn — this is what makes it a thread.
    conversation: { id: chatwootConvId, inbox_id: 5150 },
    sender: { phone_number: '+919900007777', name: 'Customer' },
    account: { id: 5150 },
  });
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/webhooks/chatwoot?org_id=${tenant.orgId}&token=${tenant.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-chatwoot-signature': sign(payload) },
    body: payload,
  });
  if (res.status !== 200) return { ok: false, reply: '', ms: Date.now() - t0, http: res.status };

  while (Date.now() - t0 < REPLY_TIMEOUT_MS) {
    const c = await db.query(
      `SELECT m.content, m.conversation_id FROM messages m
       WHERE m.org_id=$1 AND m.role='assistant'
       ORDER BY m.created_at DESC LIMIT 1`, [tenant.orgId]);
    const n = await db.query(
      `SELECT COUNT(*)::int AS n FROM messages WHERE org_id=$1 AND role='assistant'`, [tenant.orgId]);
    if (c.rows.length && n.rows[0].n > before && !isInterim(c.rows[0].content)) {
      return { ok: true, reply: c.rows[0].content || '', ms: Date.now() - t0 };
    }
    await sleep(400);
  }
  return { ok: false, reply: '', ms: Date.now() - t0, timeout: true };
}

(async () => {
  await db.connect();
  console.log('\n### MULTI-TURN SUITE — can the agent hold a conversation?\n');
  const results = [];

  for (const sc of SCENARIOS) {
    console.log(`\n--- ${sc.id} ---`);
    console.log(`    (${sc.why})`);
    // Fresh tenant per scenario so threads cannot contaminate each other.
    const tenant = await makeTenant();
    const chatwootConvId = Math.floor(Math.random() * 100000) + 1000;
    const transcript = [];
    let broke = false;

    for (let i = 0; i < sc.turns.length; i++) {
      const turn = sc.turns[i];
      const r = await say(tenant, chatwootConvId, turn.say);
      transcript.push({ role: 'customer', text: turn.say });
      if (!r.ok) {
        no(`${sc.id} turn ${i + 1} replied`, r.timeout ? 'timeout' : `HTTP ${r.http}`);
        broke = true;
        break;
      }
      transcript.push({ role: 'agent', text: r.reply, ms: r.ms });
      console.log(`    C${i + 1}: ${turn.say}`);
      console.log(`    A${i + 1}: ${r.reply.replace(/\s+/g, ' ').slice(0, 170)}`);

      if (turn.expect) {
        const hit = turn.expect.some((re) => re.test(r.reply));
        hit ? ok(`${sc.id} turn ${i + 1} carried the right fact`)
            : no(`${sc.id} turn ${i + 1} carried the right fact`, r.reply.slice(0, 120));
      }
      if (turn.mustNotRepeat) {
        const repeated = turn.mustNotRepeat.find((re) => re.test(r.reply));
        repeated
          ? no(`${sc.id} turn ${i + 1} did not re-ask what was answered`, `asked again: ${repeated}`)
          : ok(`${sc.id} turn ${i + 1} did not re-ask what was answered`);
      }
      const q = scoreQuality(r.reply);
      q.length === 0
        ? ok(`${sc.id} turn ${i + 1} quality clean`)
        : no(`${sc.id} turn ${i + 1} quality clean`, q.map((x) => x.name).join(','));
    }

    // Threading proof: every message must be in ONE conversation row.
    if (!broke) {
      const convs = await db.query(
        `SELECT COUNT(DISTINCT conversation_id)::int AS n FROM messages WHERE org_id=$1`,
        [tenant.orgId]);
      convs.rows[0].n === 1
        ? ok(`${sc.id} stayed in a single conversation thread`)
        : no(`${sc.id} stayed in a single conversation thread`, `${convs.rows[0].n} conversations created`);
    }

    results.push({ id: sc.id, transcript });
    await db.query(`DELETE FROM orgs WHERE id=$1`, [tenant.orgId]);
  }

  fs.writeFileSync(path.join(STATE, 'multiturn.json'),
    JSON.stringify({ pass, fail, results }, null, 2));
  console.log(`\n  passed ${pass} / ${pass + fail}`);
  console.log(`  transcripts: ${path.join(STATE, 'multiturn.json')}`);
  await db.end();
  process.exit(fail ? 1 : 0);
})();
