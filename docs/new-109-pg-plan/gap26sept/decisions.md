# Decisions Audit

## Live Resolution Tracker

| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | Approval never re-executes parked tool (`PATCH /api/decisions` dead-end) | P0 | `apps/dashboard/app/api/decisions/route.ts` | 🟢 Done | PATCH approves atomically, releases DB, runs `executeAutonomousToolAction` with `skipAutonomy`, writes `executed` / `execution_failed` + audit. Migration `101_decisions_execution.sql`. |
| 2 | Dead ternary `isRefund ? 'reject' : 'reject'` | P0 | `services/workflows/src/autonomy.ts` | 🟢 Done | Recommendation is `isRefund ? 'reject' : 'approve'`. |
| 3 | Missing payload summary on parked actions | P1 | `services/workflows/src/autonomy.ts` | 🟢 Done | `buildActionSummary` written into parked payload `summary`. |
| 4 | Work-item decision `modifiedArgs` + split-brain | P0 | `apps/dashboard/app/api/work-items/[id]/decision/route.ts` | 🟢 Done | Persists `modifiedArgs`; embeds them in Temporal `optionId` JSON; checks `getTemporalClient()` before signal; compensate+502 on failure; client released before Temporal. |
| 5 | Role gates / dual-auth / expiry sweeper / history on `/api/decisions` | P1–P2 | `/api/decisions` + `/api/decisions/sweep` | 🟢 Done | Auditors blocked; refunds owner/admin; refunds require 2 distinct approvals; `GET ?history=1`; `POST /api/decisions/sweep` expires past-due pending (never approves). |
| 6 | Approve/reject audit kinds rejected by `audit_events_kind_chk`, error swallowed (27sept OPS-B01) | P0 | `lib/decide-approval.ts`, migration `150` | 🟡 Tree | Migration 150 adds `decision.*` + conversation/channel/billing/skill/impersonation kinds; audit insert shares a transaction with the status change and throws `AuditWriteError` (rollback) instead of swallowing. `AUDIT_EVENT_KINDS` pinned to the newest CHECK by `audit-events.test.ts`. Unit-tested; migration not applied to a live DB. |
| 7 | `/api/agent/pending-actions` approved with no RBAC / dual approval / audit and never executed (27sept OPS-S01) | P0 | `app/api/agent/pending-actions/route.ts` | 🟡 Tree | Token route, `/api/decisions` PATCH and parked decision cards in `/api/work-items/[id]/decision` all call `decideApproval`: role gate (auditor/billing 403, refunds owner/admin, pay tools `canCallPayTools`), dual approval, expiry, execute-on-final-approval with timeout, `modifiedPayload` ≤16 KB object. `decide-approval.test.ts` (10 cases). |
| 8 | Expiry sweeper had no caller; manual sweep stamped `decided_by` = sweeping user (27sept OPS-G01) | P0 | `services/workflows/src/workflows/governance-sweep.ts` | 🟡 Tree | Worker sweep every 15 min per org expires past-due decisions with `decided_by` NULL, a system `decision.expired` audit row, and cancels the linked decision card; work-item SLA breach runs in the same sweep. Bundle + unit tests; not run against a live Temporal. |
| 9 | Approving a held send, payment, signature, publish or delete never ran it: the executor re-ran it as a new call, so the gate held it again (a new pending approval each time) while the API said "executed" and the audit log said approved_and_executed. A returned tool error was recorded as executed too. | P0 | `apps/dashboard/lib/decide-approval.ts` | 🟢 Done | Re-enters with the approved row id, the approver, source `approval` and the employee that asked; a returned error or a call held again is `execution_failed` with one plain sentence. Row 1 was only true for reads, drafts and writes. Proven by 11 unit tests and harness flows F3 to F6 against the real stack (exactly one send reaches the provider). |
| 10 | In Ask AI, approving in the chat card and then again in Decisions were two approvals for one action: the chat asked first, then the gate held the call again as a database approval. | P1 | `services/workflows/src/local-turn.ts`, `tool-gate.ts`, `apps/dashboard/lib/chat-approval.ts` | 🟢 Done | An Allow in the card is the approval: the hold the gate makes for that exact call is approved on the spot by the person who clicked, through `decideApproval` (roles, two-person rule, audit marked `via: chat`, execute once). Pause, tool card, persona, watching mode and the critic still run first. 13 workflow tests, 12 dashboard tests and harness flows F16 to F24 (double click, allow one and deny one, provider failure, auditor and member, level 0, pause, two-person refund). In-process turns only; the sidecar path still asks twice. |
| 11 | A held chat approval lives in the memory of the server that asked. After a restart, or on a second replica, the card is dead and nothing runs. | P1 | `services/workflows/src/local-turn.ts` (`ActiveLocalSession`) | 🔴 Open | Narrowed by row 10: once a person clicks Allow, the approval is durable (a row, an audit entry, an execution record). What is still lost is the card itself: the paused turn lives in memory, so after a restart the person sees "We could not finish that approval, so nothing was run. Please ask again, or approve it from Decisions" (harness flow F14). Fixing it needs the pending call stored when the card is shown (a table), and then the Allow can run without the paused turn. |
| 12 | A chat Deny did not stop the call: the in-process tool set ignored the person's answer, so a denied send, payment or signature was held as a new approval in Decisions, and a write the workspace lets run alone would have run. | P0 | `services/workflows/src/local-turn.ts` (`DarexLocalToolSet.callTool`) | 🟢 Done | A denied call returns "not run" before the budget and the gate. 2 unit tests (red first) and harness flow F15 against the real stack. |
| 13 | The two-person rule for refunds never applies: `required_approvals` defaults to 1 and nothing sets it higher, so `Math.max(1, Number(row.required_approvals) \|\| (refund ? 2 : 1))` in `decideApproval` always reads 1. Row 5 says refunds require 2 distinct approvals; one owner's approval runs a refund. | P1 | `apps/dashboard/lib/decide-approval.ts`, `services/workflows/src/autonomy.ts` (`parkPendingAction`) | 🔴 Open | Seen by harness flow F23 (before it forced a two-approval workspace). Needs a product decision, not a code fix: enforcing two approvals for every refund means a workspace with one owner can never refund. Options: require two only when the workspace has two or more people who may approve refunds; or make it a setting. The mechanics for two approvals are tested and work when a row asks for them. |
| 14 | The Customer tab crashed (React error 31) for any workspace with a held send, payment or signature, and held actions had no readable description: the board showed cards all titled "decision" and the Health page listed an email to approve with no message text. | P0 | `apps/dashboard/components/customer/DecisionCardPanel.tsx`, `lib/approval-view.ts`, `services/workflows/src/autonomy.ts` (`heldActionCard`) | 🟢 Done | The card stores a sentence, a reason and the call; the panel renders the recommendation as the option's name and shows the message. Found by driving every page with data in a real browser. 4 component tests (3 red first), 10 view tests, 3 builder tests. |
| 15 | There was no place to approve held actions: the only list was at the bottom of the Employee health page, each card showed no message text, and approving routine messages was one click each. | P0 | `apps/dashboard/app/(dashboard)/approvals/page.tsx`, `components/approvals/ApprovalCard.tsx`, `app/api/decisions/route.ts` | 🟢 Done | `/approvals` with a sidebar badge: who, what, the message itself, why held, edit before approving, approve together (never money), keyboard, per-card result in words, a Done tab. Real-browser run: 8 decisions in 9 actions; the rejected one did not send; the edit was what was sent. |
| 16 | Home and the Morning brief said "Nothing needs you" while approvals were waiting. | P1 | `components/home/ApprovalsCallout.tsx`, `app/(dashboard)/brief/page.tsx` | 🟢 Done | A call-out with the count and a Review button on both; "Nothing needs you." only when true. 5 tests. |
| 17 | The chat approval card said only "Tool Approval Required for gmail_send": with a chat Allow now being the approval, a person approved a message without seeing who it goes to or what it says. | P0 | `services/workflows/src/local-turn.ts` (`approvalRequestFor`, `rememberToolCalls`), `apps/dashboard/components/chat/AgentTrajectory.tsx` | 🟢 Done | The card shows what the call does, To, Subject and the message, from the same code as the Approvals page; falls back to the old card when the call cannot be read. 16 tests; real-browser check. |
| 18 | The sidebar was 23 unlabelled icons: a person had to hover each one to learn its name, Showings had no way in, and two items lit up at once. | P1 | `apps/dashboard/components/shell/AppShell.tsx`, `components/a11y/BottomTabs.tsx` | 🟢 Done | Names beside icons, five labelled groups that fold and remember, one highlighted page, Showings added; 10 tests and a real-browser measurement at four widths. NEW-FRONTEND needs the same change. |
| 19 | Ask AI's first message and starters talked to a new customer in developer terms (OAuth, tool ids, a raw path) and offered one starter. | P1 | `apps/dashboard/lib/ask-ai-welcome.ts`, `app/(dashboard)/ask-ai/page.tsx` | 🟢 Done | Plain greeting naming connected apps, four starters that never need an unconnected app and never invent a contact; developer words in the first message 7 -> 0, starters 1 -> 4 (real browser). |
| 20 | Home gave a new customer no first step, and said "Infrastructure: healthy" and "org stats". | P1 | `apps/dashboard/components/home/GetStarted.tsx`, `app/(dashboard)/page.tsx` | 🟢 Done | A three-step Get started card (hidden when done, unknown or dismissed), plain status line and subtitle; first steps shown 0 -> 3, developer words 2 -> 0 (real browser). |
| 21 | The Inbox left the conversation 112 px wide at laptop width with controls cut off, showed internal ids as names, and put a test control beside the real reply button. | P1 | `apps/dashboard/app/(dashboard)/conversations/page.tsx`, `lib/contact-label.ts` | 🟡 Partial | Filters drawer, context column only on wide screens, wrapping header, plain contact names, "Reply to customer / Private note" with practice mode tucked away: conversation 112 -> 656 px, cut-off controls 6 -> 0. The dark theme is unchanged. |
| 22 | Customer screens showed developer words: setting names, metric and tool ids, `OAuth`, the vendor name Nango, "SQL". | P1 | `lib/humanize-id.ts`, Billing, Insight (`core-kpis.yaml`), Autonomy, Skills, Connectors, Integrations, Settings, Health, Packs; `lib/__tests__/customer-vocabulary.test.ts` | 🟢 Done | Codes shown as words and every flagged sentence rewritten: developer words visible across 35 pages 230 -> 8 (-96%), the 8 being allow-listed ("Tenant", "Webhooks"). The contract now reads templates and conditionals too, and the metric copy has its own contract. |
| 23 | Listing prices were shown as raw numbers ("9600000") and statuses as codes ("under_offer"). | P2 | `apps/dashboard/lib/format-price.ts`, `app/(dashboard)/listings/page.tsx` | 🟢 Done | Rupee grouping and currency symbols, dash for none, words kept, "Under offer"; 0 of 4 -> 4 of 4 price cells readable (real browser). |
| 24 | The chat plan card tagged every step with an internal id (`mcp.google-sheets.sheets_read`). | P2 | `apps/dashboard/lib/plan-step-label.ts`, `components/chat/PlanCard.tsx` | 🟢 Done | Steps read "Google Sheets · Read"; internal ids on the card 3 -> 0 (real browser). The classifier still plans a single-email request that mentions a showing. |
| 25 | The chat showed the router's internal note ("low confidence — support, not round-robin") as the reason for a routing. | P2 | `apps/dashboard/lib/ask-mode.ts` | 🟢 Done | Router notes mapped to plain sentences, unknown reasons shown as written; internal router words on screen 1 -> 0 (real browser). |
| 26 | On pages in the lower sidebar groups the highlighted item was scrolled out of view, so a person could not see where they were. | P2 | `apps/dashboard/components/shell/AppShell.tsx` | 🟢 Done | The list scrolls the current page into view on arrival and when the footer settles; highlighted item in view 2 of 9 -> 9 of 9 pages (real browser). |
| 27 | Two Insight cards fell back to a sentence saying the number came from "the metrics registry SQL". | P3 | `services/workflows/src/metrics/core-kpis.yaml`, `apps/dashboard/lib/insight-engine.ts` | 🟢 Done | Every metric has its own sentence and the fallback is plain; cards mentioning SQL 1 -> 0 (real browser); contract requires a sentence per metric. |
| 28 | A chat approval card answered after a server restart sent the person to Decisions, where nothing was waiting. | P2 | `services/workflows/src/trueforge-client.ts`, `apps/dashboard/app/api/ask-ai/approve/route.ts` | 🟡 Partly | The card now says it expired and that nothing was sent; flow F25 4 of 4 (2 of 4 before). Surviving the restart needs a durable record at card time: product decision. |
| 29 | There was no number for answer quality, so "as good as the best companies" could not be checked. | P1 | `infra/harness/evals/` | 🟡 Partly | 37-task scored set and runner exist; grader tested (6 tests); canned reply scores 14 percent. A real-model score is still needed (needs the model key). |
| 30 | Nothing exercised the server for long periods, so slow leaks and stuck approvals would only show up in production. | P1 | `infra/harness/soak.js` | 🟡 Partly | 30-minute soak: 1968 requests, 0 failures, 227 of 227 approvals finished, memory +22 percent. The 24-hour run, Docker build and real-account run are in RUN_ON_YOUR_MACHINE.md and still need the owner. |
| 31 | Nothing told the owner that a sent email or a refund cannot be reversed, and a real undo is not possible once the provider has sent it. | P2 | `apps/dashboard/lib/approval-view.ts`, `apps/dashboard/components/approvals/ApprovalCard.tsx` | 🟡 Partly | The card now states what is final before approval (real browser). A delayed-send undo window is a product decision and is not built. |
| 32 | The owner had to open several pages to learn what the assistant did and what needed them. | P2 | `apps/dashboard/app/api/digest/route.ts`, `apps/dashboard/lib/owner-digest.ts`, `apps/dashboard/components/home/DailyDigest.tsx` | 🟢 Done | Home card "Today so far" with counts for the last 24 hours; 6 unit tests; real browser shows quiet and busy states; second workspace sees 0 waiting. |
| 33 | The flow harness depended on an unset sidecar address, so the expired-card flow could pass on one stack and fail on the other. | P3 | `infra/harness/run-flows.sh`, `infra/harness/flows.js` | 🟢 Done | `run-flows.sh` 95 passed, 0 failed across 25 flows (was 93 and 2 failed). |
| 34 | Several pages spoke in developer language ("gated by the real-estate pack", "Kanban of real inquiry work items", typed paths like /connectors, "Semantic metrics", "use the BYOK form"). | P2 | `apps/dashboard/app/(dashboard)/{listings,showings,inquiries,insight,integrations}/page.tsx`, `apps/dashboard/components/re/SchedulePanel.tsx` | 🟢 Done | Contract flagged 35 places and now passes; the pages read in business words in a real browser; the contract keeps them out. |
| 35 | Home repeated "approvals are waiting" three times (banner plus the new summary card). | P3 | `apps/dashboard/lib/owner-digest.ts` | 🟢 Done | The summary card reports only what happened; the banner owns waiting approvals. 7 unit tests; real browser shows it once. |
| 36 | Nothing in the product helps an owner get paid, although late payment is the largest recurring money problem for small suppliers in the research notes. | P1 | `apps/dashboard/lib/dues-engine.ts` | 🔴 Open | The rules (due day, days overdue, interest, next reminder) exist and are tested (16). No table, page, chase flow or reconciliation yet. |
| 37 | There was nowhere to record who owes the owner money. | P1 | `infra/db/migrations/212_org_dues.sql`, `services/workflows/src/dsr/tables.ts` | 🟡 Partly | Table with forced row-level security, erasure registration and column-limited reader access; isolation check 11 of 11, SQL guard 41 of 41. API, page and chase flow still to do. |
| 38 | An owner with a list of overdue invoices had no way to bring it in or to word a polite reminder. | P1 | `apps/dashboard/lib/dues-text.ts` | 🟡 Partly | Paste reader and reminder wording (3 tones, English and Roman Hindi) are tested (13). The API and page that use them are still to do. |
| 39 | The dues table had no way in or out. | P1 | `apps/dashboard/app/api/dues/`, `apps/dashboard/lib/dues-view.ts` | 🟡 Partly | Import, list with totals, mark paid, settings and reminder-through-approval work; flow F26 16 of 16. No page, no Ask AI tool yet. |

