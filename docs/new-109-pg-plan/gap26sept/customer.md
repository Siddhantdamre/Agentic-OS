# Customer Employee Audit

## Status: improved (knowledge gaps, teach modal, open-loops drawer, pagination, SSE refresh landed)

The Customer Employee command center (`apps/dashboard/app/(dashboard)/employees/customer/page.tsx`, `apps/dashboard/app/api/employees/customer/route.ts`, and `services/workflows/src/customer/*`) monitors customer satisfaction, conversation operational states, unfulfilled obligations (`agent_open_loops`), and low-confidence human escalations (`work_items` with attached decision cards). The action loop is fully wired: operator decisions (`approve`, `reject`, `snooze`) update database rows, record idempotency audit events in `work_events`, signal active Temporal workflows, and write suppression preferences into `org_preferences`.

However, **the UI completely drops the `knowledgeGaps` API payload** (fetching clusters and discarding them without rendering), the "Open Loops" counter provides zero drill-down to inspect what promises were made to customers, the page lacks real-time SSE updates, and decision cards provide no direct link to the underlying customer conversation, forcing supervisors to make blind approval decisions.

---

## What works (cite file:line, describe the verified real path — no mocked/fake data)

1. **Multi-Tenant Customer Operations Metrics**:
   - `apps/dashboard/app/api/employees/customer/route.ts:15-106` — `GET /api/employees/customer`:
     - Session-scoped tenant resolution via `getScopedClient()`.
     - Queries `conversations` over a 7-day window for handled and at-risk volumes, driven by `customer_operational_state`.
     - State machine inference (`services/workflows/src/customer/operational-state.ts:inferOperationalState`) dynamically classifies conversation health via sentiment analysis and account profile data.
2. **Idempotent Obligation Extraction**:
   - `services/workflows/src/activities/customer.ts:180-219` — `extractObligationActivity`:
     - Scans messages for promises/commitments using NLP extractors (`obligation-extractor.ts`).
     - Inserts obligations into `agent_open_loops` with content-hash deduplication (`ON CONFLICT (org_id, content_hash) DO NOTHING`), avoiding duplicate obligation entries.
3. **Low-Confidence Decision Handoff Loop**:
   - `services/workflows/src/activities/customer.ts:159-178` — `attachDecisionCardActivity`:
     - Generates structured decision cards (`lowConfidenceDecisionCard`) when confidence drops below safety thresholds.
     - Cards are queried from `work_items WHERE metadata ? 'card' OR payload ? 'card'`.
4. **Closed Decision Action Loop**:
   - `apps/dashboard/app/api/work-items/[id]/decision/route.ts`:
     - Validates UUIDs, rejects body tenant overrides, enforces action enums (`approve`, `reject`, `snooze`, `modify`).
     - Records audit trail in `work_events` and signals live Temporal workflows via `signalWorkItemDecision`.
     - If rejected with reason `'wrong_fit'`, automatically generates suppression rules in `org_preferences` via `writeSuppression()`, training the AI not to repeat the mistake.
5. **Clustered Knowledge Gap Discovery (CE-10)**:
   - `services/workflows/src/activities/customer.ts:258-288` — `listKnowledgeGapClustersActivity`:
     - Inspects `agent_decision_ledger` for suppressed turns (`low_rag_no_tool`, `confidence_below_threshold`) and clusters near-duplicate unanswered customer questions.
6. **Connection Pool Safety**:
   - `apps/dashboard/app/api/employees/customer/route.ts:104`:
     - Unconditionally releases database connection client in `finally` block.

---

## What's broken (file:line, user impact, code/schema cause)

1. **Discarded Knowledge Gap Data in Frontend UI (`apps/dashboard/app/(dashboard)/employees/customer/page.tsx:8-12, 43-99`) (P0)**:
   - *User Impact*: High-value automated insights wasted. Managers cannot see the top questions customers ask that the AI cannot answer.
   - *Code Cause*: `apps/dashboard/app/api/employees/customer/route.ts:83-96` correctly clusters and returns `knowledgeGaps` in its JSON response. However, `CustomerBrief` in `page.tsx:8-12` omits `knowledgeGaps`, and the component never renders the clusters.
