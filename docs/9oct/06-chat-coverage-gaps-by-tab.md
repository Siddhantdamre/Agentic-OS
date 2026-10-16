# 06 — Chat coverage by tab: what Ask AI can and cannot do (2026-10-09)

Goal from `AGENTS.md` §4a: "anything a user can do on any tab, and anything
any connected tool can do, must be doable by asking in the chat." This file
takes `docs/new-109-pg-plan/gap26sept/chat-coverage.md` (154 tool rows, 83
mutating route rows, all 🔴) and goes one level deeper: for every NEW-FRONTEND
tab and every mutating dashboard route, it states whether chat can do it
today, which tool covers it, the missing tool to add (name and schema sketch),
and how to prove it live from the chat.

Code read on `main` at `c8ad0ab1`. Code wins over docs.

## 0. Legend and method

Coverage column:

- ✅ **Covered**: a chat tool performs the same state change through the same
  tables, and the gate allows it for at least one roster employee.
- 🟡 **Partial**: a tool exists but differs (different store, read-only,
  missing fields, not on any default card, or blocked by the approval issue
  AP-B01 in `05-ask-ai-chat-gaps.md`).
- ❌ **None**: no tool; chat can only describe or link.
- 🔒 **Human-only by design**: should stay off chat; chat returns a deep link
  (OAuth consent, payment entry, destructive workspace actions). Each is
  argued below.

Risk column uses the gate's classes (`services/workflows/src/tools/risk.ts`
via `resolveToolRisk`): `read`, `draft`, `send`, `pay`, `sign`, `publish`,
`delete`, `execute`. Confirm-class (send/pay/sign/publish/delete/execute)
always parks for approval (`tool-gate.ts:346-348`).

How the tab inventory was built:

- Tabs: `NEW-FRONTEND/src/lib/routes.ts:13-41` and every `page.tsx` under
  `NEW-FRONTEND/src/app/(app)`.
- Actions per tab: every `api(..., { method })` call in
  `NEW-FRONTEND/src/lib/api/*.ts`, `lib/state/*.ts`, mapped to the component
  folder that imports it.
- Routes: the 83 mutating routes listed in `chat-coverage.md` §"Tab actions".
- Tools: `services/workflows/src/tool-definitions.ts` (154 `ToolDef`s).

Cross-cutting blockers that affect every "✅" below (from file 05):

1. The default `/home` chat is `TrueForgeChat` via `/api/trueforge/*`, not Ask
   AI (05 §2). Tests in this file must use the Ask AI client (`HomeChat`, the
   "Dashboard Overview" view on `/home`, or the Actions command bar) until that
   is fixed.
2. Any confirm-class tool approved in chat is parked again in Actions (05
   AP-B01). Tests for send/pay/sign/publish/delete must check both the chat
   card and the Actions queue.
3. Chat tool calls do not carry `actorUserId` (05 TS-B08). Every new tool in
   this file that mirrors an RBAC-checked route needs it, so **TS-B08 is a
   prerequisite** for the new "workspace" tools below.

---

## 1. Summary

### 1.1 Tabs in NEW-FRONTEND