## Status: working (approve executes parked tools; autonomy card/summary fixed; RBAC/dual-auth/sweep/history on `/api/decisions`)

The Human-in-the-Loop (HITL) decisions subsystem (`apps/dashboard/app/api/decisions/route.ts`, `services/workflows/src/autonomy.ts`, and `apps/dashboard/components/observability/PendingDecisionCard.tsx`) provides an approval gateway for autonomous actions exceeding confidence thresholds or carrying irreversible risk. It validates tokens, enforces session-scoped multi-tenancy, and applies status transitions (`pending` -> `approved` / `rejected`).

However, **approving an action is a dead end** (the database row is updated to `approved`, but no worker or runner ever re-executes the parked tool call), the recommendation logic contains a provably dead ternary (`isRefund ? 'reject' : 'reject'`), three duplicate endpoints read/write `agent_pending_actions` with divergent schemas, and the API lacks role-gated approval thresholds.

---

## What works (cite file:line)

1. **Multi-Tenant Pending Action Querying**:
   - `apps/dashboard/app/api/decisions/route.ts:4-15` — `GET /api/decisions`:
     - Resolves tenant context securely via `getScopedClient()`.
     - Queries `agent_pending_actions WHERE org_id = $1 AND status = 'pending' LIMIT 50`, returning typed camelCase objects.
