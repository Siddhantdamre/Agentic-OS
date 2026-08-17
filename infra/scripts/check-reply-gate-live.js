#!/usr/bin/env node
/**
 * Reply gate — LIVE smoke test.
 *
 * Runs the real `criticCheckWithRevision` activity against real infrastructure:
 * a live Postgres (idempotency), the real compliance critic, the real grounding
 * checker, and the real LiteLLM reviser if one is reachable.
 *
 * This is deliberately NOT a unit test. Unit tests inject fakes; this exercises
 * the wiring — env resolution, DB round-trips, the composed gate — which is
 * exactly where "all tests pass" and "it works" diverge.
 *
 * LLM AVAILABILITY
 * The revision step needs a working LiteLLM gateway with a provider key. When
 * one is absent the gate must FAIL CLOSED — escalate rather than send an
 * unverified reply. That path is itself asserted here, because it is the state
 * most deployments will hit first.
 *
 * Usage:
 *   DB_NAME=darex_smoke node infra/scripts/check-reply-gate-live.js
 */

// NOTE: 127.0.0.1, never 'localhost'. Node resolves localhost to IPv6 ::1 first;
// Docker publishes on [::] but that path resets the connection, producing
// intermittent ECONNRESET / "fetch failed" that looks like random flakiness.
// curl hides this by falling back to IPv4 — Node's fetch and pg do not.
const path = require('path');

let Client;
try {
  Client = require('pg').Client;
} catch {
  Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client;
}

const activities = require(path.join(__dirname, '../../services/workflows/dist/activities/index.js'));
const { buildEvidence } = require(path.join(__dirname, '../../services/workflows/dist/reply-gate.js'));

let pass = 0;
let fail = 0;
const ok = (m, d = '') => { pass++; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d = '') => { fail++; console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };

const admin = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

const TAG = `gate-live-${Date.now()}`;
let orgId;
let seq = 0;
const key = () => `${TAG}:${++seq}`;

/** Real retrieved tool output — the only admissible evidence. */
const STEPS = [
  {
    action: 'database_query',
    result: { invoice_ref: 'INV-1042', amount: 45000, status: 'overdue', due_date: '2026-03-01' },
  },
];

async function llmReachable() {
  const base = process.env.LITELLM_BASE_URL || 'http://localhost:4000/v1';
  const apiKey = process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY || '';
  if (!apiKey) return false;
  try {
    const url = base.replace(/\/$/, '') + '/chat/completions';
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 25_000);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: process.env.LITELLM_MODEL || 'atomic-agent',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'ok' }],
      }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

async function gate(draft, evidence) {
  return activities.criticCheckWithRevision({
    orgId,
    workItemId: '00000000-0000-4000-8000-000000000000',
    draft,
    intent: 'send',
    businessKey: key(),
    evidence,
  });
}

