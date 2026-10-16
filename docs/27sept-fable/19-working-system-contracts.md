# 19 · Memory, channels, identity, money — contracts that make the jobs stick

> ### 📊 Master Audit Completion Status
>
> | Status | Count | Percentage |
> |---|:---:|:---:|
> | 🟢 **Done (Verified)** | 20 | 3.3% |
> | 🟡 **Pending / In Progress** | 42 | 7.0% |
> | 🔴 **Not Done (Open)** | 538 | 89.5% |
> | ⛔ **Blocked (Human/Infra)** | 1 | 0.2% |
> | **Total Findings** | **601** | **100.0%** |

Audit date 2026-09-27. Files `05`–`08` and `10` list the holes. This file is how those layers behave once the turn contract (`17`) and the employee jobs (`18`) are true. An employee that answers well and then leaks the customer's PAN into Cognee, double-sends on retry, or ignores a suspended org has not "worked".

---

## 1. Memory — one write path, one read path

### 1.1 Write

Every insert into `org_memory`, `conversation_memory`, `entity_memory`, Cognee, or `facts` goes through `writeMemory(input)` in `services/workflows/src/memory/`. Callers stop inserting bodies themselves.

| Step | Rule | Closes |
|---|---|---|
| 1. Policy | `writeback-policy` decides. Inbound customer text (WhatsApp, Chatwoot, widget, email) is **not** org-wide memory by default. It may enter conversation-tier memory for that thread only. Org-tier requires an explicit remember, a file the user uploaded, or a connector sync the admin turned on | MEM-S02 |
| 2. Redact | `redactForEmbed` runs on the body **before** the row insert and before any Cognee call. PAN, Aadhaar, card numbers, OTPs, tokens. The model never sees a tool result that still contains an OTP (RT-S13) because redaction happens at the tool boundary too | MEM-S01 |
| 3. Scope | Row carries `org_id`, `tier` (`conversation` \| `entity` \| `org`), `source`, `source_ref`, `employee_id` nullable, `expires_at` nullable | MEM-G03 |
| 4. Embed | Job row, not an in-request embed of the first 1,000 characters. Parent `knowledge_sources` becomes `ready` only when every chunk job is `done` or `failed`. A failed chunk does not leave the parent looking ready | MEM-B01 |
| 5. Disable | `enabled = false` on a source hides every chunk whose `source_ref` starts with that path, including `#cN` | MEM-B02 |
| 6. Cognee | Same redacted text, dataset `org_<id>`, and a delete call that DSR and org purge actually invoke | MEM-S04, SEC-C01 |

`employee_memory`, `facts`, and `fact_conflicts` stay unread-only until a writer exists. Do not point the UI at them. The learning loop is not shipped (file `05` W9, W10).

Tool results are not auto-memorised. Research citations are stored only when the user says "remember this", with `source:'web'`, URL, content hash, and `fetched_at` (`14` WEB-G05).

### 1.2 Read

`retrieveMemory` takes `{orgId, employeeId, conversationId, tierCeiling}`.

| Caller | Ceiling |
|---|---|
| Ask AI / in-process turn | conversation tier for this thread, plus org tier, filtered by employee memory scope once EMP-E06 exists. Until then: conversation + org, never another conversation's customer tier |
| Work item | same, and the employee id is the **routed** employee. Retrieve runs after routing, not before (`WorkItemWorkflow` currently retrieves first — file `05` §1.2) |
| Brain UI | org tier only, same SQL as the agent so the page and the chat cannot disagree |
| Cognee tool | dataset = org id, and the tool is `cognee_search` (read). `cognee_remember` is not core |

The vector query must be able to use the HNSW index (the range predicate that disables it is removed or rewritten — MEM-B05). Citations returned to the model include `source_ref` and a stable id the UI can link. Entity lock and facts-first stay off until a caller passes `entityId` and a writer fills `facts`.

### 1.3 Forget

DSR delete and org purge are generated from `information_schema` tables that contain `org_id` plus an explicit list of external stores: Cognee dataset, Nango connection, Langfuse traces, SuperTokens user. A table added later fails CI if it has `org_id` and is missing from the purge manifest (SEC-C01, MEM-E01).

### 1.4 Proof

Upload a 3-chunk file → Brain shows `ready`. Disable it → a new Ask AI turn does not cite it. Paste a PAN in WhatsApp → the value is absent from `org_memory.body` and from the Cognee payload (assert on the test double). Delete the org → Cognee dataset delete was called.

---

## 2. Channels — one inbound pipeline

WhatsApp, Chatwoot, Gmail, Slack, SMS, Instagram, and the widget all end in the same function `acceptInbound(event)`.

