import test from 'node:test';
import assert from 'node:assert';
import {
  canonicalUnit,
  sameUnit,
  toBase,
  buildDecisionBrief,
  renderDecisionBrief,
  materiallyDiffers,
  type InternalFact,
  dedupeInternalFacts,
} from './decision-brief';
import type { ResearchReport, ResearchSource } from './market-research';

const src = (url: string, title = ''): ResearchSource =>
  ({ url, title, publisher: '', retrievedAt: '' } as unknown as ResearchSource);

function report(over: Partial<ResearchReport> = {}): ResearchReport {
  return {
    topic: 'booking amounts in Thane',
    findings: [],
    rejected: [],
    domainsConsulted: [],
    openQuestions: [],
    ...over,
  } as ResearchReport;
}

/** An external finding carrying a comparable number. */
function extNum(subject: string, value: number, urls: string[], confidence = 'corroborated') {
  return {
    claim: `${subject} is ${value}`,
    sources: urls.map((u) => src(u)),
    independentSourceCount: urls.length,
    confidence,
    caveat: 'Reported by outside sources.',
    subject,
    value,
  } as never;
}

// ── THE RULE THAT MATTERS MOST ───────────────────────────────────────────────
//
// A model handed "market says 2%" and "you charge 5%" will produce a smooth
// paragraph recommending 3.5%. That figure is supported by nothing, and it
// reads exactly like the well-supported ones. A disagreement is a FINDING.

test('a disagreement is surfaced, never averaged', () => {
  const brief = buildDecisionBrief({
    question: 'Is my booking amount competitive?',
    internal: [{ claim: 'We charge 51000', source: 'booking-policy.txt', subject: 'booking amount', value: 51000, unit: 'INR' }],
    research: report({ findings: [extNum('booking amount', 25000, ['https://a.com'])] }),
  });

  assert.equal(brief.verdict.kind, 'conflict');
  const f = brief.findings.find((x) => x.basis === 'conflict');
  assert.ok(f, 'expected a conflict finding');
  // BOTH numbers present, and no third number anywhere.
  assert.match(f.claim, /51000/);
  assert.match(f.claim, /25000/);
  const rendered = renderDecisionBrief(brief);
  assert.ok(!/38000|38,000/.test(rendered), 'must not invent a midpoint');
  assert.match(rendered, /^NO SINGLE ANSWER/);
});

test('a conflict blocks the recommendation even when other points agree', () => {
  const brief = buildDecisionBrief({
    question: 'Should I change my terms?',
    internal: [
      { claim: 'refund window 7 days', source: 'policy.txt', subject: 'refund window', value: 7, unit: 'days' },
      { claim: 'booking 51000', source: 'policy.txt', subject: 'booking amount', value: 51000, unit: 'INR' },
    ],
    research: report({
      findings: [
        extNum('refund window', 7, ['https://a.com']),
        extNum('booking amount', 20000, ['https://b.com']),
      ],
    }),
  });
  // One point agrees, one disagrees. The disagreement wins.
  assert.equal(brief.verdict.kind, 'conflict');
  assert.ok(brief.findings.some((f) => f.basis === 'both'));
});

// ── NO RECOMMENDATION FROM ONE SIDE ONLY ─────────────────────────────────────

test('market data with no internal data withholds the recommendation', () => {
  const brief = buildDecisionBrief({
    question: 'Is my pricing competitive?',
    internal: [],
    research: report({ findings: [extNum('booking amount', 25000, ['https://a.com'])] }),
  });
  assert.equal(brief.verdict.kind, 'withheld');
  if (brief.verdict.kind === 'withheld') assert.equal(brief.verdict.missing, 'internal');
  assert.match(renderDecisionBrief(brief), /^NO RECOMMENDATION/);
});

