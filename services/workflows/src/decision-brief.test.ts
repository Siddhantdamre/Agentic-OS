import test from 'node:test';
import assert from 'node:assert';
import {
  buildDecisionBrief,
  renderDecisionBrief,
  materiallyDiffers,
  type InternalFact,
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
