/**
 * @jest-environment node
 *
 * collectMetricCounts must never emit fake-healthy outboundPerCustomer: 0
 * or invented calibration drift when source tables have no rows.
 * GET metrics prefers a fresh daily snapshot over recompute-and-upsert.
 */

import type { PoolClient } from 'pg';
import {
  collectMetricCounts,
  getOrComputeDailyMetrics,
  loadFreshDailyMetricsSnapshot,
} from '../employee-metrics-query';
import { computeSilentMetrics } from '../employee-observability';

function emptyRow(overrides: Record<string, unknown> = {}) {
  return {
    executed: 0,
    escalated: 0,
    suppressed: 0,
    declined: 0,
    deferred: 0,
    total: 0,
    grounding_rejected: 0,
    grounding_checked: 0,
    total_pending: 0,
    expired: 0,
    decided_ms: [],
    obligations: 0,
    messages: 0,
    open_disc: 0,
    zero_days: 0,
    ...overrides,
  };
}

function mockClient(handler: (sql: string) => { rows: Record<string, unknown>[] }): PoolClient {
  return {
    query: jest.fn(async (sql: string) => handler(sql)),
  } as unknown as PoolClient;
}

describe('collectMetricCounts outbound + calibration', () => {
  it('returns null/null (no-data) when budget and feedback tables have no rows — not fake-healthy 0', async () => {
    const client = mockClient((sql) => {
      if (sql.includes('agent_outbound_budget')) {
        return { rows: [{ max_outbound: null }] };
      }
      if (sql.includes('outcome_feedback')) {
        return { rows: [{ drift: null }] };
      }
      return { rows: [emptyRow()] };
    });

    const counts = await collectMetricCounts(client, 'org-1');
    expect(counts.outboundPerCustomer).toBeNull();
    expect(counts.predictedMinusActual).toBeNull();

    const metrics = computeSilentMetrics(counts);
    const outbound = metrics.find((m) => m.key === 'outbound_per_customer');
    const drift = metrics.find((m) => m.key === 'confidence_calibration_drift');
    expect(outbound?.value).toBeNull();
    expect(outbound?.status).toBe('unknown');
    expect(drift?.value).toBeNull();
    expect(drift?.status).toBe('unknown');
    // Must not look healthy with a fabricated zero.
    expect(outbound?.status).not.toBe('healthy');
  });

  it('returns real aggregates when fixture outbound and feedback rows exist', async () => {
    const client = mockClient((sql) => {
      if (sql.includes('agent_outbound_budget')) {
        return { rows: [{ max_outbound: 11 }] };
      }
      if (sql.includes('outcome_feedback')) {
        return { rows: [{ drift: 0.22 }] };
      }
      return { rows: [emptyRow({ executed: 5, escalated: 5, total: 10 })] };
    });

    const counts = await collectMetricCounts(client, 'org-1');
    expect(counts.outboundPerCustomer).toBe(11);
    expect(counts.predictedMinusActual).toBe(0.22);

    const metrics = computeSilentMetrics(counts);
    const outbound = metrics.find((m) => m.key === 'outbound_per_customer');
    const drift = metrics.find((m) => m.key === 'confidence_calibration_drift');
    expect(outbound?.value).toBe(11);
    expect(outbound?.status).toBe('alert');
    expect(drift?.value).toBe(0.22);
    expect(drift?.status).toBe('alert');
  });

  it('treats missing source tables (42P01) as no-data, not zero', async () => {
    const client = mockClient((sql) => {
      if (sql.includes('agent_outbound_budget') || sql.includes('outcome_feedback')) {
        const err = new Error('relation does not exist') as Error & { code: string };
        err.code = '42P01';
        throw err;
      }
      return { rows: [emptyRow()] };
    });

    const counts = await collectMetricCounts(client, 'org-1');
    expect(counts.outboundPerCustomer).toBeNull();
    expect(counts.predictedMinusActual).toBeNull();
  });
});

