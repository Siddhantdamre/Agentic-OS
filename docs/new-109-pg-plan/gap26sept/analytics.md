# Analytics Audit

## Status: P0/P1 owned analytics gaps closed (full SaaS vision leftovers only in writeup)

## Live Resolution Tracker

| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | Unbounded LATERAL latency scan on messages | P0 | `apps/dashboard/app/api/analytics/route.ts` | 🟢 Done | Bounded to last 7 days + `LIMIT 2000` user messages before LATERAL join |
| 2 | Contradictory "Automation Rate" vs Home | P0 | `apps/dashboard/app/api/analytics/route.ts` + analytics page | 🟢 Done | `automationRate` / `conversationAutomationRate` match Home (AI-replied conversations); `toolExecutionRate` returned separately; UI label updated |
| 3 | Orphaned ROI / cost-health / calibration UI | P1 | analytics page | 🟢 Done | ROI + cost-health tabs fetch those routes; empty/missing → `hasData:false` / "No data" (never fake-healthy 0). Calibration tab uses `/api/observability/metrics` `confidence_calibration_drift` (one source); dead `/api/analytics/calibration` removed. Jest: `analytics-route-consumers.test.ts` |
| 4 | Date-range picker / CSV export | P1/P2 | analytics page + export route | 🟢 Done | Range `24h|7d|30d|90d` on `/api/analytics?range=`; `GET /api/analytics/export` CSV (session org, no secrets) |

---

The Analytics domain (`/analytics`, `/api/analytics`, `/api/analytics/cost`, `/api/analytics/roi`, `/api/analytics/cost-health`) computes genuine, multi-tenant SQL rollups from PostgreSQL and Langfuse. It never fabricates demo numbers (returns explicit 503s on Langfuse failures and labels resolution ratios as `csatIsProxy: true`). Calibration drift is owned by `/api/observability/metrics` (single source); the Analytics Calibration tab consumes that metric.

P0/P1 tracker rows above are closed. Remaining full-vision items (percentiles, rollups, real CSAT, etc.) stay in "What's missing" below.

---

## What works (cite file:line, describe the verified real path — no mocked/fake data)

1. **Multi-Tenant Operational SQL Aggregations**:
   - `apps/dashboard/app/api/analytics/route.ts:9-150` — `GET /api/analytics`:
     - Computes total, resolved, and active conversation volumes via conditional SQL aggregations (`COUNT(CASE WHEN status = 'resolved' THEN 1 END)`, `route.ts:11-21`).
     - Groups active channels by `channel_type` (`route.ts:23-34`).
     - Computes average response latency via `JOIN LATERAL` between user and assistant messages (`route.ts:43-58`).
     - Computes tool-assisted automation rate: Measures the percentage of assistant messages that issued actual `tool_calls` (`route.ts:61-70`).
     - Explicitly returns `csatIsProxy: true` alongside resolved-conversation ratios (`route.ts:73-82, 128`), ensuring frontend copy clarifies that this is an operational proxy rather than a fake user survey.
     - Calculates week-over-week conversation deltas returning `null` when prior-week baselines are absent (`route.ts:84-101`).
     - Merges semantic insight metrics from `lib/insight-engine.ts`, honestly returning `gaps` when telemetry cannot be computed (`route.ts:116-146`).
2. **Audited Cost Fetching**:
   - `apps/dashboard/app/api/analytics/cost/route.ts:20-58` — `GET /api/analytics/cost`:
     - Pulls weekly model spend from Langfuse via `fetchOrgWeeklyCost` (`lib/org-cost.ts`).
     - Returns **HTTP 503** with `verified: false` on Langfuse network errors, upholding the strict standing policy that financial metrics must never fake $0 or mock success.
3. **Advanced Business ROI Calculation Engine**:
   - `apps/dashboard/app/api/analytics/roi/route.ts:21-65`:
     - Queries `growth_pipeline_attribution` and `employee_roi_metrics` for hours saved per employee role and attributed deal pipeline value.
     - Uses `isMissingTable` (Postgres error `42P01`) to degrade gracefully during migrations.
4. **Calibration drift (shared with Observability)**:
   - `apps/dashboard/lib/employee-metrics-query.ts` `queryCalibrationDrift` → `GET /api/observability/metrics` `confidence_calibration_drift`.
   - Analytics Calibration tab fetches that API; empty windows → `null` / "No data".
5. **Connection Pool Safety**:
   - `apps/dashboard/app/api/analytics/route.ts:148`:
     - Ensures client connections are returned to the pool in `finally` blocks.

