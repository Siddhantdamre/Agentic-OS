import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyAccountProfileToState,
  evaluateSentimentTrend,
  inferOperationalState,
  sentimentSeverity,
} from './operational-state.js';
import { emptyAccountProfile } from './account-profile.js';

test('keyword state is unaffected when no account profile is available', () => {
  const state = inferOperationalState({ userMessage: 'this is unresolved' });
  assert.equal(applyAccountProfileToState(state, null), 'unresolved');
});

test('non-VIP account profile does not escalate a negative state', () => {
  const profile = { ...emptyAccountProfile(), vip: false };
  assert.equal(applyAccountProfileToState('frustrated', profile), 'frustrated');
});

test('VIP account with a negative signal is escalated', () => {
  const profile = { ...emptyAccountProfile(), vip: true, vipTags: ['gold'] };
  assert.equal(applyAccountProfileToState('frustrated', profile), 'escalated');
  assert.equal(applyAccountProfileToState('at_risk', profile), 'escalated');
  assert.equal(applyAccountProfileToState('unresolved', profile), 'escalated');
});

test('VIP account with a neutral state is left alone', () => {
  const profile = { ...emptyAccountProfile(), vip: true, vipTags: ['gold'] };
  assert.equal(applyAccountProfileToState('existing', profile), 'existing');
  assert.equal(applyAccountProfileToState('new', profile), 'new');
});

test('sentimentSeverity ranks escalated highest and neutral states at zero', () => {
  assert.equal(sentimentSeverity('escalated'), 4);
  assert.equal(sentimentSeverity('frustrated'), 3);
  assert.equal(sentimentSeverity('at_risk'), 2);
  assert.equal(sentimentSeverity('unresolved'), 2);
  assert.equal(sentimentSeverity('existing'), 0);
  assert.equal(sentimentSeverity('new'), 0);
});

test('a single negative turn does not trigger the sentiment trend alert', () => {
  const trend = evaluateSentimentTrend([{ severity: 3 }, { severity: 0 }, { severity: 0 }]);
  assert.equal(trend.escalate, false);
  assert.equal(trend.negativeCount, 1);
});

test('two of the last three negative turns crosses the trend threshold', () => {
  const trend = evaluateSentimentTrend([{ severity: 3 }, { severity: 2 }, { severity: 0 }]);
  assert.equal(trend.escalate, true);
  assert.equal(trend.negativeCount, 2);
});

test('sentiment trend only looks at the configured window, not the whole history', () => {
  const trend = evaluateSentimentTrend([
    { severity: 0 },
    { severity: 0 },
    { severity: 0 },
    { severity: 4 },
    { severity: 4 },
  ]);
  assert.equal(trend.escalate, false);
  assert.equal(trend.windowSize, 3);
});
