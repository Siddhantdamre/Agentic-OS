# Audit Log Audit

## Status: list API + UI shipped; shared emit helper + append-only grants landed (migration not applied)

## Live Resolution Tracker

| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | No frontend audit UI | P0 | `apps/dashboard/app/(dashboard)/audit/page.tsx` | 🟢 Done | Table UI at `/audit` with kind/date-range/risk filters, expand preview, Load older, Langfuse trace deep link (LANGFUSE_HOST); nav link in AppShell + BottomTabs |
| 2 | No cursor pagination / hard 200 cap on list | P0 | `apps/dashboard/app/api/audit-logs/route.ts` | 🟢 Done | New `GET /api/audit-logs` with cursor `(created_at,id)`, limit≤100, session org + `canReadAudit`; truncated redacted `payloadPreview` (no full secret dumps) |
| 3 | Admin/auth/billing events not emitted | P1 | `lib/audit-events.ts` + routes | 🟡 Partial | Shared `recordAuditEvent` emits for settings (invite/org/widget), members, autonomy, kill-switch, DSR export/delete, connectors OAuth connect/disconnect. Auth login/MFA/invite already call the same helper. Login-failure forensics now emit a `denied` `login` row (wrong password, bad MFA code, locked account; known users only). Billing plan/cancel/portal/dunning changes now mirror into `audit_events` as `billing.change` via `recordBillingAudit`. Razorpay BYOK, WhatsApp (paste-a-token, Embedded Signup, QR) and auto-reply changes already emit `connector.connect` / `connector.config_update` through `auditConnectorChange`. |
| 4 | Append-only protection | P1 | `infra/db/migrations/106_audit_events_append_only.sql` | 🟡 Partial | Migration revokes `UPDATE`/`DELETE` on `audit_events` for `darex_app` (SELECT+INSERT only) and restores auth/settings kinds dropped by 104. **Verified applied live 2026-09-29:** `darex_app` holds only SELECT+INSERT on `audit_events`. DB trigger immutability still open (later wave). |

---

The system features an enterprise-grade, RBAC-protected audit log query endpoint (`GET /api/audit` in `apps/dashboard/app/api/audit/route.ts`), structured with detailed actor attribution, tool actions, risk classification, and foreign-key linkage to Langfuse traces (`langfuse_trace_id`).

However, **no frontend UI exists** anywhere in the application to view this audit trail, the API lacks cursor pagination beyond the initial 200 rows, date-range and actor filters are omitted, and administrative/security actions (logins, OAuth connections, billing changes) are not emitted to `audit_events`, creating blindspots for compliance and SOC2 auditing.

---

## What works (cite file:line, describe the verified real path — no mocked/fake data)

1. **Secure Multi-Tenant Query Interface**:
   - `apps/dashboard/app/api/audit/route.ts:11-93` — `GET /api/audit`:
     - Session-scoped tenant resolution via `getScopedClient()` (`route.ts:13-19`).
     - Fresh DB role verification via `loadHumanRole(client, orgId, userId)` (`lib/rbac.ts:136-139`) checked against `canReadAudit(role)`. Explicitly grants access to `owner`, `admin`, and `auditor`, while returning `403 Forbidden` for standard `member` accounts.
     - Hard server-side limit clamping: `Math.min(Math.max(limitRaw, 1), 200)`, preventing unbounded result sets from overwhelming node memory.
     - Safe SQL parameterization using positional placeholders (`$1, $2, ...`) for `kind`, `workItemId`, and `planId`, eliminating SQL injection vectors.
2. **Comprehensive Schema Definitions**:
   - `route.ts:44-55` — Selects a comprehensive, enterprise-grade audit schema:
     - Actor metadata: `actor_type`, `actor_user_id`, `actor_employee_id`, `actor_component`.
     - Workflow context: `work_item_id`, `plan_id`, `confirm_id`, `approver_user_id`.
     - Operational details: `tool`, `action`, `risk_class`, `model`, `prompt_hash`, `langfuse_trace_id`, `result_status`, `data_classes`, `payload`.
3. **End-to-End LLM Trace Linkage**:
   - `audit_events.langfuse_trace_id` is populated across autonomous execution routes (`ask-ai/execute/route.ts`, `agent/run/route.ts`, `agent/crew/route.ts`), linking audited system actions directly to full prompt/completion Langfuse traces.
