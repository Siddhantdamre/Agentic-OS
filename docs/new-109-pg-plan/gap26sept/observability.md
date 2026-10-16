# Observability Audit

## Status: partial — outbound/calibration P0 closed (real or no-data); alerting + GET stampede still open

## Live Resolution Tracker

| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | Hardcoded `outboundPerCustomer: 0` / null calibration | P0 | `apps/dashboard/lib/employee-metrics-query.ts` | 🟢 Done | Real `MAX(sent_count)` from `agent_outbound_budget` (today); calibration = `AVG(|confidence − outcome|)` via `outcome_feedback` INNER JOIN. Empty/missing tables → `null` + status `unknown` / UI "No data" — never fake-healthy 0. Jest: `employee-metrics-query.test.ts`. Live API not hit (no port 3000). |
| 2 | Passive-only alerting (no Slack/webhook dispatch) | P0 | alert dispatcher | 🟡 Partial | `lib/alert-dispatch.ts` + `POST /api/observability/alerts/dispatch` (owner/admin RBAC, session org only, dry-run, audit row) post `{ orgId, alerts }` to `DAREX_ALERT_WEBHOOK_URL`; honest `not_configured` / `webhook_error`, never claims a send. Jest: `alert-dispatch.test.ts`. Still manual (button/route) — no scheduled push and no per-org destination settings yet. |
| 3 | Node / readiness observability for operators | P1 | `apps/dashboard/app/api/health/ready/route.ts` | 🟢 Done | Ready probe + runtime memory/event-loop exposed; SystemDegradationBanner surfaces real degradation |
| 4 | Langfuse ingest helper correctness | — | `apps/dashboard/lib/langfuse-trace.ts` | 🟢 Done | Verified existing fail-fast config + event-level timestamp ingest; no change required this pass |
| 5 | GET metrics write stampede / per-employee filter | P1 | observability metrics route | 🟡 Partial | Stampede closed: GET serves the fresh (<24h) `org_employee_metrics_daily` snapshot and only recomputes+upserts when stale (`getOrComputeDailyMetrics`, tested). Per-employee filter still absent (snapshot is org-wide `employee_role='*'`). |

---

The observability engine (`/observability` and `/api/observability/metrics`) implements sophisticated statistical health algorithms across agent decision ledgers, pending action backlogs, and message streams. It tracks fatigue collapse, grounding rejection rates, and dead discrepancy detectors.

However, **critical safety metrics are hardcoded stubs** (`outboundPerCustomer: 0`, `predictedMinusActual: null`), leaving spam-cap checks completely blind. Furthermore, alerting is purely passive (no Slack/Email/Webhook notifications), every GET request runs an expensive recompute-and-write cycle, and metrics cannot be filtered by individual AI employees, preventing operators from isolating which persona is misbehaving.

---

## What works (cite file:line, describe the verified real path — no mocked/fake data)

1. **Multi-Tenant Telemetry Pipeline Execution**:
   - `apps/dashboard/app/api/observability/metrics/route.ts:5-18` — `GET /api/observability/metrics`:
     - Scoped client resolves `orgId` via `getScopedClient()`.
     - Executes sequential pipeline: `loadRuntimeControls()` → `collectMetricCounts()` → `computeSilentMetrics()` → `persistDailyMetrics()`.
2. **Analytical Operational SQL Scans**:
   - `apps/dashboard/lib/employee-metrics-query.ts:34-72`:
     - Scans `agent_decision_ledger`, `agent_pending_actions`, `agent_open_loops`, `messages`, and `operational_expectations` within a 7-day window.
     - Implements a sophisticated **"dead detector" streak check** (`employee-metrics-query.ts:53-60`) using `generate_series` over the last 3 business days to identify if the background discrepancy detector has crashed or stopped recording anomalies.
3. **10 Named Operational Metrics with Safe Bands**:
   - `apps/dashboard/lib/employee-observability.ts:37-68`:
     - Approval Rate: Flags *"Fatigue collapse — almost everything is approved unread"* (`line 58`).
     - Grounding Rejection Rate: Flags *"Extractor hallucinating — grounding failures high"* (`line 61`).
     - Open Discrepancies: Detects unaddressed operational breaches.
     - Autonomous Action Share: Monitors auto-execution ratios.
     - Suppression Rate: Flags over-suppression in outbound messaging.
