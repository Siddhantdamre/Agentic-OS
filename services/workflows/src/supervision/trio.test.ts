/**
 * Three roles on every task.
 *
 * The failures that matter here are all mis-classifications that would make a
 * number lie to whoever reads it:
 *
 *   a deliberate refusal filed as a failure  -> the safest agent looks worst,
 *                                               and the number is then used to
 *                                               argue for weakening refusals
 *   an empty reply recorded as "passed"      -> a pass rate built on silence
 *   learning credited to a judgement that
 *     never happened                          -> the loop looks closed when it
 *                                               is not
 *
 * Run: node --test dist/supervision/trio.test.js
 */
import test from 'node:test';
import assert from 'node:assert';

import { judgeTask, summariseSupervision, type TaskSignals } from './trio';

const signals = (over: Partial<TaskSignals> = {}): TaskSignals => ({
  replyProduced: true,
  refused: false,
  escalated: false,
  turns: 1,
  criticBlocked: false,
  criticRevised: false,
  criticReason: '',
  criticUsedModel: false,
  gapRecorded: false,
  memoryWritten: false,
  ...over,
});

// ── The doer ────────────────────────────────────────────────────────────────

test('an ordinary answered task', () => {
  const v = judgeTask(signals());
  assert.equal(v.doerOutcome, 'replied');
  assert.equal(v.monitorVerdict, 'passed');
  assert.equal(v.learnerOutcome, 'nothing');
});

test('A REFUSAL IS NOT A FAILURE', () => {
  // The most consequential classification here. A security refusal is a
  // correct outcome; filing it as a failure makes the safest agent look like
  // the worst-performing one, and that number gets used to argue for
  // weakening the refusals.
  const v = judgeTask(signals({ refused: true, replyProduced: true }));
  assert.equal(v.doerOutcome, 'refused');
  assert.match(v.summary, /declined, on purpose/);
});

test('asking a human is its own outcome, not a failure either', () => {
  assert.equal(judgeTask(signals({ escalated: true, replyProduced: false })).doerOutcome, 'escalated');
});

test('no reply and no reason is a failure', () => {
  assert.equal(judgeTask(signals({ replyProduced: false })).doerOutcome, 'failed');
});

test('a refusal outranks an escalation', () => {
  // Both can be true at once; the refusal is the more specific fact.
  assert.equal(judgeTask(signals({ refused: true, escalated: true })).doerOutcome, 'refused');
});

// ── The monitor ─────────────────────────────────────────────────────────────

test('HONESTY: nothing produced is SKIPPED, never passed', () => {
  // A monitor reporting "passed" over an empty reply claims a judgement it
  // never made, and a pass rate built on those is mostly silence.
  const v = judgeTask(signals({ replyProduced: false }));
  assert.equal(v.monitorVerdict, 'skipped');
  assert.match(v.summary, /nothing to check/);
});

test('blocked and revised are distinguished', () => {
  assert.equal(judgeTask(signals({ criticBlocked: true })).monitorVerdict, 'blocked');
  assert.equal(judgeTask(signals({ criticRevised: true })).monitorVerdict, 'revised');
});

test('a block outranks a revision', () => {
  // A draft revised and then still blocked ended blocked.
  assert.equal(
    judgeTask(signals({ criticBlocked: true, criticRevised: true })).monitorVerdict, 'blocked');
});

test('the reason is kept only when something was decided', () => {
  const passed = judgeTask(signals({ criticReason: 'ok' }));
  assert.equal(passed.monitorReason, '', 'a pass has no reason to give');
  const blocked = judgeTask(signals({ criticBlocked: true, criticReason: 'fair_housing' }));
  assert.equal(blocked.monitorReason, 'fair_housing');
});

test('COST SIGNAL: whether a model was needed is tracked separately', () => {
  const cheap = judgeTask(signals({ criticBlocked: true, criticUsedModel: false }));
  assert.equal(cheap.monitorUsedModel, false, 'the deterministic gates decided this one');
  const dear = judgeTask(signals({ criticBlocked: true, criticUsedModel: true }));
  assert.equal(dear.monitorUsedModel, true);
});

// ── The learner, and the loop ───────────────────────────────────────────────

