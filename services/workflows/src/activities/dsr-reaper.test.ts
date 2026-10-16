import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dsrStaleMinutes } from './dsr-reaper.js';

test('dsrStaleMinutes defaults to 30 and ignores junk or too-small values', () => {
  assert.equal(dsrStaleMinutes(undefined), 30);
  assert.equal(dsrStaleMinutes(''), 30);
  assert.equal(dsrStaleMinutes('abc'), 30);
  assert.equal(dsrStaleMinutes('4'), 30);
});

test('dsrStaleMinutes honours a valid override, floored', () => {
  assert.equal(dsrStaleMinutes('5'), 5);
  assert.equal(dsrStaleMinutes('45.9'), 45);
});
