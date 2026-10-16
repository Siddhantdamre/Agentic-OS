import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyPreferenceFilters, buildIcpProfile, rankCandidates, scoreCandidate } from './lookalike.js';
import type { RankedCandidate } from '@darex/shared-types';

test('buildIcpProfile uses p10–p90 headcount and industry mode', () => {
  const icp = buildIcpProfile([
    { companyName: 'A', industry: 'SaaS', geo: 'india', headcount: 95, techTags: ['hubspot'] },
    { companyName: 'B', industry: 'SaaS', geo: 'india', headcount: 120, techTags: ['hubspot'] },
    { companyName: 'C', industry: 'SaaS', geo: 'india', headcount: 180, techTags: ['salesforce'] },
    { companyName: 'D', industry: 'logistics', geo: 'eu', headcount: 40 },
  ]);
  assert.equal(icp.industries[0], 'saas');
  assert.equal(icp.geos[0], 'india');
  assert.ok(icp.employeeMin >= 40 && icp.employeeMin <= 120);
  assert.ok(icp.employeeMax >= 120);
  assert.equal(icp.sampleSize, 4);
});

test('scoreCandidate weights fit and why-now signals', () => {
  const icp = buildIcpProfile([
    { companyName: 'A', industry: 'SaaS', geo: 'india', headcount: 120, techTags: ['hubspot'] },
  ]);
  const scored = scoreCandidate(
    {
      companyName: 'Acme',
      domain: 'acme.com',
      industry: 'saas',
      geo: 'india',
      headcount: 120,
      techTags: ['hubspot'],
      activeSignals: [
        { type: 'hiring', summary: '8 sales roles', timestamp: '2026-09-01T00:00:00Z' },
        { type: 'intent', summary: 'pricing x3', timestamp: '2026-09-02T00:00:00Z' },
      ],
    },
    icp,
  );
  assert.ok(scored.score >= 70);
  assert.ok(scored.fit > 0.8);
  assert.ok(scored.now >= 0.9);
});

test('preference filters drop instead of down-ranking', () => {
  const icp = {
    industries: ['saas'],
    geos: ['india'],
    employeeMin: 80,
    employeeMax: 200,
    techTags: [],
    decisionMakerTitles: [],
    sampleSize: 1,
  };
  const ranked = rankCandidates(
    [
      {
        companyName: 'Tiny',
        domain: 'tiny.com',
        industry: 'saas',
        geo: 'india',
        headcount: 12,
        activeSignals: [{ type: 'hiring', summary: 'x', timestamp: 't' }],
      },
      {
        companyName: 'Fit',
        domain: 'fit.com',
        industry: 'saas',
        geo: 'india',
        headcount: 110,
        activeSignals: [{ type: 'hiring', summary: 'x', timestamp: 't' }],
      },
    ],
    icp,
    [{ field: 'headcount', op: 'gte', value: 50 }],
  );
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].companyName, 'Fit');
});

test('not_in industry is a hard drop', () => {
  const candidate = {
    companyName: 'Agency',
    domain: 'ag.com',
    industry: 'agency',
    headcount: 80,
    fit: 0.5,
    now: 0.2,
    score: 40,
    activeSignals: [],
  } as RankedCandidate;
  assert.equal(applyPreferenceFilters(candidate, [{ field: 'industry', op: 'not_in', value: ['agency'] }]), false);
});
