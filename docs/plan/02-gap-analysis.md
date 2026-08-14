# 02 — Gap analysis

Every future-scope capability versus **the code** (audit **2026-08-14**).
Status values: **done**, **partial**, **missing**, **ops-blocked**
(code ready, credentials or operator step missing), **deferred**.

Linked from [README.md](./README.md),
[00-executive-summary.md](./00-executive-summary.md), and
[01-current-state-baseline.md](./01-current-state-baseline.md).
Documentation only. No application data files.

If docs and code disagree on **what exists**, **code wins**. Section 0
lists future-scope claims absorbed before this audit; section 0.1
lists plan items the 14 Aug tree closed. Narrative:
[README.md](./README.md) audit summary.

---

## 0. Future-scope `01` / `06` / `13` items already absorbed

[`docs/future-scope/01-from-today-to-os.md`](../future-scope/01-from-today-to-os.md)
was written as a bridge and is **stale** against
`docs/current-working/16-updates-2026-08-13.md`. Treat the right-hand
column as truth.

| Future-scope claim (stale) | Current-working reality (2026-08-13) | Plan status |
|----------------------------|--------------------------------------|-------------|
| 11 SKILL.md not copied into atomic-agent image | Dockerfile COPY into `starter-skills` (`07`, `16`) | **done** in working tree; still needs image rebuild after edits; may be uncommitted vs `99b5f04` |
| `infra/docker/sandbox/` not in git | Context present in working tree; untracked vs `99b5f04` | **partial** — land on default branch |
| Chatwoot webhook does not invoke the agent | `fireInboundAgent` after persist (`06`, `16`) | **done** |
| Google Chat / Meet / GA4 / GSC / GBP / Cloud are stubs | Real HTTP executors + MCP names (`08`, `16`) | **done** as executors; UI catalog hints still **partial** |
| Member invite inserts row, no email | `org_invites` + copyable URL; Resend if `RESEND_API_KEY` | **partial** — email still optional |
| Settings Meta URL points at Chatwoot | Distinct `metaWebhookUrl` / `chatwootWebhookUrl` (`16`) | **done** |
| Inbox outbound `{success:true}` does not send | Forwards to `/api/webhooks/outbound` (`06`, `16`) | **done** |
| Langfuse on shared Redis | Dedicated `langfuse-redis`; ClickHouse still flaky | **partial** |
| Hermes route should be deleted | Route gone (`10-api-reference.md`) | **done** |
| Chatwoot → WorkItemWorkflow (Phase 6 hygiene in `13`) | Agent is wired; WorkItemWorkflow itself is **missing** | agent **done**; work-item model **missing** |
| Phase 9: fix Meta URL + inbox send | Both done in working tree | **done** — do not re-list as Phase 9 work |
| `06` catalog: Chatwoot “wire to agent”, GBP/Meet/GA4 as stub | Executors exist; catalog file not updated | update `06` status column when absorbing |
| `AGENTS.md` “49 tools” | 62 MCP tools | cheat-sheet stale |

[`docs/future-scope/13-phased-roadmap.md`](../future-scope/13-phased-roadmap.md)
Phase 6 “also hygiene” and Phase 9 bullets must be read through this
table.

---

## 0.1 Plan items closed in code after the 13 Aug snapshot

The 13 Aug plan marked Phase 6–15 as **missing**. The tree now has
migrations **012–020** and matching workflows/UI. Do not rebuild.

