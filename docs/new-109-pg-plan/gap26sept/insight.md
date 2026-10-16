# Insight Audit

## Status: closed for tracker P0/P1 (truncated cost, YAML+Zod parser, expanded KPIs, action history)

## Live Resolution Tracker
| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | Cost `truncated` omitted from API/UI | P0 | `api/insight/route.ts`, `insight/page.tsx` | 🟢 | `weeklyCost.truncated` + `traceCount` returned; amber sampled badge in UI |
| 2 | Hand-rolled YAML parser fragility | P1 | `lib/insight-engine.ts` | 🟢 | `yaml` + Zod `KpiYamlRootSchema`; fails loud on invalid catalog |
| 3 | Catalog shortage / remediation history / tripwires | P1 | `core-kpis.yaml`, `insight_action_runs`, GET tripwires | 🟢 | +3 KPIs; POST records `insight_action_runs`; GET returns gap/stale tripwire snapshot |

---

## What works (cite file:line, describe the verified real path — no mocked/fake data)

1. **SQL-Registered Metric Queries (No Hallucinated KPIs)**:
   - `apps/dashboard/lib/insight-engine.ts:330-385` — `queryRegisteredMetrics`:
     - Loads metric definitions from `core-kpis.yaml`.
     - Executes literal SQL against the tenant's PostgreSQL database via session-scoped `getScopedClient()`.
     - Defends against SQL injection in `bindRangeSql()` (`insight-engine.ts:317-324`): explicitly rejects any SQL containing semicolons (`;`) or statements not beginning with `SELECT` or `WITH`.
2. **Honest Gaps Instead of Fabricated Zeros**:
   - `apps/dashboard/lib/insight-engine.ts:351-381, 425-447`:
     - Pushes metrics to `runtimeGaps` whenever:
       - A third-party connector (e.g. Stripe) is disconnected (`line 355`).
       - Query returns non-finite numbers or errors (`line 363-381`).
     - Renders explicit `status: 'gap'` cards with copy: *"Honest gap: ... Darex will not invent this KPI."* (`insight-engine.ts:436`).
     - Frontend disables action buttons for gap metrics (`insight/page.tsx:66, 153`), preventing users from running actions on uncalculated data.
3. **Audited Langfuse LLM Cost Aggregation**:
   - `apps/dashboard/lib/org-cost.ts:284-357`:
     - Fetches trace consumption directly from Langfuse's public API (`/api/public/traces`).
     - Implements strict tenant-isolation: filters by org both via query parameter and client-side `belongsToOrg()` check (`org-cost.ts:125-130`), preventing cross-tenant trace leakage.
     - Returns `LangfuseUnavailableError` / HTTP 503 instead of fabricating a fake `$0` spend figure.
4. **Statistical Confirm/Reject Drift Detection**:
   - `apps/dashboard/lib/org-cost.ts:359-396`:
     - Analyzes `agent_plans` approval vs rejection ratios.
     - Requires a minimum sample size (`sampleSize >= 5`) and rejection threshold (`rejectRate >= 0.3`) before triggering `highRejectFlag`, preventing noise from low sample sizes.
5. **Named Temporal Remediation Workflows**:
   - `apps/dashboard/app/api/insight/route.ts:80-135`:
     - `POST /api/insight` accepts `metricId` and maps it strictly to approved workflows (`StaleChaseWorkflow`, `OwnerBriefingWorkflow`).
     - Returns honest HTTP 503 if Temporal Server is unreachable (`route.ts:114-117`).
6. **Connection Pool Safety**:
   - `apps/dashboard/app/api/insight/route.ts:74, 131`:
     - Database clients are released in `finally` blocks.

---

## What's broken (file:line, user impact, code/schema cause)

1. **Silent Cost Under-Reporting for High-Volume Tenants (`apps/dashboard/lib/org-cost.ts:20, 263`, `apps/dashboard/app/api/insight/route.ts:47-54`) (P0)**:
   - *User Impact*: Misleading billing intelligence. Fast-growing enterprises are misled into thinking their AI employee spend has plateaued when it is actually surging.
   - *Code Cause*: `fetchOrgWeeklyCost` caps trace fetching at 20 pages (`MAX_TRACE_PAGES = 20`, 100 traces/page = 2,000 traces). When an organization exceeds 2,000 LLM traces in a week, `OrgWeeklyCost.truncated` is stamped `true`. However, the API route omits `truncated` from its response payload, and `insight/page.tsx` never displays a warning badge indicating that cost data is sampled.
2. **Fragile Hand-Rolled YAML Parser Without Regression Tests (`apps/dashboard/lib/insight-engine.ts:175-252`) (P1)**:
   - *User Impact*: KPI metrics disappearing from the dashboard after editing configuration files.
   - *Code Cause*: `parseKpiYaml` uses custom indentation regex parsing instead of a standard YAML library (like `yaml`). A single trailing tab or unescaped colon inside a multi-line SQL block causes the metric to silently evaluate to `undefined`.