2. **Conditional Atomic State Transitions**:
   - `apps/dashboard/app/api/decisions/route.ts:16-48` — `PATCH /api/decisions`:
     - Rejects body `org_id` overrides (`route.ts:21`).
     - Restricts transitions strictly to `status IN ('approved', 'rejected')`.
     - Conditional atomic update: `WHERE id = $1 AND org_id = $2 AND status = 'pending'`, preventing double-resolution.
     - Enforces server-side expiration checks: Appends `AND (expires_at IS NULL OR expires_at > NOW())` when approving, returning HTTP 409 Conflict if expired.
     - Stamped with the approving operator's user ID (`decided_by = $userId`).
3. **Autonomous Tool Interception & Parking**:
   - `services/workflows/src/autonomy.ts:310-381` — `parkPendingAction`:
     - Intercepts high-risk tool calls from `services/workflows/src/tool-executor.ts:267-282`.
     - Generates SHA-256 hashed approval tokens, never persisting raw authorization secrets in the database.
     - Automatically provisions linked `work_items` of type `'decision'` and dispatches non-blocking notifications to Slack.
4. **Autonomy Tier Evaluation Engine**:
   - `services/workflows/src/autonomy.ts:120-185`:
     - Evaluates proposed tool executions against four distinct autonomy tiers (`Notice`, `Draft`, `Act Internally`, `Act Externally`) and flags irreversible actions for mandatory human sign-off.