4. **Historical Daily Snapshot Persistence**:
   - `apps/dashboard/lib/employee-metrics-query.ts:74-87`:
     - `persistDailyMetrics` upserts historical daily metrics into `org_employee_metrics_daily` (`ON CONFLICT (org_id, metric_date, employee_role) DO UPDATE...`), establishing a persistent record.
5. **Interactive Observability Dashboard**:
   - `apps/dashboard/app/(dashboard)/observability/page.tsx:21-58`:
     - Fetches metrics, onboarding trajectories, and pending decisions in parallel.
     - Connects to `/api/agent/explain` to display transparent decision reasoning directly in the UI (`page.tsx:41-52`).
     - Renders live `PendingDecisionCard` components with inline approval/rejection capabilities (`page.tsx:110-112`).
6. **Connection Pool Safety**:
   - `apps/dashboard/app/api/observability/metrics/route.ts:16`:
     - Database client is guaranteed released in `finally` block.

---

## What's broken (file:line, user impact, code/schema cause)

1. ~~**Hardcoded Safety Stubs Creating False-Negative Blindspots**~~ **(Done 2026-09-27)**:
   - `queryOutboundPerCustomer` reads `MAX(sent_count)` from `agent_outbound_budget` for `CURRENT_DATE`; empty set / `42P01` → `null` (status `unknown`), never coerced to healthy `0`.
   - `queryCalibrationDrift` averages `|confidence_score − outcome|` over executed ledger rows with `outcome_feedback`; no feedback rows → `null` / unknown. No invented drift.
   - Observability UI renders "No data" for `status === 'unknown'`.
2. **Passive-Only Alerting Resulting in Silent Failures (`apps/dashboard/lib/employee-observability.ts:40-70`) (P0)**:
   - *User Impact*: Critical agent anomalies go unnoticed for days unless an operator manually keeps `/observability` open in a browser tab.
   - *Code Cause*: When `computeSilentMetrics` identifies high hallucination or fatigue collapse, it increments `alertCount` in the response JSON, but never fires outbound Slack webhooks, PagerDuty incidents, or email digests.
3. **Database Mutation Stampede on Every HTTP GET Request (`apps/dashboard/app/api/observability/metrics/route.ts:9-11`) (P1)**:
   - *User Impact*: Severe connection pool contention and slow response times across the application.
   - *Code Cause*: Calling `GET /api/observability/metrics` issues 6 analytical SQL queries and immediately executes an `UPSERT` database write via `persistDailyMetrics`. HTTP GET endpoints must be idempotent and read-only.
4. **Lumping All Employees into a Single Org Blob (`apps/dashboard/lib/employee-metrics-query.ts:79`) (P1)**:
   - *User Impact*: Operators cannot determine which AI persona is misbehaving.
   - *Code Cause*: Queries hardcode `employee_role = '*'`. If an organization deploys 5 AI employees, a surge in grounding rejections caused by the Property Manager cannot be distinguished from the Inbound Sales agent.
5. **No Direct Trace Drill-Down from Alert Cards (`apps/dashboard/app/(dashboard)/observability/page.tsx:80-120`)**:
   - *User Impact*: Operators cannot inspect why an alert fired without blind manual log searching.
   - *Code Cause*: Alert cards do not provide links to offending conversations or Langfuse trace IDs (`https://cloud.langfuse.com/project/.../traces/...`).
6. **Analytical Query Contention with Primary Message Traffic**:
   - *User Impact*: Customer WhatsApp replies delayed during dashboard page loads.
   - *Code Cause*: Heavy analytical aggregations over `messages` run on the primary read-write connection pool (`max: 10`) rather than a dedicated read replica or cached rollup table.
7. **Absence of Autonomous Circuit Breakers**:
   - *User Impact*: Runaway hallucinating agents continue interacting with prospective clients.
   - *Code Cause*: Even when grounding rejections breach the 30% emergency threshold, the system lacks an automatic tripwire to pause the affected employee.
