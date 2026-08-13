# 02 — Gap analysis

Every future-scope capability versus the current-working baseline.
Status values: **done**, **partial**, **missing**, **ops-blocked**
(code ready, credentials or operator step missing).

Linked from [README.md](./README.md),
[00-executive-summary.md](./00-executive-summary.md), and
[01-current-state-baseline.md](./01-current-state-baseline.md).
Documentation only. No application data files.

If current-working and future-scope disagree on **what exists**,
current-working wins. Section 0 lists those contradictions so we do
not rebuild closed work.

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
table. The plan’s immediate phase only keeps what is still open.

---

## 1. Six Brain OS layers

From [`00-vision-ai-brain-os.md`](../future-scope/00-vision-ai-brain-os.md).

| Layer | Today | Gap |
|-------|-------|-----|
| 1 Perception | WhatsApp + Chatwoot ingest; Gmail as tools not push; Jina web | Instagram, SMS, voice, Gmail push, unified channel object, sync workers, public-data connectors, file ingest pipeline |
| 2 Memory | pgvector extension on; atomic-agent notes/profile scratch | **No org RAG.** No retrieve prefix, write-back, inspector, entity memory |
| 3 Reasoning | simple vs complex classify; plan-confirm-execute; 3 Temporal turns | No specialist router, critic, scheduled briefing, event-triggered plans, playbook matcher, eval harness |
| 4 Action | 62 MCP tools; allowlist; honest notConnected | No connector registry table; executor is one large file; missing P0 CRMs/e-sign/maps; no compensating transactions |
| 5 Governance | Ask AI confirm; RLS; allowlists; webhook HMAC | Webhook path does not pause on `send`/`pay`/`sign`; no data-class tags; no SSO/SCIM; audit is `channel_logs` only |
| 6 Learning | Langfuse ingestion fixed | No online eval, prompt registry, cost budgets, playbook promotion |

---

## 2. Capability matrix (future-scope vs current)

### Runtime and agent loop

| Capability | Source | Status |
|------------|--------|--------|
| atomic-agent tool loop | current `07` | **done** |
| LiteLLM classify/plan/revise split | current `03`, BUILD_STATE | **done** |
| MCP `mcp.darex.*` 62 tools | current `08` | **done** |
| Skills mounted in image | current `07`/`16`; future `01` stale | **done** in tree; rebuild required |
| Sandbox Docker context | current `12`/`16` | **partial** (untracked vs commit) |
| Computer-use / browser-runner | future `08` §11, Phase 17 | **missing** |
| Semantic `metrics.query` vs raw SQL | future `02` §5, `07` §8 | **missing** |

### Orchestration

| Capability | Source | Status |
|------------|--------|--------|
| Ask AI plan-confirm-execute + parallel steps | current `03` | **done** |
| Temporal `AutonomousAgentWorkflow` (3 turns, idempotency) | current `07` | **done** |
| WorkItemWorkflow unifying inbound | future `09` | **missing** |
| OwnerBriefingWorkflow | future `09` | **missing** |
| StaleChaseWorkflow | future `09` | **missing** |
| ShowingSchedule / RentReminder | future `05`/`09` | **missing** |
| InstallPackWorkflow | future `03`/`09` | **missing** |
| Playbook matcher (skip free-form plan) | future `09` §5 | **missing** |
| Nurture timers | future `09` §7 | **missing** |
| HITL as Temporal signal (not only PlanCard HTTP) | future `09` | **missing** |
| Compensating transactions | future `01` action gaps | **missing** |

### Memory / RAG / knowledge

| Capability | Source | Status |
|------------|--------|--------|
| pgvector extension | current `11` | **done** |
| `org_memory` / `entity_memory` / `conversation_memory` | future `10` | **missing** |
| embed-worker + `EMBEDDING_MODEL` | future `02`/`10` | **missing** |
| `retrieveMemory` on Ask AI + webhooks | future `10` §4 | **missing** |
| MemoryWriteBack activity | future `10` §5 | **missing** |
| `/brain` inspector | future `10` §6, `11` | **missing** |
| Hybrid vector + FTS | future `10` §10 | **missing** |
| Temporal fact columns | future `10` §10.2 | **missing** (Phase 6 optional columns) |
| File parse → chunk → embed | future `07` | **missing** |
| Sync cursors / ingest jobs | future `02`/`07` | **missing** |
| Knowledge graph / AGE | future `02`/`07` | **missing** (after vectors) |

### Integrations

