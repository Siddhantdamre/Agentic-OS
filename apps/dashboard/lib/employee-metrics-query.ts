import type { PoolClient } from 'pg';
import {
  computeSilentMetrics,
  type MetricRawCounts,
  type SilentMetric,
  type SilentMetricKey,
  type BandStatus,
} from '@/lib/employee-observability';
import { parseRolloutStage, type RolloutStage } from '@/lib/employee-rollout';

function num(value: unknown): number { const n = Number(value); return Number.isFinite(n) ? n : 0; }

function isUndefinedTable(err: unknown): boolean {
  return (err as { code?: string })?.code === '42P01';
}

const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const METRIC_UNITS: Record<SilentMetricKey, string> = {
  approval_rate: 'ratio',
  escalation_rate: 'ratio',
  time_to_decision: 'hours',
  obligations_per_100: 'count',
  grounding_rejection_rate: 'ratio',
  open_discrepancies: 'count',
  autonomous_action_share: 'ratio',
  suppression_rate: 'ratio',
  outbound_per_customer: 'count',
  confidence_calibration_drift: 'abs',
};

const METRIC_LABELS: Record<SilentMetricKey, string> = {
  approval_rate: 'Approval rate',
  escalation_rate: 'Escalation rate',
  time_to_decision: 'Time-to-decision p50',
  obligations_per_100: 'Obligations per 100 messages',
  grounding_rejection_rate: 'Grounding rejection rate',
  open_discrepancies: 'Open discrepancies',
  autonomous_action_share: 'Autonomous action share',
  suppression_rate: 'Suppression rate',
  outbound_per_customer: 'Outbound per customer',
  confidence_calibration_drift: 'Confidence calibration drift',
};

const SNAPSHOT_KEYS: SilentMetricKey[] = [
  'approval_rate',
  'escalation_rate',
  'time_to_decision',
  'obligations_per_100',
  'grounding_rejection_rate',
  'open_discrepancies',
  'autonomous_action_share',
  'suppression_rate',
  'outbound_per_customer',
  'confidence_calibration_drift',
];

type DailySnapshotRow = {
  metric_date: Date | string;
  created_at: Date | string;
  approval_rate: string | number | null;
  escalation_rate: string | number | null;
  time_to_decision_p50_hours: string | number | null;
  obligations_per_100_messages: string | number | null;
  grounding_rejection_rate: string | number | null;
  open_discrepancies: string | number | null;
  autonomous_action_share: string | number | null;
  suppression_rate: string | number | null;
  outbound_per_customer: string | number | null;
  confidence_calibration_drift: string | number | null;
  band_alerts: unknown;
};

