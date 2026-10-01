import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifySignalText, signalsFromSearchHits } from './signals.js';

test('classifySignalText maps hiring funding leadership', () => {
  assert.equal(classifySignalText('Hiring 8 account executives for the sales team'), 'hiring');
  assert.equal(classifySignalText('Raised a Series B funding round'), 'funding');
  assert.equal(classifySignalText('Appointed a new VP Sales last week'), 'leadership');
  assert.equal(classifySignalText('Announced a product update'), 'news');
});

test('signalsFromSearchHits keeps url domain and summary', () => {
  const signals = signalsFromSearchHits([
    {
      title: 'Acme is hiring a sales team',
      url: 'https://www.acme.com/careers',
      snippet: 'Open roles on the sales team',
    },
  ]);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].companyDomain, 'acme.com');
  assert.equal(signals[0].signalType, 'hiring');
  assert.match(signals[0].summary, /hiring/i);
});
