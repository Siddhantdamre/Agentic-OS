# Execution — 00 End-to-end journeys

Every user and system journey that must work when Darex is
complete. Each journey lists **today** (from current-working),
**complete** (from future-scope), and how we prove it without
fabricating connector or inventory data.

Linked from [../README.md](../README.md). Documentation only.

Verification details: [04-verification-and-probes.md](./04-verification-and-probes.md).

---

## J1 — Ask AI simple (stream)

**Today:** `ask-ai/page.tsx` → `POST /api/ask-ai` → classify
simple → NDJSON SSE → `runAutonomousAgentDirect` → atomic-agent
→ MCP `mcp.darex.*` → `executeAutonomousToolAction`. Grounding
is in the **user** message (`buildGroundedUserMessage`) because
atomic-agent drops `system`. Sources: current-working `03`,
`AGENTS.md`.

**Complete:** Same path plus `retrieveMemory` prefix (R2),
citations (U1), employee router (E2), confirm classes unchanged
for irreversible tools.

**Prove:** Live prompt that needs a connected tool succeeds;
same prompt with that connector revoked returns
`status:'error'`, `connected:false`, `/connectors` URL. Never
invent a calendar event or CRM row.

---

## J2 — Ask AI complex (plan → confirm → execute)

**Today:** classify complex → LiteLLM `generatePlan` →
`agent_plans` row → PlanCard → `PATCH approve` →
`GET /api/ask-ai/execute` SSE. Independent steps run in
**parallel** via `stageSteps`, then `execution_done`.

**Complete:** Same protocol forever (principles). When risk ≥
`send`, execute via Temporal (O4) so process death does not
lose a confirmed send. Playbook matcher (O6) may skip
free-form plan when confident. Citations on the result.

**Prove:** A two-independent-step plan runs both steps; a
dependent step waits. Reject leaves no side-effect. Kill the
Node process mid-send after O4 and confirm Temporal finishes
or pauses honestly.

---

## J3 — WhatsApp inbound → Temporal → reply

**Today:** Meta webhook validates signature → persist message +
conversation → **return 200 immediately** → fire-and-forget
Temporal `AutonomousAgentWorkflow` (or direct) → AI reply saved
+ sent back. Outbound is ops-blocked until Meta token rotation
(H1). Sources: current-working `06`, `16`; `AGENTS.md`.

**Complete:** Same 200-first rule. WorkItemWorkflow (O2) wraps
or replaces the agent workflow. `retrieveMemory` on the user
message. Confirm classes pause `send`/`pay`/`sign` (S2, O7).
Owner approvals use a **distinct** WhatsApp number (H5).

**Prove:** Duplicate webhook does not double-send. Disconnected
Gmail/Sheets in the reply is `notConnected`, not invented
inventory. Token missing → honest error, not `{success:true}`.

---

## J4 — Chatwoot inbound → agent → reply

**Today:** Chatwoot webhook persists, then `fireInboundAgent`
(absorbed; future-scope `01`/`13` are stale). `apps/inbox` is
an HMAC proxy, not a product fork. Query `?org_id=` is the
current scoping pattern — tension with “never trust body
`org_id`” (flagged in
[02-risks-and-open-questions.md](./02-risks-and-open-questions.md)).

**Complete:** Same persist-then-200. Creates a work item (O1).
Memory prefix. HMAC still required. Prefer resolving org from
the Chatwoot inbox mapping, not an unauthenticated query
param, when S2/H2 land.

**Prove:** Bad HMAC 401. Two inboxes / two orgs never mix
replies. Agent runs after 200, not inline.

---

## J5 — Connector connect / notConnected honesty

**Today:** Nango `{orgId}_{provider}`. Missing OAuth →
`status:'error'` + `connected:false` + `/connectors` URL.
Never fabricate. Many client IDs still missing (C1). UI
`catalog_only` hints lag real executors (C2).

**Complete:** Registry-driven UI (C3). Same honesty contract
for every Wave A–E tool. Pack install **recommends**
connectors; never marks them connected.

**Prove:** Goldens: connected send; revoked token; never-
configured provider. Inbox/Ask AI/webhook all use the same
executor honesty.

---

## J6 — Employee / tool allowlists

**Today:** Per-org employee allowlist union. Tools not on the
union are hidden from the agent. Sources: current-working
employees docs; `AGENTS.md`.

**Complete:** E1 must not regress. Router (E2) picks an
employee; allowlist is still the org union unless E5
explicitly decides mention-lock. Pack employees are YAML.

**Prove:** Employee without `gmail.send` cannot send. Adding a
pack employee does not grant `pay` unless YAML says so.

---

## J7 — Multi-tenant isolation

**Today:** Every table has `org_id`. RLS. `getScopedClient()`
sets `app.current_org_id` at session level and resets on
release. Never trust body `org_id`. App still defaults to
`darex` superuser (S1 open).

**Complete:** `darex_app` in running apps. Memory tables RLS +
WITH CHECK. Two-org vector test. Billing invoices isolated.
Pack entities namespaced per org.

**Prove:** Org A embeddings / listings / invoices never appear
in Org B retrieve, `/brain`, or SQL as `darex_app`. Superuser
tests are not the production proof.

---

## J8 — Knowledge / RAG query + `/brain`

**Today:** pgvector extension is on. **No** org RAG pipeline.
Insight is templates. Sources: current-working `14`;
future-scope `10`.

**Complete:** `retrieveMemory` on all agent paths. Write-back
(M4). `/brain` search + cite (M5, U3). File/Drive ingest
(K1–K2) cites. Redaction before embed (S4).

**Prove:** Returning contact on a new thread (M6). Empty org
shows empty brain. Disconnected Drive does not invent a
policy PDF.

---