function nullableNum(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function snapshotColumnValue(row: DailySnapshotRow, key: SilentMetricKey): number | null {
  switch (key) {
    case 'approval_rate':
      return nullableNum(row.approval_rate);
    case 'escalation_rate':
      return nullableNum(row.escalation_rate);
    case 'time_to_decision':
      return nullableNum(row.time_to_decision_p50_hours);
    case 'obligations_per_100':
      return nullableNum(row.obligations_per_100_messages);
    case 'grounding_rejection_rate':
      return nullableNum(row.grounding_rejection_rate);
    case 'open_discrepancies':
      return nullableNum(row.open_discrepancies);
    case 'autonomous_action_share':
      return nullableNum(row.autonomous_action_share);
    case 'suppression_rate':
      return nullableNum(row.suppression_rate);
    case 'outbound_per_customer':
      return nullableNum(row.outbound_per_customer);
    case 'confidence_calibration_drift':
      return nullableNum(row.confidence_calibration_drift);
    default: {
      const _exhaustive: never = key;
      return _exhaustive;
    }
  }
}

function metricsFromDailySnapshot(row: DailySnapshotRow): SilentMetric[] {
  const alertKeys = new Set(
    Array.isArray(row.band_alerts) ? row.band_alerts.map((v) => String(v)) : []
  );
  return SNAPSHOT_KEYS.map((key) => {
    const value = snapshotColumnValue(row, key);
    let status: BandStatus;
    if (value == null) status = 'unknown';
    else if (alertKeys.has(key)) status = 'alert';
    else status = 'healthy';
    return {
      key,
      label: METRIC_LABELS[key],
      value,
      unit: METRIC_UNITS[key],
      healthyLow: null,
      healthyHigh: null,
      status,
      alertReason: null,
    };
  });
}

/**
 * Latest org_employee_metrics_daily row when present and younger than 24h.
 * Missing / stale / missing table → null (caller computes once and persists).
 * Null metric columns stay null → unknown / no-data — never coerced to 0.
 */
export async function loadFreshDailyMetricsSnapshot(
  client: PoolClient,
  orgId: string,
  now: Date = new Date()
): Promise<{ metrics: SilentMetric[]; asOf: string; metricDate: string } | null> {
  try {
    const res = await client.query<DailySnapshotRow>(
      `SELECT metric_date, created_at,
              approval_rate, escalation_rate, time_to_decision_p50_hours,
              obligations_per_100_messages, grounding_rejection_rate, open_discrepancies,
              autonomous_action_share, suppression_rate, outbound_per_customer,
              confidence_calibration_drift, band_alerts
         FROM org_employee_metrics_daily
        WHERE org_id = $1 AND employee_role = '*'
        ORDER BY metric_date DESC, created_at DESC
        LIMIT 1`,
      [orgId]
    );
    const row = res.rows[0];
    if (!row) return null;
    const createdAt = toDate(row.created_at);
    if (!Number.isFinite(createdAt.getTime())) return null;
    if (now.getTime() - createdAt.getTime() > SNAPSHOT_MAX_AGE_MS) return null;
    const metricDate =
      row.metric_date instanceof Date
        ? row.metric_date.toISOString().slice(0, 10)
        : String(row.metric_date).slice(0, 10);
    return {
      metrics: metricsFromDailySnapshot(row),
      asOf: createdAt.toISOString(),
      metricDate,
    };
  } catch (err) {
    if (isUndefinedTable(err)) return null;
    throw err;
  }
}

/**
 * Prefer a fresh daily snapshot; otherwise compute once, persist, return.
 * Does not change metric formulas — only when they run.
 */
export async function getOrComputeDailyMetrics(
  client: PoolClient,
  orgId: string
): Promise<{ metrics: SilentMetric[]; asOf: string; fromSnapshot: boolean }> {
  const snap = await loadFreshDailyMetricsSnapshot(client, orgId);
  if (snap) {
    return { metrics: snap.metrics, asOf: snap.asOf, fromSnapshot: true };
  }
  const metrics = computeSilentMetrics(await collectMetricCounts(client, orgId));
  await persistDailyMetrics(client, orgId, metrics);
  return { metrics, asOf: new Date().toISOString(), fromSnapshot: false };
}

/** Max outbound sends to any single customer today. null = no budget rows / table missing. */
async function queryOutboundPerCustomer(client: PoolClient, orgId: string): Promise<number | null> {
  try {
    const res = await client.query(
      `SELECT MAX(sent_count)::int AS max_outbound
         FROM agent_outbound_budget
        WHERE org_id = $1 AND window_date = CURRENT_DATE`,
      [orgId]
    );
    const raw = res.rows[0]?.max_outbound;
    // Empty set → MAX is NULL. Do not coerce to 0 (that reads as fake-healthy).
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch (err) {
    if (isUndefinedTable(err)) return null;
    throw err;
  }
}

/**
 * Mean |confidence − outcome| over executed decisions that have outcome_feedback.
 * null when no joined rows (or tables missing) — never invent a drift number.
 */
async function queryCalibrationDrift(client: PoolClient, orgId: string): Promise<number | null> {
  try {
    const res = await client.query(
      `SELECT AVG(ABS(
          l.confidence_score
          - CASE WHEN COALESCE(f.reverted, FALSE) OR COALESCE(f.complained, FALSE)
                 THEN 0.0 ELSE 1.0 END
        )) AS drift
         FROM agent_decision_ledger l
         INNER JOIN outcome_feedback f
           ON f.decision_id = l.id AND f.org_id = l.org_id
        WHERE l.org_id = $1
          AND l.decision = 'executed'
          AND l.created_at > NOW() - INTERVAL '7 days'`,
      [orgId]
    );
    const raw = res.rows[0]?.drift;
    if (raw == null) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 1000) / 1000;
  } catch (err) {
    if (isUndefinedTable(err)) return null;
    throw err;
  }
}

export async function loadRuntimeControls(client: PoolClient, orgId: string) {
  const row = await client.query(`SELECT kill_switch, autonomy_stage, shadow_reviewed, shadow_agreed FROM org_runtime_controls WHERE org_id = $1`, [orgId]);
  if (row.rows[0]) {
    return { killSwitch: Boolean(row.rows[0].kill_switch), rolloutStage: parseRolloutStage(row.rows[0].autonomy_stage), shadowReviewed: num(row.rows[0].shadow_reviewed), shadowAgreed: num(row.rows[0].shadow_agreed) };
  }
  const meta = await client.query(`SELECT meta FROM orgs WHERE id = $1`, [orgId]);
  const blob = (meta.rows[0]?.meta || {}) as Record<string, unknown>;
  return { killSwitch: Boolean(blob.kill_switch ?? blob.killSwitch), rolloutStage: parseRolloutStage(blob.autonomy_stage), shadowReviewed: num(blob.shadow_reviewed), shadowAgreed: num(blob.shadow_agreed) };
}

export async function writeKillSwitch(client: PoolClient, orgId: string, enabled: boolean, actorUserId: string | null = null): Promise<void> {
  // Pausing returns the team to level 0. That is a change of level, so it goes in the same history
  // as every other change (read before the write, because the write overwrites the level).
  let previousStage = 0;
  if (enabled) {
    const before = await client.query(`SELECT autonomy_stage FROM org_runtime_controls WHERE org_id = $1`, [orgId]);
    previousStage = Number(before.rows[0]?.autonomy_stage ?? 0);
  }
  await client.query(
    `INSERT INTO org_runtime_controls (org_id, kill_switch, autonomy_stage, updated_at) VALUES ($1, $2, 0, NOW())
     ON CONFLICT (org_id) DO UPDATE SET kill_switch = EXCLUDED.kill_switch, autonomy_stage = CASE WHEN EXCLUDED.kill_switch THEN 0 ELSE org_runtime_controls.autonomy_stage END, updated_at = NOW()`,
    [orgId, enabled]
  );
  await client.query(`UPDATE orgs SET meta = COALESCE(meta, '{}'::jsonb) || jsonb_build_object('kill_switch', $2::boolean) WHERE id = $1`, [orgId, enabled]);
  if (enabled && previousStage > 0) {
    await client.query(
      `INSERT INTO org_autonomy_stage_events (org_id, from_stage, to_stage, kind, reason, actor_user_id)
       VALUES ($1, $2, 0, 'pause', $3, $4)`,
      [orgId, previousStage, 'The team was paused, which returns it to level 0.', actorUserId],
    );
  }
}

export async function writeRolloutStage(client: PoolClient, orgId: string, stage: RolloutStage): Promise<void> {
  await client.query(
    `INSERT INTO org_runtime_controls (org_id, autonomy_stage, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (org_id) DO UPDATE SET autonomy_stage = EXCLUDED.autonomy_stage, updated_at = NOW()`,
    [orgId, stage]
  );
}

export async function collectMetricCounts(client: PoolClient, orgId: string): Promise<MetricRawCounts> {
  const ledger = await client.query(
    `SELECT COUNT(*) FILTER (WHERE decision = 'executed') AS executed, COUNT(*) FILTER (WHERE decision = 'escalated') AS escalated,
            COUNT(*) FILTER (WHERE decision = 'suppressed') AS suppressed, COUNT(*) FILTER (WHERE decision = 'declined') AS declined,
            COUNT(*) FILTER (WHERE decision = 'deferred') AS deferred, COUNT(*) AS total,
            COUNT(*) FILTER (WHERE reason_code = 'grounding_rejected') AS grounding_rejected,
            COUNT(*) FILTER (WHERE reason_code IN ('grounding_rejected','grounding_passed')) AS grounding_checked
       FROM agent_decision_ledger WHERE org_id = $1 AND created_at > NOW() - INTERVAL '7 days'`,
    [orgId]
  );
  const pending = await client.query(
    `SELECT COUNT(*) AS total_pending, COUNT(*) FILTER (WHERE status = 'expired') AS expired,
            COALESCE(ARRAY_AGG(EXTRACT(EPOCH FROM (decided_at - created_at)) * 1000) FILTER (WHERE decided_at IS NOT NULL), '{}') AS decided_ms
       FROM agent_pending_actions WHERE org_id = $1 AND created_at > NOW() - INTERVAL '7 days'`,
    [orgId]
  );
  const loops = await client.query(`SELECT COUNT(*) AS obligations FROM agent_open_loops WHERE org_id = $1 AND created_at > NOW() - INTERVAL '7 days' AND COALESCE(backfilled, FALSE) = FALSE`, [orgId]);
  const messages = await client.query(`SELECT COUNT(*) AS messages FROM messages WHERE org_id = $1 AND created_at > NOW() - INTERVAL '7 days'`, [orgId]);
  const disc = await client.query(`SELECT COUNT(*) AS open_disc FROM operational_expectations WHERE org_id = $1 AND is_discrepancy AND settled_at IS NULL AND created_at > NOW() - INTERVAL '3 days'`, [orgId]);
  const streak = await client.query(
    `SELECT COUNT(*) AS zero_days FROM (
        SELECT d::date FROM generate_series(CURRENT_DATE - 2, CURRENT_DATE, '1 day') d
         WHERE EXTRACT(ISODOW FROM d) < 6 AND NOT EXISTS (
           SELECT 1 FROM operational_expectations e WHERE e.org_id = $1 AND e.is_discrepancy AND e.created_at::date = d::date)
       ) s`,
    [orgId]
  );
  const outboundPerCustomer = await queryOutboundPerCustomer(client, orgId);
  const predictedMinusActual = await queryCalibrationDrift(client, orgId);
  const l = ledger.rows[0] || {}; const p = pending.rows[0] || {};
  const decidedMs = Array.isArray(p.decided_ms) ? p.decided_ms.map((v: unknown) => num(v)).filter((n: number) => n > 0) : [];
  return {
    executed: num(l.executed), escalated: num(l.escalated), suppressed: num(l.suppressed), declined: num(l.declined), deferred: num(l.deferred),
    totalActions: num(l.total), decidedPendingMs: decidedMs, expiredPending: num(p.expired), totalPending: num(p.total_pending),
    obligations: num(loops.rows[0]?.obligations), messages: num(messages.rows[0]?.messages),
    groundingRejected: num(l.grounding_rejected), groundingChecked: num(l.grounding_checked),
    openDiscrepancies: num(disc.rows[0]?.open_disc), discrepancyZeroStreakDays: num(streak.rows[0]?.zero_days),
    outboundPerCustomer, outboundCap: 8, predictedMinusActual,
    isWorkingDay: new Date().getUTCDay() !== 0 && new Date().getUTCDay() !== 6,
  };
}

export async function persistDailyMetrics(client: PoolClient, orgId: string, metrics: SilentMetric[]): Promise<void> {
  const byKey = Object.fromEntries(metrics.map((m) => [m.key, m]));
  const alerts = metrics.filter((m) => m.status === 'alert').map((m) => m.key);
  await client.query(
    `INSERT INTO org_employee_metrics_daily (org_id, metric_date, employee_role, approval_rate, escalation_rate, time_to_decision_p50_hours, obligations_per_100_messages, grounding_rejection_rate, open_discrepancies, autonomous_action_share, suppression_rate, outbound_per_customer, confidence_calibration_drift, band_alerts)
     VALUES ($1, CURRENT_DATE, '*', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
     ON CONFLICT (org_id, metric_date, employee_role) DO UPDATE SET
       approval_rate = EXCLUDED.approval_rate, escalation_rate = EXCLUDED.escalation_rate, time_to_decision_p50_hours = EXCLUDED.time_to_decision_p50_hours,
       obligations_per_100_messages = EXCLUDED.obligations_per_100_messages, grounding_rejection_rate = EXCLUDED.grounding_rejection_rate, open_discrepancies = EXCLUDED.open_discrepancies,
       autonomous_action_share = EXCLUDED.autonomous_action_share, suppression_rate = EXCLUDED.suppression_rate, outbound_per_customer = EXCLUDED.outbound_per_customer,
       confidence_calibration_drift = EXCLUDED.confidence_calibration_drift, band_alerts = EXCLUDED.band_alerts,
       created_at = NOW()`,
    [orgId, byKey.approval_rate?.value, byKey.escalation_rate?.value, byKey.time_to_decision?.value, byKey.obligations_per_100?.value, byKey.grounding_rejection_rate?.value, byKey.open_discrepancies?.value, byKey.autonomous_action_share?.value, byKey.suppression_rate?.value, byKey.outbound_per_customer?.value, byKey.confidence_calibration_drift?.value, JSON.stringify(alerts)]
  );
}
export { computeSilentMetrics };