| Plan id | Evidence | Status |
|---------|----------|--------|
| M1 | `infra/db/migrations/013_memory_rag.sql` | **done** |
| M2 | `services/workflows/src/activities/embed.ts`, `EmbedWorkflow` | **done** (never on webhook thread) |
| M3 / R2 | `memory/retrieve.ts`; Ask AI, `/api/agent/run`, `runAgentTurnActivity` | **done** on those paths |
| M4 | `MemoryWriteBackWorkflow` + `activities/memory-writeback.ts` | **done** |
| M5 / U3 | `/brain` page + `/api/brain` | **done** |
| M6 | `infra/evals/phase6-returning-contact.yaml`; parent `retrieveMemoryActivity` calls `retrieveMemory` | **partial** — eval exists; live eval not green on a migrated DB |
| O1–O6 | work_items, WorkItemWorkflow wrap, PlanExecute, briefing/stale-chase/nurture, playbook matcher | **done** |
| O7 | Signals + `condition()` wait on PlanExecute and WorkItem inbound send/pay/sign **tools** (not only the channel reply) | **done** |
| C3 / C4 / C5 | `014_connector_registry.sql`, `tools/*.ts`, Outlook | **done** |
| C6 | Salesforce, Zoho CRM, DocuSign, Leegality, Maps, Twilio, QuickBooks | **done** as executors (2026-08-14 leftovers). Live OAuth/BYOK **ops-blocked**. |
| K1–K4 | Ingest/Sync workflows, `metrics.ts` | **partial** (virus-scan stub) / K4 **done** |
| I3 / I4 / H7 / S1 | Redis bus, PgBouncer, `darex_app` | **done** |
| S2 / S3 / S5 / S6 | inbound-confirm, audit_events, boot-guards, DSR | **done** |
| S7 | `/api/auth/sso/*` + `SUPERTOKENS_SAML_TEST_IDP` | **partial** — env wired; live IdP still human |
| E2–E6 | router, critic, Research/Finance, @employee org-union, auditor | **done** |
| U1 / U2 / U4 / U5 | citations, `/plans`, listings/inquiries, pack-recommendations | **done** |
| P1 / P2 | `packs/core-b2b`, `InstallPackWorkflow` | **done** |
| P3 | `packs/re-brokerage-in` | **partial** — UI can start ShowingSchedule / RentReminder; fixture evals runnable; pack not `live` until Calendar + migrated-DB verify |
| A2–A5 / B4 | `infra/evals/`, insight enqueue, cost, promote | **done** as code |
| B2 / B3 | `/api/billing/*` + `DAREX_STRIPE_*` / `DAREX_RAZORPAY_*` | **partial** — config wired; live PSP keys still human |
| B5 | `marketplace-preview.md`, `/skills` | **done** as design-only |
| L4 / L5 | CI deny-list | **done** |
| H2 | `018_channel_key.sql` | **done** |
| H3–H5 | gmail/instagram/sms/owner-whatsapp API routes | **partial** |
| H6 | `/embed/widget.js` + Settings snippet + CORS | **done** |
| I5 / I6 | `infra/terraform/`, restore-drill, alerting scripts | **partial** |

---

## 1. Six Brain OS layers

From [`00-vision-ai-brain-os.md`](../future-scope/00-vision-ai-brain-os.md).

| Layer | Today (2026-08-14) | Remaining gap |
|-------|--------------------|---------------|
| 1 Perception | WhatsApp + Chatwoot + widget embed + Gmail-push/IG/SMS routes | Provider go-live for Gmail/IG/SMS; voice **deferred** |
| 2 Memory | RAG tables + hybrid retrieve + write-back + `/brain`; parent `retrieveMemoryActivity` | M6 live eval; AGE **deferred** |
| 3 Reasoning | classify + plan-confirm-execute + router + critic + playbooks + named Temporal workflows + WorkItem HITL wait | Compensating txns |
| 4 Action | Modular `tools/*`; registry; MCP includes Zoho/Leegality/QuickBooks | FUB / MLS / Pipedrive |
| 5 Governance | Ask AI + webhook confirm; RLS; auditor; DSR; SSO routes | SSO IdP proof; residency design; SCIM |
| 6 Learning | Langfuse ingest; eval YAML; thumbs → promote | ClickHouse flake; no cross-org training (correctly forbidden) |

---

## 2. Capability matrix (future-scope vs current)

### Runtime and agent loop

| Capability | Source | Status |
|------------|--------|--------|
| atomic-agent tool loop | current `07` | **done** |
| LiteLLM classify/plan/revise split | BUILD_STATE | **done** |
| MCP `mcp.darex.*` | mcp-bridge (~85 tools) | **done** |
| Skills mounted in image | Dockerfile COPY | **done** |
| Sandbox Docker context | `infra/docker/sandbox/` | **done** |
| `retrieveMemory` in grounded user message | `atomic-agent-client.ts` | **done** (Ask AI / run / child turn) |
| Risk metadata on gateway | `tools/risk.ts` | **done** |
| Semantic `metrics.query` | `tools/metrics.ts` | **done** |
| Computer-use / browser-runner | future `08` §11, Phase 17 | **deferred** |