5. **Frontend Observation Wireup**:
   - `apps/dashboard/app/(dashboard)/observability/page.tsx:31-39`:
     - Fetches pending decisions and renders interactive `PendingDecisionCard` components with live approve/reject handlers.
6. **Connection Pool Safety Across Handlers**:
   - `apps/dashboard/app/api/decisions/route.ts:14, 46`:
     - Ensures checked-out database clients are promptly returned to the pool in `finally` blocks.
7. **Graceful Degradation on Inactive Actions**:
   - `apps/dashboard/app/api/decisions/route.ts:35-42`:
     - Returns explicit 404 when an action ID does not exist or has already been transitioned by another administrator.

---

## What's broken (code-level bugs, edge cases, failure modes)

1. **Approval Never Triggers Tool Execution (Dead-End Approval) (P0)**:
   - When an operator clicks "Approve", `PATCH /api/decisions` updates `status = 'approved'` in `agent_pending_actions`.
   - However, **no background process, Temporal workflow, or cron job polls for approved actions or re-executes the tool**.
   - The tool execution parameters (`payload.tool`, `payload.action`, `payload.payload`) sit frozen in the database forever.
   - The UI informs the operator that the action was approved, but the underlying email is never sent, the refund is never processed, and the database change is never executed. This creates a severe false-positive UX.