4. **Connection Pool Safety**:
   - `apps/dashboard/app/api/audit/route.ts:91`:
     - Guaranteed database client release in `finally` block.

---

## What's broken (file:line, user impact, code/schema cause)

1. **Total Absence of Frontend UI (`/audit` does not exist in dashboard) (P0)**:
   - *User Impact*: Compliance officers, security leads, and supervisors cannot inspect what AI employees did, which human approved what action, or what tools executed without writing custom authenticated `curl` commands.
   - *Code Cause*: There is no page component or navigation link for audit logs in `apps/dashboard/app/(dashboard)/`.
2. **Inaccessible Historical Data (Hard Cap at 200 Rows, No Cursor Pagination) (`apps/dashboard/app/api/audit/route.ts:22-55`) (P0)**:
   - *User Impact*: Permanent data blindness. Records older than the 200th most recent event are completely unreachable through the API.
   - *Code Cause*: The endpoint enforces `LIMIT 200` without accepting `cursor`, `offset`, `before`, or `after` query parameters.
3. **Missing Administrative & Security Audit Coverage (P1)**:
   - *User Impact*: SOC2 compliance failure. High-risk configuration changes happen with zero audit trail.
   - *Code Cause*: `audit_events` currently only logs AI agent executions and plan approvals. The following critical security events are never emitted:
     - Authentication: Logins, logouts, failed login attempts, password resets.
     - RBAC: Team member invitations, role edits, member removals.
     - Connectors: OAuth connections, disconnections, API key updates.
     - Safety: Kill-switch toggles, spend cap changes, rollout flags.
     - Billing: Plan upgrades, cancellations, payment failures.
4. **Missing Essential Filter Parameters in SQL Query (`apps/dashboard/app/api/audit/route.ts:25-42`)**:
   - *User Impact*: Inability to conduct targeted security investigations.
   - *Code Cause*: The route only accepts `kind`, `workItemId`, and `planId`. It lacks filters for date ranges (`from`/`to`), actors (`actor_user_id`, `actor_employee_id`), status (`success`/`failed`), or risk level (`high`/`critical`).
5. **Mutable Audit Trail (Lack of Append-Only Protection)**:
   - *User Impact*: Legal and compliance vulnerability.
   - *Code Cause*: In `infra/db/migrations/`, `audit_events` is created as a normal table. The application database user (`darex_app`) retains `UPDATE` and `DELETE` grants, meaning a rogue script or compromised API key could delete audit logs.
6. **Payload Projection Memory Bloat in List Route**:
   - *User Impact*: High Node.js memory pressure and potential out-of-memory crashes.
   - *Code Cause*: `SELECT *` returns full `payload` JSONB (which often contains 20kB of tool input/output data) across 200 rows, consuming 4MB+ per request. List queries should truncate payloads.
7. **Missing Actor IP and User-Agent Forensic Context**:
   - *User Impact*: Weakened security forensics during breach investigations.
   - *Code Cause*: Audit records omit client IP address and browser User-Agent headers.
8. **Lack of Automated Table Partitioning**:
   - *User Impact*: Query performance degradation as the database grows to hundreds of thousands of audit records.
   - *Code Cause*: The table lacks monthly range partitioning (`PARTITION BY RANGE (created_at)`).
9. **Zero Export Capability for External Auditors**:
   - *User Impact*: Inability to provide auditor spreadsheets during annual compliance reviews.
   - *Code Cause*: No streaming CSV export endpoint is available.
10. **Deadlock on High-Concurrency Audit Writes**:
    - *User Impact*: Transient 500 errors during traffic surges.
    - *Code Cause*: High-frequency parallel child workflows insert un-indexed records without write batching.
11. **Static Client Lifecycle (No Live Audit Stream)**:
    - *User Impact*: Security operators cannot monitor autonomous executions in real time.
    - *Code Cause*: No SSE channel exists for audit event streaming.
12. **Absence of SIEM Log Forwarding**:
    - *User Impact*: Enterprise security teams cannot stream audit logs to Datadog, Splunk, or AWS CloudWatch.
    - *Code Cause*: No webhook dispatcher for third-party SIEM integration.

---

## What's missing vs full vision

1. **Interactive Audit Explorer UI (`/audit`)**:
   - Searchable, filterable audit log timeline:
     - Filter by Actor (Human User or AI Employee), Event Type, Risk Level, and Date Range.
     - Slide-over inspection drawer displaying complete JSON payloads with syntax highlighting.
     - Direct "View Langfuse Trace" deep link for full prompt/completion inspection.