### Orchestration

| Capability | Source | Status |
|------------|--------|--------|
| Ask AI plan-confirm-execute + parallel steps | current `03` | **done** |
| Temporal `AutonomousAgentWorkflow` (3 turns, idempotency) | current `07` | **done** |
| WorkItemWorkflow unifying inbound | future `09` | **done** (wrap) |
| OwnerBriefingWorkflow | future `09` | **done** (code) |
| StaleChaseWorkflow | future `09` | **done** (code) |
| ShowingSchedule / RentReminder | future `05`/`09` | **partial** — workflows + `/listings` `/inquiries` UI + `/api/showings` `/api/rent-reminders`; Calendar-connected book not live-proven |
| InstallPackWorkflow | future `03`/`09` | **done** |
| Playbook matcher (skip free-form plan) | future `09` §5 | **done** |
| Nurture timers | future `09` §7 | **done** |
| HITL as Temporal signal (not only PlanCard HTTP) | future `09` | **done** — PlanExecute + WorkItem inbound `condition()` **before send/pay/sign tools** |
| Compensating transactions | future `01` action gaps | **missing** — log + `needs_attention` |

### Memory / RAG / knowledge

| Capability | Source | Status |
|------------|--------|--------|
| pgvector extension | current `11` | **done** |
| `org_memory` / `entity_memory` / `conversation_memory` | future `10` | **done** (`013_memory_rag.sql`) |
| embed-worker + `EMBEDDING_MODEL` | future `02`/`10` | **done** |
| `retrieveMemory` on Ask AI + webhook child turn | future `10` §4 | **done** |
| retrieve on WorkItem parent activity | O2 + M3 | **done** |
| MemoryWriteBack activity | future `10` §5 | **done** |
| `/brain` inspector | future `10` §6, `11` | **done** |
| Hybrid vector + FTS | future `10` §10 | **done** in `retrieve.ts` |
| Temporal fact columns | future `10` §10.2 | **missing** (optional; do not block) |
| File parse → chunk → embed | future `07` | **partial** — ingest workflow; virus-scan stub |
| Sync cursors / ingest jobs | future `02`/`07` | **partial** |
| Knowledge graph / AGE | future `02`/`07` | **deferred** — `memory_edges` only |

### Integrations

| Capability | Source | Status |
|------------|--------|--------|
| Nango as OAuth truth | current `05` | **done** |
| Honest notConnected | current `08` | **done** |
| Core Google workspace executors | current `08` | **done** (if connected) |
| HubSpot/Slack/Notion/Stripe/Shopify/Zendesk/Intercom executors | current `08` | **ops-blocked** (Nango client IDs) |
| GBP / Meet / GA4 / GSC / Chat / Cloud executors | current `08` vs future `06` | **done** as HTTP |
| Connector registry tables | future `02` §4.3 | **done** (`014_connector_registry.sql`) |
| Split `tool-executor.ts` modules | future `02` §5 | **done** (`src/tools/*.ts`) |
| Outlook / Teams / OneDrive | future `06` Wave B | **partial** — Outlook + MS Calendar |
| Salesforce | future `06` | **done** as executor |
| Zoho CRM / Pipedrive | future `06` | Zoho CRM **done** as executor; Pipedrive **missing** |
| DocuSign | future `06` | **done** as executor |
| Leegality | future `06` | **done** as executor (BYOK; live token ops) |
| Twilio / Instagram | future `06` | **partial** — Twilio tool + SMS/IG webhooks |
| Maps geocoding | future `06` | **done** |
| Follow Up Boss / RESO MLS | future `05`/`06` | **missing** / **deferred** |
| QuickBooks / Zoho Books | future `06` | QuickBooks **done** as executor; Zoho Books **missing** |

### Channels and surfaces