| Capability | Source | Status |
|------------|--------|--------|
| Nango as OAuth truth | current `05` | **done** |
| Honest notConnected | current `08` | **done** |
| Core Google workspace executors | current `08` | **done** (if connected) |
| HubSpot/Slack/Notion/Stripe/Shopify/Zendesk/Intercom executors | current `08` | **ops-blocked** (Nango client IDs) |
| GBP / Meet / GA4 / GSC / Chat / Cloud executors | current `08` vs future `06` | **done** as HTTP; UI catalog **partial** |
| Connector registry tables | future `02` §4.3 | **missing** |
| Split `tool-executor.ts` modules | future `02` §5 | **missing** |
| Outlook / Teams / OneDrive | future `06` Wave B | **missing** |
| Salesforce / Zoho CRM / Pipedrive | future `06` | **missing** |
| DocuSign / Leegality | future `06` | **missing** |
| Twilio / Exotel / Instagram | future `06` | **missing** |
| Maps geocoding | future `06` | **missing** |
| Follow Up Boss / RESO MLS | future `05`/`06` | **missing** |
| QuickBooks / Zoho Books | future `06` | **missing** |

### Channels and surfaces

| Capability | Source | Status |
|------------|--------|--------|
| WhatsApp inbound persist + agent | current `06` | **done** |
| WhatsApp outbound Graph | current `06`/`14` | **ops-blocked** (expired token) |
| Chatwoot ingest + agent | current `06` | **done** |
| SSE inbox toast | current `06` | **partial** (one process) |
| Redis pub/sub event bus | future `11` §3 | **missing** |
| Gmail push inbound | future `11` | **missing** |
| Web widget / Instagram / SMS / voice | future `11` | **missing** |
| Owner WhatsApp (“text your business”) | future `11` §4 | **missing** |
| `/brain`, listings, plans inbox | future `11` §2 | **missing** |
| Mobile / a11y | future `11` §6, Phase 9 | **missing** |

### Security / tenancy / org

| Capability | Source | Status |
|------------|--------|--------|
| RLS + WITH CHECK | current `11` | **done** |
| Session GUC + no body `org_id` | current `04`/`16` | **done** |
| `darex_app` grants | current `11` | **partial** — app still uses superuser |
| Confirm on Ask AI plans | current `03` | **done** |
| Confirm classes on webhook path | future `08` §8, `12` | **missing** |
| Data-class tags | future `12` §6 | **missing** |
| SSO / SAML / SCIM | future `12` | **missing** |
| Roles owner/admin/member/auditor | future `12` | **partial** — role exists on user; not a product RBAC |
| DSR export/delete | future `12` §8 | **missing** |
| Encrypted BYOK secrets table | future `12` §3 | **partial** — `channels.meta` JSONB |
| `ALLOW_DEMO_AUTH` prod fail | future `12` | **missing** (flag still dangerous) |

### Employees / packs

| Capability | Source | Status |
|------------|--------|--------|
| Sarah / Emma / Marcus seed | current `09` | **done** |
| Allowlist union + connected channels | current `07`/`08` | **done** |
| Specialist router | future `08` §6 | **missing** |
| Critic gate | future `08` §7 | **missing** |
| Research + Finance employees | future `08` §3 | **missing** |
| Pack YAML + InstallPackWorkflow | future `03` | **missing** |
| Onboarding → pack install | future `03` §6 | **missing** (wizard stores business type only) |
| RE / agency / ecom / SaaS packs | future `04`/`05` | **missing** |

### Dashboard / analytics / billing / infra

| Capability | Source | Status |
|------------|--------|--------|
| Ask AI UI (PlanCard, execute SSE) | current `03`/`09` | **done** |
| Citations + @employee | future `11` | **missing** |
| Insight engine + named actions | future `13` Phase 7 | **missing** (templates only) |
| Analytics SQL page | current `09` | **done** as aggregates; not semantic metrics |
| Langfuse traces | current `16` | **partial** |
| Eval-runner + Promptfoo goldens | future `01`/`08`/`15` | **missing** |
| Billing / seats / meters | future `13` Phase 9 | **missing** |
| Redis SSE + two replicas | future `13` Phase 8 | **missing** |
| Terraform / HTTPS / PgBouncer / alerting | future `13` Phase 8 | **missing** |
| Warm-up as real provisioning | current `04` | **missing** (UI-only bar) |

---

## 3. Sequencing implication

Build order follows future-scope `01` §5 and `13`, minus absorbed
hygiene:

1. Remaining hygiene (section 0 leftovers + operator creds).
2. Phase 6 memory (largest single hole).
3. Connector registry + Wave A/B.
4. Event bus + scheduled workflows.
5. Real estate pack (India wedge).
6. Insight engine.
7. More packs.
8. Enterprise + billing.

Owned by workstream files in [05-workstream-index.md](./05-workstream-index.md).
Phase cut in [phases/00-phase-map.md](./phases/00-phase-map.md).