test('internal data with no market data withholds the recommendation', () => {
  const brief = buildDecisionBrief({
    question: 'Is my pricing competitive?',
    internal: [{ claim: 'We charge 51000', source: 'policy.txt', subject: 'booking amount', value: 51000 }],
    research: report(),
  });
  assert.equal(brief.verdict.kind, 'withheld');
  if (brief.verdict.kind === 'withheld') assert.equal(brief.verdict.missing, 'external');
});

test('both sides present but nothing comparable still withholds', () => {
  // The trap case: plenty of findings, none about the same measurable thing.
  // A brief that recommended here would be reasoning from adjacency.
  const brief = buildDecisionBrief({
    question: 'Should I change anything?',
    internal: [{ claim: 'Site visits run Mon-Sat', source: 'policy.txt' }],
    research: report({ findings: [extNum('stamp duty', 7, ['https://a.com'])] }),
  });
  assert.equal(brief.verdict.kind, 'withheld');
  assert.ok(brief.findings.some((f) => f.basis === 'internal'));
  assert.ok(brief.findings.some((f) => f.basis === 'external'));
  assert.equal(brief.findings.filter((f) => f.basis === 'both').length, 0);
});

test('agreement on a comparable point does yield a recommendation', () => {
  const brief = buildDecisionBrief({
    question: 'Is my refund window normal?',
    internal: [{ claim: '7 day refund', source: 'policy.txt', subject: 'refund window', value: 7, unit: 'days' }],
    research: report({ findings: [extNum('refund window', 7, ['https://a.com', 'https://b.com'])] }),
  });
  assert.equal(brief.verdict.kind, 'recommendation');
  if (brief.verdict.kind === 'recommendation') assert.equal(brief.verdict.restsOn.length, 1);
});

// ── PROVENANCE OR NOTHING ────────────────────────────────────────────────────

test('an internal fact with no source is dropped and reported', () => {
  const brief = buildDecisionBrief({
    question: 'q',
    internal: [
      { claim: 'We are the cheapest in Thane', source: '' } as InternalFact,
      { claim: 'Booking is 51000', source: 'policy.txt' },
    ],
    research: report(),
  });
  assert.ok(!brief.findings.some((f) => /cheapest/.test(f.claim)), 'unsourced claim must not appear as a finding');
  assert.ok(brief.rejected.some((r) => /cheapest/.test(r.claim)), 'and must be reported, not silently dropped');
});

test('an external finding with no sources never becomes a finding', () => {
  const brief = buildDecisionBrief({
    question: 'q',
    internal: [{ claim: 'x', source: 'policy.txt' }],
    research: report({
      findings: [{ claim: 'unsourced market claim', sources: [], independentSourceCount: 0, confidence: 'single_source', caveat: '' } as never],
    }),
  });
  assert.ok(!brief.findings.some((f) => /unsourced market claim/.test(f.claim)));
});

// ── THE VERDICT IS ALWAYS FIRST ──────────────────────────────────────────────

test('a reader who stops after one line is never misled', () => {
  // People stop after one paragraph. Every shape must lead with its verdict.
  const shapes = [
    buildDecisionBrief({ question: 'q', internal: [], research: report() }),
    buildDecisionBrief({
      question: 'q',
      internal: [{ claim: 'a', source: 's', subject: 'x', value: 1 }],
      research: report({ findings: [extNum('x', 100, ['https://a.com'])] }),
    }),
    buildDecisionBrief({
      question: 'q',
      internal: [{ claim: 'a', source: 's', subject: 'x', value: 10 }],
      research: report({ findings: [extNum('x', 10, ['https://a.com'])] }),
    }),
  ];
  for (const b of shapes) {
    const first = renderDecisionBrief(b).split('\n')[0];
    assert.match(first, /^(ANSWER|NO SINGLE ANSWER|NO RECOMMENDATION) —/, first);
  }
});

// ── THE COMPARISON ITSELF ────────────────────────────────────────────────────