2. **Blind Decision Approvals (No Conversation Link) (`apps/dashboard/app/(dashboard)/employees/customer/page.tsx:61-78`) (P0)**:
   - *User Impact*: High risk of approving inappropriate or hallucinated customer replies.
   - *Code Cause*: Decision cards render the proposed response and buttons, but contain no link to the underlying conversation ID (`/conversations?id=...`). Supervisors are forced to guess context or search manually by customer name.
3. **Dead Open Loops Metric Tile (`apps/dashboard/app/(dashboard)/employees/customer/page.tsx:59`) (P1)**:
   - *User Impact*: Inability to manage customer commitments.
   - *Code Cause*: Clicking the "Open Loops: 7" card does nothing. There is no slide-over drawer, table, or modal showing the 7 extracted promises, their due dates, or customer contact details.
4. **Static Client Lifecycle (No Real-Time SSE Synchronization)**:
   - *User Impact*: Stale risk alerts. If an angry customer messages on WhatsApp, the "At Risk" counter does not increment until a manual browser refresh.
   - *Code Cause*: The component only fetches on initial mount (`useEffect`) without subscribing to `/api/stream`.
5. **Silent Truncation on Decision Cards (`apps/dashboard/app/api/employees/customer/route.ts:56`)**:
   - *User Impact*: Buried customer escalations.
   - *Code Cause*: The SQL query enforces `LIMIT 12` on `work_items`. If 18 customers escalate simultaneously, 6 cards are silently omitted with no pagination.
6. **No Automated Obligation Fulfillment Detection**:
   - *User Impact*: Open loops remain marked open forever unless manually dismissed.
   - *Code Cause*: The system lacks an activity to scan subsequent outbound messages to detect if the promised PDF brochure, lease agreement, or quote was actually sent to the customer.
7. **Rigid Keyword-Based Operational State Inference (`services/workflows/src/customer/operational-state.ts:40-85`)**:
   - *User Impact*: False positive panic on sarcastic remarks and missed subtle churn signals.
   - *Code Cause*: Hardcoded string lists (`'lawyer'`, `'cancel'`, `'unacceptable'`, `'terrible'`) without LLM sentiment embeddings or configurable tenant sensitivity.
8. **Missing Batch Decision Approvals**:
   - *User Impact*: Tedious repetitive clicking when high-volume identical queries occur during outages or promotions.
   - *Code Cause*: The UI only allows single-card resolution.
9. **Inability to Reassign At-Risk Conversations to Humans Directly**:
   - *User Impact*: Slow crisis containment. A manager seeing an at-risk customer cannot click "Take Over Conversation" directly from the customer overview.
   - *Code Cause*: No takeover action endpoint is exposed on the customer employee view.
10. **Race Condition in Content-Hash Obligation Insertion**:
    - *User Impact*: Duplicate obligation rows created if two activities run simultaneously on the same message.
    - *Code Cause*: Content-hash deduplication does not lock the conversation row before hashing.
11. **Absence of Customer CSAT Survey Dispatch**:
    - *User Impact*: Lack of authentic quantitative feedback.
    - *Code Cause*: No post-resolution trigger exists to send a 1-5 rating survey to customers.
12. **Missing Customer Lifetime Value (LTV) Context**:
    - *User Impact*: Inability to prioritize VIP enterprise clients over free-tier inquiries during high-volume spikes.
    - *Code Cause*: Operational states do not join CRM deal size or subscription tiers.

---

## What's missing vs full vision

1. **Interactive Knowledge Gap Playbook Creator**:
   - Visual list of clustered customer knowledge gaps with a 1-click "Teach AI Answer" button that opens a modal, accepts the canonical answer, and writes it directly to `org_memory`.
