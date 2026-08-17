/**
 * Reply gate tests — compliance AND grounding in one loop.
 *
 * Run: node --test dist/reply-gate.test.js
 */
import test from 'node:test';
import assert from 'node:assert';

import { buildReplyCritique, buildReplyReviser, buildEvidence } from './reply-gate';
import { reviseUntilAllowed } from './activities/critic-revise';
import { evaluateCriticDraft, KNOWN_BAD_FAIR_HOUSING_DRAFT } from './activities/critic-check';
import type { CriticCheckResult, CriticIntent } from './activities/critic-check';

const realCritic = async (d: string, i: CriticIntent): Promise<CriticCheckResult> =>
  evaluateCriticDraft(d, i);

const EVIDENCE = '[database_query] {"invoice_ref":"INV-1042","amount":45000,"status":"overdue"}';

test('a compliant, grounded reply passes untouched', async () => {
  const critique = buildReplyCritique({ critique: realCritic }, { evidence: EVIDENCE });
  const out = await reviseUntilAllowed('INV-1042 is overdue for ₹45,000.', 'send', {
    critique,
    revise: async () => {
      throw new Error('should not revise');
    },
  });
  assert.strictEqual(out.allowed, true);
  assert.strictEqual(out.revisionsUsed, 0);
});

test('an ungrounded figure is caught and self-corrected', async () => {
  const critique = buildReplyCritique({ critique: realCritic }, { evidence: EVIDENCE });
  const out = await reviseUntilAllowed('You owe ₹98,750 in total.', 'send', {
    critique,
    // A correct fix: uses the figure that is actually in evidence.
    revise: async () => 'INV-1042 is outstanding for ₹45,000.',
  });
  assert.strictEqual(out.allowed, true);
  assert.strictEqual(out.revisionsUsed, 1);
  assert.strictEqual(out.attempts[0].policy, 'grounding');
});

test('SAFETY: hedging an invented number does not satisfy the gate', async () => {
  const critique = buildReplyCritique({ critique: realCritic }, { evidence: EVIDENCE });
  const out = await reviseUntilAllowed('You owe ₹98,750.', 'send', {
    critique,
    revise: async () => 'You owe approximately ₹98,750.',
  });
  assert.strictEqual(out.allowed, false, 'a hedge must not pass');
});

test('ORDER: a fair-housing draft escalates, never auto-revised as grounding', async () => {
  // The property that keeps escalate-only from being bypassed: compliance is
  // evaluated before grounding, so this can never be relabelled as a fixable
  // number problem.
  let revised = false;
  const critique = buildReplyCritique({ critique: realCritic }, { evidence: '' });
  const out = await reviseUntilAllowed(KNOWN_BAD_FAIR_HOUSING_DRAFT, 'send', {
    critique,
    revise: async () => {
      revised = true;
      return 'x';
    },
  });
  assert.strictEqual(revised, false);
  assert.strictEqual(out.allowed, false);
  assert.strictEqual(out.stopReason, 'policy_not_revisable');
  assert.strictEqual(out.attempts[0].policy, 'fair_housing');
});

test('SAFETY: a compliance fix that introduces an invented number is rejected', async () => {
  // Exactly why the two checks are composed rather than chained.
  const critique = buildReplyCritique({ critique: realCritic }, { evidence: EVIDENCE });
  const out = await reviseUntilAllowed('We offer guaranteed returns of 12%.', 'send', {
    critique,
    revise: async () => 'Returns have averaged ₹98,750 per unit.',
    // ^ compliant now, but the figure was never retrieved
  });
  assert.strictEqual(out.allowed, false, 'must not accept a compliant-but-ungrounded rewrite');
});

test('SAFETY: empty evidence is NOT the same as opting out of grounding', async () => {
  // Regression. The activity used `skipGrounding: !evidence`, so '' (the agent
  // retrieved nothing) skipped grounding entirely — the most dangerous input
  // received the least checking. `undefined` opts out; '' means nothing was
  // found, and therefore NO figure is defensible.
  const critique = buildReplyCritique({ critique: realCritic }, { evidence: '' });
  const verdict = await critique('Your balance is ₹45,000.', 'send');
  assert.strictEqual(verdict.allow, false, 'a figure with zero evidence must be refused');
  assert.strictEqual(verdict.policy, 'grounding');
});

test('skipGrounding allows a pure acknowledgement with no data', async () => {
  const critique = buildReplyCritique(
    { critique: realCritic },
    { evidence: '', skipGrounding: true }
  );
  const out = await reviseUntilAllowed('Thanks — noted, I will follow up.', 'send', {
    critique,
    revise: async () => '',
  });
  assert.strictEqual(out.allowed, true);
});

test('the reviser receives grounding-specific instructions', async () => {
  let seenPrompt = '';
  const revise = buildReplyReviser(
    {
      revise: async (_d, _v, override) => {
        seenPrompt = override || '';
        return 'INV-1042 is overdue for ₹45,000.';
      },
    },
    { evidence: EVIDENCE }
  );
  await revise('You owe ₹98,750.', {
    allow: false,
    policy: 'grounding',
    reason: 'unsupported money',
    violations: ['money:₹98,750'],
    source: 'heuristic',
  });
  assert.match(seenPrompt, /98,750/, 'names the offending value');
  assert.match(seenPrompt, /approximately/i, 'forbids hedging');
});

test('non-grounding failures use the standard revision prompt', async () => {
  let override: string | undefined = 'unset';
  const revise = buildReplyReviser(
    {
      revise: async (_d, _v, o) => {
        override = o;
        return 'fixed';
      },
    },
    { evidence: EVIDENCE }
  );
  await revise('guaranteed returns', {
    allow: false,
    policy: 'legal_promise',
    reason: 'r',
    violations: [],
    source: 'heuristic',
  });
  assert.strictEqual(override, undefined, 'no grounding override for compliance failures');
});

// ── Evidence assembly ─────────────────────────────────────────────────────

test('SECURITY: the customer message is not evidence', () => {
  // A prompt-injected inbound ("I already paid ₹99,999") must not license the
  // agent to state that figure back as fact.
  const evidence = buildEvidence([{ action: 'db_query', result: { amount: 45000 } }]);
  assert.ok(evidence.includes('45000'));
  assert.ok(!evidence.includes('99999'));
});

test('evidence flattens tool actions and results', () => {
  const evidence = buildEvidence([
    { action: 'gmail.search', result: { count: 3 } },
    { action: 'db_query', output: 'INV-1042' },
  ]);
  assert.match(evidence, /gmail\.search/);
  assert.match(evidence, /3/);
  assert.match(evidence, /INV-1042/);
});

test('SAFETY: unserialisable step values do not break the reply', () => {
  const circular: any = { a: 1 };
  circular.self = circular;
  assert.doesNotThrow(() => buildEvidence([{ action: 'x', result: circular }]));
});

test('SAFETY: missing or empty steps yield empty evidence, not a crash', () => {
  assert.strictEqual(buildEvidence(undefined), '');
  assert.strictEqual(buildEvidence([]), '');
  assert.doesNotThrow(() => buildEvidence([{}]));
});