| # | Tab | Route | Main surfaces | Mutating actions found | Chat coverage |
|---|-----|-------|---------------|------------------------|---------------|
| 1 | Home | `/home` | Chat (TrueForge UI), overview: greeting, snapshot, attention chips, employee mini cards, Ask AI bar with mode picker, history menu, plan cards, approvals | Ask AI routes (excluded from matrix), presence | n/a (it is the chat) |
| 2 | AI Employees | `/ai-employees` | Employee grid, drawer (settings, tools, activity, performance), create flow, skills panel, packs panel, growth panel | 11 | 1 ✅ 2 🟡 8 ❌ |
| 3 | Conversations | `/conversations` | Thread list, thread panel (reply, note, assign, status), new conversation, search, customer overview, open loops, bell popover | 5 | 0 ✅ 2 🟡 3 ❌ |
| 4 | Actions | `/actions` | Morning brief, attention cards (approvals), tasks (work items), templates/playbooks, command bar (sends to Ask AI), work item drawer | 9 | 3 ✅ 2 🟡 4 ❌ |
| 5 | Opportunities | `/opportunities` | Growth opportunities, follow-ups calendar, nudge/call/case-study dialogs | 2 | 0 ✅ 1 🟡 1 ❌ |
| 6 | Insights | `/insights` | KPI cards, insight rows with "Review action", performance | 1 | 0 ✅ 1 🟡 0 ❌ |
| 7 | Insights › Plans | `/insights/plans` and `/plans` | Plan inbox, history, edit params, approve/cancel/execute | 4 (ask-ai plan routes) | chat-native 🟡 (see §4.7) |
| 8 | Insights › Observability | `/insights/observability` | Health, alerts dispatch, backfill, decisions sweep, explain | 3 | 0 ✅ 0 🟡 3 ❌ |
| 9 | Integrations | `/integrations` | Connector cards, connect dialog (Nango), manage drawer, WhatsApp panel, widget drawer, sync now | 9 | 1 🟡 (status only), 8 🔒/❌ |
| 10 | Settings › profile | `/settings/profile` | Profile form, avatar, password, MFA | 2 (+auth) | 🔒 |
| 11 | Settings › business | `/settings/business` | Business overview, onboarding settings, knowledge library (Brain), learned preferences (suppressions) | 8 | 0 ✅ 2 🟡 6 ❌ |
| 12 | Settings › ai-workforce | `/settings/ai-workforce` | Autonomy rules, rollout stage, kill switch | 4 | 0 ✅ 0 🟡 4 ❌ |
| 13 | Settings › notification | `/settings/notification` | Email frequency, toggles (POST `/api/settings`) | 1 | ❌ |
| 14 | Settings › integration | `/settings/integration` | Integration toggles (POST `/api/settings`) | 1 | ❌ |
| 15 | Settings › billing | `/settings/billing` | Plan, change plan, portal, invoices, usage | 3 | 1 🟡 (usage read), 3 🔒/❌ |
| 16 | Settings › security | `/settings/security` | Members, invites, roles, sessions, audit log, data requests (DSR), workspaces | 9 | 0 ✅ 0 🟡 9 ❌/🔒 |
| — | Real-estate panels | none mounted | `components/real-estate/*` (listings, inquiries, showings, rent) are not imported by any page | 14 routes | chat is the **only** live surface (4 ✅ 3 🟡 7 ❌) |
| — | Onboarding flow | `/onboarding/*` | Steps, ready | 4 | 🔒 (one-time flow) |
| — | Platform admin | `/admin/*` | Platform console | excluded (as in `chat-coverage.md`) | — |

Finding T-00: `NEW-FRONTEND/src/components/real-estate/*` (listings, inquiries,
showings, rent panels and dialogs) is not mounted by any route; a grep for
`ListingsPanel|InquiriesPanel|RentPanel` outside the folder returns nothing.
The 14 real-estate routes are therefore reachable only from chat or not at
all. Either mount the panels (likely under Opportunities or a new
"Properties" tab when the real-estate pack is installed) or mark the routes
chat-only in the matrix.

### 1.2 Mutating routes (83)

| Coverage | Count | Routes |
|----------|-------|--------|
| ✅ Covered | 9 | agent crew/run/stream/tools (chat itself), work item create, reassign/priority (PATCH subset), inquiry create, showing create, listing match |
| 🟡 Partial | 14 | brain add (Cognee only), open-loops close (read only), insight review (read), work-item decision (read via brief), billing usage (read), connectors (status only), rent reminders (list only), conversations reply (channel tools, not the inbox), employees (read via SQL), growth opportunity decision (read), pending actions (gate park only), listings sync (none, but sheets read exists), showing update, inquiry status |
| ❌ None | 47 | see §3 |
| 🔒 Human-only | 13 | OAuth/Nango connect, payment checkout/portal, DSR delete, delete member, workspace create/switch, onboarding complete, kill switch (off), auth |

### 1.3 Proposed new tools (39)

Grouped into five new tool modules. Every one is internal (Darex DB), so the
implementation is a thin call into the same `lib` function the route uses,
with the route's RBAC check applied to `actorUserId` (prerequisite TS-B08).

| Module | Tools | Count |
|--------|-------|-------|
| `workspace-work` | `work_item_update_status`, `work_item_comment`, `work_item_decide`, `brief_triage`, `approval_list`, `approval_decide`, `playbook_run`, `sla_sweep_run`, `decisions_sweep_run` | 9 |
| `workspace-inbox` | `inbox_list_threads`, `inbox_read_thread`, `inbox_reply`, `inbox_note`, `inbox_update_thread`, `inbox_start_conversation`, `open_loop_update` | 7 |
| `workspace-employees` | `employee_list`, `employee_create`, `employee_update`, `employee_set_status`, `employee_archive`, `employee_set_tools`, `skill_toggle`, `pack_list`, `pack_install`, `pack_uninstall`, `pack_configure` | 11 |
| `workspace-knowledge` | `brain_add_source`, `brain_update_source`, `brain_delete_source`, `brain_reindex`, `suppression_list`, `suppression_remove` | 6 |
| `workspace-admin` | `autonomy_rule_set`, `rollout_stage_set`, `kill_switch_set`, `settings_update`, `member_update_role`, `invite_create` | 6 |
| extend existing | `growth_opportunity_decide`, `insight_review_start`, `rent_charge_create`, `rent_lease_create`, `rent_reminder_send`, `listing_create`, `listing_update`, `listing_delete`, `listing_sync`, `inquiry_update`, `inquiry_delete`, `showing_update`, `showing_cancel`, `calendar_watch_start`, `alert_dispatch`, `backfill_run` | 16 (counted in §3) |

