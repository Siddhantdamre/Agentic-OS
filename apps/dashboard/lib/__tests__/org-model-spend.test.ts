/**
 * @jest-environment node
 *
 * Tests for model spend accounting & meter refresh (RT-G01).
 * Verifies that:
 * 1. getOrgModelSpend aggregates spend_cents and model_calls from Postgres.
 * 2. refreshOrgMeters uses org_model_spend so cost accounting is never blind
 *    even when Langfuse is down or not configured.
 * 3. Usage cap blocks correctly when org_model_spend exceeds the hard limit.
 */

import { getOrgModelSpend, refreshOrgMeters } from '@/app/api/billing/_lib';

const mockOrgId = '00000000-0000-4000-8000-000000000001';

let mockSpendCents = 15000; // $150.00
let mockModelCalls = 42;
let upsertedMeters: Array<any> = [];

jest.mock('@/lib/org-cost', () => {
  const actual = jest.requireActual('@/lib/org-cost');
  return {
    ...actual,
    fetchOrgWeeklyCost: jest.fn(async () => {
      throw new actual.LangfuseUnavailableError('Langfuse connection refused');
    }),
    queryConfirmRejectDrift: jest.fn(async () => null),
  };
});

jest.mock('@/lib/db', () => ({
  getOrgScopedClient: jest.fn(async () => ({
    client: {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        if (sql.includes('SELECT seat_cap, meter_caps FROM org_plan_overrides')) {
          return { rows: [] };
        }
        if (sql.includes('SELECT COUNT(*)::text AS count FROM conversations')) {
          return { rows: [{ count: '5' }] };
        }
        if (sql.includes('SELECT COUNT(*)::text AS count FROM users')) {
          return { rows: [{ count: '2' }] };
        }
        if (sql.includes('SELECT COALESCE(SUM(spend_cents), 0)::text AS total_cents')) {
          return {
            rows: [
              {
                total_cents: String(mockSpendCents),
                total_calls: String(mockModelCalls),
              },
            ],
          };
        }
        if (sql.includes('INSERT INTO billing_meters')) {
          upsertedMeters.push({ sql, params });
          return { rowCount: 1 };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    },
  })),
  pool: {},
}));

describe('Model Spend Accounting & Meter Refresh (RT-G01)', () => {
  beforeEach(() => {
    upsertedMeters = [];
    mockSpendCents = 15000;
    mockModelCalls = 42;
    process.env.DAREX_METER_LLM_HARD_USD = '100'; // $100 hard cap
  });

  afterEach(() => {
    delete process.env.DAREX_METER_LLM_HARD_USD;
  });

  it('aggregates spend_cents and converts to USD via getOrgModelSpend', async () => {
    const mockClient = {
      query: jest.fn(async () => ({
        rows: [{ total_cents: '7550', total_calls: '15' }],
      })),
    };

    const res = await getOrgModelSpend(mockClient as any, mockOrgId, '2026-09-01');
    expect(res.spendCents).toBe(7550);
    expect(res.spendUsd).toBe(75.5);
    expect(res.modelCalls).toBe(15);
  });

  it('populates llm_tokens meter from org_model_spend when Langfuse is down', async () => {
    const refresh = await refreshOrgMeters(mockOrgId);

    expect(refresh.llmError).toBe('Langfuse connection refused');
    expect(refresh.llm).toBeNull();

    const llmMeter = refresh.meters.find((m) => m.kind === 'llm_tokens');
    expect(llmMeter).toBeDefined();
    expect(llmMeter?.quantity).toBe(150); // $150 from mockSpendCents
    expect(llmMeter?.source).toBe('model_spend');
    expect(llmMeter?.overHard).toBe(true); // $150 >= $100 hard cap

    // Over hard limit triggers usageBlocked = true
    expect(refresh.usageBlocked).toBe(true);

    // Verifies billing_meters table was upserted with org_model_spend values
    const llmUpsert = upsertedMeters.find((u) => u.params[3] === 'llm_tokens');
    expect(llmUpsert).toBeDefined();
    expect(llmUpsert.params[4]).toBe(150); // quantity
    expect(llmUpsert.params[8]).toBe('model_spend'); // source
  });
});
