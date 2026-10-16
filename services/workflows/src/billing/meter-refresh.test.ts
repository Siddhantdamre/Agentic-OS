import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  METER_UPSERT_SQL,
  meterUpserts,
  meterWindow,
  readOrgMeterReading,
  spendCentsToUsd,
  writeOrgMeters,
  type MeterCaps,
  type OrgMeterReading,
} from './meter-refresh.js';
import { isUsageBlocked, assertUsageAllowed, USAGE_GATE_UNAVAILABLE_MESSAGE } from '../usage-gate.js';

const caps: MeterCaps = {
  llmSoftUsd: 50,
  llmHardUsd: 200,
  whatsappSoft: 500,
  whatsappHard: 2000,
  seatSoft: 5,
  seatHard: 25,
};

const ORG = '00000000-0000-0000-0000-00000000000a';

function reading(over: Partial<OrgMeterReading> = {}): OrgMeterReading {
  return {
    orgId: ORG,
    periodStart: '2026-09-21',
    periodEnd: '2026-09-28',
    whatsappConversations: 10,
    seats: 3,
    llmUsd: 12.5,
    llmSpendAvailable: true,
    ...over,
  };
}

test('meterWindow is a 7-day rolling window in UTC dates', () => {
  const w = meterWindow(new Date('2026-09-28T10:00:00Z'));
  assert.equal(w.periodStart, '2026-09-21');
  assert.equal(w.periodEnd, '2026-09-28');
});

test('spendCentsToUsd keeps sub-cent precision and ignores junk', () => {
  assert.equal(spendCentsToUsd(1250), 12.5);
  assert.equal(spendCentsToUsd(1), 0.01);
  assert.equal(spendCentsToUsd(-5), 0);
  assert.equal(spendCentsToUsd(Number.NaN), 0);
});

test('llm meter is monotonic and sourced from model_spend; others overwrite', () => {
  const rows = meterUpserts(reading(), caps);
  const llm = rows.find((r) => r.kind === 'llm_tokens');
  assert.ok(llm);
  assert.equal(llm.source, 'model_spend');
  assert.equal(llm.monotonic, true);
  assert.equal(llm.hard, 200);
  for (const r of rows.filter((x) => x.kind !== 'llm_tokens')) assert.equal(r.monotonic, false);
  assert.match(METER_UPSERT_SQL, /GREATEST\(billing_meters\.quantity, EXCLUDED\.quantity\)/);
});

test('no llm row when org_model_spend is missing (never writes a fake zero)', () => {
  const rows = meterUpserts(reading({ llmSpendAvailable: false }), caps);
  assert.equal(rows.some((r) => r.kind === 'llm_tokens'), false);
});

test('writeOrgMeters reports hard and soft breaches', async () => {
  const calls: unknown[][] = [];
  const client = { query: async (_sql: string, params: unknown[]) => { calls.push(params); return { rows: [] }; } };
  const res = await writeOrgMeters(
    client as never,
    reading({ llmUsd: 250, whatsappConversations: 600 }),
    caps
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(res.overHard, ['llm_tokens']);
  assert.deepEqual(res.overSoft, ['whatsapp_conversations']);
});

test('readOrgMeterReading sums org_model_spend cents into usd', async () => {
  const client = {
    query: async (sql: string) => {
      if (/org_model_spend/.test(sql)) return { rows: [{ cents: '4321' }] };
      if (/FROM users/.test(sql)) return { rows: [{ count: '4' }] };
      return { rows: [{ count: '7' }] };
    },
  };
  const r = await readOrgMeterReading(client as never, ORG, meterWindow(new Date('2026-09-28T00:00:00Z')));
  assert.equal(r.llmUsd, 43.21);
  assert.equal(r.seats, 4);
  assert.equal(r.whatsappConversations, 7);
  assert.equal(r.llmSpendAvailable, true);
});

test('usage gate fails closed when the meter read errors', async () => {
  delete process.env.DAREX_USAGE_GATE_FAIL_OPEN;
  const gate = await isUsageBlocked(ORG, {
    readReasons: async () => {
      throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    },
  });
  assert.equal(gate.blocked, true);
  assert.equal(gate.reasons[0]?.kind, 'gate_unavailable');
});

test('usage gate allows when billing_meters table is missing (partial migrations)', async () => {
  const gate = await isUsageBlocked(ORG, {
    readReasons: async () => {
      throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
    },
  });
  assert.equal(gate.blocked, false);
});

test('DAREX_USAGE_GATE_FAIL_OPEN=true restores fail-open for local dev', async () => {
  process.env.DAREX_USAGE_GATE_FAIL_OPEN = 'true';
  try {
    const gate = await isUsageBlocked(ORG, {
      readReasons: async () => {
        throw new Error('boom');
      },
    });
    assert.equal(gate.blocked, false);
  } finally {
    delete process.env.DAREX_USAGE_GATE_FAIL_OPEN;
  }
});

test('usage gate blocks over hard cap and allows under it', async () => {
  const blocked = await isUsageBlocked(ORG, {
    readReasons: async () => [
      { kind: 'llm_tokens', quantity: 250, hardLimit: 200, periodStart: null, periodEnd: null },
    ],
  });
  assert.equal(blocked.blocked, true);
  const open = await isUsageBlocked(ORG, { readReasons: async () => [] });
  assert.equal(open.blocked, false);
  assert.equal(typeof USAGE_GATE_UNAVAILABLE_MESSAGE, 'string');
  assert.equal(typeof assertUsageAllowed, 'function');
});