test('materiallyDiffers uses a relative threshold', () => {
  assert.equal(materiallyDiffers(100, 100), false);
  assert.equal(materiallyDiffers(100, 105), false, '5% apart is noise');
  assert.equal(materiallyDiffers(100, 200), true);
  assert.equal(materiallyDiffers(51000, 25000), true);
  // Zero must not divide.
  assert.equal(materiallyDiffers(0, 0), false);
  assert.equal(materiallyDiffers(0, 10), true);
  // Non-numbers never manufacture a conflict.
  assert.equal(materiallyDiffers(NaN, 10), false);
  assert.equal(materiallyDiffers(Infinity, 10), false);
});

test('subjects are matched loosely on wording but not across topics', () => {
  const agree = buildDecisionBrief({
    question: 'q',
    internal: [{ claim: 'x', source: 's', subject: 'Booking Amount', value: 7 }],
    research: report({ findings: [extNum('booking  amount', 7, ['https://a.com'])] }),
  });
  assert.ok(agree.findings.some((f) => f.basis === 'both'), 'case and spacing must not prevent a pairing');

  const unrelated = buildDecisionBrief({
    question: 'q',
    internal: [{ claim: 'x', source: 's', subject: 'booking amount', value: 7 }],
    research: report({ findings: [extNum('stamp duty', 7, ['https://a.com'])] }),
  });
  assert.equal(unrelated.findings.filter((f) => f.basis === 'both').length, 0,
    'two unrelated things at the same number is a coincidence, not corroboration');
});

test('a claim with no number is never paired, however well it matches', () => {
  // Pairing needs a comparable figure. Prose about the same subject cannot
  // corroborate a number, and treating it as though it could is how a brief
  // ends up claiming market support it does not have.
  const brief = buildDecisionBrief({
    question: 'q',
    internal: [{ claim: 'Our booking amount is refundable', source: 's', subject: 'booking amount' }],
    research: report({ findings: [extNum('booking amount', 25000, ['https://a.com'])] }),
  });
  assert.equal(brief.findings.filter((f) => f.basis === 'both' || f.basis === 'conflict').length, 0);
  assert.ok(brief.findings.some((f) => f.basis === 'internal'));
  assert.ok(brief.findings.some((f) => f.basis === 'external'));
});

test('open questions from the research survive into the brief', () => {
  const brief = buildDecisionBrief({
    question: 'q',
    internal: [{ claim: 'a', source: 's' }],
    research: report({ openQuestions: ['Nobody publishes Thane broker commissions'] }),
  });
  assert.deepEqual(brief.openQuestions, ['Nobody publishes Thane broker commissions']);
  assert.match(renderDecisionBrief(brief), /Could not be established by either side/);
});

test('the evidence base is counted, not claimed', () => {
  const brief = buildDecisionBrief({
    question: 'q',
    internal: [
      { claim: 'a', source: 'policy.txt' },
      { claim: 'b', source: 'conversations' },
      { claim: 'c', source: 'policy.txt' },
    ],
    research: report({
      findings: [
        extNum('x', 1, ['https://a.com/1', 'https://a.com/2']),
        extNum('y', 2, ['https://b.com/1']),
      ],
    }),
  });
  assert.equal(brief.internalSourceCount, 2, 'policy.txt twice is one record');
  assert.equal(brief.externalDomainCount, 2, 'two pages on a.com is one publisher');
});

// -- Duplicates ------------------------------------------------------------
//
// Memory holds a fact once per row it appears in: the upload, the conversation
// that quoted it, the write-back summary. One live brief listed the booking
// amount four times. All true, all one fact - and repetition reads as
// corroboration, which it is not.

test('the same fact from several rows collapses to one', () => {
  const out = dedupeInternalFacts([
    { claim: 'The booking amount to hold a flat is 51000.', source: 'upload', subject: 'booking amount', value: 51000 },
    { claim: 'The booking amount to hold a unit is 51000, fully refundable within 7 days.', source: 'conversation', subject: 'booking amount', value: 51000 },
    { claim: 'Booking is 51000.', source: 'tool', subject: 'booking amount', value: 51000 },
  ]);
  assert.equal(out.length, 1);
  // The longest wording survives, because it carries the most detail.
  assert.match(out[0].claim, /fully refundable/);
  // Provenance is merged, never lost.
  assert.match(out[0].source, /upload/);
  assert.match(out[0].source, /conversation/);
});