## J9 — Multi-step orchestration / work items

**Today:** Ask AI plans + three Temporal turns on inbound.
No `work_items` table. No scheduled briefing. No HITL signal
on webhook send.

**Complete:** WorkItemWorkflow (O2). Owner briefing + stale
chase (O5). Playbooks + nurture cancel-on-reply (O6). HITL
signal (O7). Work items UI (U2).

**Prove:** Process death mid-workflow resumes. Nurture
cancels when the contact replies. Owner reject leaves no send.

---

## J10 — Admin / settings / analytics / insight

**Today:** Settings (webhooks, Meta vs Chatwoot URLs fixed),
employees, connectors, analytics pages, Insight templates.
Langfuse ingestion fixed; ClickHouse flaky.

**Complete:** Insight from semantic metrics (A3, K4), not
templates. Cost per org (A4). Rate limits (S5). Audit log
(S3). Billing portal (B2). Warm-up = real provisioning (U5).

**Prove:** Insight number matches SQL. “Review Action”
enqueues Temporal. Analytics does not LLM-scan `messages`.

---

## J11 — Register / onboarding → pack

**Today:** SuperTokens register. Onboarding stores business
type in Zustand + `org_onboarding`. Does **not** install a
pack. Default roster Sarah/Emma/Marcus is seeded, not a
versioned pack.

**Complete:** P1/P2/U5. Type → pack recommendations.
InstallPackWorkflow idempotent. Other/not sure → `core-b2b`
only. Connectors recommended, never auto-connected.

**Prove:** Re-run onboarding does not duplicate employees.
Uninstall hides modules; conversations remain.

---

## J12 — Owner WhatsApp approve

**Today:** Missing. Customer WhatsApp is the only Meta path.

**Complete:** Distinct owner number (H5). Temporal signal
(O7) for `send`/`pay`/`sign`. Critic gate (E3) before the
approval request.

**Prove:** Customer inbound on the customer number cannot
approve a payment. Wrong-org owner cannot signal another
org’s workflow.

---

## J13 — Real estate inquiry → match → showing (target)

**Today (2026-08-14):** Pack + `re_listings` projection + listings/inquiries
UI can start `ShowingScheduleWorkflow`. Goldens in
`infra/evals/re-brokerage.yaml`. Pack is **not** `live`.

**Complete:** WhatsApp “2BHK in X under Y” filters the sheet
first, then optional vector. Zero matches does not invent.
Showing books on Calendar. RERA/fair-housing validators.
Goldens in future-scope `05` §11.

**Prove:** Sheet with three rows returns a subset. Empty
sheet / disconnected Sheets → notConnected + setupUrl.
Two-org listings never leak.

---

## J14 — Billing / stranger signup (target)

**Today:** `orgs.plan` column exists. No Stripe/Razorpay
**Darex** billing. Org payment-link tools are unrelated.

**Complete:** B2/B3. Stranger signup → paid plan in staging →
pack → WhatsApp → memory reply (Phase 9 exit). Failed
payment does not leak invoices.

**Prove:** Webhook signature required. Two-org invoice
isolation. Meters do not increment on `notConnected`.

---

## J15 — Disconnected MLS / Sheets honesty

**Today:** No MLS. Sheets is a connector/tool, not an
inventory SoR.

**Complete:** Licensed MLS may never exist. Sheets wedge is
the bar. Agent never scrapes portals or invents RERA/price.

**Prove:** Eval-runner fails any reply that includes a listing
id not in the sheet.

---

## J16 — Inbox outbound send

**Today:** Inbox forwards to `/api/webhooks/outbound`
(absorbed). Still depends on a live Meta token (H1).

**Complete:** Same path; work item + confirm class if the
message is agent-originated `send`.

**Prove:** Fake `{success:true}` without Meta is a regression.
Probe the outbound route with a revoked token.

---

## J17 — Invite member

**Today:** `org_invites` + copyable URL; Resend if key set.

**Complete:** B1 default email when key set; URL always
works. SSO orgs (S7) still accept invites per design.

**Prove:** No key → URL works. Expired invite cannot join
the wrong org.

---

## J18 — DSR export / delete (target)

**Today:** Missing.

**Complete:** S6. Export is org-scoped. Delete removes
memory vectors for that org only.

**Prove:** Org B rows remain after Org A delete.

---

## Journey coverage map

| Journey | Immediate | Near | Mid | Complete |
|---------|-----------|------|-----|----------|
| J1 simple Ask AI | R2 prefix | U1 cite | — | — |
| J2 complex plan | — | O4 start | O4+O6 | — |
| J3 WhatsApp | H1 token | O2 wrap | O7/H5 | — |
| J4 Chatwoot | — | O1/O2 | — | org mapping |
| J5 connectors | C1/C2 | C3–C6 | C7 | later waves |
| J6 allowlists | E1 | E2 | E5 decide | — |
| J7 tenancy | S1 | vector test | billing | DSR |
| J8 RAG / brain | M1–M3 | M4–M6 | — | ingest polish |
| J9 orchestration | O1 optional | O2 | O5–O7 | — |
| J10 admin/insight | — | A3 | B2 | S3/S7 |
| J11 onboarding | — | — | P1/P2 | — |
| J12 owner WA | — | — | H5 | — |
| J13 RE wedge | **blocked** | **blocked** | P3 | P4 |
| J14 billing | — | — | B2 | — |
| J15 Sheets honesty | — | — | P3 | — |
| J16 inbox send | H1 | — | confirm | — |
| J17 invite | B1 optional | — | B1 | — |
| J18 DSR | — | — | — | S6 |

Related: [01-definition-of-done.md](./01-definition-of-done.md),
[../phases/00-phase-map.md](../phases/00-phase-map.md).