| Step | Rule | Closes |
|---|---|---|
| 1. Authenticate | Per-org secret or platform signature. A global `CHATWOOT_WEBHOOK_SECRET` is not enough to choose the org. Slack `team_id` maps to `org_connectors`. Widget uses a server-issued visitor token. Body `orgId` is ignored | CH-S01, CH-S02 |
| 2. Dedupe | Unique partial index: one open conversation per `(org, channel, contact)`. Insert the message idempotently on the provider event id | CH-B05 / the unique-index packet in `12` §1.7 |
| 3. Persist and return 200 | Before any model call. The agent runs after the response, on Temporal | standing rule in `AGENTS.md` |
| 4. Route | Channel → employee assignment, else sticky employee for that contact, else router. Never "first employee created" (`webhooks/whatsapp/route.ts:165-172`, EMP-G08) | EMP-G08 |
| 5. Turn | `17` §2 with that employee id. Inbound never starts a crew | `17` §6 |
| 6. Reply | Send through the same gate (confirm class `send`). Human-approval replies wait. Quiet hours defer. The outbound row is written **after** the provider accepts, with `failed` if it did not | CH-B12 |
| 7. Memory | Conversation-tier only, redacted (`§1`) | MEM-S02 |

**Widget.** Two anonymous visitors are two conversations. The session cookie is the visitor token, not a shared anon bucket.

**Owner WhatsApp.** The owner-briefing webhook is the one path that may address the org owner. It still uses §2 of `17`. It is not a backdoor that skips the kill switch.

**Proof.** A forged outbound POST with another org's conversation id returns 403. Two concurrent WhatsApp deliveries of the same user create one conversation. Kill switch on ⇒ inbound is stored, no reply is sent.

---

## 3. Identity and tenancy

The turn contract trusts `orgId` and `actorUserId`. This section is how those values are produced.

| Rule | Working behaviour | Closes |
|---|---|---|
| Session cookie | Every login mints `epoch` from `users.session_epoch` and an `exp`. `revoke-sessions` increments epoch. The next login works. A revoked cookie is 401 on tenant routes **and** on `/api/platform/*` | SEC-A01, SEC-A02 |
| Org status | `suspended` and `soft_deleted` fail `assertOrgRunnable` in the executor, the webhook accept, and the sweep tick. Not only at worker boot | EMP-S11 |
| RLS | `darex_app` remains the runtime role. `darex_platform` has the grants the admin console needs (migration `123`) and no blanket `write_all`. The isolation test does **not** re-grant privileges to hide a hole | SEC-P01, SEC-C02 |
| Platform admin | `requirePlatformAdmin` checks epoch. Impersonation is a separate cookie; ending it does not log the customer out | SEC-A02, SEC-P04 |
| Pack catalogs | Not writable by a tenant (SEC-T02). `platform_send_counters` has RLS | SEC-T01 |
| Webhook secrets | Per org, stored encrypted. Rotation does not require a deploy | CH-S01 |
| SSO | One global SSO client that JIT-creates an owner org is not the enterprise design. Per-org IdP, group → role, domain claim are Wave 3 (ENT-01, SEC-A05). Until then, SSO stays off for any org that has not configured it, and the docs do not say SSO is done | SEC-A05 |
| MFA | Org-enforced TOTP with recovery codes, secrets not replayable from plaintext. Wave 3. Do not claim it | SEC-A08 |

**Proof.** Login → revoke sessions → login again succeeds. Revoked platform cookie gets 401 on `/api/platform/orgs`. Tenant A cannot `SELECT` tenant B (isolation test green without a re-grant). `/admin` lists orgs using `darex_platform`.

---

## 4. Money

Caps cannot work if spend is invisible. Record spend at the model boundary, then enforce.

| Rule | Working behaviour | Closes |
|---|---|---|
| Record | Every LLM and embed call, including webhook, crew, and sweep turns, writes `org_model_spend` with `org_id`, `employee_id`, tokens, and cost. In-process Gemini/Groq calls are included. LiteLLM callback uses `user_id = orgId` | BIZ-B01, OPS-B02, OPS-B03 |
| Refresh | `refreshOrgMeters` is a Temporal schedule per org, not a side effect of opening `/billing` | BIZ-B02 |
| Gate | Hard cap denies the next turn (chat, webhook, sweep) inside `17` §2 step 4. DB error denies. A free org does not get nine employees and every tool: `plan_limits` checked at provision, invite, executor, and crew start | BIZ-G01, EMP-B14 |
| Pay tools | Amount is required in the parsed payload. Missing amount is `invalid_args`. `canCallPayTools` on the human who approves | RT-B06, SEC-R01 |
| Credits | Apollo/enrichment debits a credit meter in the same transaction as the idempotency claim (`14` §8.1) | WEB-S09 area |
| Billing page | Shows the same numbers the gate uses. Cost health says "no data" when the table is empty, not "healthy" | OPS-B02 |
| Webhooks | Stripe (and Razorpay) signature, tolerance window, and event-id dedupe. A replay does not grant a second period | `12` §1.7 |