test('the same subject with DIFFERENT numbers is not a duplicate', () => {
  // That is a real inconsistency in the records. Collapsing it would hide the
  // fact that the business contradicts itself.
  const out = dedupeInternalFacts([
    { claim: 'Booking is 51000.', source: 'upload', subject: 'booking amount', value: 51000 },
    { claim: 'Booking is 25000.', source: 'old-policy', subject: 'booking amount', value: 25000 },
  ]);
  assert.equal(out.length, 2);
});

test('unrelated non-numeric facts are all kept', () => {
  const out = dedupeInternalFacts([
    { claim: 'Site visits run Monday to Saturday.', source: 'upload' },
    { claim: 'Sunday visits are by appointment.', source: 'upload' },
    { claim: 'Station pickup is free.', source: 'upload' },
  ]);
  assert.equal(out.length, 3);
});

test('deduping runs inside the brief, so four rows are one finding', () => {
  const brief = buildDecisionBrief({
    question: 'What is our booking amount?',
    internal: [
      { claim: 'Booking is 51000.', source: 'upload', subject: 'booking amount', value: 51000 },
      { claim: 'The booking amount to hold a flat is 51000 and is refundable.', source: 'conversation', subject: 'booking amount', value: 51000 },
      { claim: 'Booking 51000.', source: 'tool', subject: 'booking amount', value: 51000 },
      { claim: 'Booking is 51000.', source: 'upload', subject: 'booking amount', value: 51000 },
    ],
    research: null,
  });
  assert.equal(brief.findings.filter((f) => f.basis === 'internal').length, 1,
    'one fact, however many rows hold it');
});

test('a percent is never compared against a currency', () => {
  // Before: rendered as "your records say 2 percent, the market says 150000
  // percent" - a number nobody wrote, in a unit nobody used, shown to an owner
  // as a disagreement to act on.
  const brief = buildDecisionBrief({
    question: 'What should our commission be?',
    internal: [{ claim: 'Our commission is 2 percent.', source: 'policy.pdf', subject: 'commission', value: 2, unit: 'percent' }],
    research: {
      findings: [{ claim: 'Market fee is 150000 INR.', subject: 'commission', value: 150000, unit: 'INR', confidence: 'medium', sources: [src('https://x.test/a', 'A')] }],
      openQuestions: [], sources: [src('https://x.test/a', 'A')],
    } as unknown as ResearchReport,
  });
  assert.equal(brief.findings.filter((f) => f.basis === 'conflict').length, 0);
  assert.ok(!JSON.stringify(brief).includes('150000 percent'));
  // Not silently dropped either - the reader is told they were not compared.
  assert.ok(brief.openQuestions.some((q) => /NOT compared/i.test(q)), JSON.stringify(brief.openQuestions));
});

test('lakh and rupees are the same money', () => {
  const brief = buildDecisionBrief({
    question: 'Is our booking amount right?',
    internal: [{ claim: 'Booking is Rs 51,000.', source: 'terms.pdf', subject: 'booking amount', value: 51000, unit: 'INR' }],
    research: {
      findings: [{ claim: 'Typical booking 0.51 lakh.', subject: 'booking amount', value: 0.51, unit: 'lakh', confidence: 'medium', sources: [src('https://x.test/b', 'B')] }],
      openQuestions: [], sources: [src('https://x.test/b', 'B')],
    } as unknown as ResearchReport,
  });
  assert.ok(brief.findings.some((f) => f.basis === 'both'), JSON.stringify(brief.findings.map((f) => f.basis)));
});