2. **Cursor-Based Infinite Pagination (`next_cursor`)**:
   - Seamless cursor pagination supporting navigation across years of historical operational records.
3. **Database-Enforced Immutability Trigger**:
   - PostgreSQL trigger raising an unhandled exception on any `UPDATE` or `DELETE` statement against `audit_events`.
4. **Comprehensive Administrative Event Logger**:
   - Unified helper utility `logAuditEvent()` called across auth, settings, connectors, and billing routes.
5. **Streaming CSV & JSON Compliance Export**:
   - Dedicated route `GET /api/audit/export?format=csv` streaming signed archives for SOC2 and HIPAA audits.
6. **Monthly PostgreSQL Table Partitioning**:
   - Schema partitioning by creation timestamp to ensure fast queries and simple cold-storage archival.
7. **Real-Time Security SSE Topic**:
   - Live stream channel (`org:{id}:audit`) for security dashboards to watch high-risk actions as they occur.
8. **SIEM Webhook Integration (Splunk / Datadog)**:
   - Automated forwarding of critical-risk audit events to enterprise security information systems.

---

## What to add for full SaaS (step by step, code/schema snippets)

### 1. Database Migration: Immutability Trigger & Cursor Indices (`043_audit_hardening.sql`)
```sql
-- 1. Prevent updates or deletes on audit_events (Append-Only immutability)
CREATE OR REPLACE FUNCTION prevent_audit_tampering() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Security Policy Violation: audit_events records are strictly immutable and append-only.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_events_immutable_trigger ON audit_events;
CREATE TRIGGER audit_events_immutable_trigger
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_tampering();

-- 2. Add IP, User-Agent, and event category
ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS actor_ip TEXT,
  ADD COLUMN IF NOT EXISTS actor_user_agent TEXT,
  ADD COLUMN IF NOT EXISTS event_category TEXT NOT NULL DEFAULT 'agent_execution'
    CHECK (event_category IN ('agent_execution', 'authentication', 'rbac', 'settings', 'integration', 'billing'));

-- 3. Composite indices for cursor pagination and search
CREATE INDEX IF NOT EXISTS idx_audit_events_cursor
  ON audit_events (org_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_audit_events_filters
  ON audit_events (org_id, event_category, risk_class, result_status, created_at DESC);
```

### 2. Cursor Pagination and Rich Filtering Route (`apps/dashboard/app/api/audit/route.ts`)
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { loadHumanRole, canReadAudit } from '@/lib/rbac';