---

## What's broken (file:line, user impact, code/schema cause)

1. **Unbounded Full Table Scan in Average Response Time (`apps/dashboard/app/api/analytics/route.ts:43-58`) (P0)**:
   - *User Impact*: Severe database CPU spikes, 10-second page load times, and connection pool starvation (`max: 10`).
   - *Code Cause*: Unlike `dashboard/stats/route.ts` which safely bounds its scan with `INTERVAL '7 days'` and `LIMIT 1000`, the query in `analytics/route.ts:43-58` has **no date range boundary**:
     ```sql
     WHERE m1.role = 'user' AND m1.org_id = $1
     ```
     In an enterprise account with 200,000 historical messages, this executes a massive unbounded nested loop scan on every analytics page visit, exhausting PostgreSQL pool slots.
2. **Contradictory Definition of "Automation Rate" Across Dashboard (P0)**:
   - *User Impact*: Severe user confusion and loss of executive trust. An executive sees "92% AI Automation" on the Home dashboard, clicks to Analytics, and sees "24% Automation Rate".
   - *Code Cause*: Taxonomy collision across files:
     - In `dashboard/stats/route.ts:49-61`: Automation rate = `(conversations with >= 1 assistant message) / (total conversations)`.
     - In `analytics/route.ts:60-70`: Automation rate = `(assistant messages with tool calls) / (total assistant messages)`.
     The two endpoints measure completely different things under the identical UI label.
3. ~~**Orphaned Backend Endpoints with Zero UI Visualization (`roi`, `cost-health`, `calibration`) (P1)**~~ — **closed**: see tracker row 3.
4. **Misleading CSAT Proxy Calculation (`apps/dashboard/app/api/analytics/route.ts:73-82`) (P1)**:
   - *User Impact*: Inaccurate customer satisfaction reporting.
   - *Code Cause*: Resolving a ticket does not indicate a happy customer (e.g. an unsatisfied tenant who gave up or cancelled still has their conversation marked "resolved"). The platform lacks true post-resolution CSAT surveys.
5. **Dropped Semantic Gaps in Frontend UI (`apps/dashboard/app/api/analytics/route.ts:146`)**:
   - *User Impact*: Confusing blank tiles when third-party connectors are disconnected.
   - *Code Cause*: The API returns `gaps: semantic.gaps`, but `analytics/page.tsx` omits rendering of gap explanation cards.
6. **Contention Between Analytical Reporting and Real-Time Chat**:
   - *User Impact*: Incoming WhatsApp webhooks experience connection checkout delays when a manager loads analytics reports.
   - *Code Cause*: Analytical queries run on the primary transactional connection pool (`max: 10`) instead of being served from pre-aggregated rollups or a read-only replica.
7. **Absence of Percentile Latencies (P50, P90, P99)**:
   - *User Impact*: The arithmetic mean (`AVG()`) conceals severe tail latency spikes where 5% of users wait 45+ seconds.
   - *Code Cause*: Only `AVG()` is selected; no `PERCENTILE_CONT()` queries are executed.
8. **Hardcoded 7-Day Window Without Date-Range Picker**:
   - *User Impact*: Businesses cannot inspect month-to-date, quarter-to-date, or custom historical performance.
   - *Code Cause*: UI does not provide date selection controls or pass `startDate`/`endDate` parameters.
9. **Zero Export Capability (CSV / PDF)**:
   - *User Impact*: Operators cannot export data to Excel or deliver PDF monthly reports to stakeholders.
   - *Code Cause*: No export routes or CSV formatting endpoints are provided.
10. **Division by Zero on Empty Message Tenants**:
    - *User Impact*: 500 error when newly created tenants click the Analytics tab.
    - *Code Cause*: Calculations fail to wrap denominators with `NULLIF(..., 0)`.
11. **Timezone Offset Distortion on Daily Rollups**:
    - *User Impact*: Metrics shifting between days based on UTC server time rather than tenant local time.
    - *Code Cause*: Aggregations group by `created_at::date` in server UTC without applying `AT TIME ZONE org.timezone`.
12. **Static Client Lifecycle (No SSE Invalidation)**:
    - *User Impact*: Stale analytics during busy shifts without manual page reload.
    - *Code Cause*: Metrics are fetched once on mount.

---

## What's missing vs full vision

