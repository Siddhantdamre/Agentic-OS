/**
 * @jest-environment node
 */
import type { PoolClient } from 'pg';
import { dispatchOrgAlerts, toAlertDispatchItems } from '../alert-dispatch';
import type { SilentMetric } from '../employee-observability';

jest.mock('../employee-metrics-query', () => ({
  getOrComputeDailyMetrics: jest.fn(),
}));
import { getOrComputeDailyMetrics } from '../employee-metrics-query';

function metric(key: string, status: SilentMetric['status']): SilentMetric {
  return {
    key,
    label: key,
    value: status === 'alert' ? 9 : 1,
    unit: '%',
    status,
    alertReason: status === 'alert' ? 'out of band' : null,
    healthyLow: 0,
    healthyHigh: 5,
  } as SilentMetric;
}

const client = {} as PoolClient;

describe('alert-dispatch', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    (getOrComputeDailyMetrics as jest.Mock).mockResolvedValue({
      metrics: [metric('a', 'alert'), metric('b', 'healthy' as SilentMetric['status'])],
      asOf: 'now',
      fromSnapshot: true,
    });
  });
  afterEach(() => {
    delete process.env.DAREX_ALERT_WEBHOOK_URL;
    global.fetch = realFetch;
  });

  it('keeps only alert-status metrics', () => {
    const items = toAlertDispatchItems([metric('a', 'alert'), metric('b', 'healthy' as SilentMetric['status'])]);
    expect(items.map((i) => i.key)).toEqual(['a']);
  });

  it('reports not_configured and never calls fetch when the URL is unset', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    const r = await dispatchOrgAlerts(client, 'org-1');
    expect(r).toMatchObject({ dispatched: false, reason: 'not_configured' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('dryRun previews without posting', async () => {
    process.env.DAREX_ALERT_WEBHOOK_URL = 'https://hooks.example.test/x';
    global.fetch = jest.fn() as unknown as typeof fetch;
    const r = await dispatchOrgAlerts(client, 'org-1', { dryRun: true });
    expect(r).toMatchObject({ dispatched: false, reason: 'preview' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('posts { orgId, alerts } and reports dispatched on 2xx', async () => {
    process.env.DAREX_ALERT_WEBHOOK_URL = 'https://hooks.example.test/x';
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;
    const r = await dispatchOrgAlerts(client, 'org-1');
    expect(r).toMatchObject({ dispatched: true, status: 200 });
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.orgId).toBe('org-1');
    expect(body.alerts).toHaveLength(1);
  });

  it('surfaces webhook failures instead of claiming success', async () => {
    process.env.DAREX_ALERT_WEBHOOK_URL = 'https://hooks.example.test/x';
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch;
    const r = await dispatchOrgAlerts(client, 'org-1');
    expect(r).toMatchObject({ dispatched: false, reason: 'webhook_error', status: 500 });
  });
});
