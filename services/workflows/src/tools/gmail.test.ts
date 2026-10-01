import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractSignatureFields } from './gmail.js';

test('extracts a labeled phone number and a title line from a signature', () => {
  const body = [
    'Thanks for the quick turnaround on this.',
    '',
    'Best,',
    'Jordan Lee',
    'Director of Operations',
    'Phone: +1 (415) 555-0199',
    'Acme Corp',
  ].join('\n');
  const result = extractSignatureFields(body);
  assert.equal(result.phone, '+1 (415) 555-0199');
  assert.equal(result.title, 'Director of Operations');
});

test('falls back to a bare phone number when no label is present', () => {
  const body = ['See you then.', '', 'Sam', '415-555-0134'].join('\n');
  const result = extractSignatureFields(body);
  assert.equal(result.phone, '415-555-0134');
});

test('returns nothing when the body has no signature block', () => {
  const result = extractSignatureFields('Sounds good, talk soon.');
  assert.equal(result.phone, undefined);
  assert.equal(result.title, undefined);
});

test('empty body returns an empty result', () => {
  assert.deepEqual(extractSignatureFields(''), {});
});
