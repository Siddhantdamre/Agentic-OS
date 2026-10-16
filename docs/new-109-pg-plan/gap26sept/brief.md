# Brief Audit

## Status: closed for tracker P0/P1 (inline triage, granular deviation, pagination + tz overnight)

## Live Resolution Tracker
| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | No inline triage on brief cards | P0 | `brief/page.tsx`, `api/brief/[id]/triage` | 🟢 | Approve / Snooze 2h / Dismiss; status update + audit; no tool-executor |
| 2 | Coarse "1 day over" deviation math | P1 | `api/brief/route.ts` `formatDeviation` | 🟢 | Shows `15m` / `2h` / `3d 4h` overdue — never rounds minutes to 1 day |
| 3 | Silent LIMIT 40 / UTC overnight window | P1 | `api/brief/route.ts` GET | 🟢 | `totalOpen` + `truncated`; due_at sort; `tz` overnight window with UTC fallback label |

---

## What works (cite file:line, describe the verified real path — no mocked/fake data)

1. **Multi-Tenant Morning Brief Data Aggregation**:
   - `apps/dashboard/app/api/brief/route.ts:32-115` — `GET /api/brief`:
     - Resolves tenant context securely via `getScopedClient()` session lookup (`route.ts:34`); body/query `orgId` is never accepted.
     - Queries `work_items` with parameterized SQL (`WHERE org_id = $1 AND status IN ('needs_attention', 'waiting_approval')`), prioritizing `needs_attention` items over `waiting_approval`, ordered by `updated_at DESC`.
     - Defensive metadata extraction (`titleFromMetadata`, `detailFromMetadata`, lines 13-30) safely parses nested JSON payloads (`metadata.card.title`, `metadata.card.companyName`, `metadata.card.situation`, `metadata.card.whyNow`) with clean fallbacks to `row.type` and `row.status`.
     - Computes `handledOvernight` through an actual SQL aggregation: `SELECT COUNT(*) FROM work_items WHERE org_id = $1 AND status IN ('done', 'cancelled') AND updated_at >= NOW() - INTERVAL '16 hours'`.
     - Gracefully catches missing table exceptions (`42P01` / relation does not exist), preventing crashes during schema migrations or cold starts.
2. **Accessible Client Component**:
   - `apps/dashboard/app/(dashboard)/brief/page.tsx:26-42`:
     - Fetches `/api/brief`, handles loading skeletons, validates array structures, and renders accessible status announcements via `LiveRegion` (`page.tsx:50`).
3. **Integrated Explainability**:
   - `page.tsx:56, 87`:
     - Integrates `ExplainDrawer` with `objectId={item.id}` and `defaultQuery={item.title}`, enabling the user to inspect the underlying agent decision ledger and reasoning.
4. **Honest Empty State**:
   - `page.tsx:65-70`:
     - When zero exceptions exist, it displays "Nothing needs you. {handled} things handled.", aligning strictly with the product principle that handled work remains in background logs.
5. **Connection Pool Safety**:
   - `apps/dashboard/app/api/brief/route.ts:113`:
     - Guaranteed database client release in `finally` block.

---

## What's broken (file:line, user impact, code/schema cause)

1. **Zero Inline Actionability (`apps/dashboard/app/(dashboard)/brief/page.tsx:77-90`)**:
   - *User Impact*: High friction and operational drag. Managers open the morning brief to triage blockers, but cannot take action directly on the screen.
   - *Code Cause*: Exception cards only render informational text and an "Explain" drawer toggle. There are no buttons to "Approve", "Reject", "Snooze", "Reassign", or "Mark Done". Operators are forced to manually copy task IDs and navigate to `/work-items` or `/plans` to unblock agents.