describe('computeSilentMetrics outbound null', () => {
  it('marks null outbound as unknown, never healthy', () => {
    const metrics = computeSilentMetrics({
      executed: 8,
      escalated: 10,
      suppressed: 1,
      declined: 1,
      deferred: 0,
      totalActions: 40,
      decidedPendingMs: [1_000_000],
      expiredPending: 0,
      totalPending: 4,
      obligations: 12,
      messages: 80,
      groundingRejected: 2,
      groundingChecked: 20,
      openDiscrepancies: 1,
      discrepancyZeroStreakDays: 0,
      outboundPerCustomer: null,
      outboundCap: 8,
      predictedMinusActual: null,
      isWorkingDay: true,
    });
    const outbound = metrics.find((m) => m.key === 'outbound_per_customer');
    expect(outbound?.status).toBe('unknown');
    expect(outbound?.value).toBeNull();
  });
});

describe('loadFreshDailyMetricsSnapshot', () => {
  it('returns null when no snapshot row exists', async () => {
    const client = mockClient(() => ({ rows: [] }));
    const snap = await loadFreshDailyMetricsSnapshot(client, 'org-1');
    expect(snap).toBeNull();
  });

  it('returns null when latest snapshot is older than 24h', async () => {
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const client = mockClient(() => ({
      rows: [
        {
          metric_date: '2026-09-26',
          created_at: stale,
          approval_rate: 0.7,
          escalation_rate: 0.1,
          time_to_decision_p50_hours: 1,
          obligations_per_100_messages: 10,
          grounding_rejection_rate: 0.05,
          open_discrepancies: 2,
          autonomous_action_share: 0.4,
          suppression_rate: 0.1,
          outbound_per_customer: null,
          confidence_calibration_drift: null,
          band_alerts: [],
        },
      ],
    }));
    const snap = await loadFreshDailyMetricsSnapshot(client, 'org-1');
    expect(snap).toBeNull();
  });

  it('reconstructs metrics from a fresh snapshot without fabricating nulls as 0', async () => {
    const fresh = new Date(Date.now() - 60 * 60 * 1000);
    const client = mockClient(() => ({
      rows: [
        {
          metric_date: '2026-09-27',
          created_at: fresh,
          approval_rate: 0.75,
          escalation_rate: null,
          time_to_decision_p50_hours: null,
          obligations_per_100_messages: 12,
          grounding_rejection_rate: 0.05,
          open_discrepancies: 1,
          autonomous_action_share: 0.5,
          suppression_rate: 0.1,
          outbound_per_customer: null,
          confidence_calibration_drift: null,
          band_alerts: ['open_discrepancies'],
        },
      ],
    }));
    const snap = await loadFreshDailyMetricsSnapshot(client, 'org-1');
    expect(snap).not.toBeNull();
    const outbound = snap!.metrics.find((m) => m.key === 'outbound_per_customer');
    const escalation = snap!.metrics.find((m) => m.key === 'escalation_rate');
    const openDisc = snap!.metrics.find((m) => m.key === 'open_discrepancies');
    expect(outbound?.value).toBeNull();
    expect(outbound?.status).toBe('unknown');
    expect(escalation?.value).toBeNull();
    expect(escalation?.status).toBe('unknown');
    expect(openDisc?.value).toBe(1);
    expect(openDisc?.status).toBe('alert');
  });

  it('treats missing metrics table (42P01) as no snapshot', async () => {
    const client = mockClient(() => {
      const err = new Error('relation does not exist') as Error & { code: string };
      err.code = '42P01';
      throw err;
    });
    const snap = await loadFreshDailyMetricsSnapshot(client, 'org-1');
    expect(snap).toBeNull();
  });
});

describe('getOrComputeDailyMetrics', () => {
  it('returns snapshot without recompute when fresh', async () => {
    const fresh = new Date(Date.now() - 30 * 60 * 1000);
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('org_employee_metrics_daily') && sql.includes('SELECT')) {
        return {
          rows: [
            {
              metric_date: '2026-09-27',
              created_at: fresh,
              approval_rate: 0.8,
              escalation_rate: 0.1,
              time_to_decision_p50_hours: 2,
              obligations_per_100_messages: 10,
              grounding_rejection_rate: 0.05,
              open_discrepancies: 2,
              autonomous_action_share: 0.5,
              suppression_rate: 0.1,
              outbound_per_customer: 3,
              confidence_calibration_drift: 0.05,
              band_alerts: [],
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    });
    const client = { query } as unknown as PoolClient;
    const result = await getOrComputeDailyMetrics(client, 'org-1');
    expect(result.fromSnapshot).toBe(true);
    expect(result.metrics).toHaveLength(10);
    expect(query.mock.calls.some((c) => String(c[0]).includes('INSERT'))).toBe(false);
  });
});
