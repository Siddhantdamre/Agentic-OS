import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HEALTHY_BRIEF_LINE } from './types.js';
import { buildTriageBrief } from './brief.js';

test('a quiet day is one healthy line, not a dump', () => {
  const brief = buildTriageBrief([]);
  assert.equal(brief.headline, HEALTHY_BRIEF_LINE);
  assert.equal(brief.exceptions.length, 0);
  assert.equal(brief.healthyLine, HEALTHY_BRIEF_LINE);
});

test('filters to at most three exceptions', () => {
  const brief = buildTriageBrief([
    { severity: 'low', title: 'noise', detail: 'ok' },
    { severity: 'critical', title: 'SLA', detail: '3h late' },
    { severity: 'high', title: 'dup', detail: 'review' },
    { severity: 'medium', title: 'phone', detail: 'missing cc' },
  ]);
  assert.equal(brief.exceptions.length, 3);
  assert.equal(brief.exceptions[0].severity, 'critical');
  assert.equal(brief.counts.dropped, 1);
  assert.equal(brief.healthyLine, HEALTHY_BRIEF_LINE);
});