test('unit canonicalisation and scale conversion', () => {
  assert.equal(canonicalUnit('Rs').unit, 'inr');
  assert.equal(canonicalUnit('%').unit, 'percent');
  assert.equal(canonicalUnit('sq ft').unit, 'sqft');
  assert.equal(toBase(0.51, 'lakh'), 51000);
  assert.equal(toBase(2, 'crore'), 2e7);
  // An unlabelled figure cannot prove a mismatch, so it stays comparable.
  assert.equal(sameUnit('INR', undefined), true);
  assert.equal(sameUnit('percent', 'INR'), false);
  assert.equal(sameUnit('lakh', 'INR'), true);
});

test('the brief tells the reader how old its own records are', () => {
  const stale = new Date(Date.now() - 400 * 86400000).toISOString();
  const brief = buildDecisionBrief({
    question: 'Are our prices competitive?',
    internal: [{ claim: 'List price is 45000.', source: 'pricelist.pdf' }],
    internalAsOf: { newest: stale, oldest: stale, stale: 1, total: 1 },
    research: null,
  });
  assert.ok(brief.freshness, 'freshness missing');
  assert.match(brief.freshness!.note, /months ago/);
  // And it must be visible near the top, not buried at the end.
  const head = renderDecisionBrief(brief).slice(0, 400);
  assert.match(head, /months ago/);
});

test('no dates supplied means the brief claims nothing about freshness', () => {
  const brief = buildDecisionBrief({
    question: 'Are our prices competitive?',
    internal: [{ claim: 'List price is 45000.', source: 'pricelist.pdf' }],
    research: null,
  });
  assert.equal(brief.freshness, undefined);
});

test('unreadable records are never reported as empty records', () => {
  // The caller used to do `catch { internal = []; }`, so a database timeout
  // produced a brief telling the owner "this workspace holds no data of its
  // own on the question" — false, and it sent them off to upload records they
  // already had, in response to an outage nobody mentioned.
  const research = {
    findings: [{ claim: 'Market rate is 50000 INR.', subject: 'rate', value: 50000,
      unit: 'INR', confidence: 'medium', sources: [src('https://x.test/a', 'A')] }],
    openQuestions: [], sources: [src('https://x.test/a', 'A')],
  } as unknown as ResearchReport;

  const dead = buildDecisionBrief({
    question: 'What should we charge?', internal: [], research,
    degraded: { internal: 'connection timeout' },
  });
  assert.equal(dead.verdict.kind, 'withheld');
  const deadReason = dead.verdict.kind === 'withheld' ? dead.verdict.reason : '';
  assert.ok(!/holds no data of its own|upload the relevant/i.test(deadReason), deadReason);
  assert.match(deadReason, /could NOT BE READ/i);
  assert.equal(dead.unavailable?.internal, 'connection timeout');
  // And the reader is told before anything else.
  assert.match(renderDecisionBrief(dead), /INCOMPLETE —/);

  // A side that genuinely returned nothing keeps its original wording: that is
  // a real finding about the business and must not be softened into an outage.
  const empty = buildDecisionBrief({ question: 'What should we charge?', internal: [], research });
  const emptyReason = empty.verdict.kind === 'withheld' ? empty.verdict.reason : '';
  assert.match(emptyReason, /holds no data of its own/i);
  assert.equal(empty.unavailable, undefined);
  assert.ok(!/INCOMPLETE/.test(renderDecisionBrief(empty)));
});

test('both halves unreadable does not claim nothing was found', () => {
  const brief = buildDecisionBrief({
    question: 'q', internal: [], research: null,
    degraded: { internal: 'db down', external: 'search failed' },
  });
  assert.equal(brief.verdict.kind, 'withheld');
  const reason = brief.verdict.kind === 'withheld' ? brief.verdict.reason : '';
  assert.ok(!/nothing was found on either side/i.test(reason), reason);
  // "Neither side could be read" carries its negation in "Neither".
  assert.match(reason, /neither side could be read/i);
  assert.match(reason, /nothing was searched/i);
});
