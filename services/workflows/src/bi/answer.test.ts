import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnswer } from './answer.js';
import { verifyAnswer } from './numbers.js';
import { computeAll } from './gold.js';

const computed = computeAll();

test('answers from a computed value, with show-work and a verifiable text', () => {
  const a = buildAnswer('How much is overdue?', computed);
  assert.match(a.text, /₹18,02,500/);
  assert.equal(a.confidence, 'high');
  assert.equal(a.showWork.length, 1);
  assert.match(a.showWork[0].query, /^SELECT/);
  assert.ok(verifyAnswer(a.text, computed).ok);
});

test('hinglish question gets a hinglish answer', () => {
  assert.match(buildAnswer('Kitne invoice overdue hain?', computed).text, /overdue hain/);
});

test('unknown question: low confidence, plain refusal, no numbers', () => {
  const a = buildAnswer('What is my profit margin?', computed);
  assert.equal(a.confidence, 'low');
  assert.match(a.text, /can't compute that yet/);
  assert.equal(a.showWork.length, 0);
});

test('metric known but not computed: refuses instead of guessing', () => {
  const a = buildAnswer('How much is overdue?', computed.filter((c) => c.id !== 'overdue_total'));
  assert.equal(a.confidence, 'low');
  assert.match(a.text, /can't compute that yet/);
});

test('time words drop confidence and say so', () => {
  const a = buildAnswer('How much is overdue last month?', computed);
  assert.equal(a.confidence, 'medium');
  assert.ok(a.caveats.some((c) => /not interpreted/.test(c)));
});

test('zero result is flagged', () => {
  const zero = computed.map((c) => (c.id === 'overdue_count' ? { ...c, value: 0 } : c));
  assert.equal(buildAnswer('How many invoices are overdue?', zero).confidence, 'medium');
});
