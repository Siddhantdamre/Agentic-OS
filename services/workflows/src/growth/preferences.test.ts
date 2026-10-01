import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heuristicRulesFromComment, mergePreferenceRules, parseLlmRules } from './preferences.js';

test('heuristicRulesFromComment extracts headcount floor', () => {
  const rules = heuristicRulesFromComment("Don't target companies this small — under 50 employees");
  assert.equal(rules.length, 1);
  assert.equal(rules[0].field, 'headcount');
  assert.equal(rules[0].op, 'gte');
  assert.equal(rules[0].value, 50);
});

test('heuristicRulesFromComment extracts india-only geo', () => {
  const rules = heuristicRulesFromComment('Never contact companies outside India');
  assert.equal(rules[0].field, 'geo');
  assert.deepEqual(rules[0].value, ['india']);
});

test('parseLlmRules ignores junk and keeps valid filters', () => {
  const rules = parseLlmRules('Sure:\n[{"field":"industry","op":"not_in","value":["agency"]},{"field":"nope","op":"gte"}]');
  assert.equal(rules.length, 1);
  assert.equal(rules[0].field, 'industry');
});

test('mergePreferenceRules dedupes', () => {
  const merged = mergePreferenceRules(
    [{ field: 'headcount', op: 'gte', value: 50 }],
    [{ field: 'headcount', op: 'gte', value: 50 }, { field: 'geo', op: 'in', value: ['india'] }],
  );
  assert.equal(merged.length, 2);
});