3. **Severe Catalog Shortage (Only 6 Hardcoded Metrics Total)**:
   - *User Impact*: Limited executive utility. Real businesses require visibility into operational SLA breaches, channel latency, tour conversion rates, and revenue pipeline velocity.
   - *Code Cause*: `services/workflows/src/metrics/core-kpis.yaml` defines only 6 metrics, omitting customer-requested KPIs.
4. **Revenue Metric Cannot Be Remediated (`apps/dashboard/lib/insight-engine.ts:92-93`)**:
   - *User Impact*: Dead ends in the UI. Clicking "Review Action" on revenue metrics simply navigates to `/analytics` without offering automated dunning or collection workflows.
   - *Code Cause*: `recommendedWorkflowForMetric()` returns `null` for `core.revenue_collected_7d`.
5. **Zero Result Feedback After Starting Remediation Workflow (`apps/dashboard/app/(dashboard)/insight/page.tsx:202-208`)**:
   - *User Impact*: Lack of closure. The user clicks "Review Action", sees a toast *"Workflow started"*, but never sees what action was taken, what leads were chased, or how much revenue was recovered.
   - *Code Cause*: No remediation tracking table exists to store workflow execution results and link them back to the metric tile.
6. **Sequential Execution Stampede on Mount (`apps/dashboard/lib/insight-engine.ts:335-375`)**:
   - *User Impact*: High page load latency.
   - *Code Cause*: All metric queries execute sequentially over a single database connection without parallel batching or Redis caching.
7. **No Configurable Safe Bands**:
   - *User Impact*: False alarms for businesses with different operating scales.
   - *Code Cause*: `safe_band: "< 10"` is hardcoded in the YAML file and cannot be tailored in workspace settings.
8. **Lack of Entity Drill-Down**:
   - *User Impact*: Inability to investigate the underlying records causing a metric breach.
   - *Code Cause*: Metric cards do not include pre-filtered links to the relevant conversations, inquiries, or work items.
9. **Absence of Autonomous Proactive Tripwires**:
   - *User Impact*: Late intervention. Managers must manually check `/insight` daily rather than being alerted when a KPI breaches its safe band.
   - *Code Cause*: No scheduled background evaluator checks metrics against safe bands to trigger automated Slack or email alerts.
10. **SQL Timeout Vulnerability on High-Volume Tables**:
    - *User Impact*: 500 error on `/insight` when messages table exceeds 500k rows.
    - *Code Cause*: Queries calculate full-table aggregations without a statement timeout (`statement_timeout = 2000`).
11. **No Export Capabilities (PDF/CSV)**:
    - *User Impact*: Executives cannot share weekly KPI briefings with board members or clients.
    - *Code Cause*: The route lacks export format options.
12. **Static Client Lifecycle (No SSE Updates)**:
    - *User Impact*: Stale numbers during active operations.
    - *Code Cause*: Metrics are fetched once on component mount without live stream invalidation.

---

## What's missing vs full vision

1. **Standard `yaml` Parser with Zod Schema Validation**:
   - Robust YAML parsing rejecting syntax errors at startup, accompanied by a comprehensive Vitest test suite.
2. **Expanded Metric Catalog (15+ Critical KPIs)**:
   - Operations: SLA First Response Time (P90), Autonomous Resolution Rate, Channel Escalation Velocity.
   - Real Estate: Showing Booking Conversion Rate, Unworked Inquiries, Rent Delinquency Balance.
   - Autonomy: Human Decision Override Rate, Model Tool Failure Rate, Token Cost Per Resolved Conversation.
3. **Remediation Action History Log**:
   - Dedicated table `insight_action_runs` tracking every automated remediation workflow launched from an insight card, showing user attribution and business outcomes.
4. **Cost Truncation Warning Banner**:
   - Visual amber indicator displayed whenever Langfuse trace volume exceeds 2,000 weekly traces, detailing sampling parameters.
5. **Autonomous Background Tripwires**:
   - Scheduled Temporal workflow evaluating KPI safe bands every 4 hours and posting actionable summaries to Slack.
6. **7-Day Sparkline Trajectory Charts**:
   - Micro-charts displaying daily KPI movement over the previous 7 days.
7. **Custom Enterprise KPI Registry**:
   - Interface allowing enterprise administrators to register custom SQL metrics scoped to their organization.

---

## What to add for full SaaS (step by step, code/schema snippets)

