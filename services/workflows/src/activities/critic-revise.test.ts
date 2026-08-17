/**
 * Critic self-revision tests.
 *
 * These encode SAFETY properties, not behaviour preferences. Each one describes
 * a way an automated revision loop can become dangerous, and asserts we do not
 * do it. If one of these ever has to be "relaxed" to ship a feature, the
 * feature is wrong.
 *
 * Run: node --test dist/activities/critic-revise.test.js
 */
import test from 'node:test';
import assert from 'node:assert';

import {
  reviseUntilAllowed,
  isRevisablePolicy,
  buildRevisionPrompt,
  DEFAULT_MAX_REVISIONS,
} from './critic-revise';
import { evaluateCriticDraft, KNOWN_BAD_FAIR_HOUSING_DRAFT } from './critic-check';
import type { CriticCheckResult, CriticIntent } from './critic-check';

/** The real, unmodified critic — these tests run against the actual gate. */
const realCritic = async (draft: string, intent: CriticIntent): Promise<CriticCheckResult> =>
  evaluateCriticDraft(draft, intent);

const neverRevise = async () => {
  throw new Error('reviser must not be called');
};

test('a clean draft passes with no revision', async () => {
  const out = await reviseUntilAllowed(
    'Thanks for getting in touch — happy to arrange a viewing this week.',
    'send',
    { critique: realCritic, revise: neverRevise as any }
  );
  assert.strictEqual(out.allowed, true);
  assert.strictEqual(out.revisionsUsed, 0);
  assert.strictEqual(out.stopReason, 'allowed_first_try');
});

test('SAFETY: fair-housing violations are never auto-revised', async () => {
  // The core property. Letting a model retry until it slips past the
  // discrimination regex yields text that evades the filter while keeping the
  // intent — worse than escalating, because it now looks clean.
  let reviserCalled = false;
  const out = await reviseUntilAllowed(
    KNOWN_BAD_FAIR_HOUSING_DRAFT,
    'send',
    {
      critique: realCritic,
      revise: async () => {
        reviserCalled = true;
        return 'This 2BHK is a lovely home.';
      },
    }
  );

  assert.strictEqual(reviserCalled, false, 'reviser must never run on fair_housing');
  assert.strictEqual(out.allowed, false);
  assert.strictEqual(out.stopReason, 'policy_not_revisable');
  assert.match(out.escalationReason || '', /human review/i);
  assert.strictEqual(isRevisablePolicy('fair_housing'), false);
});

test('SAFETY: a revision must independently pass the real critic', async () => {
  // The reviser "fixes" one violation but introduces another. The loop must
  // not accept it just because the text changed.
  const out = await reviseUntilAllowed(
    'We offer guaranteed returns of 12% on this unit.',
    'send',
    {
      critique: realCritic,
      // swaps a legal-promise breach for a different legal-promise breach
      revise: async () => 'We offer assured returns on this unit.',
    },
    { maxRevisions: 1 }
  );
  assert.strictEqual(out.allowed, false, 'must not accept a still-violating revision');
  assert.strictEqual(out.stopReason, 'revision_budget_exhausted');
});

test('a legitimate fix is accepted after revision', async () => {
  const out = await reviseUntilAllowed(
    'We offer guaranteed returns of 12% on this unit.',
    'send',
    {
      critique: realCritic,
      revise: async () => 'Historical rental yields in this area have varied; I can share the data.',
    }
  );
  assert.strictEqual(out.allowed, true);
  assert.strictEqual(out.revisionsUsed, 1);
  assert.strictEqual(out.stopReason, 'allowed_after_revision');
  assert.ok(!/guaranteed/i.test(out.finalDraft));
});

test('SAFETY: the loop is bounded by maxRevisions', async () => {
  let calls = 0;
  const out = await reviseUntilAllowed(
    'guaranteed returns of 12%',
    'send',
    {
      critique: realCritic,
      // never actually fixes it, but always changes the text
      revise: async () => `guaranteed returns of ${++calls + 12}%`,
    },
    { maxRevisions: 2 }
  );
  assert.strictEqual(out.allowed, false);
  assert.strictEqual(out.revisionsUsed, 2, 'must stop at the cap');
  assert.strictEqual(calls, 2, 'reviser called exactly maxRevisions times');
  assert.strictEqual(out.stopReason, 'revision_budget_exhausted');
});