(The table counts 39 core workspace tools; the 16 extensions bring the total
of new tool definitions to 55.)

---

## 2. Per-tab detail

Each table row: UI action → API route → chat today → gap → tool to add →
risk → live test from `/ask-ai` (prompt and pass condition). "Card" means the
default roster employee whose `tool_allowlist` should list the tool.

### 2.1 AI Employees (`/ai-employees`)

Components: `components/ai-employees/{employees-view,employee-drawer,employee-settings,tools-panel,skills-panel,packs-panel,growth-panel,create-panel}.tsx`;
API clients `lib/api/{employee-details,skills,packs,opportunities}.ts`,
`lib/state/employees.ts`.

| UI action | Route | Chat today | Gap | Tool to add | Risk | Card | Live test |
|-----------|-------|-----------|-----|-------------|------|------|-----------|
| List employees, status, metrics | `GET /api/employees` | 🟡 `database_query` can `SELECT` `ai_employees` (25 rows) | No purpose-built read; SQL tool is read-only and RLS-scoped but returns raw rows | `employee_list` `{ status?: 'active'\|'paused'\|'all' }` → id, name, role, status, tools count, last active | read | all (core read) | "Who is on my team and who is paused?" → names match `/ai-employees`. |
| Create employee (create flow) | `POST /api/employees` | ❌ | — | `employee_create` `{ name: string, role: string, persona?: string, tools?: string[], rosterKey?: string }` | draft | Executive | "Create a Finance employee called Priya with Stripe and QuickBooks." → new card appears; tools exactly those two plus core. |
| Edit persona/name/role (settings) | `PATCH /api/employees/[id]` | ❌ | — | `employee_update` `{ employeeId: uuid, name?, role?, persona? }` | draft | Executive | "Rename Emma to Emily." → drawer shows Emily; audit row `employee.update`. |
| Change tools (tools panel) | `PATCH /api/employees/[id]` (`tool_allowlist`) | ❌ | Must never let an employee widen its own card | `employee_set_tools` `{ employeeId: uuid, add?: string[], remove?: string[] }`; gate rule: caller employee ≠ target unless human actor is admin | publish | Executive (admin user only) | "Give Sarah access to Apollo." → approval card; after approve, Sarah's card lists apollo. Deny path: Sarah asking to add tools to herself is refused. |
| Pause / resume | `PATCH /api/employees` (bulk status, `canDisableEmployee`) | ❌ | — | `employee_set_status` `{ employeeIds: uuid[], status: 'active'\|'paused' }` | publish | Executive | "Pause Marcus until Monday." → Marcus paused; mode picker shows him disabled. |
| Archive (delete) | `DELETE /api/employees/[id]` | ❌ | — | `employee_archive` `{ employeeId: uuid, reason?: string }` | delete | Executive | "Archive the test employee." → approval, then card gone, `archived_at` set. |
| Toggle a skill | `PATCH /api/skills/[id]` (rebuilds allowlists) | ❌ | — | `skill_toggle` `{ skillId: string, employeeId?: uuid, enabled: boolean }` | publish | Executive | "Turn on the invoice-chasing skill for Finance." → skills panel shows on; Finance card gains the skill's tools. |
| List / install pack | `GET/POST /api/packs` | ❌ | — | `pack_list` `{}` (read); `pack_install` `{ packId: string }` | read / publish | Executive | "Install the real-estate pack." → approval → pack listed as installed; `InstallPackWorkflow` started. |
| Uninstall pack | `DELETE /api/packs` | ❌ | — | `pack_uninstall` `{ packId: string }` | delete | Executive | "Remove the real-estate pack." → approval → removed. |
| Configure pack | `PATCH /api/packs/[id]/config` | ❌ | — | `pack_configure` `{ packId: string, config: Record<string, unknown> }` (validated by the pack's schema) | draft | Executive | "Set the real-estate pack's default city to Pune." → config saved. |
| Growth panel: match listings | `POST /api/growth/listings/match` | ✅ `re_inquiry_listing_match` | Same effect (queues opportunity cards) | — | draft | Growth/Sales (needs `re` on card) | "Match open inquiries to listings." → new opportunity cards on `/opportunities`. |

Notes:

- T-01 (P1): none of the employee-management tools exist, so "AI employees
  are configured from the chat" is not possible. The create flow
  (`create-panel`) is itself chat-shaped (`create-transcript.tsx`) but runs
  client-side, not through Ask AI.
- T-02 (P1): `employee_set_tools` and `skill_toggle` change permissions.
  They must be `publish` risk (confirm-class), require an admin human actor,
  and the gate must refuse when the calling employee is the target
  (self-escalation).

### 2.2 Conversations (`/conversations`)

Components: `components/conversations/*`; clients `lib/state/threads.ts`,
`lib/api/{conversations,customer}.ts`.

| UI action | Route | Chat today | Gap | Tool to add | Risk | Card | Live test |
|-----------|-------|-----------|-----|-------------|------|------|-----------|
| List / search threads | `GET /api/conversations` | 🟡 `whatsapp_list_messages`, `instagram_list_messages`, `customer_list_at_risk`; `database_query` | No single inbox read across channels with status/assignee | `inbox_list_threads` `{ status?: 'open'\|'pending'\|'closed', channel?: string, assigneeEmployeeId?: uuid, query?: string, limit?: number }` | read | Customer, Support | "Which open conversations are waiting on us?" → same list and count as `/conversations` filter Open. |
| Read a thread | `GET /api/conversations/[id]/messages` | 🟡 channel-specific list tools | Same | `inbox_read_thread` `{ conversationId: uuid, limit?: number }` | read | Customer, Support | "Show me the last messages with Ravi." → matches thread panel. |
| Reply in thread (teammate reply) | `POST /api/conversations/[id]/messages` | 🟡 `whatsapp_send`, `instagram_send`, `gmail_reply`, `intercom_reply` send directly on the channel, but the message is **not written back** to `messages` (BUILD_STATE 2026-10-09 notes this for WhatsApp/Instagram) | Reply from chat does not appear in the thread | `inbox_reply` `{ conversationId: uuid, text: string, asNote?: false }` → uses the thread's channel (same code path as the route: persist + `channel-outbound`) | send | Customer, Support | "Reply to Ravi: your order ships tomorrow." → approval → message in thread panel and delivered on the channel. |
| Internal note | `POST /api/conversations/[id]/messages` (`note`) | ❌ | — | `inbox_note` `{ conversationId: uuid, text: string }` | draft | all | "Add a note on Ravi's thread: VIP, handle personally." → note visible, not sent. |
| Assign / change status | `PATCH /api/conversations/[id]` (`status`, `employee_id`) | ❌ | — | `inbox_update_thread` `{ conversationId: uuid, status?: 'open'\|'pending'\|'closed', assigneeEmployeeId?: uuid\|null }` | draft | Customer, Support, Operations | "Close the thread with Ravi and assign the next one to Emma." → status closed; assignee updated. |
| New conversation | `POST /api/conversations` (`contactId`, `channelType`, `employeeId`, `initialMessage`) | ❌ | — | `inbox_start_conversation` `{ contactId: string, channelType: string, employeeId?: uuid, initialMessage?: string }` | send (when `initialMessage`), else draft | Customer, Sales | "Start a WhatsApp conversation with +91… and say hi from Darex." → approval → new thread with first message. |
| Open loops: close / snooze | `PATCH /api/employees/customer/open-loops` | 🟡 `customer_list_open_loops` (read only) | No write | `open_loop_update` `{ loopId: string, action: 'close'\|'snooze', until?: string }` | draft | Customer | "Close the open promise to send Ravi a refund status." → loop disappears from Open loops. |

Notes:

- T-03 (P1): chat replies on a channel bypass the inbox. Until `inbox_reply`
  exists, a reply sent from chat is invisible on `/conversations`, breaks SLA
  metrics and the next inbound auto-reply has no record of it.

### 2.3 Actions (`/actions`)

Components: `components/actions/*`; clients `lib/api/{work,actions}.ts`,
`lib/state/{brief,work-items,approvals}.ts`. The command bar already sends to
Ask AI (`components/actions/command-bar.tsx:9`, `:30`).

| UI action | Route | Chat today | Gap | Tool to add | Risk | Card | Live test |
|-----------|-------|-----------|-----|-------------|------|------|-----------|
| Morning brief | `GET /api/brief` | ✅ `daily_brief` | — | — | read | Executive | "Brief me for today." → same items as the brief strip. |
| Triage brief item (approve/snooze/dismiss) | `POST /api/brief/[id]/triage` | ❌ | — | `brief_triage` `{ workItemId: uuid, action: 'approve'\|'snooze'\|'dismiss', snoozeUntil?: string }` | draft | Executive, Operations | "Snooze the Acme renewal item until Friday." → item hidden until Friday. |
| Create task | `POST /api/work-items` | ✅ `work_item_create` | Not on default cards except Operations | add to Executive card | draft | Operations, Executive | "Create a high-priority task to call Acme, assign to Sarah." → task in Tasks. |
| Reassign / priority | `PATCH /api/work-items/[id]` | ✅ `work_item_reassign`, `work_item_set_priority` | — | — | draft | Operations | "Bump the Acme task to urgent." → priority urgent. |
| Change status / due / comment | `PATCH /api/work-items/[id]` | ❌ (only assignee and priority) | — | `work_item_update_status` `{ id: uuid, status: 'open'\|'in_progress'\|'blocked'\|'done', dueAt?: string }`; `work_item_comment` `{ id: uuid, text: string }` | draft | Operations | "Mark the Acme task done." → Tasks shows done; `work_events` row. |
| Approve / reject a pending decision | `POST /api/work-items/[id]/decision`, `PATCH /api/decisions`, `POST /api/agent/pending-actions` | ❌ (gate can park, nothing can decide) | Central gap for approvals from chat (05 AP-B01) | `approval_list` `{ status?: 'pending', employeeId?: uuid }` (read); `approval_decide` `{ approvalId: uuid, decision: 'approve'\|'reject', modifiedPayload?: object, reason?: string }` — RBAC from `decideApproval` on `actorUserId`; never self-approval by an employee | read / (decide inherits the parked action's risk) | Executive | "What is waiting for my approval?" then "Approve the email to Ravi." → action executes once; Actions card disappears. |
| Run a playbook template | `POST /api/work-items/playbook` | ❌ | — | `playbook_run` `{ playbookId: string, inputs?: Record<string, unknown> }` | draft (steps gated individually) | Operations | "Run the overdue-invoice playbook." → work items created as on the Templates section. |
| Sweep SLA breaches | `POST /api/work-items/sweep-sla` | ❌ | Admin/maintenance | `sla_sweep_run` `{}` | draft | Operations | "Check for SLA breaches now." → returns `breachedCount` equal to the button's toast. |
| Expire stale decisions | `POST /api/decisions/sweep` | ❌ | Admin/maintenance | `decisions_sweep_run` `{}` | draft | Operations | "Expire stale approvals." → `expiredCount` matches. |

Notes:

- T-04 (P0 for the chat promise): `approval_decide` is the single most
  important missing tool. Without it, every parked action created by chat
  (05 AP-B01) needs a tab switch.

### 2.4 Opportunities (`/opportunities`)

Components: `components/opportunities/*`; client `lib/api/opportunities.ts`,
`lib/api/growth.ts`.

| UI action | Route | Chat today | Gap | Tool to add | Risk | Card | Live test |
|-----------|-------|-----------|-----|-------------|------|------|-----------|
| List opportunities | `GET /api/growth/brief` | 🟡 `growth_list_dormant_leads`, `growth_list_pipeline_attribution`, `growth_pipeline_roi` (different views) | No list of the opportunity cards themselves | `growth_list_opportunities` `{ status?: 'waiting_approval'\|'approved'\|'rejected', limit?: number }` | read | Growth, Sales | "What growth opportunities are waiting?" → same list as the tab. |
| Approve / reject opportunity (starts outreach) | `POST /api/growth/opportunities/[id]/decision` | ❌ | — | `growth_opportunity_decide` `{ opportunityId: uuid, action: 'approve'\|'reject'\|'snooze', note?: string }` | send (approve starts outreach) | Growth | "Approve the Acme lookalike opportunity." → approval → outreach started (same `work_events` as the button). |
| Follow-up calendar, nudge, call | client dialogs that end in work items or sends | 🟡 `work_item_create`, `gmail_send`, `twilio_send_sms` | Generic tools work but are not tied to the opportunity id | add `opportunityId?: uuid` to `work_item_create` | draft | Growth | "Schedule a follow-up with Acme next Tuesday." → work item linked to the opportunity. |

### 2.5 Insights (`/insights`)

| UI action | Route | Chat today | Gap | Tool to add | Risk | Card | Live test |
|-----------|-------|-----------|-----|-------------|------|------|-----------|
| KPI cards | `GET /api/insight` | ✅ `metrics_list`, `metrics_query` | — | — | read | all | "What's my automation rate this week?" → matches the card. |
| Review action (starts InsightActionWorkflow) | `POST /api/insight` | 🟡 read only | — | `insight_review_start` `{ insightKey: string }` | draft | Executive | "Act on the slow-response insight." → workflow started; card shows "in review". |

### 2.6 Insights › Observability (`/insights/observability`)

| UI action | Route | Chat today | Gap | Tool to add | Risk | Card | Live test |
|-----------|-------|-----------|-----|-------------|------|------|-----------|
| Dispatch alerts | `POST /api/observability/alerts/dispatch` (needs `canManageOrgSettings`) | ❌ | — | `alert_dispatch` `{ alertIds?: string[] }` | send | Operations (admin) | "Send the current alerts to our webhook." → approval → webhook receives payload. |
| Backfill history | `POST /api/onboarding/backfill` | ❌ | — | `backfill_run` `{ kinds?: Array<'loops'\|'won'> }` | draft | Operations (admin) | "Import closed loops and won accounts." → counts match the button. |
| Explain a decision | `GET /api/agent/explain?q=` | 🟡 `database_query` on the ledger | No tool | `decision_explain` `{ query: string }` | read | all | "Why did Emma not reply to Ravi yesterday?" → same rows as Explain. |

### 2.7 Plans (`/plans`, `/insights/plans`)

These are the Ask AI plan routes (`/api/ask-ai/plan`, `/execute`, `/revise`,
`/feedback`). `chat-coverage.md` excludes them as "the chat itself"; they are
listed here because the tab exists and chat cannot drive a plan by words.

| UI action | Route | Chat today | Gap | Tool to add | Risk | Live test |
|-----------|-------|-----------|-----|-------------|------|-----------|
| List plans / history | `GET /api/ask-ai/plan?history=1` | ❌ by words (card only) | "What plans are pending?" cannot be answered | `plan_list` `{ status?: string, limit?: number }` | read | "Which of my plans are still pending?" |
| Approve / cancel | `PATCH /api/ask-ai/plan` | 🟡 buttons on the card only | Approve by words | Do **not** add a model-callable approve (an approval must be a human click). Add a chat command parser: "approve plan <title>" → client renders the card with the Approve button focused. | — | Type "approve the onboarding plan" → card shown, nothing executed without the click. |
| Edit step params | `PATCH /api/ask-ai/plan` (`steps`) | 🟡 card editor | Edit by words | `plan_edit_step` `{ planId: uuid, stepId: string, payload?: object, enabled?: boolean, description?: string }` — only while `pending` | draft | "Change the email in step 2 to ravi@acme.com." → card updates; plan stays pending. |
| Revise draft | `POST /api/ask-ai/revise` | 🟡 card | — | handled by `plan_edit_step` + planner | draft | "Make the draft shorter." |
| Promote to playbook | `POST /api/ask-ai/feedback` (`promote`) | ❌ | — | `plan_promote` `{ planId: uuid, name: string }` | draft | "Save that plan as the 'new client onboarding' playbook." |

### 2.8 Integrations (`/integrations`)

Components: `components/integrations/*`; clients `lib/api/{integrations,whatsapp,widget}.ts`.

| UI action | Route | Chat today | Gap | Tool / decision | Risk | Live test |
|-----------|-------|-----------|-----|-----------------|------|-----------|
| See status | `GET /api/integrations` | ✅ `connectors_status` (live probe) | — | — | read | "Is Gmail connected?" → matches the card. |
| Connect (OAuth) | `GET/POST /api/integrations/nango-token` | 🔒 | Consent must happen in the browser | Chat returns `/integrations?connect=<id>` (already done by tool results) | — | "Connect HubSpot" → link opens the connect dialog. |
| Disconnect | `POST /api/integrations` (`action: disconnect`) | ❌ | Reversible but disruptive | `connector_disconnect` `{ connector: string }` | delete | "Disconnect Slack." → approval → card shows disconnected. |
| Sync now / test | `POST /api/integrations/test`, `POST /api/integrations/[provider]/ping` | 🟡 `connectors_status` probes | Same intent | extend `connectors_status` with `ping: true` | read | "Test the Zendesk connection." |
| Razorpay keys | `POST /api/integrations/razorpay` | 🔒 | Secrets must not pass through model context | Link only | — | Chat refuses and links. |
| WhatsApp number connect (Meta / embedded signup / Evolution QR) | `POST /api/integrations/whatsapp`, `/embedded-signup`, `/evolution` | 🔒 | Credentials / QR scan | Link only | — | — |
| WhatsApp number remove | `DELETE /api/integrations/whatsapp/numbers`, `DELETE …/evolution` | ❌ | — | `whatsapp_number_remove` `{ channelId: uuid }` | delete | "Remove the old WhatsApp number." → approval. |
| WhatsApp auto-reply on/off | `PUT /api/integrations/whatsapp/auto-reply` | ❌ | Common ask | `whatsapp_auto_reply_set` `{ channelId?: uuid, enabled: boolean, employeeId?: uuid }` | publish | "Turn off WhatsApp auto-replies tonight." → panel shows off. |
| Register webhook | `POST /api/integrations/webhooks` | ❌ | Admin | leave link-only (rare) | — | — |
| Website widget config | (`lib/api/widget.ts`) | ❌ | — | `widget_update` `{ enabled?: boolean, greeting?: string, employeeId?: uuid }` | publish | "Change the website widget greeting." |

### 2.9 Settings › business (`/settings/business`)

Components: `business-overview`, `knowledge-library`, `knowledge-files`,
`knowledge-sources`, `knowledge-note-dialog`, `knowledge-revisions-dialog`,
`learned-preferences`; clients `lib/api/{brain,onboarding-settings,suppressions,settings}.ts`.

| UI action | Route | Chat today | Gap | Tool to add | Risk | Live test |
|-----------|-------|-----------|-----|-------------|------|-----------|
| Edit business profile | `PATCH /api/onboarding/settings`, `PATCH /api/org/onboarding` | ❌ | — | `settings_update` `{ section: 'business', patch: { name?, industry?, timezone?, hours?, … } }` | draft | "Our business hours are 9 to 6 IST." → business card updated; quiet hours follow. |
| Add knowledge note / URL / file | `POST /api/brain` | 🟡 `cognee_memory_remember` writes Cognee only; it is NEVER_CORE (`tool-gate.ts:33`) and not visible in the Brain library | Different store; not in the library | `brain_add_source` `{ kind: 'note'\|'url', title: string, content?: string, url?: string }` (files via the chat attachment path, 05 AT-B01) | draft | "Remember our refund policy: 30 days, no questions." → appears in Knowledge library; retrievable next turn. |
| Edit note | `PATCH /api/brain/[id]` | ❌ | — | `brain_update_source` `{ id: string, title?: string, content?: string }` | draft | "Update the refund policy note to 45 days." → revision created. |
| Delete source | `DELETE /api/brain/[id]` | ❌ | — | `brain_delete_source` `{ id: string }` | delete | "Delete the old pricing doc." → approval → removed. |
| Reindex source | `POST /api/brain/[id]` | ❌ | — | `brain_reindex` `{ id?: string }` (no id = whole brain → `POST /api/brain/reindex`) | draft | "Re-index the pricing doc." → status pending → ready. |
| Reindex all | `POST /api/brain/reindex` | ❌ | — | (same tool) | draft | — |
| Learned preferences (suppressions) remove | `DELETE /api/settings/suppressions` | ❌ | — | `suppression_list` `{}`; `suppression_remove` `{ id: string }` | read / draft | "What have my employees stopped suggesting?" then "Let Sarah suggest discount offers again." |

### 2.10 Settings › ai-workforce (`/settings/ai-workforce`)

Components: `autonomy-rules`, `add-autonomy-dialog`, `kill-switch-card`;
clients `lib/api/{autonomy,team}.ts`.

| UI action | Route | Chat today | Gap | Tool to add | Risk | Live test |
|-----------|-------|-----------|-----|-------------|------|-----------|
| Set autonomy tier per employee/action | `PATCH /api/settings/autonomy` | ❌ | — | `autonomy_rule_set` `{ employeeRole?: string, actionType?: string, tier: 0\|1\|2\|3 }` | publish (changes what runs unattended) | "Let Emma send replies without approval for order-status questions." → approval → rule row; next matching send executes without parking. |
| Rollout stage | `PATCH /api/org/rollout` | ❌ | — | `rollout_stage_set` `{ stage: 0\|1\|2\|3 }` | publish | "Move us out of watching mode." |
| Kill switch on | `PATCH /api/org/kill-switch` (`enabled: true`) | ❌ | Turning it **on** from chat is a safety feature | `kill_switch_set` `{ enabled: true, reason: string }` (only `true` allowed from chat) | publish (but allowed for any admin without second approval) | "Stop all employees now." → kill switch on; next tool call denied `kill_switch`. |
| Kill switch off | same with `enabled: false` | 🔒 | Re-enabling must be a deliberate click | link only | — | Chat explains and links. |

### 2.11 Settings › notification and › integration

| UI action | Route | Chat today | Tool to add | Risk | Live test |
|-----------|-------|-----------|-------------|------|-----------|
| Email frequency, notification toggles | `POST /api/settings` | ❌ | `settings_update` `{ section: 'notifications', patch: {...} }` | draft | "Only email me a daily digest." |
| Integration toggles | `POST /api/settings` | ❌ | `settings_update` `{ section: 'integrations', patch: {...} }` | draft | "Stop syncing Shopify orders." |

### 2.12 Settings › billing

| UI action | Route | Chat today | Gap | Tool / decision | Risk | Live test |
|-----------|-------|-----------|-----|-----------------|------|-----------|
| See usage and plan | `GET /api/billing` | ✅ `billing_usage` | — | — | read | "How much of my plan have we used?" |
| Upgrade (checkout) | `POST /api/billing/checkout` | 🔒 | Card entry on Stripe | `billing_checkout_link` `{ plan: string }` returns the Checkout URL (no charge) | draft | "Upgrade to Growth." → link to Stripe Checkout. |
| Manage billing (portal) | `POST /api/billing/portal` | 🔒 | Same | `billing_portal_link` `{}` | draft | "Open the billing portal." |
| Change plan / cancel at period end | `PATCH /api/billing/subscription` | ❌ | Owner only | `billing_change_plan` `{ plan: string, cancelAtPeriodEnd?: boolean }` | pay | "Downgrade to Starter at the end of the cycle." → approval by owner → subscription updated. |

### 2.13 Settings › security

Components: `security-panel`, `invite-dialog`, `sessions-dialog`,
`audit-log-drawer`, `data-requests-drawer`, `delete-data-dialog`,
`create-workspace-dialog`, `delete-workspace-dialog`, `mfa-control`; clients
`lib/api/{team,settings,dsr,audit}.ts`.

| UI action | Route | Chat today | Gap | Tool / decision | Risk | Live test |
|-----------|-------|-----------|-----|-----------------|------|-----------|
| Invite member | `POST /api/org/invites` (via team) | ❌ | — | `invite_create` `{ email: string, role: 'admin'\|'member'\|'viewer' }` | send (emails) | "Invite asha@acme.com as admin." → approval → invite listed. |
| Revoke invite | `DELETE /api/org/invites/[id]` | ❌ | — | `invite_revoke` `{ inviteId: uuid }` | delete | "Cancel Asha's invite." |
| Change member role | `PATCH /api/settings/members/[id]` | ❌ | — | `member_update_role` `{ userId: string, role: string }` | publish | "Make Ravi a viewer." → approval by owner. |
| Remove member | `DELETE /api/settings/members/[id]` | 🔒 | Removing humans from chat is high-impact | link only | — | — |
| Audit log | `GET /api/audit` | 🟡 `database_query` (if `audit_events` readable) | — | `audit_search` `{ kind?: string, actorUserId?: string, since?: string, limit?: number }` | read | "Who approved the Stripe refund yesterday?" |
| Data export (DSR) | `POST /api/dsr/export` | ❌ | — | `dsr_export_start` `{}` returns the download path | draft | "Export all our data." → DSR row created; download link. |
| Data delete (DSR) | `POST /api/dsr/delete` | 🔒 | Irreversible; route requires typing the workspace name | link only | — | — |
| Create workspace / switch | `POST /api/org/workspaces`, `POST /api/org/switch` | 🔒 | Changes the session's org mid-chat; the chat's own context would be wrong | link only | — | — |
| Sessions, password, MFA | `/api/auth/*` | 🔒 | Auth | link only | — | — |

### 2.14 Real-estate (no mounted tab)

Clients exist (`lib/api/{listings,inquiries,showings,rent}.ts`) but no page
renders `components/real-estate/*` (T-00).

| UI action | Route | Chat today | Gap | Tool to add | Risk | Live test |
|-----------|-------|-----------|-----|-------------|------|-----------|
| Search / get listings | `GET /api/listings` | ✅ `re_listings_search`, `re_listings_get` | — | — | read | "2 BHK under 80L in Baner?" |
| Create listing | `POST /api/listings` | ❌ | — | `listing_create` `{ title, locality, bhk?, price?, status?, sourceUrl? }` | draft | "Add a 3 BHK listing in Kothrud at 1.2 Cr." |
| Update listing | `PATCH /api/listings/[id]` | ❌ | — | `listing_update` `{ listingId: uuid, patch: {...} }` | draft | "Mark the Kothrud listing sold." |
| Delete listing | `DELETE /api/listings/[id]` | ❌ | — | `listing_delete` `{ listingId: uuid }` | delete | — |
| Sync listings from sheet | `POST /api/listings/sync` | ❌ (`sheets_read` exists) | — | `listing_sync` `{}` | draft | "Sync listings from the sheet." → counts match. |
| Create inquiry | `POST /api/inquiries` | ✅ `re_inquiry_create` | — | — | draft | "Log an inquiry from Ravi for a 2 BHK in Baner, budget 80L." |
| Update inquiry status | `PATCH /api/inquiries/[id]` | ❌ | — | `inquiry_update` `{ inquiryId: uuid, status?: string, notes?: string }` | draft | "Mark Ravi's inquiry as qualified." |
| Delete inquiry | `DELETE /api/inquiries/[id]` | ❌ | — | `inquiry_delete` `{ inquiryId: uuid }` | delete | — |
| Book showing | `POST /api/showings` | ✅ `re_showing_book` | — | — | send | "Book a showing for Ravi at the Baner flat Saturday 11am." → approval → calendar event. |
| Update / cancel showing | `PATCH`/`DELETE /api/showings/[id]` | ❌ | — | `showing_update` `{ showingId: uuid, startTime?, endTime?, status? }`; `showing_cancel` `{ showingId: uuid, notify?: boolean }` | send (notifies) | "Move Ravi's showing to 4pm." |
| Calendar watch | `POST /api/showings/calendar-watch` (and the duplicate nested path) | ❌ | — | `calendar_watch_start` `{}` | draft | "Watch my calendar for showing changes." |
| Rent reminders list | `GET /api/rent-reminders` | ✅ `rent_reminders_list` | — | — | read | "Whose rent is due this week?" |
| Create lease / charge | `POST /api/rent-reminders/leases`, `/charges` | ❌ | — | `rent_lease_create` `{ tenantName, unit, rentAmount, dueDay, contact? }`; `rent_charge_create` `{ leaseId: uuid, amount, dueDate }` | draft | "Add a lease for flat 4B, 25 000 due on the 5th." |
| Send reminders | `POST /api/rent-reminders` | ❌ (list returns drafts only) | — | `rent_reminder_send` `{ chargeIds?: uuid[] }` | send | "Send this week's rent reminders." → approval → sent; status updated. |
EOF
wc -l /Users/addy/Coding/SaaS/Agentic-Os-SaaS/docs/9oct/06-chat-coverage-gaps-by-tab.md