1. **Unified Automation Taxonomy**:
   - Clear, distinct metric labels:
     - `Conversation Automation Rate`: % of customer conversations resolved without human intervention.
     - `Tool Execution Rate`: % of agent turns requiring external tool invocation.
2. **Dedicated AI Employee ROI Breakdown Tab**:
   - Visual scorecard showing value created by each individual AI employee:
     - Sarah (Leasing): 18 showings booked, $34,000 lease value, 46 hours saved.
     - Emma (Support): 310 tickets resolved, $4,650 labor cost saved ($35/hr).
3. **Interactive Date-Range Picker**:
   - Range options: `Today (24h)`, `Last 7 Days`, `Last 30 Days`, `Last 90 Days`, `Month to Date`, `Custom Range`.
4. **SLA Response Latency Distribution (P50 / P90 / P99)**:
   - Percentile latency breakdown exposing the authentic customer experience tail.
5. **Streaming CSV & PDF Report Export**:
   - One-click "Export to CSV" button generating clean, auditable spreadsheets of daily operational metrics.
6. **Model Cost Attribution by Feature**:
   - Pie chart showing LLM spend distribution across Ask AI planning, Inbound webhooks, and background crew sweeps.
7. **Authentic Post-Conversation CSAT Polls**:
   - Real 1-5 customer rating collection in WhatsApp and web chat.
8. **Hourly Message Volume Heatmap**:
   - Day-of-week vs hour-of-day heatmap showing operational traffic spikes.

---

## What to add for full SaaS (step by step, code/schema snippets)

### 1. Database Migration: Analytics Rollups & Indices (`041_analytics_rollups_and_percentiles.sql`)
```sql
-- 1. Table for persistent daily analytics rollups
CREATE TABLE IF NOT EXISTS analytics_daily_rollups (
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  channel TEXT NOT NULL DEFAULT 'all',
  total_conversations INTEGER NOT NULL DEFAULT 0,
  resolved_conversations INTEGER NOT NULL DEFAULT 0,
  autonomous_conversations INTEGER NOT NULL DEFAULT 0,
  tool_assisted_messages INTEGER NOT NULL DEFAULT 0,
  total_assistant_messages INTEGER NOT NULL DEFAULT 0,
  avg_latency_seconds NUMERIC(10,2) DEFAULT 0,
  p90_latency_seconds NUMERIC(10,2) DEFAULT 0,
  estimated_hours_saved NUMERIC(10,2) DEFAULT 0,
  model_cost_usd NUMERIC(10,4) DEFAULT 0,
  PRIMARY KEY (org_id, date, channel)
);

CREATE INDEX IF NOT EXISTS idx_analytics_daily_rollups_org_date
  ON analytics_daily_rollups (org_id, date DESC);

ALTER TABLE analytics_daily_rollups ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_daily_rollups FORCE ROW LEVEL SECURITY;

CREATE POLICY analytics_rollups_isolation ON analytics_daily_rollups
  FOR ALL USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- 2. Index to accelerate bounded latency percentiles
CREATE INDEX IF NOT EXISTS idx_messages_latency_bounded
  ON messages (org_id, role, created_at DESC)
  INCLUDE (conversation_id);
```

### 2. Bounded Latency Query with Percentiles & Unified Taxonomy (`apps/dashboard/app/api/analytics/route.ts`)
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';