test('SAFETY: maxRevisions=0 reproduces todays escalate-immediately behaviour', async () => {
  // Proves this change can only ever REDUCE escalations, never permit
  // something that would previously have been stopped.
  const out = await reviseUntilAllowed(
    'guaranteed returns of 12%',
    'send',
    { critique: realCritic, revise: neverRevise as any },
    { maxRevisions: 0 }
  );
  assert.strictEqual(out.allowed, false);
  assert.strictEqual(out.revisionsUsed, 0);
});

test('an unchanged revision stops the loop immediately', async () => {
  let calls = 0;
  const out = await reviseUntilAllowed(
    'guaranteed returns of 12%',
    'send',
    {
      critique: realCritic,
      revise: async (draft) => {
        calls++;
        return draft; // no progress
      },
    },
    { maxRevisions: 5 }
  );
  assert.strictEqual(out.stopReason, 'no_progress');
  assert.strictEqual(calls, 1, 'must not keep re-submitting identical text');
});

test('whitespace-only changes count as no progress', async () => {
  const out = await reviseUntilAllowed(
    'guaranteed returns of 12%',
    'send',
    { critique: realCritic, revise: async () => '  guaranteed   returns of 12%  ' },
    { maxRevisions: 3 }
  );
  assert.strictEqual(out.stopReason, 'no_progress');
});

test('a throwing reviser escalates rather than crashing the workflow', async () => {
  const out = await reviseUntilAllowed(
    'guaranteed returns of 12%',
    'send',
    {
      critique: realCritic,
      revise: async () => {
        throw new Error('LiteLLM unreachable');
      },
    }
  );
  assert.strictEqual(out.allowed, false);
  assert.strictEqual(out.stopReason, 'reviser_failed');
  assert.match(out.escalationReason || '', /LiteLLM unreachable/);
});

test('an empty revision escalates rather than sending nothing', async () => {
  const out = await reviseUntilAllowed(
    'guaranteed returns of 12%',
    'send',
    { critique: realCritic, revise: async () => '   ' }
  );
  assert.strictEqual(out.allowed, false);
  assert.strictEqual(out.stopReason, 'reviser_failed');
});

test('AUDIT: every draft considered is recorded in order', async () => {
  const out = await reviseUntilAllowed(
    'guaranteed returns of 12%',
    'send',
    {
      critique: realCritic,
      revise: async () => 'Yields vary by unit; I can send the historical figures.',
    }
  );
  assert.strictEqual(out.attempts.length, 2);
  assert.strictEqual(out.attempts[0].attempt, 0);
  assert.strictEqual(out.attempts[0].disposition, 'revised');
  assert.ok(out.attempts[0].violations.length > 0, 'violations retained for audit');
  assert.strictEqual(out.attempts[1].disposition, 'accepted');
  assert.strictEqual(out.attempts[1].allowed, true);
});

test('AUDIT: the escalated attempt chain is preserved for a human', async () => {
  const out = await reviseUntilAllowed(
    KNOWN_BAD_FAIR_HOUSING_DRAFT,
    'send',
    { critique: realCritic, revise: neverRevise as any }
  );
  assert.strictEqual(out.attempts.length, 1);
  assert.strictEqual(out.attempts[0].disposition, 'escalated');
  assert.strictEqual(out.attempts[0].policy, 'fair_housing');
  assert.ok(out.attempts[0].violations.length > 0);
});

test('policy revisability is explicit, not inferred', () => {
  assert.strictEqual(isRevisablePolicy('fair_housing'), false);
  assert.strictEqual(isRevisablePolicy('legal_promise'), true);
  assert.strictEqual(isRevisablePolicy('rera'), true);
  assert.strictEqual(isRevisablePolicy('model'), true);
  // 'ok' never reaches the revise path, and must not be treated as revisable.
  assert.strictEqual(isRevisablePolicy('ok'), false);
});

test('the revision prompt gives the model no route to approval', () => {
  const verdict: CriticCheckResult = {
    allow: false,
    policy: 'legal_promise',
    reason: 'blocked by policy: legal promise',
    violations: ['guaranteed_returns'],
    source: 'heuristic',
  };
  const prompt = buildRevisionPrompt('guaranteed returns of 12%', verdict);
  assert.match(prompt, /guaranteed_returns/, 'names the specific violation');
  assert.match(prompt, /Do not argue/i, 'no arguing route');
  assert.match(prompt, /corrected message only/i);
  assert.ok(!/override|approve|allow it/i.test(prompt), 'must not hint at bypass');
});

test('default revision budget is small and deliberate', () => {
  assert.strictEqual(DEFAULT_MAX_REVISIONS, 2);
});
