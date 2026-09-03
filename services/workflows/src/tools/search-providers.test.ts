/**
 * The parser is the part that can silently rot: DuckDuckGo can change its HTML
 * any week, and the failure mode is not a crash — it is zero results, which
 * reads exactly like "the internet had nothing on that". These tests pin the
 * shape against a captured real response so a layout change fails loudly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDuckDuckGoLite,
  KEYLESS_SEARCH_PROVIDERS,
  searchWeb,
  looksRelevant,
} from './search-providers.js';

/** Captured verbatim from lite.duckduckgo.com on 3 September 2026. */
const REAL_HTML = `
<table>
  <tr><td valign="top">1.&nbsp;</td>
    <td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fcleartax.in%2Fs%2Fstamp%2Dduty%2Din%2Dmaharashtra&amp;rut=71ad26" class='result-link'>Stamp Duty &amp; Registration Charges in Maharashtra 2026</a></td>
  </tr>
  <tr><td>&nbsp;</td>
    <td class='result-snippet'>The <b>Maharashtra</b> <b>Stamp</b> <b>Duty</b> Act of 1958 governs stamp duty.</td>
  </tr>
  <tr><td valign="top">2.&nbsp;</td>
    <td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Figrmaharashtra.gov.in%2F&amp;rut=aa11" class='result-link'>IGR Maharashtra</a></td>
  </tr>
  <tr><td>&nbsp;</td>
    <td class='result-snippet'>Department of Registration &amp; Stamps.</td>
  </tr>
</table>`;

test('extracts the real destination, never the redirector', () => {
  const rows = parseDuckDuckGoLite(REAL_HTML, 5);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].url, 'https://cleartax.in/s/stamp-duty-in-maharashtra');
  assert.equal(rows[1].url, 'https://igrmaharashtra.gov.in/');
  for (const r of rows) {
    assert.ok(!r.url.includes('duckduckgo.com'), `cited the redirector: ${r.url}`);
  }
});

test('decodes entities and strips the bold tags DDG wraps query terms in', () => {
  const rows = parseDuckDuckGoLite(REAL_HTML, 5);
  assert.equal(rows[0].title, 'Stamp Duty & Registration Charges in Maharashtra 2026');
  assert.equal(rows[0].snippet, 'The Maharashtra Stamp Duty Act of 1958 governs stamp duty.');
  assert.ok(!rows[0].snippet.includes('<b>'));
});

test('pairs each snippet with its own result, not the previous one', () => {
  const rows = parseDuckDuckGoLite(REAL_HTML, 5);
  assert.equal(rows[1].snippet, 'Department of Registration & Stamps.');
});

test('honours the limit', () => {
  assert.equal(parseDuckDuckGoLite(REAL_HTML, 1).length, 1);
});

test('a layout change yields zero rows rather than garbage rows', () => {
  // If DDG renames the class, we must return nothing — never a row whose url
  // is a fragment of markup that an agent would then try to cite.
  const changed = REAL_HTML.replace(/result-link/g, 'result__a');
  assert.deepEqual(parseDuckDuckGoLite(changed, 5), []);
});

test('drops a row whose destination cannot be recovered', () => {
  const noUddg = `<a href="//duckduckgo.com/l/?rut=xyz" class='result-link'>Untraceable</a>`;
  assert.deepEqual(parseDuckDuckGoLite(noUddg, 5), []);
});

test('accepts a bare absolute href with no redirector', () => {
  const direct = `<a href="https://example.gov.in/notice" class='result-link'>Notice</a>`;
  const rows = parseDuckDuckGoLite(direct, 5);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, 'https://example.gov.in/notice');
});

test('every parsed row names the provider that produced it', () => {
  for (const r of parseDuckDuckGoLite(REAL_HTML, 5)) {
    assert.equal(r.provider, 'duckduckgo');
  }
});

test('the chain has a floor that needs no credential', () => {
  assert.ok(KEYLESS_SEARCH_PROVIDERS.length >= 1);
  assert.ok(KEYLESS_SEARCH_PROVIDERS.includes('duckduckgo'));
});

test('an empty query short-circuits without touching the network', async () => {
  const out = await searchWeb('   ');
  assert.deepEqual(out.results, []);
  assert.equal(out.provider, null);
  assert.deepEqual(out.attempts, []);
});

// ── Relevance ───────────────────────────────────────────────────────────────
// Wikipedia always returns its nearest article, however far away. Measured: it
// answered "Maharashtra ready reckoner rate hike 2026" with "One Rank, One
// Pension" — real title, real URL, real snippet, and an agent would have cited
// it. These pin the guard that drops rows like that.

test('rejects the real irrelevant result Wikipedia returned', () => {
  assert.equal(
    looksRelevant('Maharashtra ready reckoner rate hike 2026', {
      title: 'One Rank, One Pension',
      snippet: 'a demand of Indian ex-servicemen for a uniform pension',
    }),
    false
  );
});

test('rejects the real irrelevant results that one matching term let through', () => {
  // Wikipedia answered "best CRM for Indian real estate brokers" with these.
  // Every one matched on the single word "Indian".
  for (const row of [
    { title: 'Cognizant', snippet: 'an American multinational with a large Indian workforce' },
    { title: 'IBM', snippet: 'International Business Machines, with Indian operations' },
    { title: 'List of unicorn startup companies', snippet: 'includes Indian companies' },
  ]) {
    assert.equal(looksRelevant('best CRM for Indian real estate brokers', row), false, row.title);
  }
});

test('keeps a result matching half the query terms', () => {
  assert.equal(
    looksRelevant('Maharashtra ready reckoner rate', {
      title: 'Ready reckoner rates in Maharashtra',
      snippet: 'published by the state registry',
    }),
    true
  );
});

test('a suffix is the same word; an arbitrary substring is not', () => {
  // "rate" must find "rates" ...
  assert.equal(looksRelevant('stamp duty rate', { title: 'Stamp duty rates', snippet: '' }), true);
  // ... but "real" must not match inside "unrelated".
  assert.equal(
    looksRelevant('real estate broker', { title: 'Unrelated', snippet: 'nothing to do with it' }),
    false
  );
});

test('matches on the snippet when the title alone would miss', () => {
  assert.equal(
    looksRelevant('MahaRERA registration rules', {
      title: 'Housing regulation in India',
      snippet: 'The MahaRERA authority publishes registration requirements.',
    }),
    true
  );
});

test('the bar scales with how specific the question was', () => {
  const row = { title: 'Maharashtra', snippet: 'a state in western India' };
  // Two terms, one match: enough.
  assert.equal(looksRelevant('Maharashtra state', row), true);
  // Eight terms, one match: a coincidence, not a topic.
  assert.equal(
    looksRelevant('Maharashtra ready reckoner rate hike notification circular 2026', row),
    false
  );
});

test('short words never carry relevance on their own', () => {
  // "the", "in", "of" match almost any page. Only terms of four or more
  // characters count, so a stopword overlap cannot smuggle a row through.
  assert.equal(
    looksRelevant('the rate of tax in Thane', { title: 'Cricket', snippet: 'the game of bat and ball in England' }),
    false
  );
});

test('a query with no substantive terms does not filter everything out', () => {
  // Better to return the provider's rows unfiltered than to return nothing at
  // all because the query was two short words.
  assert.equal(looksRelevant('a in of', { title: 'Anything', snippet: 'x' }), true);
});