test('the learner records what it took away', () => {
  assert.equal(judgeTask(signals({ gapRecorded: true })).learnerOutcome, 'gap_recorded');
  assert.equal(judgeTask(signals({ memoryWritten: true })).learnerOutcome, 'memory_written');
  assert.equal(judgeTask(signals({ gapRecorded: true, memoryWritten: true })).learnerOutcome, 'both');
});

test('THE LOOP: learning counts as caused by the judgement only when there WAS one', () => {
  const closed = judgeTask(signals({ criticBlocked: true, gapRecorded: true }));
  assert.equal(closed.learnerFromMonitor, true);
  assert.match(closed.summary, /because of that judgement/);

  // A gap opened on a task the monitor happily passed is not the loop closing.
  // It is two things happening on the same afternoon, and counting it would
  // inflate the one number that says whether being judged teaches anything.
  const coincidence = judgeTask(signals({ gapRecorded: true }));
  assert.equal(coincidence.learnerFromMonitor, false);
  assert.doesNotMatch(coincidence.summary, /because of that judgement/);
});

test('an intervention that taught nothing does not count as a closed loop', () => {
  assert.equal(judgeTask(signals({ criticBlocked: true })).learnerFromMonitor, false);
});

test('turns are never negative or fractional', () => {
  assert.equal(judgeTask(signals({ turns: -3 })).doerTurns, 0);
  assert.equal(judgeTask(signals({ turns: 2.7 })).doerTurns, 2);
  assert.equal(judgeTask(signals({ turns: NaN })).doerTurns, 0);
});

test('the summary is always a readable sentence', () => {
  for (const over of [{}, { refused: true }, { replyProduced: false }, { criticBlocked: true }]) {
    const s = judgeTask(signals(over)).summary;
    assert.ok(s.length > 30 && s.endsWith('.'), `unreadable: "${s}"`);
  }
});

// ── Reading it across many tasks ────────────────────────────────────────────

const row = (over: Partial<{
  monitorVerdict: 'passed' | 'revised' | 'blocked' | 'skipped';
  doerOutcome: 'replied' | 'failed' | 'refused' | 'escalated';
  learnerFromMonitor: boolean; monitorUsedModel: boolean;
}> = {}) => ({
  monitorVerdict: 'passed' as const,
  doerOutcome: 'replied' as const,
  learnerFromMonitor: false,
  monitorUsedModel: false,
  ...over,
});

test('HONESTY: no rate is quoted from a handful of tasks', () => {
  const s = summariseSupervision([row(), row({ monitorVerdict: 'blocked' })]);
  assert.equal(s.interventionRatePct, null, 'null, not 50% from two tasks');
  assert.equal(s.tasks, 2);
  assert.match(s.headline, /Too few/);
});

test('with a real sample the rates are stated', () => {
  const rows = [
    ...Array.from({ length: 8 }, () => row()),
    ...Array.from({ length: 2 }, () => row({ monitorVerdict: 'blocked' })),
  ];
  const s = summariseSupervision(rows);
  assert.equal(s.tasks, 10);
  assert.equal(s.monitorIntervened, 2);
  assert.equal(s.interventionRatePct, 20);
});

test('THE DENOMINATOR: loop closure is measured over INTERVENTIONS, not tasks', () => {
  // 12 interventions, 6 of which taught something = 50%.
  // Over all 100 tasks it would read 6%, which measures how rarely the monitor
  // has to act — a different and much more flattering question.
  const rows = [
    ...Array.from({ length: 88 }, () => row()),
    ...Array.from({ length: 6 }, () => row({ monitorVerdict: 'blocked', learnerFromMonitor: true })),
    ...Array.from({ length: 6 }, () => row({ monitorVerdict: 'blocked' })),
  ];
  const s = summariseSupervision(rows);
  assert.equal(s.monitorIntervened, 12);
  assert.equal(s.loopClosedPct, 50, 'must be 6/12, not 6/100');
});

test('loop closure is withheld until there are enough interventions to mean it', () => {
  const rows = Array.from({ length: 50 }, () => row());
  rows[0] = row({ monitorVerdict: 'blocked', learnerFromMonitor: true });
  const s = summariseSupervision(rows);
  assert.equal(s.loopClosedPct, null, 'one intervention is not a 100% closure rate');
});

test('an empty ledger reports nothing, not zero percent', () => {
  const s = summariseSupervision([]);
  assert.equal(s.interventionRatePct, null);
  assert.equal(s.tasks, 0);
});