2. **Misleading Coarse Deviation Calculation (`apps/dashboard/app/api/brief/route.ts:65-71`)**:
   - *User Impact*: False operational panic. Tasks overdue by 5 minutes display as `"1 day over"`, desensitizing managers to actual high-priority emergencies.
   - *Code Cause*: The calculation `Math.max(1, Math.round(overdueMs / (24 * 60 * 60 * 1000)))` unconditionally rounds up any positive millisecond value to 1 day. A task due at 7:55 AM inspected at 8:00 AM displays as "1 day over".
3. **Silent Truncation via Hardcoded LIMIT 40 (`apps/dashboard/app/api/brief/route.ts:54`)**:
   - *User Impact*: Critical blockers hidden from operations managers without warning.
   - *Code Cause*: The SQL query enforces `LIMIT 40` with no cursor or offset pagination and no `total_count` returned in the response payload. If an organization accumulates 50 exceptions during a surge, 10 urgent tasks are silently hidden.
4. **Flawed Server-UTC Timezone Assumption for "Overnight" (`apps/dashboard/app/api/brief/route.ts:88-90`)**:
   - *User Impact*: Completely inaccurate "Handled Overnight" counts for international teams.
   - *Code Cause*: `NOW() - INTERVAL '16 hours'` relies on the PostgreSQL server timestamp (UTC). For an organization located in Tokyo (UTC+9) or Sydney (UTC+10), the 16-hour interval captures afternoon business hours rather than the local overnight window.
5. **Suboptimal Sort Ordering (`apps/dashboard/app/api/brief/route.ts:51-54`)**:
   - *User Impact*: Severe blockers buried below trivial recent notifications.
   - *Code Cause*: The query orders by `status ASC, updated_at DESC`. A task overdue by 3 days with a hard client deadline is displayed beneath a non-urgent task updated 30 seconds ago. Urgent overdue items must be sorted by `due_at ASC NULLS LAST`.
6. **Missing Entity Joins & Customer Context (`apps/dashboard/app/api/brief/route.ts:40-55`)**:
   - *User Impact*: Lack of context. Managers cannot tell which customer or AI employee is involved without opening nested inspection panels.
   - *Code Cause*: The query selects only from `work_items` without joining `ai_employees`, `conversations`, or `contacts`.
7. **Static Client Lifecycle (No Real-Time SSE Sync) (`apps/dashboard/app/(dashboard)/brief/page.tsx:26-35`)**:
   - *User Impact*: Stale triage state. Actions taken by automated agents or colleagues in another tab do not update the brief view without a full browser reload.
   - *Code Cause*: Data fetching occurs once inside a React `useEffect` without subscribing to the tenant's Server-Sent Events stream (`/api/stream`).
8. **Weekend Context Amnesia**:
   - *User Impact*: Demoralizing metrics on Monday mornings.
   - *Code Cause*: On Monday at 8 AM, the 16-hour lookback only covers Sunday afternoon, completely discarding dozens of autonomous actions completed by AI employees throughout Friday night and Saturday.
9. **No Audit Event Generation on Triage**:
   - *User Impact*: Inability to trace who approved or dismissed a blocked action.
   - *Code Cause*: Because triage actions are not supported on the brief endpoint, ad-hoc status updates do not record an immutable event in `audit_events`.
10. **Deadlock Risk on Concurrent Batch Approvals**:
    - *User Impact*: HTTP 500 errors when multiple managers triage work items simultaneously.
    - *Code Cause*: Updates to `work_items` do not lock rows in a consistent order (`SELECT ... FOR UPDATE`), risking deadlock under high concurrency.
11. **Metadata Card Schema Inconsistencies**:
    - *User Impact*: Blank cards or ugly JSON fallback strings.
    - *Code Cause*: Different industry packs format `metadata` differently (`situation` vs `summary`, `card.title` vs `label`), leading to missing titles when pack schemas drift.
12. **Absence of Proactive Push Delivery (Slack / Email)**:
    - *User Impact*: Low engagement. Executives rarely log in to a dashboard first thing in the morning; they expect an executive email or Slack digest at 8:00 AM.
    - *Code Cause*: No scheduled background cron workflow exists to format and dispatch the morning digest to external notification channels.