2. **Provably Dead Ternary in Recommendation Engine (P0) (`services/workflows/src/autonomy.ts:296-297`)**:
   - In `autonomy.ts`, the recommendation builder contains:
     ```typescript
     recommendation: {
       optionId: isRefund ? 'reject' : 'reject',
       confidence: 0.9,
     }
     ```
   - Both branches of the ternary return `'reject'`.
   - For normal, non-refund actions (such as sending a follow-up email or creating a calendar event), the system erroneously tells the operator to reject the action, creating unnecessary operational friction.
3. **Generic Cards Due to Missing Payload Summary (`autonomy.ts:363`, `PendingDecisionCard.tsx:6`)**:
   - `PendingDecisionCard.tsx` displays `payload.summary`, falling back to `"Proposed " + actionType` if missing.
   - `parkPendingAction` never writes a `summary` property to `payload`.
   - Every decision card in the dashboard renders a generic title (*"Proposed send_email"*, *"Proposed refund"*), omitting the actual dollar amount, customer name, or message snippet contained in `payload.payload`.
4. **Three Duplicate Routes with Divergent Error Handling**:
   - The exact same `agent_pending_actions` table is managed by three independent routes:
     1. `/api/decisions` (`apps/dashboard/app/api/decisions/route.ts`)
     2. `/api/agent/pending-actions` (`apps/dashboard/app/api/agent/pending-actions/route.ts`)
     3. `/api/settings/pending` (`apps/dashboard/app/api/settings/pending/route.ts`)
   - `/api/settings/pending` handles missing tables gracefully, while `/api/decisions` throws unhandled 500 errors. None of the three trigger execution upon approval.
5. **Missing RBAC Checks on Financial Approvals**:
   - `PATCH /api/decisions` permits any logged-in organization member to approve pending actions.
   - There are no financial limits or role restrictions: a junior support agent can approve a $10,000 refund with zero admin escalation.
6. **Race Condition on Concurrent Multi-User Approvals**:
   - Two administrators open the dashboard and review a pending refund card simultaneously.
   - While the SQL `UPDATE ... WHERE status = 'pending'` prevents duplicate status updates, the lack of an execution worker lock means that if execution is triggered on approval, both could trigger external actions if not guarded by distributed locks.
7. **No Action Expiration Notification & Stale Row Buildup**:
   - When an action expires past its `expires_at` window, it remains in the database in `status = 'pending'`. The operator is only alerted of the expiration when clicking the Approve button and encountering an unexpected HTTP 409 error.
8. **Suspended Conversations Hang Indefinitely**:
   - When an agent parks an action pending approval, the conversation thread with the customer is placed in a waiting state. If the operator rejects or ignores the decision, no message is dispatched back to the customer informing them that their request was denied.
9. **Inability to Edit / Modify Parameters Prior to Approval**:
   - Operators can only click binary "Approve" or "Reject". If an AI proposes refunding $100 but policy requires $50, the operator cannot edit the parameter before approving.
10. **Missing Audit Logging on Decisions**:
    - Decisions approved or rejected do not write to the primary `audit_events` table, preventing compliance traceability.
11. **Lack of Idempotency Key in Tool Execution**:
    - If the tool execution fails with a network timeout after charging or refunding, a retry can duplicate the financial transaction because no unique idempotency key is passed to the underlying provider.
12. **Missing Batch Approval Capability in UI**:
    - In high-volume environments (e.g. 50 routine low-risk emails parked for review), operators must click "Approve" 50 times individually, with no "Approve All Verified" action.
13. **Absence of Real-Time UI Expiry Countdown**:
    - Decision cards do not display an active timer showing when the pending action will expire, leading to race conditions where an operator spends minutes reviewing a proposal only to have it expire mid-read.