**Proof.** A WhatsApp reply increments `org_model_spend`. An org over the hard cap gets `usage_blocked` on the next webhook within one cron interval. A plan step with `{tool:'stripe', action:'create_charge'}` and no amount returns `invalid_args` and creates no charge.

---

## 5. Approvals and audit — one table, one executor

Five screens (decisions, pending-actions, work-item decision, Ask AI approve, Slack card) call `decideApproval({pendingActionId, decision, actorUserId})`.

| Rule | Detail | Closes |
|---|---|---|
| State | Row in `agent_pending_actions`. Survives a worker restart | OPS-S01 |
| Execute | On approve, re-enter `17` §2 at the idempotency step with the **stored** payload. The client cannot swap the amount | ASK-E01, RT-G04 |
| Audit kind | The kind string passes the `audit_events` CHECK. A failed insert is a 500, not a swallowed warning | OPS-B01 |
| RBAC | Pay actions require `canCallPayTools`. Viewers cannot approve | SEC-R01 |
| Expiry | The decision-expiry sweep and the SLA sweep are in `PERIODIC_SWEEPS` and call this executor | OPS-G07 |
| Coverage | Every mutating HTTP route calls `recordAuditEvent` or it fails a CI grep that lists the exceptions | SEC-C03 |

---

## 6. Frontend states the contracts need

The API can be right and the product still look broken. These states are part of "works":

| Surface | Required state | Closes |
|---|---|---|
| Any page | `error.tsx` renders the failure. A 500 is never the empty-state illustration ("No listings") | UI-B01, UI-B06 |
| Ask AI | Routing line, then tokens. Approval card shows the summary from §5. Reload restores it (`17` §4) | ASK-B09, ASK-G10 |
| Kill switch | A banner on every dashboard page when `assertOrgRunnable` would deny, not only a toggle that nothing reads | EMP-S01 |
| Mobile nav | Settings, Billing, and Sign out are reachable | UI-B02 |
| Connectors | A tool with no catalog row is not offered in the employee picker (`18` Sarah, Marcus) | RT-E01 |
| Plans | History, per-step risk, and edit-params. Revise returns the plan to pending in the UI because the API did | ASK-G02, ASK-B11 |

---

## 7. How the four contracts compose on one message

WhatsApp from a customer, org at stage 2, under cap, kill switch off:

1. `acceptInbound` verifies the per-org signature, dedupes, stores the message, returns 200.
2. Router picks Emma (sticky) or Customer (refund language).
3. `retrieveMemory` returns conversation-tier context, redacted, no other customer's tickets.
4. The model drafts a reply. `gmail`/`whatsapp` send hits confirm class `send` → `pending_approval` because stage 2 escalates external actions (`employee-gate.ts` stage 2).
5. Owner approves in the inbox. `decideApproval` sends once. The idempotency key blocks the Temporal retry from sending again.
6. Spend row is written. Conversation-tier memory stores the redacted exchange. Cognee does not receive the raw thread.
7. Audit row exists for the approval and the send.

If step 4 sends immediately, or step 5 can send twice, or step 6 can find the customer's phone number in Cognee, the product does not work yet — even if each individual bug ticket was closed in isolation.

---

## 8. Proof list (run after Wave 1)

| # | Action | Pass |
|---|---|---|
| 1 | `17` §8 six checks | all six |
| 2 | `18` proving prompts for Emma, Customer, Operations, Executive | routing + tool + no invention |
| 3 | PAN in a webhook body | absent from memory tables and Cognee |
| 4 | Disable an uploaded file | next turn does not cite it |
| 5 | Forged cross-org webhook | 403, no row in the victim org |
| 6 | Revoke sessions, log in again | success; old cookie 401 |
| 7 | Suspend org | sweep tick sends nothing; chat returns `org_not_runnable` |
| 8 | WhatsApp reply | `org_model_spend` increased |
| 9 | Approve a refund as `member` | 403; as owner, one charge attempt, replay does not repeat it |
| 10 | Throw inside a dashboard page | error boundary, not a blank screen |

Record the date and the command or screenshot note in `BUILD_STATE.md` in the same commit that flips the matching rows in `13-master-tracker.md`.