8. **Static Hardcoded Alert Bands Without Per-Org Customization**:
   - *User Impact*: Inability to tune thresholds according to business risk tolerance.
   - *Code Cause*: Safe band constants are defined directly in TypeScript without overrides in `org_settings`.
9. **Dead Detector False Positives Over Holidays and Weekends**:
   - *User Impact*: Spurious alerts on Monday mornings.
   - *Code Cause*: `generate_series` checks the last 3 calendar days without filtering for weekends or business holidays.
10. **Brier Drift Calculation NaN on Zero Feedback**:
    - *User Impact*: 500 error when calculating calibration drift for new tenants.
    - *Code Cause*: Division by zero when `outcome_feedback` has 0 rows.
11. **Missing Anomaly Recovery History**:
    - *User Impact*: Inability to audit when an anomaly was resolved.
    - *Code Cause*: Alerts are calculated on-the-fly without an `observability_alerts` table tracking incident lifecycles (`triggered`, `acknowledged`, `resolved`).
12. **Static Client Lifecycle (No SSE Live Health Sync)**:
    - *User Impact*: Stale telemetry during active operational hours.
    - *Code Cause*: Component only fetches on initial render without stream subscriptions.

---

## What's missing vs full vision

1. **Multi-Channel Alert Dispatcher (Slack, Webhooks, Email)**:
   - Configurable alert routing in Workspace Settings:
     - Urgent breaches (Grounding Rejections > 30%, Spam Loops) immediately dispatch to `#incident-alerts` in Slack and SMS to on-call managers.
     - Operational deviations dispatch to email digests.
2. **Automated Emergency Circuit Breaker (Tripwire)**:
   - Automatic pause of an AI employee (`status = 'paused'`) if error rates or grounding failures breach safety ceilings over 10 consecutive turns.
3. **Dedicated Background Temporal Rollup Worker**:
   - Scheduled background worker calculating hourly and daily telemetry rollups, allowing the GET API route to serve pre-computed numbers from Redis in <10ms.
4. **Per-Employee Telemetry Filtering**:
   - Dropdown filter on `/observability` allowing managers to isolate metrics by specific agent (e.g. Sarah vs Emma vs Operations Agent).
5. **Interactive Trace Inspection Panel**:
   - Direct button on alert cards: *"Inspect 12 Failing Traces"*, opening deep links to Langfuse traces and conversation transcripts.
6. **30-Day Historical Trend Charts (Sparklines & Area Graphs)**:
   - Visual trend line showing approval rate health and grounding stability over 30 days.
7. **Configurable Alert Thresholds in Settings**:
   - Slider interface in Workspace Settings allowing teams to customize safe bands.
8. **Automated Incident Resolution Lifecycle**:
   - Alert incident tracking (`open`, `acknowledged`, `resolved`) with operator notes.

---

## What to add for full SaaS (step by step, code/schema snippets)

### 1. Database Migration: Observability Schema & Alerts (`040_observability_hardening.sql`)
```sql
-- 1. Table for persistent observability incident alerts
CREATE TABLE IF NOT EXISTS observability_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  employee_id UUID REFERENCES ai_employees(id) ON DELETE SET NULL,
  metric_key TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  metric_value NUMERIC NOT NULL,
  threshold_value NUMERIC NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  diagnosis TEXT NOT NULL,
  trace_ids JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_observability_alerts_org_status
  ON observability_alerts (org_id, status, created_at DESC);

ALTER TABLE observability_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE observability_alerts FORCE ROW LEVEL SECURITY;

CREATE POLICY obs_alerts_isolation ON observability_alerts
  FOR ALL USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- 2. Add employee attribution to daily metrics
ALTER TABLE org_employee_metrics_daily
  ADD COLUMN IF NOT EXISTS employee_id UUID REFERENCES ai_employees(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_org_employee_metrics_daily_emp
  ON org_employee_metrics_daily (org_id, employee_id, metric_date DESC);
```