export async function GET(req: NextRequest) {
  const { client, orgId } = await getScopedClient();
  const { searchParams } = new URL(req.url);
  const range = searchParams.get('range') || '7d';
  const intervalMap: Record<string, string> = {
    '24h': '24 hours',
    '7d': '7 days',
    '30d': '30 days',
    '90d': '90 days'
  };
  const intervalStr = intervalMap[range] || '7 days';

  try {
    // 1. High-level conversation volumes and autonomous resolution
    const convRes = await client.query(
      `SELECT
         COUNT(*) AS total_conversations,
         COUNT(*) FILTER (WHERE status = 'resolved') AS resolved_conversations,
         COUNT(*) FILTER (WHERE status = 'resolved' AND NOT EXISTS (
           SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user_agent'
         )) AS autonomous_conversations
       FROM conversations c
       WHERE org_id = $1 AND started_at >= NOW() - $2::interval`,
      [orgId, intervalStr]
    );

    // 2. Bounded Latency Scan with Percentiles (P50 and P90)
    const latencyRes = await client.query(
      `SELECT
         COALESCE(AVG(EXTRACT(EPOCH FROM (m2.created_at - m1.created_at))), 0)::numeric(10,1) AS avg_latency_sec,
         COALESCE(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (m2.created_at - m1.created_at))), 0)::numeric(10,1) AS p50_latency_sec,
         COALESCE(PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (m2.created_at - m1.created_at))), 0)::numeric(10,1) AS p90_latency_sec
       FROM (
         SELECT conversation_id, created_at
         FROM messages
         WHERE org_id = $1 AND role = 'user' AND created_at >= NOW() - $2::interval
         ORDER BY created_at DESC
         LIMIT 2000
       ) m1
       CROSS JOIN LATERAL (
         SELECT created_at
         FROM messages m2
         WHERE m2.org_id = $1 AND m2.conversation_id = m1.conversation_id AND m2.role = 'assistant' AND m2.created_at > m1.created_at
         ORDER BY m2.created_at ASC
         LIMIT 1
       ) m2`,
      [orgId, intervalStr]
    );

    const convRow = convRes.rows[0];
    const totalConv = parseInt(convRow.total_conversations, 10) || 0;
    const resolvedConv = parseInt(convRow.resolved_conversations, 10) || 0;
    const autoConv = parseInt(convRow.autonomous_conversations, 10) || 0;

    // Unified taxonomy definition
    const conversationAutomationRate = totalConv > 0
      ? Math.round((autoConv / totalConv) * 100)
      : 100;

    return NextResponse.json({
      totalConversations: totalConv,
      resolvedConversations: resolvedConv,
      conversationAutomationRate,
      latency: {
        avgSeconds: parseFloat(latencyRes.rows[0]?.avg_latency_sec || 0),
        p50Seconds: parseFloat(latencyRes.rows[0]?.p50_latency_sec || 0),
        p90Seconds: parseFloat(latencyRes.rows[0]?.p90_latency_sec || 0)
      }
    });
  } finally {
    client.release();
  }
}
```

### 3. Dedicated Employee ROI Breakdown Route (`apps/dashboard/app/api/analytics/roi/route.ts`)
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';

export async function GET(req: NextRequest) {
  const { client, orgId } = await getScopedClient();
  try {
    const res = await client.query(
      `SELECT
         e.id,
         e.name as employee_name,
         e.role as employee_role,
         COUNT(c.id) as conversations_handled,
         ROUND(COUNT(c.id) * 0.25, 1) as hours_saved,
         ROUND(COUNT(c.id) * 0.25 * 35, 2) as estimated_savings_usd,
         COALESCE(SUM((c.metadata->>'deal_value')::numeric), 0) as pipeline_influenced_usd
       FROM ai_employees e
       LEFT JOIN conversations c ON c.assignee_employee_id = e.id AND c.created_at >= NOW() - INTERVAL '30 days'
       WHERE e.org_id = $1 AND e.status = 'active'
       GROUP BY e.id, e.name, e.role
       ORDER BY conversations_handled DESC`,
      [orgId]
    );

    return NextResponse.json({ roi: res.rows });
  } finally {
    client.release();
  }
}
```