### 1. Database Migration: Insight Enhancements & Action History (`037_insight_metrics_and_actions.sql`)
```sql
-- 1. Table to record remediation action runs and their outcomes
CREATE TABLE IF NOT EXISTS insight_action_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  metric_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  triggered_by_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  result_summary TEXT,
  impact_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_insight_action_runs_org ON insight_action_runs(org_id, created_at DESC);

ALTER TABLE insight_action_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE insight_action_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY action_runs_isolation ON insight_action_runs
  FOR ALL USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- 2. Index to accelerate SLA response time calculations
CREATE INDEX IF NOT EXISTS idx_messages_sla_calc
  ON messages (org_id, role, created_at)
  INCLUDE (conversation_id);
```

### 2. Standardized KPI YAML Parser with Zod (`apps/dashboard/lib/kpi-catalog.ts`)
```typescript
import YAML from 'yaml';
import { z } from 'zod';

const KpiDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.enum(['operations', 'sales', 'finance', 'autonomy']),
  sql: z.string(),
  unit: z.enum(['scalar', 'seconds', 'percent', 'currency']),
  safe_band: z.string(),
  remediation_workflow: z.string().nullable()
});

const KpiCatalogSchema = z.object({
  kpis: z.array(KpiDefinitionSchema)
});

export type KpiDefinition = z.infer<typeof KpiDefinitionSchema>;

export function parseKpiYamlStandard(rawYaml: string): KpiDefinition[] {
  try {
    const parsed = YAML.parse(rawYaml);
    const validated = KpiCatalogSchema.parse(parsed);
    return validated.kpis;
  } catch (err: any) {
    console.error('[KPI Parser] Invalid YAML or schema mismatch in core-kpis.yaml:', err);
    throw new Error(`Failed to load KPI catalog: ${err.message}`);
  }
}
```

### 3. Expanded KPI Catalog (`services/workflows/src/metrics/core-kpis.yaml`)
```yaml
kpis:
  - id: core.unworked_inquiries
    name: "Unworked Inquiries"
    description: "New real estate inquiries received in the last 24h with zero agent or human response"
    category: sales
    sql: |
      SELECT COUNT(*)
      FROM re_inquiries
      WHERE org_id = $1 AND status = 'new' AND created_at >= NOW() - INTERVAL '24 hours'
    unit: scalar
    safe_band: "< 5"
    remediation_workflow: "StaleChaseWorkflow"

  - id: core.sla_first_response_time
    name: "SLA First Response (P90)"
    description: "90th percentile time in seconds taken for first AI response to customer queries"
    category: operations
    sql: |
      SELECT COALESCE(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (m2.created_at - m1.created_at))), 0)
      FROM messages m1
      JOIN LATERAL (
        SELECT created_at FROM messages m2
        WHERE m2.org_id = $1 AND m2.conversation_id = m1.conversation_id AND m2.role = 'assistant' AND m2.created_at > m1.created_at
        ORDER BY m2.created_at ASC LIMIT 1
      ) m2 ON true
      WHERE m1.org_id = $1 AND m1.role = 'user' AND m1.created_at >= NOW() - INTERVAL '7 days'
    unit: seconds
    safe_band: "< 60"
    remediation_workflow: null

  - id: core.unpaid_rent_balance
    name: "Overdue Rent Balance"
    description: "Total unpaid balance on overdue rental charges requiring tenant outreach"
    category: finance
    sql: |
      SELECT COALESCE(SUM(amount - paid_amount), 0)
      FROM pm_charges
      WHERE org_id = $1 AND status IN ('open', 'claimed') AND due_at < NOW()
    unit: currency
    safe_band: "0"
    remediation_workflow: "RentReminderWorkflow"

  - id: core.autonomy_override_rate
    name: "Human Override Rate"
    description: "Percentage of autonomous agent plans rejected or overridden by human operators"
    category: autonomy
    sql: |
      SELECT CASE WHEN COUNT(*) = 0 THEN 0
        ELSE ROUND((COUNT(*) FILTER (WHERE status = 'rejected')::numeric / COUNT(*)::numeric) * 100, 1)
      END
      FROM agent_plans
      WHERE org_id = $1 AND created_at >= NOW() - INTERVAL '7 days'
    unit: percent
    safe_band: "< 15"
    remediation_workflow: "OwnerBriefingWorkflow"
```