---

## What's missing vs full vision

1. **Inline Triage Actions Bar on Cards**:
   - One-click buttons directly on each card:
     - `Approve Action`: Executes the pending autonomous tool step immediately.
     - `Snooze`: Snooze for 2 hours, until 2 PM, or tomorrow morning.
     - `Reassign to Human`: Transfers conversation/task ownership to a specific team member.
     - `Mark Resolved`: Dismisses the exception with a mandatory reason note.
2. **Proactive Morning Brief Push Delivery (Email & Slack)**:
   - Automated 8:00 AM local time dispatch via Temporal Cron Workflow:
     - Slack Block Kit message sent to `#ops-daily`.
     - Responsive HTML email digest sent to workspace owners and department heads.
3. **Smart Timezone & Last-Seen Lookback Engine**:
   - Dynamically calculates handled work since the user's actual `last_session_at` timestamp rather than a naive 16-hour UTC offset, providing an authentic Monday morning recap.
4. **Department and AI Employee Filtering Tabs**:
   - Quick-filter chips at the top of `/brief`: `All (12)`, `Leasing (5)`, `Sales (4)`, `Overdue (3)`, `My Approvals (2)`.
5. **Real-Time Stream Synchronization**:
   - Automatic card removal or update via SSE when an item is resolved in real time.
6. **Executive Audio Briefing**:
   - 60-second synthesized audio summary ("Good morning! Overnight, Sarah handled 14 tenant inquiries and booked 3 showings. 2 lease renewals require your signature today.") generated via ElevenLabs.
7. **Historical Resolution Velocity Analytics**:
   - Visual trend line showing average time-to-triage and resolution volume over the last 30 days.

---

## What to add for full SaaS (step by step, code/schema snippets)

### 1. Database Migration: Brief Indices & Preferences (`034_brief_enhancements.sql`)
```sql
-- 1. Index for fast brief queries and priority sorting
CREATE INDEX IF NOT EXISTS idx_work_items_brief_lookup
  ON work_items (org_id, status, due_at ASC NULLS LAST, updated_at DESC)
  WHERE status IN ('needs_attention', 'waiting_approval');

-- 2. Index for overnight / since last seen metrics
CREATE INDEX IF NOT EXISTS idx_work_items_handled_lookup
  ON work_items (org_id, status, updated_at DESC)
  WHERE status IN ('done', 'cancelled');

-- 3. Add last seen timestamp to users
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_brief_viewed_at TIMESTAMPTZ;

-- 4. Add brief delivery preferences to org_settings
ALTER TABLE orgs
  ADD COLUMN IF NOT EXISTS brief_settings JSONB NOT NULL DEFAULT '{
    "slack_channel": null,
    "email_recipients": [],
    "delivery_time": "08:00",
    "enabled": false
  }'::jsonb;
```

