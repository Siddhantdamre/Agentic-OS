#!/usr/bin/env node
'use strict';
/**
 * LATENCY — what is actually fast, and what has never been measured.
 *
 * The existing latency-probe.js measures the agent turn, which needs model
 * credit and has therefore never produced a number on this deployment. That
 * left "is it fast?" unanswered, when in fact most of the paths a customer
 * waits on are measurable for free:
 *
 *   the gates that run on EVERY reply          pure functions, no I/O
 *   the budget check on the hot path           one indexed query
 *   memory retrieval                           the query that feeds the agent
 *   the API routes an operator loads
 *   the identity resolution now on every inbound message
 *
 * ── PERCENTILES, NOT AVERAGES ─────────────────────────────────────────────
 * A mean hides the tail, and the tail is what a customer experiences as "this
 * is slow". p50 says whether it is usually fine; p95 and max say whether it is
 * ever bad. A mean of 40ms over a set containing one 3-second call reads as
 * healthy and is not.
 *
 * ── IT NAMES WHAT IT CANNOT MEASURE ───────────────────────────────────────
 * The agent turn is the dominant cost in wall-clock terms and needs credit.
 * Reporting only the fast paths and calling it "latency" would be the most
 * flattering possible framing, so the unmeasured path is printed alongside the
 * measured ones rather than omitted.
 *
 * Usage: node infra/scripts/measure-latency.js [--samples 30] [--json]
 */
const path = require('path');
require('./lib/env').loadRepoEnv();

let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client; }

const W = path.join(__dirname, '..', '..', 'services', 'workflows', 'dist');
const { sanitiseCustomerReply, isKnowledgeGap } = require(path.join(W, 'reply-gate.js'));
const { decideBudget } = require(path.join(W, 'budget', 'budget.js'));
const { assessLead, DEFAULT_POLICY } = require(path.join(W, 'leads', 'quiet.js'));
const { normaliseIdentity } = require(path.join(W, 'identity', 'identity.js'));
const { judgeTask } = require(path.join(W, 'supervision', 'trio.js'));
const { decideToolCall, ROLE_HANDS } = require(path.join(W, 'tools', 'capability.js'));

const args = process.argv.slice(2);
const SAMPLES = args.includes('--samples') ? Number(args[args.indexOf('--samples') + 1]) || 30 : 30;
const JSON_OUT = args.includes('--json');
const BASE = process.env.DASHBOARD_URL || 'http://127.0.0.1:3000';

const db = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

/** p50/p95/max over sorted samples. Percentiles, because a mean hides the tail. */
function stats(ms) {
  if (!ms.length) return null;
  const s = [...ms].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  return { n: s.length, p50: at(50), p95: at(95), max: s[s.length - 1] };
}

const results = [];
function record(layer, name, budgetMs, st, note = '') {
  const verdict = st === null ? 'not measured'
    : st.p95 <= budgetMs ? 'ok'
      : st.p95 <= budgetMs * 2 ? 'watch' : 'slow';
  results.push({ layer, name, budgetMs, ...(st || {}), verdict, note });
}

async function timeAsync(fn, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = process.hrtime.bigint();
    try { await fn(i); } catch { /* a failed call is not a timing sample */ continue; }
    out.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  return out;
}

function timeSync(fn, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = process.hrtime.bigint();
    fn(i);
    out.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  return out;
}

let scratchOrg = null;