async function main() {
  console.log('\n=== Reply Gate — LIVE smoke test ===\n');
  await admin.connect();

  const org = await admin.query(
    `INSERT INTO orgs (name, slug) VALUES ($1, $2) RETURNING id`,
    [TAG, TAG.toLowerCase()]
  );
  orgId = org.rows[0].id;
  console.log(`org: ${orgId}\n`);

  const evidence = buildEvidence(STEPS);
  console.log('1. Evidence assembly (real tool output)');
  evidence.includes('45000') && evidence.includes('INV-1042')
    ? ok('evidence carries the retrieved facts')
    : no('evidence carries the retrieved facts', evidence.slice(0, 120));

  const llmUp = await llmReachable();
  console.log(`\nLLM gateway reachable: ${llmUp ? 'YES' : 'NO (revision unavailable)'}\n`);

  // ── 2. A grounded, compliant reply must pass untouched ───────────────────
  console.log('2. Grounded + compliant reply');
  const good = await gate('INV-1042 is overdue for ₹45,000. Shall I chase it?', evidence);
  good.allow === true
    ? ok('allowed without revision', `revisions=${good.revisionsUsed}`)
    : no('allowed without revision', `${good.stopReason}: ${good.reason}`);
  good.revisionsUsed === 0 ? ok('no LLM call was needed') : no('no LLM call was needed');

  // ── 3. An invented figure must never be sent ─────────────────────────────
  console.log('\n3. Ungrounded figure (the trust-killer)');
  const bad = await gate('You owe ₹98,750 across your invoices.', evidence);
  if (llmUp) {
    // With a reviser available the gate may fix it; either way it must not send
    // the original invented number.
    bad.allow === false || !bad.finalDraft.includes('98,750')
      ? ok('invented figure never sent', `allow=${bad.allow} stop=${bad.stopReason}`)
      : no('invented figure never sent', bad.finalDraft);
  } else {
    bad.allow === false
      ? ok('FAIL CLOSED: escalated with no reviser', bad.stopReason)
      : no('FAIL CLOSED: escalated with no reviser', 'it allowed an unverified figure');
  }
  // Check the ATTEMPT CHAIN, not the final policy. On a successful revision the
  // last attempt is the accepted one (policy 'ok'); the grounding failure that
  // triggered the fix lives earlier in the chain. Asserting the final policy
  // only passes when revision is unavailable — which is how this initially
  // "passed" with no LLM and then failed once one was reachable.
  const sawGrounding = (bad.attempts || []).some((a) => a.policy === 'grounding');
  sawGrounding
    ? ok('grounding failure recorded in the audit chain', `${bad.attempts.length} attempt(s)`)
    : no('grounding failure recorded in the audit chain', JSON.stringify(bad.attempts));

  if (bad.allow) {
    // Prove the correction is real, not a hedge or a dropped sentence.
    !/98,?750/.test(bad.finalDraft)
      ? ok('the invented figure is gone from the sent text')
      : no('the invented figure is gone from the sent text', bad.finalDraft);
    !/approximat|roughly|about ₹/i.test(bad.finalDraft)
      ? ok('the fix is not a hedge')
      : no('the fix is not a hedge', bad.finalDraft);
    console.log(`         corrected draft: ${JSON.stringify(bad.finalDraft.slice(0, 160))}`);
  }

  // ── 4. Compliance still takes precedence ─────────────────────────────────
  console.log('\n4. Compliance outranks grounding');
  const fh = await gate(
    'This 2BHK is perfect for Christian families, no kids, adults only, no Section 8.',
    evidence
  );
  fh.allow === false ? ok('fair-housing draft blocked') : no('fair-housing draft blocked');
  fh.policy === 'fair_housing'
    ? ok('escalated as fair_housing, not relabelled as grounding')
    : no('escalated as fair_housing', `got ${fh.policy}`);
  fh.stopReason === 'policy_not_revisable'
    ? ok('never offered to the reviser')
    : no('never offered to the reviser', fh.stopReason);

  // ── 5. Empty evidence blocks any specific figure ─────────────────────────
  console.log('\n5. No evidence retrieved');
  const noEv = await gate('Your balance is ₹45,000.', '');
  noEv.allow === false || !noEv.finalDraft.includes('45,000')
    ? ok('figure not sent when nothing was retrieved')
    : no('figure not sent when nothing was retrieved');

  // ── 6. Prose without claims is unaffected ────────────────────────────────
  console.log('\n6. Ordinary reply with no figures');
  const prose = await gate('Thanks for getting in touch — I will look into this and revert.', evidence);
  prose.allow === true
    ? ok('plain reply passes cleanly')
    : no('plain reply passes cleanly', prose.reason);

  // ── 7. Idempotency through the real DB ───────────────────────────────────
  console.log('\n7. Idempotency (same businessKey returns the cached verdict)');
  const bk = key();
  const first = await activities.criticCheckWithRevision({
    orgId, workItemId: '00000000-0000-4000-8000-000000000000',
    draft: 'INV-1042 is overdue for ₹45,000.', intent: 'send', businessKey: bk, evidence,
  });
  const second = await activities.criticCheckWithRevision({
    orgId, workItemId: '00000000-0000-4000-8000-000000000000',
    draft: 'COMPLETELY DIFFERENT DRAFT ₹1.', intent: 'send', businessKey: bk, evidence,
  });
  second.finalDraft === first.finalDraft
    ? ok('replay returns the original verdict')
    : no('replay returns the original verdict', 'idempotency key was ignored');

  // ── Cleanup ──────────────────────────────────────────────────────────────
  console.log('\n8. Cleanup');
  await admin.query(`DELETE FROM orgs WHERE slug = $1`, [TAG.toLowerCase()]);
  ok('test org removed');

  console.log('\n--- Summary ---');
  const total = pass + fail;
  console.log(fail === 0 ? `  ALL CHECKS PASSED (${pass}/${total})` : `  ${fail} of ${total} CHECKS FAILED`);
  if (!llmUp) {
    console.log('\n  NOTE: no LLM gateway was reachable, so the SELF-REVISION path was not');
    console.log('  exercised. What is proven here is that the gate fails closed without it.');
  }
  console.log('');

  await admin.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\nLive gate check error:', err);
  try { await admin.query(`DELETE FROM orgs WHERE slug = $1`, [TAG.toLowerCase()]); } catch {}
  try { await admin.end(); } catch {}
  process.exit(1);
});
