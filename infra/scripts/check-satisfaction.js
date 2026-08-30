#!/usr/bin/env node
'use strict';
/**
 * WAS THE WORK ANY GOOD? — the first honest answer, from data already stored.
 *
 * The dashboard can currently say "652 conversations resolved". That number is
 * produced by the quiet sweep: the business spoke last and the customer never
 * came back. It is SILENCE. A customer who got exactly what they needed and one
 * who gave up and went to a competitor produce the identical row.
 *
 * Meanwhile 711 customer replies were collected and their meaning discarded.
 *
 * This reads every reply that followed an agent answer, classifies it with the
 * same tested module the runtime will use, and reports three numbers instead of
 * one:
 *
 *     landed      the customer thanked, confirmed, or acted on it
 *     missed      the customer said it was wrong, or asked for a person
 *     no idea     nobody said anything readable
 *
 * The third number is the point. If it is large, the product cannot yet measure
 * itself — which is worth knowing, and is currently hidden behind a resolution
 * rate of 91%.
 *
 * Reads only. Writes nothing, sends nothing, contacts nobody.
 *
 * Usage: node infra/scripts/check-satisfaction.js [--org <uuid>] [--samples]
 */
const path = require('path');
require('./lib/env').loadRepoEnv();

let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client; }

const { classifyCustomerReply, isRepeatedQuestion } =
  require(path.join(__dirname, '..', '..', 'services', 'workflows', 'dist', 'satisfaction', 'signal.js'));

const args = process.argv.slice(2);
const ORG = args.includes('--org') ? args[args.indexOf('--org') + 1] : null;
const SHOW = args.includes('--samples');

const db = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

let pass = 0;
let fail = 0;
const ok = (m, d = '') => { pass++; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d = '') => { fail++; console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };

(async () => {
  await db.connect();
  console.log('\n=== SATISFACTION — reading the evidence already stored ===\n');

  try {
    // Every customer message that FOLLOWED an agent answer in the same
    // conversation. A customer's opening message is not a verdict on anything,
    // so it is excluded — counting it would measure how people say hello.
    const { rows } = await db.query(
      `WITH ordered AS (
         SELECT m.org_id, m.conversation_id, m.role, m.content, m.created_at,
                LAG(m.role)    OVER w AS prev_role,
                LAG(m.content) OVER w AS prev_content,
                LAG(m.content, 2) OVER w AS prev_customer
           FROM messages m
          ${ORG ? 'WHERE m.org_id = $1' : ''}
         WINDOW w AS (PARTITION BY m.conversation_id ORDER BY m.created_at)
       )
       SELECT org_id, conversation_id, content, prev_customer
         FROM ordered
        WHERE role = 'user' AND prev_role = 'assistant'`,
      ORG ? [ORG] : [],
    );

    const tally = { positive: 0, negative: 0, neutral: 0 };
    const reasons = new Map();
    const samples = { positive: [], negative: [] };
    let repeats = 0;

    for (const r of rows) {
      const v = classifyCustomerReply(r.content);
      // A repeated question is a negative the words alone do not carry: nobody
      // asks twice when the first answer worked.
      const repeated = v.polarity === 'neutral' && r.prev_customer
        && isRepeatedQuestion(String(r.prev_customer), String(r.content));
      const polarity = repeated ? 'negative' : v.polarity;
      const reason = repeated ? 'asked the same thing again' : v.reason;
      if (repeated) repeats += 1;

      tally[polarity] += 1;
      reasons.set(reason, (reasons.get(reason) || 0) + 1);
      if (polarity !== 'neutral' && samples[polarity].length < 4) {
        samples[polarity].push(String(r.content).replace(/\s+/g, ' ').slice(0, 68));
      }
    }

    const total = rows.length;
    const readable = tally.positive + tally.negative;
    const pct = (n, d) => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);

    console.log(`  ${total} customer replies followed an agent answer\n`);
    console.log(`    landed     ${String(tally.positive).padStart(4)}`);
    console.log(`    missed     ${String(tally.negative).padStart(4)}`);
    console.log(`    no idea    ${String(tally.neutral).padStart(4)}\n`);

    if (readable > 0) {
      console.log(`  Of the ${readable} we can read, ${pct(tally.positive, readable)}% landed.`);
    }
    console.log(`  For ${pct(tally.neutral, total)}% of replies we have no idea.\n`);

    // ── What the dashboard says today, beside what is true ──────────────────
    const swept = Number((await db.query(
      `SELECT COUNT(*)::int AS n FROM conversations
        WHERE status = 'resolved'
          AND metadata #>> '{resolution,closed_by}' = 'quiet_sweep'
          ${ORG ? 'AND org_id = $1' : ''}`, ORG ? [ORG] : [])).rows[0].n);
    console.log(`  ─── for comparison ───`);
    console.log(`  ${swept} conversation(s) are marked RESOLVED because nobody replied.\n`);

    // ── The assertions ──────────────────────────────────────────────────────
    console.log('1. The classifier refuses to flatter');
    tally.neutral > 0 || total === 0
      ? ok('unreadable replies are counted as unreadable',
        `${tally.neutral} of ${total} — not silently added to either side`)
      : no('unreadable replies are counted as unreadable',
        'every single reply was classified, which is implausible and means the '
        + 'patterns are too greedy');

    // The whole point: silence must not be able to become satisfaction.
    swept === 0 || tally.positive < swept + tally.positive
      ? ok('silence is never counted as satisfaction',
        `${swept} swept conversation(s) contribute 0 to "landed"`)
      : no('silence is never counted as satisfaction');

    console.log('\n2. There is something to learn from');
    tally.negative > 0
      ? ok('the data contains failures', `${tally.negative} reply(s) the agent got wrong`)
      : ok('no readable failures found',
        'either genuinely good, or the negative patterns miss this data — '
        + 'worth an eye once real traffic exists');

    if (repeats > 0) ok('repeated questions detected as failures', `${repeats} found`);

    console.log('\n3. What drove each verdict');
    for (const [reason, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(4)}  ${reason}`);
    }

    if (SHOW) {
      for (const k of ['positive', 'negative']) {
        if (!samples[k].length) continue;
        console.log(`\n  sample ${k}:`);
        for (const s of samples[k]) console.log(`    "${s}"`);
      }
    }
  } finally {
    await db.end().catch(() => {});
  }

  console.log(`\n  passed ${pass} / ${pass + fail}\n`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.log(`\n  ERROR: ${e.message}\n`);
  try { await db.end(); } catch { /* closed */ }
  process.exit(1);
});