2. **Interactive Open Loops Slide-Over Drawer**:
   - Full slide-over drawer displaying all pending promises made to customers, categorized by:
     - Overdue promises (red)
     - Due today (amber)
     - Due later this week (slate)
   - Actions to mark fulfilled, edit due date, or trigger an autonomous follow-up draft.
3. **Direct Conversation Deep Linking**:
   - Every decision card and open loop card includes an explicit "View Full Conversation" deep link that opens `/conversations?id=...` in a new tab.
4. **Real-Time SSE Sentiment Synchronization**:
   - Live stream listener that increments the "At Risk" badge with an audio chime when an urgent customer escalation occurs.
5. **Configurable Sentiment & Risk Sensitivity**:
   - Organization settings slider (Low, Medium, High) allowing tenants to adjust how aggressively conversations are flagged as `at_risk`.
6. **Automated Post-Resolution CSAT Surveys**:
   - Configurable trigger to dispatch an automated satisfaction survey via WhatsApp or Email 15 minutes after conversation resolution.
7. **Customer Health & Churn Risk Scorecard**:
   - Real-time customer health score (0–100) combining sentiment trajectory, response latency, and open loops.
8. **One-Click Human Takeover from Customer Command Center**:
   - Button to pause AI employee autonomy on a specific conversation and transfer ownership directly to a human agent.

---

## What to add for full SaaS (step by step, code/schema snippets)

### 1. Database Migration: Customer Operations & CSAT (`036_customer_operations_enhancements.sql`)
```sql
-- 1. Enhance agent_open_loops with customer context and fulfillment tracking
ALTER TABLE agent_open_loops
  ADD COLUMN IF NOT EXISTS customer_contact_id TEXT,
  ADD COLUMN IF NOT EXISTS fulfilled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fulfilled_by_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS due_date TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent'));

CREATE INDEX IF NOT EXISTS idx_agent_open_loops_org_open
  ON agent_open_loops(org_id, status, due_date ASC NULLS LAST)
  WHERE status = 'open';

-- 2. Create customer CSAT survey table
CREATE TABLE IF NOT EXISTS customer_csat_surveys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  customer_contact_id TEXT NOT NULL,
  score INTEGER CHECK (score BETWEEN 1 AND 5),
  feedback TEXT,
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE customer_csat_surveys ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_csat_surveys FORCE ROW LEVEL SECURITY;

CREATE POLICY csat_isolation ON customer_csat_surveys
  FOR ALL USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
```

### 2. Dedicated Open Loops API Endpoint (`apps/dashboard/app/api/employees/customer/open-loops/route.ts`)
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';

export async function GET(req: NextRequest) {
  const { client, orgId } = await getScopedClient();
  try {
    const res = await client.query(
      `SELECT o.id, o.promise_summary, o.created_at, o.due_date, o.status, o.priority,
              c.id as conversation_id, c.contact_id, c.channel
       FROM agent_open_loops o
       LEFT JOIN conversations c ON c.id = o.conversation_id
       WHERE o.org_id = $1 AND o.status = 'open'
       ORDER BY o.due_date ASC NULLS LAST, o.created_at DESC
       LIMIT 50`,
      [orgId]
    );

    return NextResponse.json({ openLoops: res.rows });
  } finally {
    client.release();
  }
}