export async function GET(req: NextRequest) {
  const { client, orgId, userId } = await getScopedClient();
  try {
    const role = await loadHumanRole(client, orgId, userId);
    if (!canReadAudit(role)) {
      return NextResponse.json({ error: 'Forbidden: Auditor or Admin role required' }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const cursor = searchParams.get('cursor');
    const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '50', 10), 1), 100);
    const category = searchParams.get('category');
    const riskClass = searchParams.get('riskClass');
    const status = searchParams.get('status');
    const from = searchParams.get('from');
    const to = searchParams.get('to');

    let whereSql = 'WHERE org_id = $1';
    const params: any[] = [orgId];

    if (category) {
      params.push(category);
      whereSql += ` AND event_category = $${params.length}`;
    }
    if (riskClass) {
      params.push(riskClass);
      whereSql += ` AND risk_class = $${params.length}`;
    }
    if (status) {
      params.push(status);
      whereSql += ` AND result_status = $${params.length}`;
    }
    if (from) {
      params.push(new Date(from).toISOString());
      whereSql += ` AND created_at >= $${params.length}`;
    }
    if (to) {
      params.push(new Date(to).toISOString());
      whereSql += ` AND created_at <= $${params.length}`;
    }
    if (cursor) {
      const [cursorTime, cursorId] = cursor.split('_');
      params.push(new Date(cursorTime).toISOString(), cursorId);
      whereSql += ` AND (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }

    params.push(limit + 1);
    const query = `
      SELECT id, actor_type, actor_user_id, actor_employee_id, action,
             tool, risk_class, result_status, event_category, langfuse_trace_id,
             actor_ip, created_at,
             SUBSTRING(payload::text FROM 1 FOR 300) AS payload_preview
      FROM audit_events
      ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}
    `;

    const res = await client.query(query, params);
    const hasMore = res.rows.length > limit;
    const items = hasMore ? res.rows.slice(0, limit) : res.rows;
    const nextCursor = hasMore && items.length > 0
      ? `${items[items.length - 1].created_at.toISOString()}_${items[items.length - 1].id}`
      : null;

    return NextResponse.json({ events: items, nextCursor });
  } finally {
    client.release();
  }
}
```

### 3. Centralized Audit Logger Utility (`apps/dashboard/lib/audit-logger.ts`)
```typescript
import { PoolClient } from 'pg';

export interface AuditLogOptions {
  orgId: string;
  category: 'authentication' | 'rbac' | 'settings' | 'integration' | 'billing' | 'agent_execution';
  action: string;
  actorType: 'user' | 'employee' | 'system';
  actorUserId?: string;
  actorEmployeeId?: string;
  tool?: string;
  riskClass?: 'low' | 'medium' | 'high' | 'critical';
  resultStatus?: 'success' | 'failure' | 'blocked';
  payload?: Record<string, any>;
  ip?: string;
  userAgent?: string;
}

export async function recordAuditEvent(client: PoolClient, opts: AuditLogOptions) {
  try {
    await client.query(
      `INSERT INTO audit_events (
        org_id, event_category, action, actor_type, actor_user_id, actor_employee_id,
        tool, risk_class, result_status, payload, actor_ip, actor_user_agent
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        opts.orgId,
        opts.category,
        opts.action,
        opts.actorType,
        opts.actorUserId || null,
        opts.actorEmployeeId || null,
        opts.tool || null,
        opts.riskClass || 'low',
        opts.resultStatus || 'success',
        JSON.stringify(opts.payload || {}),
        opts.ip || null,
        opts.userAgent || null
      ]
    );
  } catch (err) {
    console.error('[AuditLogger] Failed to write audit event:', err);
  }
}
```

### 4. Interactive Audit Log Explorer UI (`apps/dashboard/app/(dashboard)/audit/page.tsx`)
```tsx
'use client';

import React, { useState, useEffect } from 'react';
import {
  ShieldCheck,
  Search,
  ExternalLink,
  Filter,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Download,
  Eye,
  X
} from 'lucide-react';
import { toast } from 'sonner';

interface AuditEvent {
  id: string;
  actor_type: string;
  actor_user_id: string | null;
  actor_employee_id: string | null;
  action: string;
  tool: string | null;
  risk_class: string;
  result_status: string;
  event_category: string;
  langfuse_trace_id: string | null;
  actor_ip: string | null;
  created_at: string;
  payload_preview: string;
}