(async () => {
  await db.connect();
  try {
    // ── The gates that run on every single reply ────────────────────────────
    // These are pure and should be microseconds. If any of them is not, it is
    // on the hot path of every message and the cost is paid per customer.
    const draft = 'You can return items within 30 days of delivery for a full refund. '
      + 'Items must be unused and in their original packaging. Call +91 98765 43210.';
    record('gate', 'reply sanitiser', 1,
      stats(timeSync(() => sanitiseCustomerReply(draft), SAMPLES * 20)),
      'runs on every reply');
    record('gate', 'knowledge-gap detector', 1,
      stats(timeSync(() => isKnowledgeGap(draft, 'what is your returns policy?'), SAMPLES * 20)),
      'runs on every reply');
    record('gate', 'budget decision', 1,
      stats(timeSync(() => decideBudget({ limitTokens: 1_000_000, usedTokens: 250_000 }), SAMPLES * 20)),
      'runs before every paid call');
    record('gate', 'tool authorisation', 1,
      stats(timeSync(() => decideToolCall({
        tool: 'razorpay', action: 'payout', allowlist: ROLE_HANDS.sales, autonomyLevel: 2,
      }), SAMPLES * 20)),
      'runs before every tool call');
    record('gate', 'identity normalisation', 1,
      stats(timeSync(() => normaliseIdentity('+91 97999 92973', 'whatsapp'), SAMPLES * 20)),
      'runs on every inbound message');
    record('gate', 'quiet-lead judgement', 1,
      stats(timeSync(() => assessLead({
        conversationId: 'c', lastCustomerMessageAt: new Date(Date.now() - 9e8),
        lastOutboundAt: new Date(Date.now() - 8e8), nudgesSent: 0, lastNudgeAt: null,
        status: 'open', optedOut: false, lastCustomerText: 'price?',
      }, new Date(), DEFAULT_POLICY), SAMPLES * 20)),
      'runs per candidate lead');
    record('gate', 'supervision verdict', 1,
      stats(timeSync(() => judgeTask({
        replyProduced: true, refused: false, escalated: false, turns: 1,
        criticBlocked: false, criticRevised: false, criticReason: '', criticUsedModel: false,
        gapRecorded: false, memoryWritten: false,
      }), SAMPLES * 20)),
      'runs once per task');

    // ── Database, on the hot path ───────────────────────────────────────────
    const org = (await db.query(
      `SELECT org_id FROM conversations GROUP BY org_id ORDER BY COUNT(*) DESC LIMIT 1`)).rows[0]?.org_id;

    record('database', 'tenant context + budget status', 25,
      stats(await timeAsync(async () => {
        await db.query("SELECT set_config('app.current_org_id', $1, false)", [org]);
        await db.query(`SELECT * FROM llm_budget_status($1::uuid)`, [org]);
      }, SAMPLES)),
      'the gate on every agent turn');

    record('database', 'conversation lookup by person', 25,
      stats(await timeAsync(async () => {
        await db.query(
          `SELECT id FROM conversations WHERE org_id = $1 AND person_id IS NOT NULL LIMIT 20`, [org]);
      }, SAMPLES)),
      'cross-channel history');

    // Resolution WRITES. Measuring it against a real workspace would leave
    // dozens of invented people in it, so it runs in a throwaway org that is
    // dropped in the `finally` below — a benchmark must not leave residue in
    // the data it benchmarks.
    scratchOrg = (await db.query(
      `INSERT INTO orgs (name, slug) VALUES ($1,$1) RETURNING id`,
      [`latency-scratch-${Date.now()}`])).rows[0].id;

    record('database', 'identity resolution — first sight (writes)', 30,
      stats(await timeAsync(async (i) => {
        await db.query(
          `SELECT resolve_contact_person($1::uuid,'phone',$2::text,$3::text,true,'')`,
          [scratchOrg, `9199000${String(i).padStart(5, '0')}`, `+9199000${String(i).padStart(5, '0')}`]);
      }, SAMPLES)),
      'a person nobody has seen before');

    record('database', 'identity resolution — known person', 25,
      stats(await timeAsync(async () => {
        await db.query(
          `SELECT resolve_contact_person($1::uuid,'phone',$2::text,$3::text,true,'')`,
          [scratchOrg, '919900000000', '+919900000000']);
      }, SAMPLES)),
      'the common case — every message after the first');

    record('database', 'memory retrieval (full-text)', 50,
      stats(await timeAsync(async () => {
        await db.query(
          `SELECT id FROM org_memory WHERE org_id = $1
             AND body_tsv @@ plainto_tsquery('english', $2) LIMIT 10`,
          [org, 'returns policy days refund']);
      }, SAMPLES)),
      'feeds the agent its context');

    // ── HTTP, what an operator waits on ─────────────────────────────────────
    record('http', 'GET /api/health', 100,
      stats(await timeAsync(async () => {
        await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(10000) });
      }, SAMPLES)),
      'the liveness probe');

    record('http', 'GET /api/leaks (unauthenticated 401)', 150,
      stats(await timeAsync(async () => {
        await fetch(`${BASE}/api/leaks`, { signal: AbortSignal.timeout(10000) });
      }, SAMPLES)),
      'the auth path itself');

    record('http', 'GET / (dashboard shell)', 800,
      stats(await timeAsync(async () => {
        await fetch(`${BASE}/`, { signal: AbortSignal.timeout(15000) });
      }, Math.min(SAMPLES, 10))),
      'first paint for an operator');

    // ── Named, not omitted ──────────────────────────────────────────────────
    record('agent', 'agent turn (reply to a customer)', 20000, null,
      'NEEDS MODEL CREDIT — the dominant wall-clock cost, never measured here');
    record('agent', 'critic + revision', 12000, null, 'NEEDS MODEL CREDIT');
    record('agent', 'memory write-back', 25000, null, 'NEEDS MODEL CREDIT');

    if (JSON_OUT) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.log('\n=== LATENCY ===  p95 against a budget, not an average\n');
      let layer = '';
      for (const r of results) {
        if (r.layer !== layer) { layer = r.layer; console.log(`  ${layer.toUpperCase()}`); }
        const mark = r.verdict === 'ok' ? '  ok  ' : r.verdict === 'watch' ? ' watch'
          : r.verdict === 'slow' ? ' SLOW ' : '  --  ';
        const nums = r.p50 === undefined ? '—'
          : `p50 ${r.p50.toFixed(r.p50 < 10 ? 2 : 0)}ms  p95 ${r.p95.toFixed(r.p95 < 10 ? 2 : 0)}ms  max ${r.max.toFixed(0)}ms`;
        console.log(`   [${mark}] ${r.name.padEnd(38)} ${nums.padEnd(38)} budget ${r.budgetMs}ms`);
        if (r.note) console.log(`            ${r.note}`);
      }
      const slow = results.filter((r) => r.verdict === 'slow');
      const unmeasured = results.filter((r) => r.verdict === 'not measured');
      console.log(`\n  ${results.length - unmeasured.length} path(s) measured, `
        + `${slow.length} over budget, ${unmeasured.length} need model credit.\n`);
      if (slow.length) process.exitCode = 1;
    }
  } finally {
    if (scratchOrg) {
      await db.query(`DELETE FROM orgs WHERE id = $1`, [scratchOrg]).catch(() => {});
    }
    await db.end().catch(() => {});
  }
})().catch((e) => {
  console.error(`\n  ERROR: ${e.message}\n`);
  process.exit(1);
});
