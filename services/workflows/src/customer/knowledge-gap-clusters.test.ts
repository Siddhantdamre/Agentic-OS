import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clusterGapQuestions } from './knowledge-gap-clusters.js';

test('near-duplicate refund questions cluster together', () => {
  const clusters = clusterGapQuestions([
    { question: 'What is your refund policy?', createdAt: '2026-01-01T00:00:00.000Z' },
    { question: 'What is your refund policy for late orders?', createdAt: '2026-01-02T00:00:00.000Z' },
    { question: 'Whats the refund policy', createdAt: '2026-01-03T00:00:00.000Z' },
  ]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].count, 3);
  assert.ok(clusters[0].examples.length <= 3);
});

test('unrelated questions do not merge', () => {
  const clusters = clusterGapQuestions([
    { question: 'Do you ship to Canada?', createdAt: '2026-01-01T00:00:00.000Z' },
    { question: 'How do I cancel my subscription?', createdAt: '2026-01-01T00:00:00.000Z' },
  ]);
  assert.equal(clusters.length, 2);
  assert.ok(clusters.every((c) => c.count === 1));
});

test('clusters are ranked by count descending', () => {
  const clusters = clusterGapQuestions([
    { question: 'Where is my order?', createdAt: '2026-01-01T00:00:00.000Z' },
    { question: 'Do you offer student discounts?', createdAt: '2026-01-01T00:00:00.000Z' },
    { question: 'Where is my order tracking?', createdAt: '2026-01-02T00:00:00.000Z' },
    { question: 'Where is my order status?', createdAt: '2026-01-03T00:00:00.000Z' },
  ]);
  assert.equal(clusters[0].count, 3);
  assert.equal(clusters[1].count, 1);
});

test('blank questions are dropped', () => {
  const clusters = clusterGapQuestions([
    { question: '   ', createdAt: '2026-01-01T00:00:00.000Z' },
    { question: 'Can I get a refund?', createdAt: '2026-01-01T00:00:00.000Z' },
  ]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].count, 1);
});