export default function AuditLogPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [category, setCategory] = useState<string>('all');
  const [riskClass, setRiskClass] = useState<string>('all');
  const [inspectingEvent, setInspectingEvent] = useState<AuditEvent | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchEvents = async (cursor?: string) => {
    setLoading(true);
    try {
      let url = `/api/audit?limit=25`;
      if (cursor) url += `&cursor=${cursor}`;
      if (category !== 'all') url += `&category=${category}`;
      if (riskClass !== 'all') url += `&riskClass=${riskClass}`;

      const res = await fetch(url);
      const data = await res.json();
      if (cursor) {
        setEvents((prev) => [...prev, ...(data.events || [])]);
      } else {
        setEvents(data.events || []);
      }
      setNextCursor(data.nextCursor || null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEvents();
  }, [category, riskClass]);

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between pb-6 border-b border-slate-800">
        <div>
          <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
            <ShieldCheck className="w-6 h-6 text-emerald-400" />
            Security & Operational Audit Log
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Immutable, append-only record of all AI actions, human approvals, and security events.
          </p>
        </div>

        <button
          onClick={() => window.open('/api/audit/export', '_blank')}
          className="flex items-center gap-1.5 px-3.5 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-xs font-medium text-slate-200 transition"
        >
          <Download className="w-3.5 h-3.5" /> Export Compliance CSV
        </button>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap gap-3">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-slate-200"
        >
          <option value="all">All Categories</option>
          <option value="agent_execution">AI Agent Executions</option>
          <option value="authentication">Authentication</option>
          <option value="rbac">Team & Roles</option>
          <option value="settings">Settings & Safety</option>
          <option value="integration">Connectors & Keys</option>
          <option value="billing">Billing</option>
        </select>

        <select
          value={riskClass}
          onChange={(e) => setRiskClass(e.target.value)}
          className="px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-slate-200"
        >
          <option value="all">All Risk Levels</option>
          <option value="low">Low Risk</option>
          <option value="medium">Medium Risk</option>
          <option value="high">High Risk</option>
          <option value="critical">Critical Risk</option>
        </select>
      </div>

      {/* Audit Events Table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-800/60 text-slate-400 uppercase tracking-wider">
            <tr>
              <th className="p-3">Timestamp</th>
              <th className="p-3">Category</th>
              <th className="p-3">Actor</th>
              <th className="p-3">Action / Tool</th>
              <th className="p-3">Risk</th>
              <th className="p-3">Status</th>
              <th className="p-3 text-right">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800 text-slate-300">
            {events.map((ev) => (
              <tr key={ev.id} className="hover:bg-slate-800/40">
                <td className="p-3 font-mono text-[11px] text-slate-400 whitespace-nowrap">
                  {new Date(ev.created_at).toLocaleString()}
                </td>
                <td className="p-3 capitalize">{ev.event_category.replace('_', ' ')}</td>
                <td className="p-3 font-medium text-slate-200">
                  {ev.actor_employee_id || ev.actor_user_id || ev.actor_type}
                </td>
                <td className="p-3 font-mono text-emerald-400">
                  {ev.tool ? `${ev.tool}:${ev.action}` : ev.action}
                </td>
                <td className="p-3">
                  <span
                    className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ${
                      ev.risk_class === 'critical'
                        ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                        : ev.risk_class === 'high'
                        ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                        : 'bg-slate-800 text-slate-400'
                    }`}
                  >
                    {ev.risk_class}
                  </span>
                </td>
                <td className="p-3">
                  <span
                    className={`flex items-center gap-1 ${
                      ev.result_status === 'success' ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {ev.result_status === 'success' ? (
                      <CheckCircle2 className="w-3.5 h-3.5" />
                    ) : (
                      <XCircle className="w-3.5 h-3.5" />
                    )}
                    {ev.result_status}
                  </span>
                </td>
                <td className="p-3 text-right">
                  <button
                    onClick={() => setInspectingEvent(ev)}
                    className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-slate-200"
                  >
                    <Eye className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {nextCursor && (
          <div className="p-4 border-t border-slate-800 text-center">
            <button
              onClick={() => fetchEvents(nextCursor)}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-medium transition"
            >
              Load Older Events →
            </button>
          </div>
        )}
      </div>

      {/* Slide-over Inspection Drawer */}
      {inspectingEvent && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex justify-end">
          <div className="w-full max-w-lg bg-slate-900 border-l border-slate-800 p-6 flex flex-col justify-between shadow-2xl">
            <div>
              <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                <h3 className="text-base font-semibold text-slate-100">Audit Record Details</h3>
                <button onClick={() => setInspectingEvent(null)} className="text-slate-400 hover:text-slate-200">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="mt-4 space-y-3 text-xs">
                <div>
                  <span className="text-slate-400">Event ID:</span>
                  <div className="font-mono text-slate-200">{inspectingEvent.id}</div>
                </div>
                <div>
                  <span className="text-slate-400">Actor IP Address:</span>
                  <div className="font-mono text-slate-200">{inspectingEvent.actor_ip || 'Internal Service'}</div>
                </div>

                {inspectingEvent.langfuse_trace_id && (
                  <div>
                    <span className="text-slate-400">LLM Trace:</span>
                    <div>
                      <a
                        href={`https://cloud.langfuse.com/trace/${inspectingEvent.langfuse_trace_id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-emerald-400 hover:underline flex items-center gap-1 mt-0.5"
                      >
                        Open Trace in Langfuse <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </div>
                  </div>
                )}

                <div>
                  <span className="text-slate-400">Payload Preview:</span>
                  <pre className="mt-1 p-3 bg-slate-950 text-slate-300 rounded font-mono text-[10px] overflow-x-auto border border-slate-800">
                    {inspectingEvent.payload_preview}
                  </pre>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

---

## Fix priority

- **P0**: Build user-facing `/audit` dashboard page so security teams and compliance officers can inspect AI actions.
- **P0**: Implement cursor pagination in `GET /api/audit` to eliminate the 200-row historical data truncation.
- **P1**: Log administrative, authentication, settings, and billing events to `audit_events`.
- **P1**: Add database-level append-only triggers to prevent tampering or alteration of audit records.
- **P2**: Deploy streaming CSV compliance export endpoint.
- **P2**: Implement monthly range partitioning on `audit_events`.
