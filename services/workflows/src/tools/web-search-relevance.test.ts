import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keepRelevantResults } from './web-search.js';

test('drops wikipedia hits that never mention the company', () => {
  const kept = keepRelevantResults('DareX AI founder OR DareX founders', [
    { title: 'Diomedes', url: 'https://en.wikipedia.org/wiki/Diomedes', snippet: 'Greek hero' },
    { title: 'Sanu Shaurya', url: 'https://in.linkedin.com/in/sanu', snippet: 'Founder at DarexAI' },
  ]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].title, 'Sanu Shaurya');
});

test('does not treat a different Darex company as Darex AI', () => {
  const kept = keepRelevantResults('Darex AI founders', [
    { title: 'DareX Solutions', url: 'https://darex-solutions.com', snippet: 'Boutique web studio' },
    { title: 'Darex AI', url: 'https://darexai.com', snippet: 'AI automation' },
  ]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].url, 'https://darexai.com');
});