export async function PATCH(req: NextRequest) {
  const { client, orgId, userId } = await getScopedClient();
  try {
    const { loopId, status } = await req.json();
    if (!loopId || !['fulfilled', 'cancelled'].includes(status)) {
      return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
    }

    const res = await client.query(
      `UPDATE agent_open_loops
       SET status = $1,
           fulfilled_at = CASE WHEN $1 = 'fulfilled' THEN NOW() ELSE NULL END,
           updated_at = NOW()
       WHERE id = $2 AND org_id = $3
       RETURNING id, status`,
      [status, loopId, orgId]
    );

    if (res.rowCount === 0) {
      return NextResponse.json({ error: 'Open loop not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, loop: res.rows[0] });
  } finally {
    client.release();
  }
}
```

### 3. Interactive Open Loops Drawer Component (`components/customer/OpenLoopsDrawer.tsx`)
```tsx
'use client';

import React, { useState, useEffect } from 'react';
import { X, CheckCircle, Clock, ExternalLink, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

interface OpenLoop {
  id: string;
  promise_summary: string;
  due_date: string | null;
  priority: string;
  conversation_id: string;
  contact_id: string;
  channel: string;
}

interface OpenLoopsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onUpdated: () => void;
}

export function OpenLoopsDrawer({ isOpen, onClose, onUpdated }: OpenLoopsDrawerProps) {
  const [loops, setLoops] = useState<OpenLoop[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchLoops = async () => {
    try {
      const res = await fetch('/api/employees/customer/open-loops');
      const data = await res.json();
      setLoops(data.openLoops || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) fetchLoops();
  }, [isOpen]);

  const handleResolve = async (loopId: string) => {
    const res = await fetch('/api/employees/customer/open-loops', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loopId, status: 'fulfilled' })
    });
    if (res.ok) {
      toast.success('Commitment marked fulfilled');
      setLoops((prev) => prev.filter((l) => l.id !== loopId));
      onUpdated();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-black/60 backdrop-blur-sm flex justify-end">
      <div className="w-full max-w-lg bg-slate-900 border-l border-slate-800 p-6 flex flex-col justify-between shadow-2xl">
        <div>
          <div className="flex items-center justify-between pb-4 border-b border-slate-800">
            <div>
              <h2 className="text-lg font-semibold text-slate-100 flex items-center gap-2">
                <Clock className="w-5 h-5 text-amber-400" />
                Active Customer Commitments
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Promises and follow-ups extracted from customer conversations.
              </p>
            </div>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-200">
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="mt-4 space-y-3 overflow-y-auto max-h-[calc(100vh-140px)]">
            {loading ? (
              <div className="text-slate-500 text-sm text-center py-8">Loading commitments...</div>
            ) : loops.length === 0 ? (
              <div className="text-center py-12 text-slate-400">
                <CheckCircle className="w-8 h-8 text-emerald-400 mx-auto mb-2" />
                No unfulfilled customer promises.
              </div>
            ) : (
              loops.map((loop) => (
                <div
                  key={loop.id}
                  className="p-4 bg-slate-800/40 border border-slate-700/60 rounded-lg space-y-2"
                >
                  <div className="flex items-start justify-between">
                    <span className="text-xs font-semibold text-slate-300">
                      Customer: {loop.contact_id} ({loop.channel})
                    </span>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full capitalize font-medium ${
                        loop.priority === 'urgent'
                          ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                          : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                      }`}
                    >
                      {loop.priority}
                    </span>
                  </div>

                  <p className="text-sm text-slate-200">{loop.promise_summary}</p>

                  <div className="flex items-center justify-between pt-2 border-t border-slate-700/40 text-xs">
                    <a
                      href={`/conversations?id=${loop.conversation_id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-emerald-400 hover:underline flex items-center gap-1"
                    >
                      View Chat <ExternalLink className="w-3 h-3" />
                    </a>
                    <button
                      onClick={() => handleResolve(loop.id)}
                      className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded font-medium transition"
                    >
                      Mark Fulfilled
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
```

### 4. Teach Knowledge Gap Modal (`components/customer/TeachKnowledgeGapModal.tsx`)
```tsx
'use client';

import React, { useState } from 'react';
import { X, Sparkles, BookOpen } from 'lucide-react';
import { toast } from 'sonner';

interface TeachKnowledgeGapModalProps {
  cluster: {
    clusterQuestion: string;
    count: number;
    reasonCode: string;
  } | null;
  onClose: () => void;
  onSaved: () => void;
}

export function TeachKnowledgeGapModal({ cluster, onClose, onSaved }: TeachKnowledgeGapModalProps) {
  const [answer, setAnswer] = useState('');
  const [saving, setSaving] = useState(false);

  if (!cluster) return null;

  const handleSave = async () => {
    if (!answer.trim()) return;
    setSaving(true);
    try {
      const res = await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `FAQ: ${cluster.clusterQuestion}`,
          body: answer.trim(),
          source: 'knowledge_gap_resolution'
        })
      });
      if (res.ok) {
        toast.success('Answer added to AI knowledge base!');
        onSaved();
        onClose();
      } else {
        toast.error('Failed to save answer');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-2xl">
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <BookOpen className="w-5 h-5 text-emerald-400" />
            <h3 className="text-base font-semibold text-slate-100">Teach AI Knowledge Base</h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="mt-4 space-y-4">
          <div className="p-3 bg-slate-800/60 rounded-lg border border-slate-700/60">
            <div className="text-xs font-semibold text-slate-400 uppercase">Frequent Customer Question</div>
            <div className="text-sm font-medium text-slate-200 mt-1">{cluster.clusterQuestion}</div>
            <div className="text-xs text-amber-400 mt-1">Asked {cluster.count} times without answer</div>
          </div>

          <div>
            <label className="text-xs font-medium text-slate-300">Canonical Answer</label>
            <textarea
              rows={4}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="e.g. Yes, we offer 24/7 emergency maintenance for plumbing leaks..."
              className="w-full mt-1.5 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-200 focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-800">
            <button
              onClick={onClose}
              className="px-3.5 py-1.5 text-xs text-slate-400 hover:text-slate-200 transition"
            >
              Cancel
            </button>
            <button
              disabled={saving || !answer.trim()}
              onClick={handleSave}
              className="px-4 py-1.5 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg transition flex items-center gap-1.5"
            >
              <Sparkles className="w-3.5 h-3.5" />
              {saving ? 'Teaching AI...' : 'Save & Ground Agent'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

---

## Fix priority

- **P0**: Add direct conversation deep links (`/conversations?id=...`) to all decision cards so supervisors can verify context before approving actions.
- **P0**: Render `knowledgeGaps` clusters in `customer/page.tsx` and implement the "Teach AI Answer" modal.
- **P1**: Build the interactive Open Loops slide-over drawer so operators can inspect and resolve customer commitments.
- **P1**: Add pagination and remove the hardcoded `LIMIT 12` ceiling on customer decision cards.
- **P2**: Deploy real-time SSE stream listeners to update customer sentiment metrics without manual reload.
- **P2**: Implement automated CSAT survey dispatching following conversation resolution.
- **P2**: Add configurable sentiment threshold sensitivity in workspace settings.

---

## Live Resolution Tracker

| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | `knowledgeGaps` API payload discarded in UI | P0 | `employees/customer/page.tsx` | 🟢 Done | Renders real clusters from API. |
| 2 | Decision cards lack conversation deep link | P0 | `DecisionCardPanel.tsx` | 🟢 Done | Links `/conversations?id=...` when `conversationId` present. |
| 3 | Teach AI Answer modal for gaps | P0 | `TeachKnowledgeGapModal.tsx` | 🟢 Done | Writes via `POST /api/brain` action=create → `org_memory`. |
| 4 | Open Loops tile has no drill-down | P1 | `open-loops/route.ts` + `OpenLoopsDrawer.tsx` | 🟢 Done | Drawer lists real `agent_open_loops`; mark fulfilled. |
| 5 | Decision card LIMIT 12 silent truncate | P1 | `customer/route.ts` | 🟢 Done | `limit`/`offset` pagination + `cardsHasMore` + Load more. |
| 6 | Real-time SSE on customer page | P2 | `customer/page.tsx` | 🟢 Done | Subscribes to `/api/stream/events` and reloads on attention/conversation/work_item events. |