### 2. Dedicated Inline Triage API Route (`apps/dashboard/app/api/brief/[id]/triage/route.ts`)
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { executeAutonomousToolAction } from '@darex/workflows';

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { client, orgId, userId } = await getScopedClient();
  try {
    const { action, snoozeDuration, note, reassignedTo } = await req.json();
    const itemId = params.id;

    // 1. Fetch item with lock
    const itemRes = await client.query(
      `SELECT * FROM work_items WHERE id = $1 AND org_id = $2 FOR UPDATE`,
      [itemId, orgId]
    );

    if (itemRes.rowCount === 0) {
      return NextResponse.json({ error: 'Work item not found' }, { status: 404 });
    }

    const item = itemRes.rows[0];

    if (action === 'approve') {
      // Execute the pending tool action if stored in metadata
      if (item.metadata?.pending_tool_action) {
        await executeAutonomousToolAction(
          orgId,
          item.metadata.pending_tool_action.toolName,
          item.metadata.pending_tool_action.input
        );
      }

      await client.query(
        `UPDATE work_items
         SET status = 'done',
             metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{resolved_by}', $1::jsonb),
             updated_at = NOW()
         WHERE id = $2`,
        [JSON.stringify({ userId, action: 'approved', note: note || null }), itemId]
      );
    } else if (action === 'snooze') {
      const hours = snoozeDuration === 'tomorrow' ? 24 : snoozeDuration === 'afternoon' ? 4 : 2;
      await client.query(
        `UPDATE work_items
         SET due_at = NOW() + ($1 || ' hours')::interval,
             updated_at = NOW()
         WHERE id = $2`,
        [hours, itemId]
      );
    } else if (action === 'dismiss') {
      await client.query(
        `UPDATE work_items
         SET status = 'cancelled',
             metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{cancelled_by}', $1::jsonb),
             updated_at = NOW()
         WHERE id = $2`,
        [JSON.stringify({ userId, reason: note || 'dismissed_via_brief' }), itemId]
      );
    } else if (action === 'reassign') {
      await client.query(
        `UPDATE work_items
         SET assignee_user_id = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [reassignedTo, itemId]
      );
    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }

    // Record in audit log
    await client.query(
      `INSERT INTO audit_events (org_id, user_id, event_type, payload)
       VALUES ($1, $2, 'brief_item_triaged', $3)`,
      [orgId, userId, JSON.stringify({ itemId, action, note })]
    );

    return NextResponse.json({ success: true, itemId, action });
  } finally {
    client.release();
  }
}
```

### 3. Interactive Morning Brief UI with Inline Triage (`apps/dashboard/app/(dashboard)/brief/page.tsx`)
```tsx
'use client';

import React, { useState, useEffect } from 'react';
import {
  Sun,
  CheckCircle2,
  Clock,
  AlertTriangle,
  ChevronRight,
  Sparkles,
  Check,
  XCircle,
  RotateCw
} from 'lucide-react';
import { toast } from 'sonner';

interface BriefItem {
  id: string;
  type: string;
  title: string;
  detail: string;
  deviation: string;
  dueAt: string | null;
  employeeName: string | null;
  status: 'needs_attention' | 'waiting_approval';
}

export default function MorningBriefPage() {
  const [items, setItems] = useState<BriefItem[]>([]);
  const [handledOvernight, setHandledOvernight] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'needs_attention' | 'waiting_approval'>('all');
  const [actingId, setActingId] = useState<string | null>(null);

  const fetchBrief = async () => {
    try {
      const res = await fetch('/api/brief');
      const data = await res.json();
      setItems(data.items || []);
      setHandledOvernight(data.handledOvernight || 0);
    } catch {
      toast.error('Failed to load morning brief');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBrief();
  }, []);

  const handleTriage = async (id: string, action: 'approve' | 'snooze' | 'dismiss') => {
    setActingId(id);
    try {
      const res = await fetch(`/api/brief/${id}/triage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
      if (res.ok) {
        toast.success(`Item ${action}d successfully`);
        setItems((prev) => prev.filter((item) => item.id !== id));
        if (action === 'approve') setHandledOvernight((prev) => prev + 1);
      } else {
        toast.error(`Failed to ${action} item`);
      }
    } finally {
      setActingId(null);
    }
  };

  const filteredItems = items.filter((item) => {
    if (filter === 'all') return true;
    return item.status === filter;
  });

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="flex items-center justify-between pb-6 border-b border-slate-800">
        <div>
          <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
            <Sun className="w-6 h-6 text-amber-400" />
            Morning Brief
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Review exceptions requiring executive human oversight.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-xs text-slate-400">Autonomous Progress</div>
            <div className="text-sm font-semibold text-emerald-400">
              {handledOvernight} actions handled overnight
            </div>
          </div>
          <button
            onClick={fetchBrief}
            className="p-2 text-slate-400 hover:text-slate-200 bg-slate-800/80 hover:bg-slate-700/80 rounded-lg border border-slate-700 transition"
          >
            <RotateCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex gap-2 my-6">
        <button
          onClick={() => setFilter('all')}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
            filter === 'all' ? 'bg-slate-800 text-white border border-slate-700' : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          All Exceptions ({items.length})
        </button>
        <button
          onClick={() => setFilter('needs_attention')}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
            filter === 'needs_attention'
              ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          Needs Attention ({items.filter((i) => i.status === 'needs_attention').length})
        </button>
        <button
          onClick={() => setFilter('waiting_approval')}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
            filter === 'waiting_approval'
              ? 'bg-blue-500/10 text-blue-400 border border-blue-500/30'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          Waiting Approval ({items.filter((i) => i.status === 'waiting_approval').length})
        </button>
      </div>

      {/* Cards List */}
      {filteredItems.length === 0 ? (
        <div className="text-center py-16 bg-slate-900/40 rounded-xl border border-slate-800/80">
          <CheckCircle2 className="w-10 h-10 text-emerald-400 mx-auto mb-3" />
          <h3 className="text-base font-semibold text-slate-200">Nothing needs you</h3>
          <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
            All AI employee workflows are operating within normal parameters.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {filteredItems.map((item) => (
            <div
              key={item.id}
              className="p-5 rounded-xl bg-slate-900/60 border border-slate-800 hover:border-slate-700 transition"
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-slate-400 bg-slate-800 px-2 py-0.5 rounded">
                      {item.employeeName || 'AI Agent'}
                    </span>
                    <span className="text-xs text-amber-400 font-medium">{item.deviation}</span>
                  </div>
                  <h4 className="text-sm font-semibold text-slate-200 mt-1.5">{item.title}</h4>
                  <p className="text-xs text-slate-400 mt-1">{item.detail}</p>
                </div>
              </div>

              {/* Inline Action Controls */}
              <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between">
                <div className="text-xs text-slate-500">ID: {item.id.slice(0, 8)}...</div>
                <div className="flex items-center gap-2">
                  <button
                    disabled={actingId === item.id}
                    onClick={() => handleTriage(item.id, 'dismiss')}
                    className="flex items-center gap-1 px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 bg-slate-800/60 hover:bg-slate-800 rounded-lg border border-slate-700/60 transition"
                  >
                    <XCircle className="w-3.5 h-3.5" /> Dismiss
                  </button>
                  <button
                    disabled={actingId === item.id}
                    onClick={() => handleTriage(item.id, 'snooze')}
                    className="flex items-center gap-1 px-3 py-1.5 text-xs text-slate-300 hover:text-slate-100 bg-slate-800 hover:bg-slate-700 rounded-lg border border-slate-700 transition"
                  >
                    <Clock className="w-3.5 h-3.5" /> Snooze 2h
                  </button>
                  <button
                    disabled={actingId === item.id}
                    onClick={() => handleTriage(item.id, 'approve')}
                    className="flex items-center gap-1 px-3.5 py-1.5 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg shadow-sm transition"
                  >
                    <Check className="w-3.5 h-3.5" /> Approve Action
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

---

## Fix priority

- **P0**: Implement inline triage controls (`Approve`, `Snooze`, `Dismiss`) directly on brief cards to unblock agent workflows.
- **P0**: Build `/api/brief/[id]/triage` endpoint to execute approved actions and update work item statuses atomically.
- **P1**: Replace coarse deviation math with granular formatting (`"15m overdue"`, `"2h overdue"`) to prevent false operational alarms.
- **P1**: Remove hardcoded `LIMIT 40` truncation ceiling and implement pagination metadata.
- **P1**: Factor in tenant-specific IANA timezones when calculating handled overnight metrics.
- **P2**: Deploy scheduled Temporal Cron Workflow to deliver Morning Brief digests to Slack and Email.
- **P2**: Add real-time SSE stream listeners to auto-dismiss cards when resolved by peer workers.
