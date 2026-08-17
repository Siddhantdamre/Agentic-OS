/**
 * Adaptive turn budget tests.
 *
 * The budget controls how much compute a customer's request receives, so these
 * assert the safety envelope rather than exact tuning: bounded, deterministic,
 * never starves real work, and degrades to today's behaviour when unsure.
 *
 * Run: node --test dist/turn-budget.test.js
 */
import test from 'node:test';
import assert from 'node:assert';

import {
  computeTurnBudget,
  extractSignals,
  evaluateTurnProgress,
  MIN_TURNS,
  DEFAULT_TURNS,
  MAX_TURNS_CEILING,
} from './turn-budget';

test('SAFETY: budget is always within the hard bounds', () => {
  const inputs = [
    '',
    'hi',
    'x'.repeat(5000),
    'a? b? c? d? e? f? g? h?',
    '1. one\n2. two\n3. three\n4. four\nthen also after that',
    'then also after that ' + 'y'.repeat(2000) + ' 1. a\n2. b ??? ',
  ];
  for (const input of inputs) {
    const b = computeTurnBudget(input, Array.from({ length: 40 }, (_, i) => `tool${i}`));
    assert.ok(b.turns >= MIN_TURNS, `below floor for ${JSON.stringify(input.slice(0, 24))}`);
    assert.ok(b.turns <= MAX_TURNS_CEILING, `above ceiling: ${b.turns}`);
    assert.ok(Number.isInteger(b.turns), 'must be a whole number of turns');
  }
});

test('SAFETY: deterministic — same input always yields the same budget', () => {
  // Temporal replays workflow code; a budget that varied would corrupt replay.
  const msg = 'Please chase the landlord, then book a viewing, and also send the invoice.';
  const first = computeTurnBudget(msg, ['gmail', 'calendar']);
  for (let i = 0; i < 25; i++) {
    const again = computeTurnBudget(msg, ['gmail', 'calendar']);
    assert.deepStrictEqual(again, first);
  }
});

test('SAFETY: an empty message falls back to todays fixed behaviour', () => {
  const b = computeTurnBudget('', []);
  assert.strictEqual(b.turns, DEFAULT_TURNS);
  assert.match(b.reason, /default/i);
});

test('an ordinary request keeps the current default budget', () => {
  const b = computeTurnBudget('Can you check whether the deposit has arrived?', ['gmail']);
  assert.strictEqual(b.turns, DEFAULT_TURNS, 'must not be starved relative to today');
});

test('conversational filler gets the minimum budget', () => {
  for (const msg of ['thanks', 'Thank you!', 'ok', 'Got it, cheers', 'hi', 'Good morning']) {
    const b = computeTurnBudget(msg, []);
    assert.strictEqual(b.turns, MIN_TURNS, `expected minimum for ${JSON.stringify(msg)}`);
  }
});

test('SAFETY: filler detection never starves a real request', () => {
  // The dangerous failure: a loose "contains thanks" check would give this the
  // minimum budget and abandon the actual task.
  const sneaky = [
    'thanks — can you also cancel the viewing and email the landlord?',
    'Hi, I need you to reconcile three invoices',
    'ok so what happened with the deposit?',
    'Good morning, please chase the agent about Friday',
  ];
  for (const msg of sneaky) {
    const b = computeTurnBudget(msg, []);
    assert.ok(b.turns >= DEFAULT_TURNS, `starved a real task: ${JSON.stringify(msg)} -> ${b.turns}`);
  }
});

test('multi-step language increases the budget', () => {
  const plain = computeTurnBudget('Please email the landlord.', []);
  const multi = computeTurnBudget('Please email the landlord, then book a viewing.', []);
  assert.ok(multi.turns > plain.turns, 'sequencing should buy more turns');
  assert.match(multi.reason, /sequencing/i);
});

test('enumerated tasks increase the budget', () => {
  const b = computeTurnBudget('Do these:\n1. email the landlord\n2. book a viewing\n3. send invoice', []);
  assert.ok(b.turns > DEFAULT_TURNS);
  assert.match(b.reason, /enumerated/i);
});

test('several questions increase the budget', () => {
  const b = computeTurnBudget('What is the rent? When is it due? Who is the landlord?', []);
  assert.ok(b.turns > DEFAULT_TURNS);
  assert.match(b.reason, /questions/i);
});

test('a compound request is capped at the ceiling, not unbounded', () => {
  const b = computeTurnBudget(
    'First do this, then that, after that the other. ' +
      '1. one\n2. two\n3. three\n' +
      'Why? When? Who? How? ' +
      'z'.repeat(900),
    []
  );
  assert.strictEqual(b.turns, MAX_TURNS_CEILING);
});

test('the budget explains itself for audit', () => {
  const b = computeTurnBudget('Email them, then call, and also text.', ['gmail', 'twilio']);
  assert.ok(b.reason.length > 0, 'must carry a reason');
  assert.strictEqual(b.signals.hasMultiStepMarkers, true);
  assert.strictEqual(b.signals.toolCount, 2);
});

test('signal extraction is accurate', () => {
  const s = extractSignals('One? Two? Three?\n1. a\n2. b\nthen finish', ['a', 'b', 'c']);
  assert.strictEqual(s.questionCount, 3);
  assert.strictEqual(s.hasEnumeration, true);
  assert.strictEqual(s.hasMultiStepMarkers, true);
  assert.strictEqual(s.toolCount, 3);
  assert.strictEqual(s.isTrivial, false);
});

// ── Stuck detection ───────────────────────────────────────────────────────

test('a turn that uses a new tool counts as progress', () => {
  const p = evaluateTurnProgress(new Set(['gmail']), ['gmail', 'calendar'], 0);
  assert.strictEqual(p.newTools, 1);
  assert.strictEqual(p.madeProgress, true);
});

test('a turn that records new steps counts as progress', () => {
  const p = evaluateTurnProgress(new Set(['gmail']), ['gmail'], 2);
  assert.strictEqual(p.newTools, 0);
  assert.strictEqual(p.newSteps, 2);
  assert.strictEqual(p.madeProgress, true);
});

test('STUCK: repeating the same tool with no new steps is NOT progress', () => {
  // The case a plain "did it use tools?" check gets wrong — it would keep
  // spending budget re-running an identical failing call.
  const p = evaluateTurnProgress(new Set(['gmail']), ['gmail'], 0);
  assert.strictEqual(p.madeProgress, false);
});

test('STUCK: a turn that does nothing at all is not progress', () => {
  const p = evaluateTurnProgress(new Set(), [], 0);
  assert.strictEqual(p.madeProgress, false);
});

test('negative step counts cannot fake progress', () => {
  const p = evaluateTurnProgress(new Set(['a']), ['a'], -5);
  assert.strictEqual(p.newSteps, 0);
  assert.strictEqual(p.madeProgress, false);
});
