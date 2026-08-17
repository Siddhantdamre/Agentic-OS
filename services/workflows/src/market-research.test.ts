/**
 * Market research tests.
 *
 * A market report gets read once and acted on. These assert that nothing
 * reaches the reader without a real source behind it, and that confidence
 * reflects independent corroboration rather than page count.
 *
 * Run: node --test dist/market-research.test.js
 */
import test from 'node:test';
import assert from 'node:assert';

import {
  validateFindings,
  registrableDomain,
  renderReport,
  buildResearchPrompt,
  type ResearchSource,
} from './market-research';

const retrieved: ResearchSource[] = [
  { url: 'https://www.propnews.in/rent-trends-2026', title: 'Rent trends', snippet: 'Rents rose 8%.', publishedAt: '2026-02-01' },
  { url: 'https://blog.propnews.in/mumbai-update', title: 'Mumbai update', snippet: 'Rents rose 8% in Mumbai.', publishedAt: '2026-02-03' },
  { url: 'https://economictimes.example.com/realty', title: 'Realty report', snippet: 'Rents up around 8%.', publishedAt: '2026-02-05' },
  { url: 'https://housingdata.example.org/q1', title: 'Q1 data', snippet: 'Rental index +8.2%.' },
];

test('SOURCING: a finding with no sources is dropped', () => {
  const r = validateFindings('rents', [{ claim: 'Rents are rising fast' }], retrieved);
  assert.strictEqual(r.findings.length, 0);
  assert.match(r.rejected[0].reason, /no sources/i);
});

test('SOURCING: a fabricated URL is rejected, not trusted', () => {
  // The research equivalent of an invented number: a plausible URL the model
  // never actually read.
  const r = validateFindings(
    'rents',
    [{ claim: 'Rents rose 20%', sources: ['https://totally-real-source.example.com/report'] }],
    retrieved
  );
  assert.strictEqual(r.findings.length, 0);
  assert.match(r.rejected[0].reason, /never retrieved|fabricated/i);
});

test('SOURCING: real citations are kept, fabricated ones stripped from the same claim', () => {
  const r = validateFindings(
    'rents',
    [
      {
        claim: 'Rents rose about 8%',
        sources: ['https://www.propnews.in/rent-trends-2026', 'https://fake.example.com/x'],
      },
    ],
    retrieved
  );
  assert.strictEqual(r.findings.length, 1);
  assert.strictEqual(r.findings[0].sources.length, 1, 'only the real source survives');
});

test('INDEPENDENCE: two pages from one publisher count as ONE source', () => {
  // The core quality rule. propnews.in and blog.propnews.in are the same
  // publisher repeating itself — that is not corroboration.
  const r = validateFindings(
    'rents',
    [
      {
        claim: 'Rents rose 8%',
        sources: ['https://www.propnews.in/rent-trends-2026', 'https://blog.propnews.in/mumbai-update'],
      },
    ],
    retrieved
  );
  assert.strictEqual(r.findings[0].independentSourceCount, 1);
  assert.strictEqual(r.findings[0].confidence, 'single_source');
  assert.match(r.findings[0].caveat, /one source/i);
});

test('INDEPENDENCE: distinct publishers do corroborate', () => {
  const r = validateFindings(
    'rents',
    [
      {
        claim: 'Rents rose 8%',
        sources: ['https://www.propnews.in/rent-trends-2026', 'https://economictimes.example.com/realty'],
      },
    ],
    retrieved
  );
  assert.strictEqual(r.findings[0].independentSourceCount, 2);
  assert.strictEqual(r.findings[0].confidence, 'corroborated');
});

test('three independent publishers reach well_established', () => {
  const r = validateFindings(
    'rents',
    [
      {
        claim: 'Rents rose about 8%',
        sources: [
          'https://www.propnews.in/rent-trends-2026',
          'https://economictimes.example.com/realty',
          'https://housingdata.example.org/q1',
        ],
      },
    ],
    retrieved
  );
  assert.strictEqual(r.findings[0].confidence, 'well_established');
});

test('registrable domain groups subdomains and separates real publishers', () => {
  assert.strictEqual(registrableDomain('https://blog.propnews.in/x'), 'propnews.in');
  assert.strictEqual(registrableDomain('https://www.propnews.in/y'), 'propnews.in');
  assert.strictEqual(registrableDomain('https://news.bbc.co.uk/a'), 'bbc.co.uk');
  assert.notStrictEqual(registrableDomain('https://bbc.co.uk'), registrableDomain('https://guardian.co.uk'));
  assert.strictEqual(registrableDomain('not a url'), '');
});

test('undated sources are flagged as possibly stale', () => {
  const r = validateFindings(
    'rents',
    [{ claim: 'Index up 8.2%', sources: ['https://housingdata.example.org/q1'] }],
    retrieved
  );
  assert.match(r.findings[0].caveat, /undated|out of date/i);
});

test('findings are ordered best-supported first', () => {
  const r = validateFindings(
    'rents',
    [
      { claim: 'weak claim', sources: ['https://www.propnews.in/rent-trends-2026'] },
      {
        claim: 'strong claim',
        sources: [
          'https://www.propnews.in/rent-trends-2026',
          'https://economictimes.example.com/realty',
          'https://housingdata.example.org/q1',
        ],
      },
    ],
    retrieved
  );
  assert.strictEqual(r.findings[0].claim, 'strong claim');
});

test('QUALITY: the rendered report keeps caveats attached to claims', () => {
  const r = validateFindings(
    'rents',
    [{ claim: 'Rents rose 8%', sources: ['https://www.propnews.in/rent-trends-2026'] }],
    retrieved,
    ['Whether the rise continues into Q2']
  );
  const text = renderReport(r);
  assert.match(text, /ONE SOURCE/, 'confidence must be visible next to the claim');
  assert.match(text, /propnews\.in/, 'sources cited inline');
  assert.match(text, /Could not be established/i, 'gaps are surfaced, not hidden');
});

test('QUALITY: an empty report says so plainly rather than padding', () => {
  const r = validateFindings('rents', [{ claim: 'x', sources: [] }], retrieved);
  const text = renderReport(r);
  assert.match(text, /No findings could be supported/i);
  assert.ok(!/ONE SOURCE|CORROBORATED/.test(text));
});

test('SAFETY: malformed model output never throws', () => {
  for (const raw of [null, undefined, [], [{}], [{ claim: 5, sources: 'x' }] as any]) {
    assert.doesNotThrow(() => validateFindings('t', raw as any, retrieved));
  }
});

test('the prompt forbids citing anything not retrieved', () => {
  const p = buildResearchPrompt('rent trends', retrieved);
  assert.match(p, /Never invent a URL/i);
  assert.match(p, /Never cite a URL that is not listed/i);
  assert.match(p, /report that as a separate finding/i, 'disagreement must not be flattened');
});
