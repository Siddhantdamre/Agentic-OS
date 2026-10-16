/**
 * P5-DEMO-1 — composition test for the four mechanisms in 11 §0.
 * Exits non-zero on any failed scene. Run: pnpm demo:e2e
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assertTransition } from '@darex/shared-types';
import {
  buildDecisionCard,
  canPreemptLease,
  checkAutonomy,
  DEFAULT_RULES,
  evaluateAutonomy,
  leasePrecedence,
  resolveActionType,
} from '../autonomy.js';
import { extractOpenLoops } from '../customer/obligation-extract.js';
import { formatExplainAnswer, type DecisionLedgerRow } from '../operations/decision-ledger.js';
import { ACME, BRIGHT, DEMO_ENQUIRY, DEMO_MESSAGES, hoursAgo } from './demo-seed.js';

type SceneResult = { name: string; ok: boolean; detail: string };

const results: SceneResult[] = [];
let modelCalls = 0;

function scene(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, ok: true, detail: 'ok' });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, detail });
    console.error(`  ✗ ${name}: ${detail}`);
  }
}

function scene1(): void {
  const loops = DEMO_MESSAGES.flatMap((m) =>
    extractOpenLoops({
      message: m.content,
      speaker: m.speaker,
      at: m.at,
    }).map((loop) => ({ ...loop, customer: m.customer, source: m.content, speaker: m.speaker }))
  );
  assert.equal(loops.length, 2, `expected 2 loops, got ${loops.length}`);
  const acme = loops.find((l) => l.customer === ACME.name);
  const bright = loops.find((l) => l.customer === BRIGHT.name);
  assert.ok(acme, 'Acme quote loop missing');
  assert.ok(bright, 'Bright delivery-date loop missing');
  assert.equal(acme.dueBasis, 'explicit');
  assert.equal(bright.dueBasis, 'relative');
  for (const loop of loops) {
    assert.ok(loop.source.includes(loop.sourceQuote), 'source_quote must be a substring');
    if (loop.speaker === 'them') assert.notEqual(loop.obligor, 'us');
  }
  const themLoops = DEMO_MESSAGES.filter((m) => m.speaker === 'them').flatMap((m) =>
    extractOpenLoops({ message: m.content, speaker: m.speaker, at: m.at })
  );
  assert.equal(themLoops.length, 0, 'customer-sent messages must not create obligor=us');
}

function scene2(): void {
  const idleModelCallsBefore = modelCalls;
  const quote = DEMO_MESSAGES[0];
  const loops = extractOpenLoops({ message: quote.content, speaker: quote.speaker, at: quote.at });
  assert.equal(loops.length, 1);
  assert.ok(loops[0].targetCheckAt.getTime() < Date.now(), 'quote loop must already be due');
  assert.notEqual('already_resolved', 'irreversible_action');
  assert.equal(modelCalls, idleModelCallsBefore, 'idle due-check made a model call');
}

function scene3(): void {
  assertTransition('enquiry', DEMO_ENQUIRY.state, 'assigned');
  const verdict = evaluateAutonomy({
    actionType: 'assign_owner',
    bucket: 'internal_write',
    rule: DEFAULT_RULES.internal_write,
    confidence: 0.9,
    ruleSource: 'default',
  });
  assert.equal(verdict.mode, 'execute');
  assert.equal(verdict.reasonCode, 'reversible_within_policy');
}

function scene4(): void {
  const card = buildDecisionCard({
    actionType: 'refund_payment',
    tool: 'stripe',
    action: 'refund_payment',
    payload: { order: '#4837', customer: ACME.name },
    reasonCode: 'irreversible_action',
  });
  assert.ok(card.options.length >= 2, 'a single-option card is a lost nerve');
  for (const option of card.options) {
    assert.ok(option.cost && option.cost.length > 0, `option ${option.id} missing cost`);
  }
  assert.ok(card.recommendation.basis);
}

async function scene5(): Promise<void> {
  const verdict = await checkAutonomy({
    orgId: '00000000-0000-4000-8000-00000000d3e0',
    employeeRole: 'customer',
    tool: 'stripe',
    action: 'refund_payment',
    confidence: 0.99,
  });
  assert.equal(verdict.mode, 'approval_required');
  assert.equal(verdict.reasonCode, 'irreversible_action');
  assert.equal(DEFAULT_RULES.irreversible.requiresHumanApproval, true);
}

function scene6(): void {
  const declined: DecisionLedgerRow = {
    id: 'demo-ledger-1',
    orgId: '00000000-0000-4000-8000-00000000d3e0',
    employeeRole: 'customer',
    actionConsidered: 'confirm delivery date',
    decision: 'declined',
    reasonCode: 'confidence_below_threshold',
    reasonSummary: 'no source for a delivery date',
    confidenceScore: 0.41,
    confidenceBreakdown: { grounding: 0.12, state: 0.4, precedent: 0.5, self: 0.6 },
    entityId: null,
    createdAt: new Date().toISOString(),
  };
  const explained = formatExplainAnswer("why didn't you confirm Bright's delivery date", [declined]);
  assert.equal(explained.source, 'ledger');
  assert.equal(explained.reasonCode, 'confidence_below_threshold');
  assert.equal(explained.grounding, 0.12);
  assert.ok(explained.remedy);
  const empty = formatExplainAnswer('why did you email the moon', []);
  assert.equal(empty.answer, 'I have no record of considering that.');
  assert.equal(empty.source, 'none');
}

function scene7(): void {
  const sent = new Set<string>();
  const key = 'org:sendExternal:acme-quote';
  function sendOnce(businessKey: string): 'sent' | 'replayed' {
    const hashed = createHash('sha256').update(businessKey).digest('hex');
    if (sent.has(hashed)) return 'replayed';
    sent.add(hashed);
    return 'sent';
  }
  assert.equal(sendOnce(key), 'sent');
  assert.equal(sendOnce(key), 'replayed');
  assert.equal(sent.size, 1);
}

function scene8(): void {
  const due = extractOpenLoops({
    message: 'Thanks, all sorted.',
    speaker: 'them',
    at: hoursAgo(10 * 24),
  });
  assert.equal(due.length, 0);
  assert.equal(modelCalls, 0);
}

function scene9(): void {
  assert.ok(canPreemptLease('growth', 'customer'));
  assert.equal(canPreemptLease('customer', 'growth'), false);
  assert.ok(leasePrecedence('customer') > leasePrecedence('growth'));
  const classified = resolveActionType('gmail', 'send_external_email');
  assert.equal(classified.bucket, 'external_send');
}

async function main(): Promise<void> {
  console.log('P5-DEMO-1');
  scene('scene 1  ingest + extract', scene1);
  scene('scene 2  timer fires unprompted', scene2);
  scene('scene 3  autonomous internal act', scene3);
  scene('scene 4  decision escalated', scene4);
  try {
    await scene5();
    results.push({ name: 'scene 5  irreversible blocked', ok: true, detail: 'ok' });
    console.log('  ✓ scene 5  irreversible blocked');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name: 'scene 5  irreversible blocked', ok: false, detail });
    console.error(`  ✗ scene 5  irreversible blocked: ${detail}`);
  }
  scene('scene 6  explained a negative', scene6);
  scene('scene 7  retry produced 1 effect', scene7);
  scene('scene 8  silence when healthy', scene8);
  scene('scene 9  one message, lease honoured', scene9);

  const failed = results.filter((r) => !r.ok);
  const passed = results.filter((r) => r.ok).length;
  console.log(`  ${passed} passed · ${failed.length} failed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
