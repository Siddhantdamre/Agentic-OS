/**
 * Budget arithmetic.
 *
 * The failures that matter here are in two directions, and both are bad:
 *
 *   - a budget that never fires   → one tenant starves the rest, silently
 *   - a budget that fires wrongly → a paying customer is throttled for free
 *
 * A parse error must never become a ceiling of zero, and an absent limit must
 * never become a limit of zero. Both are tested below, because both turn a
 * missing row into an outage for somebody who is paying.
 *
 * Run: node --test dist/budget/budget.test.js
 */
import test from 'node:test';
import assert from 'node:assert';

import { decideBudget, estimateCostUsd } from './budget';

// ── The ordinary path ───────────────────────────────────────────────────────

test('under the limit: normal tier, no restriction', () => {
  const d = decideBudget({ limitTokens: 1_000_000, usedTokens: 250_000 });
  assert.equal(d.allowed, true);
  assert.equal(d.tier, 'normal');
  assert.equal(d.state, 'ok');
  assert.equal(d.pctUsed, 25);
  assert.equal(d.remainingTokens, 750_000);
});

test('past the warning line: warned, but nothing is restricted yet', () => {
  const d = decideBudget({ limitTokens: 1_000_000, usedTokens: 850_000 });
  assert.equal(d.state, 'warn');
  assert.equal(d.tier, 'normal', 'a warning must not change routing');
  assert.equal(d.allowed, true);
});

test('the warning line is configurable', () => {
  const d = decideBudget({ limitTokens: 1_000_000, usedTokens: 550_000, warnAt: 0.5 });
  assert.equal(d.state, 'warn');
});

// ── Over budget ─────────────────────────────────────────────────────────────

test('DEFAULT: over budget degrades to free and KEEPS ANSWERING', () => {
  const d = decideBudget({ limitTokens: 1_000_000, usedTokens: 1_000_000 });
  assert.equal(d.state, 'exceeded');
  assert.equal(d.tier, 'free');
  assert.equal(
    d.allowed,
    true,
    'silence is the worst failure mode; the default must not create one',
  );
});

test('the boundary is inclusive — exactly at the limit is over it', () => {
  const at = decideBudget({ limitTokens: 100, usedTokens: 100 });
  const under = decideBudget({ limitTokens: 100, usedTokens: 99 });
  assert.equal(at.state, 'exceeded');
  assert.equal(under.state, 'warn');
});

test('OPT-IN: stop refuses the turn', () => {
  const d = decideBudget({ limitTokens: 1_000_000, usedTokens: 2_000_000, onExceeded: 'stop' });
  assert.equal(d.allowed, false);
  assert.equal(d.state, 'exceeded');
});

test('remaining never goes negative, however far over the tenant is', () => {
  const d = decideBudget({ limitTokens: 100, usedTokens: 10_000 });
  assert.equal(d.remainingTokens, 0);
  assert.ok(d.pctUsed !== null && d.pctUsed > 100, 'but the percentage tells the truth');
});

// ── The cases that turn a missing value into an outage ───────────────────────

test('SAFETY: no limit means unlimited, not zero', () => {
  const d = decideBudget({ limitTokens: null, usedTokens: 999_999_999 });
  assert.equal(d.state, 'unlimited');
  assert.equal(d.allowed, true);
  assert.equal(d.tier, 'normal');
  assert.equal(d.pctUsed, null, 'null, not 0 — a dial must not read "0% used"');
  assert.equal(d.remainingTokens, null);
});

test('SAFETY: a NaN limit is treated as absent, never as a ceiling of zero', () => {
  const d = decideBudget({ limitTokens: NaN, usedTokens: 500 });
  assert.equal(d.state, 'unlimited', 'a bad column read must not refuse every turn');
  assert.equal(d.allowed, true);
});

test('SAFETY: a negative limit is treated as absent', () => {
  const d = decideBudget({ limitTokens: -1, usedTokens: 500 });
  assert.equal(d.state, 'unlimited');
});

test('SAFETY: unusable usage counts as zero used, not as over budget', () => {
  const d = decideBudget({ limitTokens: 1000, usedTokens: NaN });
  assert.equal(d.usedTokens, 0);
  assert.equal(d.state, 'ok');
  assert.equal(d.allowed, true);
});

test('a zero limit is a real instruction and is honoured', () => {
  const degrade = decideBudget({ limitTokens: 0, usedTokens: 0 });
  assert.equal(degrade.state, 'exceeded');
  assert.equal(degrade.tier, 'free');
  assert.equal(degrade.pctUsed, null, 'no percentage against a zero denominator');

  const stop = decideBudget({ limitTokens: 0, usedTokens: 0, onExceeded: 'stop' });
  assert.equal(stop.allowed, false);
});

// ── What a human is told ────────────────────────────────────────────────────

test('the reason states the numbers, never a bare assertion', () => {
  const d = decideBudget({ limitTokens: 1_000_000, usedTokens: 1_200_000 });
  // Indian grouping, deliberately: 12,00,000 not 1,200,000. See group().
  assert.match(d.reason, /12,00,000/);
  assert.match(d.reason, /10,00,000/);
  assert.match(d.reason, /free model/);
});

test('PINNED: digit grouping does not follow the host locale', () => {
  // Written because the first run of this suite produced Indian grouping on a
  // machine set to en-IN and US grouping was what the test expected. Whichever
  // one is chosen, it must be the code's choice and not the container's --
  // otherwise the same build shows customers different text on different hosts.
  const d = decideBudget({ limitTokens: 1_000_000, usedTokens: 1_200_000 });
  assert.ok(
    !d.reason.includes('1,200,000'),
    'US grouping here means the locale leaked in from the host',
  );
  assert.match(d.reason, /12,00,000/);
});

test('a refusal says it was refused, and why', () => {
  const d = decideBudget({ limitTokens: 10, usedTokens: 99, onExceeded: 'stop' });
  assert.match(d.reason, /refused/);
});

test('no reason claims the workspace was "blocked" without saying what to do', () => {
  for (const used of [0, 800_000, 1_000_000, 5_000_000]) {
    const d = decideBudget({ limitTokens: 1_000_000, usedTokens: used });
    assert.ok(d.reason.length > 20, 'a one-word status is not an explanation');
    assert.match(d.reason, /workspace/i);
  }
});

// ── Money is an estimate, and says so by refusing to guess ──────────────────

test('cost estimate uses the provider blended rate', () => {
  // $14 of real provider spend across 46,000,000 tokens.
  const c = estimateCostUsd(1_000_000, 14, 46_000_000);
  assert.ok(c !== null);
  assert.ok(Math.abs(c - 0.304348) < 0.001, `got ${c}`);
});

test('HONESTY: no provider sample means no number, not zero', () => {
  assert.equal(estimateCostUsd(1_000_000, null, null), null);
  assert.equal(estimateCostUsd(1_000_000, 14, 0), null, 'no divide-by-zero, no Infinity');
  assert.equal(
    estimateCostUsd(1_000_000, 14, null),
    null,
    'zero would be a claim that this cost nothing',
  );
});

test('a free-only window estimates zero, which is the truth there', () => {
  assert.equal(estimateCostUsd(1_000_000, 0, 46_000_000), 0);
});

test('resolution survives a single turn — 49k tokens must not round to $0.00', () => {
  const c = estimateCostUsd(49_000, 14, 46_000_000);
  assert.ok(c !== null && c > 0, 'a real cost must not vanish into cents rounding');
});
