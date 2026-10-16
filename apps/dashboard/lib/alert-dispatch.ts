/**
 * Outbound observability alert dispatcher.
 * Posts alert metrics to DAREX_ALERT_WEBHOOK_URL when set.
 * Never includes secrets, tokens, or webhook request bodies in payloads/logs.
 */
import type { PoolClient } from 'pg';
import type { SilentMetric } from '@/lib/employee-observability';
import { getOrComputeDailyMetrics } from '@/lib/employee-metrics-query';

const WEBHOOK_TIMEOUT_MS = 10_000;

export type AlertDispatchItem = {
  key: string;
  label: string;
  value: number | null;
  unit: string;
  status: 'alert';
  alertReason: string | null;
  healthyLow: number | null;
  healthyHigh: number | null;
};

export type AlertDispatchResult =
  | { dispatched: false; reason: 'not_configured'; orgId: string; alerts: AlertDispatchItem[] }
  | { dispatched: false; reason: 'preview'; orgId: string; alerts: AlertDispatchItem[]; configured: true }
  | { dispatched: false; reason: 'webhook_error'; orgId: string; alerts: AlertDispatchItem[]; status?: number; message?: string }
  | { dispatched: true; orgId: string; alerts: AlertDispatchItem[]; status: number };

function alertWebhookUrl(): string | null {
  const raw = process.env.DAREX_ALERT_WEBHOOK_URL;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isAlertWebhookConfigured(): boolean {
  return alertWebhookUrl() != null;
}

export function toAlertDispatchItems(metrics: SilentMetric[]): AlertDispatchItem[] {
  return metrics
    .filter((m) => m.status === 'alert')
    .map((m) => ({
      key: m.key,
      label: m.label,
      value: m.value,
      unit: m.unit,
      status: 'alert' as const,
      alertReason: m.alertReason,
      healthyLow: m.healthyLow,
      healthyHigh: m.healthyHigh,
    }));
}

/**
 * Load current org alert metrics and POST them to the configured webhook.
 * Returns { dispatched: false, reason: 'not_configured' } when the env URL is unset —
 * does not pretend a message was sent.
 * Pass `dryRun: true` to load alerts and report config without POSTing.
 */
export async function dispatchOrgAlerts(
  client: PoolClient,
  orgId: string,
  opts?: { dryRun?: boolean }
): Promise<AlertDispatchResult> {
  const { metrics } = await getOrComputeDailyMetrics(client, orgId);
  const alerts = toAlertDispatchItems(metrics);
  const url = alertWebhookUrl();

  if (!url) {
    return { dispatched: false, reason: 'not_configured', orgId, alerts };
  }

  if (opts?.dryRun) {
    return { dispatched: false, reason: 'preview', orgId, alerts, configured: true };
  }

  const payload = { orgId, alerts };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });

    if (!res.ok) {
      return {
        dispatched: false,
        reason: 'webhook_error',
        orgId,
        alerts,
        status: res.status,
        message: `webhook returned ${res.status}`,
      };
    }

    return { dispatched: true, orgId, alerts, status: res.status };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'webhook request failed';
    return {
      dispatched: false,
      reason: 'webhook_error',
      orgId,
      alerts,
      message,
    };
  }
}