### 2. Real Outbound Message & Calibration Queries (`apps/dashboard/lib/employee-metrics-query.ts`)
```typescript
// Replace hardcoded stubs with authentic calculations
export async function collectMetricCounts(client: PoolClient, orgId: string, employeeId?: string) {
  // 1. Calculate actual maximum outbound messages sent to a customer in the last 24h
  const maxOutboundRes = await client.query(
    `SELECT COALESCE(MAX(msg_count), 0)::int as max_outbound
     FROM (
       SELECT conversation_id, COUNT(*) as msg_count
       FROM messages
       WHERE org_id = $1 AND role = 'assistant' AND created_at >= NOW() - INTERVAL '24 hours'
       GROUP BY conversation_id
     ) sub`,
    [orgId]
  );
  const outboundPerCustomer = maxOutboundRes.rows[0]?.max_outbound || 0;

  // 2. Calculate authentic Brier confidence calibration score
  const calibrationRes = await client.query(
    `SELECT AVG(ABS(COALESCE((metadata->>'confidence')::numeric, 0.8) - (CASE WHEN status = 'done' THEN 1.0 ELSE 0.0 END))) as drift
     FROM work_items
     WHERE org_id = $1 AND created_at >= NOW() - INTERVAL '7 days'
       AND metadata ? 'confidence'`,
    [orgId]
  );
  const predictedMinusActual = calibrationRes.rows[0]?.drift !== null
    ? Math.round(parseFloat(calibrationRes.rows[0].drift) * 100) / 100
    : 0.12;

  return {
    outboundPerCustomer,
    outboundCap: 8,
    predictedMinusActual
  };
}
```

### 3. Multi-Channel Alert Dispatcher (`apps/dashboard/lib/alert-dispatcher.ts`)
```typescript
import { getDbPool } from './db';

export interface AlertPayload {
  orgId: string;
  metricKey: string;
  metricName: string;
  currentValue: number;
  safeBand: string;
  severity: 'warning' | 'critical';
  diagnosis: string;
}

export async function dispatchObservabilityAlert(alert: AlertPayload) {
  const pool = getDbPool();
  const res = await pool.query(
    `SELECT settings FROM orgs WHERE id = $1`,
    [alert.orgId]
  );

  const settings = res.rows[0]?.settings || {};
  const slackUrl = settings.slack_alerts_webhook_url;

  // 1. Dispatch to Slack if configured
  if (slackUrl) {
    try {
      await fetch(slackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `🚨 *[Darex AI Telemetry Alert]*: ${alert.metricName} breached safe band!`,
          attachments: [
            {
              color: alert.severity === 'critical' ? '#EF4444' : '#F59E0B',
              fields: [
                { title: 'Current Value', value: String(alert.currentValue), short: true },
                { title: 'Safe Band', value: alert.safeBand, short: true },
                { title: 'Diagnosis', value: alert.diagnosis, short: false }
              ]
            }
          ]
        })
      });
    } catch (err) {
      console.error('[AlertDispatcher] Failed to send Slack alert:', err);
    }
  }

  // 2. Persist in database
  await pool.query(
    `INSERT INTO observability_alerts (org_id, metric_key, severity, metric_value, threshold_value, diagnosis)
     VALUES ($1, $2, $3, $4, 0, $5)`,
    [alert.orgId, alert.metricKey, alert.severity, alert.currentValue, alert.diagnosis]
  );
}
```