14. **Silent Notification Failures on Slack Rate Limits**:
    - When Slack incoming webhook quotas are exceeded, notification dispatches fail silently, leaving operators unaware of urgent pending decisions.

---

## What's missing vs full product vision

1. **Automatic Execution Worker for Approved Actions**:
   - An automated consumer that listens for `action.approved` events or queries `WHERE status = 'approved' AND executed_at IS NULL`, calls `executeAutonomousToolAction()`, updates status to `executed`, and logs results.
2. **Historical Decision Audit Log View (`/decisions/history`)**:
   - Operators cannot review past decisions (who approved what and when). The UI only shows the current pending queue, and lacks a "Decision History" tab with filters for actor, employee, and status.
3. **Multi-Level Dual-Authorization Policies**:
   - Inability to configure dual-authorization rules (e.g. *"Refunds > $500 require approval from 2 managers"*).
4. **Proactive Background Expiration Sweeper**:
   - Automated cron job that periodically transitions expired pending actions to `expired` status and notifies the assigned agent to resume conversation with a timeout message.
5. **Contextual Conversation & Customer Sidecar**:
   - A decision card showing a customer refund or contract cancellation lacks a 1-click link to view the complete underlying conversation thread and CRM profile, forcing operators to manually search for context.
6. **Parameter Modification Modal ("Approve with Edits")**:
   - Allowing operators to adjust the draft email text or dollar amount before clicking "Approve with Modifications".
7. **Multi-Channel Urgent Escalation**:
   - When high-severity decisions sit unreviewed for >30 minutes, automatically escalate via SMS or phone call to the on-call manager.
8. **Compensating Rollback Button**:
   - A single-click "Revert Action" for executed decisions that automatically dispatches inverse operations (e.g. un-canceling a lease or cancelling a scheduled event).

---

## What to add for full SaaS

### 1. Database Schema Enhancements Migration
Create `infra/db/migrations/030_decisions_execution_and_policies.sql`:
```sql
-- Migration: 030_decisions_execution_and_policies.sql
-- Enables tool execution state tracking, modifications, and role-based decision policies

ALTER TABLE agent_pending_actions
  ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS execution_result JSONB,
  ADD COLUMN IF NOT EXISTS execution_error TEXT,
  ADD COLUMN IF NOT EXISTS modified_payload JSONB,
  ADD COLUMN IF NOT EXISTS required_role VARCHAR(32) DEFAULT 'member',
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(64) DEFAULT encode(gen_random_bytes(32), 'hex');

CREATE TABLE IF NOT EXISTS decision_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  tool_name VARCHAR(64) NOT NULL,
  min_role VARCHAR(32) NOT NULL DEFAULT 'admin',
  max_auto_amount NUMERIC(10, 2) DEFAULT 0,
  require_two_approvals BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_org_tool_policy UNIQUE(org_id, tool_name)
);

CREATE INDEX IF NOT EXISTS idx_agent_pending_actions_execution 
  ON agent_pending_actions(org_id, status) 
  WHERE status IN ('approved', 'pending');

CREATE INDEX IF NOT EXISTS idx_agent_pending_actions_expiry
  ON agent_pending_actions(expires_at)
  WHERE status = 'pending';
```

