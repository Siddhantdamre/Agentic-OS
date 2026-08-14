import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchListings, parseBudget, parseBhk } from './match.js';
import type { ListingRecord } from './types.js';

const ORG_A: ListingRecord[] = [
  {
    id: 'SH-KOR-2BHK-01',
    orgId: 'org-a',
    source: 'sheets',
    sourceRef: 'SH-KOR-2BHK-01',
    title: '2BHK Koramangala',
    locality: 'Koramangala',
    city: 'Bengaluru',
    bhk: 2,
    listPrice: 11_000_000,
    currency: 'INR',
    reraId: null,
    status: 'active',
    lastSourceSyncAt: '2026-08-01T00:00:00.000Z',
  },
  {
    id: 'SH-KOR-3BHK-02',
    orgId: 'org-a',
    source: 'sheets',
    sourceRef: 'SH-KOR-3BHK-02',
    title: '3BHK Koramangala',
    locality: 'Koramangala',
    city: 'Bengaluru',
    bhk: 3,
    listPrice: 18_000_000,
    currency: 'INR',
    reraId: null,
    status: 'active',
    lastSourceSyncAt: '2026-08-01T00:00:00.000Z',
  },
];

test('parseBudget understands 1.2 Cr', () => {
  assert.equal(parseBudget('1.2 Cr'), 12_000_000);
  assert.equal(parseBhk('2BHK'), 2);
});

test('2BHK Koramangala under 1.2 Cr returns only matching sheet rows', () => {
  const hits = matchListings(ORG_A, {
    bhk: 2,
    locality: 'Koramangala',
    maxPrice: parseBudget('1.2 Cr') ?? undefined,
  });
  assert.deepEqual(hits.map((r) => r.id), ['SH-KOR-2BHK-01']);
});

test('zero matches does not invent a listing id', () => {
  const hits = matchListings(ORG_A, { bhk: 2, locality: 'Whitefield', maxPrice: 4_000_000 });
  assert.equal(hits.length, 0);
  assert.ok(!hits.some((r) => r.id === 'LST-FAKE-88'));
});

test('unknown price cannot match a maxPrice filter', () => {
  const unknown: ListingRecord = { ...ORG_A[0], id: 'SH-UNK', sourceRef: 'SH-UNK', listPrice: null };
  const hits = matchListings([unknown], { maxPrice: 12_000_000 });
  assert.equal(hits.length, 0);
});