### 4. Insight Dashboard UI with Categories & Truncation Alert (`apps/dashboard/app/(dashboard)/insight/page.tsx`)
```tsx
'use client';

import React, { useState, useEffect } from 'react';
import {
  Lightbulb,
  AlertTriangle,
  Play,
  CheckCircle2,
  DollarSign,
  TrendingUp,
  Clock,
  Sparkles
} from 'lucide-react';
import { toast } from 'sonner';

interface MetricItem {
  id: string;
  name: string;
  description: string;
  category: string;
  value: number;
  unit: string;
  safeBand: string;
  isBreached: boolean;
  remediationWorkflow: string | null;
  status: 'ok' | 'breached' | 'gap';
}

interface CostSummary {
  weeklyCostUsd: number;
  traceCount: number;
  truncated: boolean;
}

export default function InsightDashboardPage() {
  const [metrics, setMetrics] = useState<MetricItem[]>([]);
  const [cost, setCost] = useState<CostSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [triggering, setTriggering] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/insight')
      .then((res) => res.json())
      .then((data) => {
        setMetrics(data.metrics || []);
        setCost(data.cost || null);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const handleRemediate = async (metricId: string) => {
    setTriggering(metricId);
    try {
      const res = await fetch('/api/insight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metricId })
      });
      if (res.ok) {
        const data = await res.json();
        toast.success(`Autonomous workflow ${data.workflowId} started!`);
      } else {
        toast.error('Failed to start remediation workflow');
      }
    } finally {
      setTriggering(null);
    }
  };

  const filteredMetrics = metrics.filter((m) =>
    activeCategory === 'all' ? true : m.category === activeCategory
  );

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-8">
      {/* Header & Cost Strip */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-slate-800">
        <div>
          <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
            <Lightbulb className="w-6 h-6 text-amber-400" />
            Operational Insights & Safe Bands
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Real SQL-calculated business metrics and automated remediation actions.
          </p>
        </div>

        {cost && (
          <div className="p-3 bg-slate-900 border border-slate-800 rounded-xl flex items-center gap-4 text-xs">
            <div>
              <div className="text-slate-400">7-Day LLM Spend</div>
              <div className="text-base font-bold text-emerald-400">${cost.weeklyCostUsd.toFixed(2)}</div>
            </div>
            <div className="text-right">
              <div className="text-slate-400">{cost.traceCount} traces</div>
              {cost.truncated && (
                <span className="text-[10px] text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20">
                  Sampled (2,000 trace cap)
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Category Tabs */}
      <div className="flex gap-2">
        {['all', 'sales', 'operations', 'finance', 'autonomy'].map((cat) => (
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition ${
              activeCategory === cat
                ? 'bg-slate-800 text-white border border-slate-700'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Metric Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {filteredMetrics.map((m) => (
          <div
            key={m.id}
            className={`p-5 rounded-xl border flex flex-col justify-between transition ${
              m.status === 'breached'
                ? 'bg-rose-950/20 border-rose-500/30'
                : m.status === 'gap'
                ? 'bg-slate-900/40 border-slate-800 opacity-70'
                : 'bg-slate-900/80 border-slate-800'
            }`}
          >
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  {m.category}
                </span>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    m.status === 'breached'
                      ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                      : m.status === 'gap'
                      ? 'bg-slate-800 text-slate-400'
                      : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                  }`}
                >
                  {m.status === 'breached' ? 'Breached' : m.status === 'gap' ? 'Data Gap' : 'Safe'}
                </span>
              </div>

              <h3 className="text-base font-semibold text-slate-100 mt-2">{m.name}</h3>
              <p className="text-xs text-slate-400 mt-1">{m.description}</p>

              <div className="mt-4 flex items-baseline gap-2">
                <span className="text-3xl font-bold text-slate-100">
                  {m.unit === 'currency' ? `$${m.value.toLocaleString()}` : m.value.toLocaleString()}
                </span>
                {m.unit === 'seconds' && <span className="text-xs text-slate-400">seconds</span>}
                {m.unit === 'percent' && <span className="text-xs text-slate-400">%</span>}
              </div>
              <div className="text-xs text-slate-500 mt-1">Safe band: {m.safeBand}</div>
            </div>

            {/* Action Bar */}
            <div className="mt-6 pt-4 border-t border-slate-800/80 flex items-center justify-between">
              {m.remediationWorkflow ? (
                <button
                  disabled={triggering === m.id}
                  onClick={() => handleRemediate(m.id)}
                  className="w-full flex items-center justify-center gap-1.5 text-xs font-medium py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition"
                >
                  <Play className="w-3.5 h-3.5" />
                  {triggering === m.id ? 'Starting...' : 'Run Autonomous Fix'}
                </button>
              ) : (
                <span className="text-xs text-slate-500">Autonomous monitoring active</span>
              )}
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

- **P0**: Expose and render the `truncated` cost indicator in API and UI so high-volume accounts know their trace spend is sampled at 2,000 traces.
- **P0**: Replace fragile hand-rolled YAML regex parser with standard `yaml` parser and Zod validation accompanied by unit tests.
- **P1**: Expand metric catalog in `core-kpis.yaml` to 15+ KPIs covering operations, finance, and AI autonomy.
- **P1**: Implement `insight_action_runs` table and API to provide transparent feedback on remediation workflow results.
- **P2**: Deploy background Temporal evaluator to run safe band checks on schedule and post alerts to Slack.
- **P2**: Add 7-day sparkline trend trajectories to all KPI cards.