### 4. Interactive Analytics UI with Date Picker, ROI Tab, & CSV Export (`apps/dashboard/app/(dashboard)/analytics/page.tsx`)
```tsx
'use client';

import React, { useState, useEffect } from 'react';
import {
  BarChart3,
  Download,
  Clock,
  Zap,
  TrendingUp,
  DollarSign,
  Users,
  Calendar
} from 'lucide-react';
import { toast } from 'sonner';

export default function AnalyticsDashboardPage() {
  const [range, setRange] = useState<'24h' | '7d' | '30d' | '90d'>('7d');
  const [activeTab, setActiveTab] = useState<'overview' | 'roi'>('overview');
  const [data, setData] = useState<any>(null);
  const [roiData, setRoiData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadMetrics() {
      setLoading(true);
      try {
        const [analyticsRes, roiRes] = await Promise.all([
          fetch(`/api/analytics?range=${range}`),
          fetch('/api/analytics/roi')
        ]);
        setData(await analyticsRes.json());
        const roiJson = await roiRes.json();
        setRoiData(roiJson.roi || []);
      } finally {
        setLoading(false);
      }
    }
    loadMetrics();
  }, [range]);

  const handleExportCsv = () => {
    window.open('/api/analytics/export', '_blank');
  };

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
      {/* Top Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-slate-800">
        <div>
          <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
            <BarChart3 className="w-6 h-6 text-emerald-400" />
            Performance & Value Analytics
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Quantify AI employee labor savings, automation efficiency, and response SLAs.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Date Range Picker */}
          <div className="flex bg-slate-800 p-1 rounded-lg border border-slate-700 text-xs">
            {(['24h', '7d', '30d', '90d'] as const).map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`px-3 py-1 rounded font-medium transition ${
                  range === r ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {r}
              </button>
            ))}
          </div>

          <button
            onClick={handleExportCsv}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-xs font-medium text-slate-200 transition"
          >
            <Download className="w-3.5 h-3.5" /> Export CSV
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2">
        <button
          onClick={() => setActiveTab('overview')}
          className={`px-4 py-2 rounded-lg text-xs font-semibold transition ${
            activeTab === 'overview' ? 'bg-slate-800 text-white border border-slate-700' : 'text-slate-400'
          }`}
        >
          Operational Overview
        </button>
        <button
          onClick={() => setActiveTab('roi')}
          className={`px-4 py-2 rounded-lg text-xs font-semibold transition ${
            activeTab === 'roi' ? 'bg-slate-800 text-white border border-slate-700' : 'text-slate-400'
          }`}
        >
          AI Employee Labor ROI ({roiData.length})
        </button>
      </div>

      {activeTab === 'overview' ? (
        <div className="space-y-6">
          {/* Main KPI Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-5 bg-slate-900 border border-slate-800 rounded-xl">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>Total Inquiries ({range})</span>
                <Users className="w-4 h-4 text-blue-400" />
              </div>
              <div className="text-3xl font-bold text-slate-100 mt-2">{data?.totalConversations || 0}</div>
              <div className="text-xs text-emerald-400 mt-2">
                {data?.resolvedConversations || 0} resolved autonomously
              </div>
            </div>

            <div className="p-5 bg-slate-900 border border-slate-800 rounded-xl">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>Autonomous Resolution Rate</span>
                <Zap className="w-4 h-4 text-emerald-400" />
              </div>
              <div className="text-3xl font-bold text-slate-100 mt-2">{data?.conversationAutomationRate || 0}%</div>
              <div className="text-xs text-slate-400 mt-2">Zero human intervention needed</div>
            </div>

            <div className="p-5 bg-slate-900 border border-slate-800 rounded-xl">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>Response SLA (P90 Latency)</span>
                <Clock className="w-4 h-4 text-purple-400" />
              </div>
              <div className="text-3xl font-bold text-slate-100 mt-2">
                {data?.latency?.p90Seconds || 0}s
              </div>
              <div className="text-xs text-slate-400 mt-2">
                P50: {data?.latency?.p50Seconds || 0}s · Avg: {data?.latency?.avgSeconds || 0}s
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* ROI Scorecard Table */
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          <div className="p-4 border-b border-slate-800">
            <h3 className="text-sm font-semibold text-slate-200">AI Employee Value Contribution</h3>
            <p className="text-xs text-slate-400 mt-0.5">Calculated based on $35/hr equivalent human labor wage.</p>
          </div>

          <table className="w-full text-left text-xs">
            <thead className="bg-slate-800/60 text-slate-400 uppercase tracking-wider">
              <tr>
                <th className="p-3">Employee</th>
                <th className="p-3">Role</th>
                <th className="p-3">Inquiries Handled</th>
                <th className="p-3">Hours Saved</th>
                <th className="p-3">Estimated Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 text-slate-300">
              {roiData.map((emp) => (
                <tr key={emp.id} className="hover:bg-slate-800/30">
                  <td className="p-3 font-semibold text-slate-200">{emp.employee_name}</td>
                  <td className="p-3 text-slate-400">{emp.employee_role}</td>
                  <td className="p-3">{emp.conversations_handled}</td>
                  <td className="p-3">{emp.hours_saved} hrs</td>
                  <td className="p-3 font-semibold text-emerald-400">${emp.estimated_savings_usd}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

---

## Fix priority

- **P0**: Add date range boundaries to the unindexed LATERAL latency scan to prevent database pool exhaustion and connection timeouts.
- **P0**: Unify the contradictory definitions of "Automation Rate" across the Home overview and Analytics pages.
- **P1**: Build UI visualization for the orphaned `/api/analytics/roi` endpoint to display hours saved and pipeline attributed to AI employees.
- **P1**: Add date-range picker (`24h`, `7d`, `30d`, `90d`) to the analytics interface.
- **P2**: Deploy `041_analytics_rollups_and_percentiles.sql` and scheduled background workers for daily rollups.
- **P2**: Implement streaming CSV and PDF data export capabilities.