### 2. Complete Execution Engine on Approval (`apps/dashboard/app/api/decisions/route.ts`)
```typescript
import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { loadHumanRole } from '@/lib/rbac';
import { broadcastToOrg } from '@/lib/realtime-hub';
import { executeAutonomousToolAction } from '@/services/workflows/dist/tool-executor';

export async function PATCH(request: Request) {
  const { client, orgId, userId } = await getScopedClient();
  try {
    const body = await request.json();
    const { id, status, modifiedPayload } = body;

    if (!id || !['approved', 'rejected'].includes(status)) {
      return NextResponse.json({ error: 'Invalid decision payload' }, { status: 400 });
    }

    const role = await loadHumanRole(client, orgId, userId);

    // Fetch existing pending action
    const existing = await client.query(
      `SELECT * FROM agent_pending_actions WHERE id = $1 AND org_id = $2`,
      [id, orgId]
    );
    if (existing.rowCount === 0) {
      return NextResponse.json({ error: 'Decision action not found' }, { status: 404 });
    }
    const action = existing.rows[0];

    // Enforce role gates for sensitive financial tools
    if (action.payload?.tool === 'stripe_refund' && role !== 'owner' && role !== 'admin') {
      return NextResponse.json({ error: 'Only workspace owners and admins can approve refunds.' }, { status: 403 });
    }

    if (status === 'approved') {
      // 1. Mark as approved atomically with expiration check
      const lockRes = await client.query(
        `UPDATE agent_pending_actions
            SET status = 'approved',
                decided_by = $1,
                modified_payload = COALESCE($2::jsonb, modified_payload),
                updated_at = NOW()
          WHERE id = $3 AND org_id = $4 AND status = 'pending'
            AND (expires_at IS NULL OR expires_at > NOW())
          RETURNING *`,
        [userId, modifiedPayload ? JSON.stringify(modifiedPayload) : null, id, orgId]
      );

      if (lockRes.rowCount === 0) {
        return NextResponse.json({ error: 'Action already resolved or expired.' }, { status: 409 });
      }

      const lockedRow = lockRes.rows[0];
      const payloadToExecute = lockedRow.modified_payload || lockedRow.payload?.payload;

      // 2. Immediately execute tool action with idempotency
      try {
        const executionResult = await executeAutonomousToolAction(
          lockedRow.payload?.tool,
          payloadToExecute,
          { 
            orgId, 
            userId, 
            isResumedApproval: true,
            idempotencyKey: lockedRow.idempotency_key 
          }
        );

        // 3. Mark executed in DB
        await client.query(
          `UPDATE agent_pending_actions
              SET status = 'executed',
                  executed_at = NOW(),
                  execution_result = $1::jsonb
            WHERE id = $2`,
          [JSON.stringify(executionResult), id]
        );

        // 4. Audit Log
        await client.query(
          `INSERT INTO audit_events (org_id, actor_type, actor_user_id, action, target_type, target_id, risk_class, result_status, metadata)
           VALUES ($1, 'user', $2, 'decision.approved_and_executed', 'agent_pending_actions', $3, 'high', 'success', $4)`,
          [orgId, userId, id, JSON.stringify({ tool: lockedRow.payload?.tool, result: executionResult })]
        );

        broadcastToOrg(orgId, { type: 'decision_executed', id, result: executionResult });
        return NextResponse.json({ success: true, status: 'executed', result: executionResult });
      } catch (execErr: any) {
        await client.query(
          `UPDATE agent_pending_actions
              SET status = 'execution_failed',
                  execution_error = $1
            WHERE id = $2`,
          [execErr.message || String(execErr), id]
        );

        await client.query(
          `INSERT INTO audit_events (org_id, actor_type, actor_user_id, action, target_type, target_id, risk_class, result_status, metadata)
           VALUES ($1, 'user', $2, 'decision.execution_failed', 'agent_pending_actions', $3, 'high', 'failure', $4)`,
          [orgId, userId, id, JSON.stringify({ error: execErr.message })]
        );

        return NextResponse.json({ success: false, status: 'execution_failed', error: execErr.message }, { status: 500 });
      }
    } else {
      // Rejection logic
      await client.query(
        `UPDATE agent_pending_actions
            SET status = 'rejected',
                decided_by = $1,
                updated_at = NOW()
          WHERE id = $2 AND org_id = $3 AND status = 'pending'`,
        [userId, id, orgId]
      );

      // Audit Log
      await client.query(
        `INSERT INTO audit_events (org_id, actor_type, actor_user_id, action, target_type, target_id, risk_class, result_status)
         VALUES ($1, 'user', $2, 'decision.rejected', 'agent_pending_actions', $3, 'medium', 'success')`,
        [orgId, userId, id]
      );

      broadcastToOrg(orgId, { type: 'decision_rejected', id });
      return NextResponse.json({ success: true, status: 'rejected' });
    }
  } finally {
    client.release();
  }
}
```

### 3. Fix Dead Ternary in Recommendation Engine
In `services/workflows/src/autonomy.ts:296-297`:
```typescript
recommendation: {
  optionId: isRefund ? 'reject' : 'approve',
  confidence: isRefund ? 0.95 : 0.85,
}
```

### 4. Enforce Rich Human-Readable Summary on Action Creation
In `services/workflows/src/autonomy.ts:360`:
```typescript
export function buildActionSummary(tool: string, action: string, payload: any): string {
  if (tool === 'stripe_refund' || tool === 'mcp.darex.billing_refund') {
    return `Refund $${(payload.amount / 100).toFixed(2)} to ${payload.customerEmail || payload.customerId || 'Customer'}`;
  }
  if (tool === 'gmail_send' || tool === 'mcp.darex.email_send') {
    return `Send email "${payload.subject || 'Follow-up'}" to ${payload.to}`;
  }
  if (tool === 'calendar_create' || tool === 'mcp.darex.calendar_create') {
    return `Schedule showing for ${payload.summary || 'Property'} on ${payload.startTime}`;
  }
  if (tool === 'hubspot_deal_update') {
    return `Update deal "${payload.dealName || payload.dealId}" stage to "${payload.stage}"`;
  }
  return `Execute ${tool}.${action || 'run'}`;
}
```