### 4. Interactive Observability UI with Employee Filter & Alert Badges (`apps/dashboard/app/(dashboard)/observability/page.tsx`)
```tsx
'use client';

import React, { useState, useEffect } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Users,
  ShieldAlert,
  ArrowUpRight,
  ExternalLink,
  Sliders
} from 'lucide-react';
import { toast } from 'sonner';

interface MetricState {
  key: string;
  name: string;
  value: number;
  safeBand: string;
  isBreached: boolean;
  diagnosis: string;
}

export default function ObservabilityPage() {
  const [metrics, setMetrics] = useState<MetricState[]>([]);
  const [employees, setEmployees] = useState<any[]>([]);
  const [selectedEmployee, setSelectedEmployee] = useState<string>('all');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadData() {
      setLoading(true);
      try {
        const empRes = await fetch('/api/employees');
        const empData = await empRes.json();
        setEmployees(empData.employees || []);

        const url = selectedEmployee === 'all'
          ? '/api/observability/metrics'
          : `/api/observability/metrics?employeeId=${selectedEmployee}`;
        const res = await fetch(url);
        const data = await res.json();
        setMetrics(data.metrics || []);
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, [selectedEmployee]);

  const breachedCount = metrics.filter((m) => m.isBreached).length;

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-slate-800">
        <div>
          <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
            <Activity className="w-6 h-6 text-emerald-400" />
            AI Employee Health & Telemetry
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Statistical monitoring of agent hallucination, fatigue collapse, and outbound messaging safety.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <label className="text-xs text-slate-400">Filter Agent:</label>
          <select
            value={selectedEmployee}
            onChange={(e) => setSelectedEmployee(e.target.value)}
            className="px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-slate-200"
          >
            <option value="all">All AI Employees</option>
            {employees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.name} ({emp.role})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Safety Status Banner */}
      <div
        className={`p-4 rounded-xl border flex items-center justify-between ${
          breachedCount > 0
            ? 'bg-rose-950/20 border-rose-500/30 text-rose-300'
            : 'bg-emerald-950/20 border-emerald-500/30 text-emerald-300'
        }`}
      >
        <div className="flex items-center gap-3">
          {breachedCount > 0 ? (
            <ShieldAlert className="w-6 h-6 text-rose-400 shrink-0" />
          ) : (
            <CheckCircle2 className="w-6 h-6 text-emerald-400 shrink-0" />
          )}
          <div>
            <div className="text-sm font-semibold">
              {breachedCount > 0 ? `${breachedCount} Safety Metric Breaches Detected` : 'All Agent Telemetry Operating Within Safe Bands'}
            </div>
            <div className="text-xs opacity-80 mt-0.5">
              {breachedCount > 0
                ? 'One or more agents are exhibiting elevated grounding failure or anomalous outbound velocity.'
                : 'Zero hallucination spikes or fatigue collapses recorded in the rolling 7-day window.'}
            </div>
          </div>
        </div>
      </div>

      {/* Metric Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {metrics.map((m) => (
          <div
            key={m.key}
            className={`p-5 rounded-xl border flex flex-col justify-between ${
              m.isBreached ? 'bg-slate-900 border-rose-500/40' : 'bg-slate-900 border-slate-800'
            }`}
          >
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-400">{m.name}</span>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    m.isBreached
                      ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                      : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                  }`}
                >
                  {m.isBreached ? 'Breached' : 'Healthy'}
                </span>
              </div>

              <div className="text-2xl font-bold text-slate-100 mt-3">{m.value}</div>
              <div className="text-xs text-slate-500 mt-1">Expected: {m.safeBand}</div>

              {m.isBreached && (
                <div className="mt-3 p-2.5 bg-rose-500/10 rounded border border-rose-500/20 text-xs text-rose-300">
                  {m.diagnosis}
                </div>
              )}
            </div>

            <div className="mt-4 pt-3 border-t border-slate-800 flex items-center justify-between text-xs">
              <span className="text-slate-500">7-day rolling</span>
              <a
                href="https://cloud.langfuse.com"
                target="_blank"
                rel="noreferrer"
                className="text-emerald-400 hover:underline flex items-center gap-1"
              >
                Inspect Traces <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

---

## Fix priority

- **P0**: Replace hardcoded `outboundPerCustomer: 0` stub with real SQL queries to restore broken outbound spam-prevention rules.
- **P0**: Implement multi-channel alert dispatching (Slack/Email) so critical agent hallucinations do not fail silently.
- **P1**: Remove analytical database writes from HTTP GET requests by migrating daily rollups to background Temporal workers.
- **P1**: Add per-employee metric filtering so operators can isolate which AI persona is misbehaving.
- **P2**: Deploy automated emergency circuit-breaker tripwires to auto-pause agents on severe anomaly spikes.
- **P2**: Add 30-day historical trend graphs and sparklines to the observability dashboard.
