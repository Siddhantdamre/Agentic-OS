import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keywordSuggestsCommitment } from './keyword-prefilter.js';

test('keyword pre-filter catches explicit commitments', () => {
  assert.equal(keywordSuggestsCommitment("I'll send the quote by Friday"), true);
  assert.equal(keywordSuggestsCommitment('we will check the warehouse'), true);
});

test('keyword pre-filter ignores greetings and checking-in', () => {
  assert.equal(keywordSuggestsCommitment('Thanks, checking in on this'), false);
  assert.equal(keywordSuggestsCommitment('Hi, just wanted to say hello'), false);
});