| Capability | Source | Status |
|------------|--------|--------|
| WhatsApp inbound persist + agent | current `06` | **done** |
| WhatsApp outbound Graph | current `06`/`14` | **ops-blocked** (expired token) |
| Chatwoot ingest + agent | current `06` | **done** |
| SSE inbox + Redis bus | future `11` §3 | **done** (code; two-replica probe) |
| Gmail push inbound | future `11` | **partial** — route; needs Pub/Sub |
| Web widget / Instagram / SMS | future `11` | widget embed **done**; IG/SMS APIs **partial** |
| Owner WhatsApp (“text your business”) | future `11` §4 | **partial** — distinct route; needs number |
| `/brain`, listings, plans inbox | future `11` §2 | **done** |
| Mobile / a11y | future `11` §6, Phase 9 | **partial** — `components/a11y/*` |
| Voice | Phase 17 | **deferred** |

### Security / tenancy / org

| Capability | Source | Status |
|------------|--------|--------|
| RLS + WITH CHECK | current `11` | **done** |
| Session GUC + no body `org_id` | current `04`/`16` | **done** |
| `darex_app` grants + runtime | current `11` | **done** (compose `DB_USER=darex_app`) |
| Confirm on Ask AI plans | current `03` | **done** |
| Confirm classes on webhook path | future `08` §8, `12` | **done** (`inbound-confirm.ts`) |
| Data-class tags | future `12` §6 | **partial** — `audit_events.data_classes` |
| SSO / SAML / SCIM | future `12` | **partial** — SSO routes; SCIM **missing** |
| Roles owner/admin/member/auditor | future `12` | **done** (`019_human_roles.sql`) |
| DSR export/delete | future `12` §8 | **done** |
| Encrypted BYOK secrets table | future `12` §3 | **partial** — `channels.meta` JSONB |
| `ALLOW_DEMO_AUTH` prod fail | future `12` | **done** (`boot-guards.ts`) |
| Data residency design | future `13` Phase 15 | **missing** |

### Employees / packs

| Capability | Source | Status |
|------------|--------|--------|
| Sarah / Emma / Marcus seed | current `09` | **done** |
| Allowlist union + connected channels | current `07`/`08` | **done** |
| Specialist router | future `08` §6 | **done** (`route-employee.ts`) |
| Critic gate | future `08` §7 | **done** (`critic-check.ts`) |
| Research + Finance employees | future `08` §3 | **done** |
| Pack YAML + InstallPackWorkflow | future `03` | **done** (Core B2B) |
| Onboarding → pack install | future `03` §6 | **done** (recommend; Wave 2 ids RFC) |
| RE / agency / ecom / SaaS packs | future `04`/`05` | RE **partial**; Wave 2 **deferred** (RFC) |

### Dashboard / analytics / billing / infra

| Capability | Source | Status |
|------------|--------|--------|
| Ask AI UI (PlanCard, execute SSE, citations, @employee) | current `03`/`09` | **done** |
| Insight engine + named actions | future `13` Phase 7 | **done** as code (`/api/insight` POST → Temporal) |
| Analytics SQL page | current `09` | **done** as aggregates + `metrics.query` |
| Langfuse traces | current `16` | **partial** |
| Eval-runner + Promptfoo goldens | future `01`/`08`/`15` | **done** (`infra/evals/`) |
| Billing / seats / meters | future `13` Phase 9 | **partial** — APIs; PSP keys |
| Redis SSE + two replicas | future `13` Phase 8 | **partial** — bus done; replica drill not recorded |
| Terraform / HTTPS / PgBouncer / alerting | future `13` Phase 8 | **partial** — PgBouncer **done**; TF/alerting scripts |
| Warm-up as real provisioning | current `04` | **partial** |

---

## 3. Sequencing implication

Memory is **no longer the empty hole**. Remaining order:

1. Operator creds (C1, H1, Gmail compose, Jina) — unblocks live demos.
2. Close wiring gaps: M6 eval on a migrated DB.
3. RE pack live-verify (P3 quality bar) without inventing inventory.
4. Wave B leftovers (Zoho CRM / Leegality / QuickBooks) **shipped** as executors; live OAuth/BYOK is ops.
5. Channel go-live (Gmail Pub/Sub, owner WhatsApp). Widget embed **done**.
6. Staging SSO + Darex billing keys.
7. One Wave 2 pack as pull after M6 is green.
8. Enterprise residency design; Wave 3–4 / voice / computer-use stay pull.

Owned by workstream files in [05-workstream-index.md](./05-workstream-index.md).
Phase cut in [phases/00-phase-map.md](./phases/00-phase-map.md).
Full narrative: [README.md](./README.md) audit summary.