### 5. Proactive Expiration Sweeper Cron (`services/workflows/src/workflows/expiration-sweeper.ts`)
```typescript
import { getPool } from '@/lib/db';
import { broadcastToOrg } from '@/lib/realtime-hub';

export async function sweepExpiredDecisions() {
  const pool = getPool();
  const res = await pool.query(
    `UPDATE agent_pending_actions
        SET status = 'expired', updated_at = NOW()
      WHERE status = 'pending' AND expires_at < NOW()
      RETURNING id, org_id, conversation_id`
  );

  for (const row of res.rows) {
    broadcastToOrg(row.org_id, { type: 'decision_expired', id: row.id });
    if (row.conversation_id) {
      // Notify conversation thread that the approval timed out
      await pool.query(
        `INSERT INTO messages (conversation_id, org_id, role, content, meta)
         VALUES ($1, $2, 'system', 'The requested action timed out before receiving manager approval.', '{"reason":"decision_expired"}')`,
        [row.conversation_id, row.org_id]
      );
    }
  }
}
```

### 6. Interactive Decision Card with Edit Modal (`PendingDecisionCard.tsx`)
```tsx
'use client';

import { useState } from 'react';
import { CheckCircle2, XCircle, Clock, Edit3, AlertTriangle } from 'lucide-react';

export function PendingDecisionCard({ action, onActionComplete }: { action: any; onActionComplete: () => void }) {
  const [isEditing, setIsEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [modifiedJson, setModifiedJson] = useState(JSON.stringify(action.payload?.payload, null, 2));

  const handleDecision = async (status: 'approved' | 'rejected', payload?: any) => {
    setLoading(true);
    try {
      const res = await fetch('/api/decisions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: action.id,
          status,
          modifiedPayload: payload,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to resolve decision');
      }
      onActionComplete();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-900 border border-amber-200 dark:border-amber-900/50 rounded-xl p-5 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center space-x-2">
          <span className="px-2.5 py-1 text-xs font-semibold rounded-md bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
            {action.payload?.tool || 'Action Required'}
          </span>
          {action.expires_at && (
            <span className="text-xs text-gray-500 flex items-center">
              <Clock className="w-3.5 h-3.5 mr-1" />
              Expires {new Date(action.expires_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
        <button
          onClick={() => setIsEditing(!isEditing)}
          className="text-xs text-gray-500 hover:text-blue-600 flex items-center"
        >
          <Edit3 className="w-3.5 h-3.5 mr-1" /> {isEditing ? 'Cancel Edit' : 'Edit Params'}
        </button>
      </div>

      <h4 className="font-semibold text-gray-900 dark:text-gray-100 text-sm mb-2">
        {action.payload?.summary || `Proposed ${action.action_type || 'Execution'}`}
      </h4>

      {isEditing ? (
        <div className="mb-4">
          <textarea
            value={modifiedJson}
            onChange={(e) => setModifiedJson(e.target.value)}
            rows={5}
            className="w-full text-xs font-mono bg-gray-50 dark:bg-gray-950 p-2.5 rounded border border-gray-300 dark:border-gray-800"
          />
        </div>
      ) : (
        <pre className="text-xs bg-gray-50 dark:bg-gray-950 p-3 rounded-lg overflow-x-auto text-gray-700 dark:text-gray-300 mb-4 max-h-36">
          {JSON.stringify(action.payload?.payload, null, 2)}
        </pre>
      )}

      <div className="flex space-x-3">
        <button
          disabled={loading}
          onClick={() => {
            const parsed = isEditing ? JSON.parse(modifiedJson) : undefined;
            handleDecision('approved', parsed);
          }}
          className="flex-1 inline-flex justify-center items-center py-2 px-4 border border-transparent rounded-lg text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none"
        >
          <CheckCircle2 className="w-4 h-4 mr-1.5" />
          {isEditing ? 'Approve with Edits' : 'Approve & Execute'}
        </button>
        <button
          disabled={loading}
          onClick={() => handleDecision('rejected')}
          className="inline-flex justify-center items-center py-2 px-4 border border-gray-300 dark:border-gray-700 rounded-lg text-xs font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700"
        >
          <XCircle className="w-4 h-4 mr-1.5" />
          Reject
        </button>
      </div>
    </div>
  );
}
```

---

## Fix priority

- **P0**: Close the execution loop on approval so that approved tool actions actually execute against target APIs instead of terminating in a dead-end database update.
- **P0**: Fix the dead ternary in `autonomy.ts` that erroneously recommends rejecting all non-refund actions.
- **P1**: Add role-based approval limits to prevent unprivileged members from approving sensitive actions or refunds.
- **P1**: Populate human-readable summaries on pending action payloads to replace generic `"Proposed <action>"` card labels.
- **P1**: Implement parameter modification modal ("Approve with Edits") to avoid blocking operations over minor discrepancies.
- **P2**: Consolidate duplicate endpoints (`/api/decisions`, `/api/agent/pending-actions`, `/api/settings/pending`) into a single canonical route.
- **P2**: Build a historical decision audit log view in the dashboard (`/decisions/history`).
- **P2**: Deploy background expiration sweeper to automatically mark stale decisions expired and resume waiting conversation threads.
