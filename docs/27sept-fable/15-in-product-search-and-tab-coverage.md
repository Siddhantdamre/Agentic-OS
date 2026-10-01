# 15 · In-product search, discoverability, and tab→chat coverage

> ### 📊 Completion Status
>
> | Status | Count | Percentage |
> |---|:---:|:---:|
> | 🟢 **Done (Verified)** | 1 | 3.2% |
> | 🟡 **Pending / In Progress** | 0 | 0.0% |
> | 🔴 **Not Done (Open)** | 30 | 96.8% |
> | ⛔ **Blocked (Human/Infra)** | 0 | 0.0% |
> | **Total Findings** | **31** | **100.0%** |

Audit date 2026-09-27, read-only. Completes the report that [Audit in-product search & tabs](56144167-01cd-49d7-9e7d-59aab8bef436) started before the usage-limit abort. Pairs with `14` (open-web / Research) and `10` (frontend). Scope: every `q=`/`search` API, FTS/vector indexes, dashboard search boxes, Ask AI as an internal finder, and every dashboard tab action vs an agent tool.

**Headline.** A human cannot ⌘K anything. Tenant search is five ILIKE boxes (conversations, brain, platform-admin orgs, widget listings, agent/explain). Work items, audit, employees, plans, decisions, listings, inquiries have **filters, not search**. FTS + HNSW exist only on the four `*_memory` tables. Chat has **no** `conversation_search` / `work_item_search` / `audit_search` / `decision_search` tools — the escape hatch is raw `database_query` (RT-B01). Most tab buttons have no twin tool, so "everything from chat" (`AGENTS.md §4a`) is unproven (ASK-G01).

---

## 1. API search surfaces (every `q` / `search` / `query`)

| Surface | Route | Fields | SQL | Index | Page / cursor | RLS | RBAC | Result | Tests |
|---|---|---|---|---|---|---|---|---|---|
| Platform org finder | `api/platform/search/route.ts:22-72` | org name/slug ILIKE, user email **prefix**, connector id/key | `UNION` + `DISTINCT ON (id)` cap 50 | btree on orgs/users only | cap 50, no cursor | `darex_platform` (SEC-P01 may 42501) | `requirePlatformAdmin` + audited `platform.search` | `{id,name,slug,status,plan,matchVia}` | none |
| Conversations | `api/conversations/route.ts:39,74-80` | `contact_id`, `summary`, `metadata.sender_name`, **latest message content** ILIKE | ILIKE ESCAPE | no FTS on `messages`/`conversations` | `limit` + `cursor` | scoped | **none** (CH-S05) | inbox rows | none for `search=` |
| Brain | `api/brain/route.ts:371-403` | hybrid when `q` else list | embed + retrieve (see `05`) | gin tsv + hnsw on memory | snippets/entities/sources | scoped; pool released before embed | `canMutateBrain` on writes | `{snippets,entities,sources,searchMode}` | retrieve tests (not in CI script) |
| Agent explain | `api/agent/explain/route.ts:13` | `q` | swallows DB errors (OPS-B09) | — | — | scoped | session only | explanation or empty | none |
| Widget listings | `api/widget/listings/search/route.ts:35` | `q` | pack listings | — | — | widget token | origin allowlist | listings | none |
| Work items | `api/work-items/route.ts:29-68` | type/priority/assignee/status only | equality | btree org+updated | LIMIT 200, **no `q`** | scoped | create gated; GET open | full rows | none |
| Audit | `api/audit-logs/route.ts:43-50` | kind/risk/from/to/cursor | filters | — | cursor 1–100 | scoped | `canReadAudit` | redacted preview | none for text search |
| Employees / plans / decisions / listings / inquiries / showings / growth | their GET routes | status/id filters | no `q` | — | often unbounded or 200 | scoped | mixed | — | — |

`rg searchParams.get('(q|query|search)')` across `app/api` returns **exactly those five** `q`/`search` handlers. Everything else is a filter.

---

## 2. Indexes that actually support search

| Table | FTS / vector / trigram | Used by tenant search? |
|---|---|---|
| `org_memory`, `employee_memory`, `entity_memory`, `conversation_memory` | `body_tsv` GIN + HNSW (`013:49-238`) | Brain + retrieve only. HNSW unused due to range predicate (MEM-B05) |
| `pg_trgm` extension | installed (`023:452-455`) | **Dedup engine**, not inbox/audit/work-item search |
| `conversations`, `messages` | no tsv, no trigram | Conversations ILIKE on latest message — seq scan |
| `work_items`, `audit_events`, `agent_plans`, `ai_employees`, `re_listings`, `re_inquiries`, `entities`, `facts` | no tsv | unsearchable except equality filters |
| `rera_cache` | PK `(rera_id, market)` | rera tool only; writable by any tenant (SEC-T02) |

---

## 3. Frontend search UX

| UI | Box? | Debounce | URL `?q=` | Empty / error | Keyboard |
|---|---|---|---|---|---|
| Global / ⌘K | **none** (`rg ⌘K\|cmdk\|CommandPalette` → 0) | — | — | — | — (UI-G01) |
| Conversations | yes | **no** — refetch per keystroke (UI-B12, `:340-343`) | no (UI-G11) | 500 can look empty | no |
| Brain | `q` via `window.location.search` (`brain/page.tsx:69`) | reload | yes, not router | hybrid empty state | no |
| Audit | risk filter only (UI-G05) | — | no | — | no |
| Work items | fetch all (UI-G06) | — | no | — | no |
| Employees / plans / listings / inquiries | no text search | — | no | listings 500 → "No listings" (UI-B06) | no |
| Ask AI history drawer | client filter | — | no | — | no |
| Connectors | client filter of catalog | — | no | localhost copy (UI-B17) | no |
| `/admin` | uses platform search | — | — | `migrationMissing` on any 500 (UI-B18) | — |

No saved searches, no recent searches, no snippets/highlights except Brain, no facets except Brain list vs hybrid.

---

## 4. Ask AI as internal search

| Buyer prompt | Tool that should fire | What exists | Finding |
|---|---|---|---|
| "find the conversation where X said Y" | `conversation_search` | conversations API ILIKE only; chat must `database_query` `messages` | SRCH-G01 |
| "show work items about Acme" | `work_item_search` | GET filters type/status; Growth `list_pipeline_attribution` is not text search | SRCH-G02 |
| "what did we decide about pricing last week" | `decision_search` / audit search | `/api/decisions` list; no q; audit no text | SRCH-G03 |
| "who in the roster handles refunds" | `employee_search` | roster GET; no tool | SRCH-G04 |
| "open the plan we approved Tuesday" | `plan_search` | `/plans` pending/approved/running only (UI-G02) | SRCH-G05 |
| "quote our refund SOP" | Drive/Notion/Brain | Research card + retrieve | 🟡 if connected (see `14` W4–W5) |
| "listings under 3 Cr in Bandra" | `re.listings_search` | loads **all** `re_listings` then filters in process (`realestate/index.ts:106-113,243`) | SRCH-B01 |
| anything else | `database_query` | SELECT/WITH including writes (RT-B01) | SRCH-S01 |

**Entities with no first-class find tool:** conversations, messages, work_items, audit_events, agent_plans, decisions/pending-actions, employees, showings, rent charges, insight runs, DSR requests, billing invoices, connectors, packs/skills, members/invites.

---

## 5. Findings — in-product search

| ID | Sev | Where | Issue | Fix | Status |
|---|---|---|---|---|---|
| SRCH-G01 | **P0** | no tool | Chat cannot search conversations/messages | `conversation_search({q, channel?, from?, to?})` → tsv + snippet + conversationId | 🔴 |
| SRCH-G02 | P1 | `work-items/route.ts:29-68` | No `q`; LIMIT 200 dump | `q` on title/payload + `work_item_search` tool | 🔴 |
| SRCH-G03 | P1 | `audit-logs/route.ts:43-50` | No text search | tsv on kind+redacted preview; tool for owner/auditor | 🔴 |
| SRCH-G04 | P2 | employees GET | No search | name/role ILIKE | 🔴 |
| SRCH-G05 | P1 | plans list | No history search (ASK-G07) | completed/failed + `q` | 🔴 |
| SRCH-G06 | **P0** | AppShell | No ⌘K (UI-G01) | command palette over nav + last 10 conversations + work items + Brain | 🔴 |
| SRCH-G07 | P1 | conversations search | ILIKE, no tsv, searches one latest message | `messages.body_tsv`; rank + highlight | 🔴 |
| SRCH-B01 | P1 | `realestate/index.ts:106-113,243` | `listings_search` loads every row then matches in RAM | SQL WHERE on bhk/city/price | 🔴 |
| SRCH-B02 | P1 | `conversations/page.tsx:340-343` | No debounce/abort (UI-B12) | 250 ms + AbortController | 🔴 |
| SRCH-B03 | P2 | `platform/search/route.ts:54-58` | Email match is prefix-only (`$2` = `q%`) while name is infix — easy to miss | same ILIKE for email | 🔴 |
| SRCH-S01 | P1 | chat + `database.ts` | Internal find routed through writable SQL | purpose-built read tools; lock down SQL (1.3) | 🔴 |
| SRCH-S02 | P2 | conversations search | Any role reads message bodies (CH-S05) | `canReadInbox` | 🔴 |
| SRCH-E01 | P2 | — | No saved/recent searches, no highlight, no org locale stemming (MEM-B20) | after G01 | 🔴 |

---

## 6. Tab action → chat tool (coverage matrix)

Status: **tool** = same mutation exists as an executor action the model can call. **read-only twin** = chat can see but not do. **no tool** = human-only. This is the ASK-G01 matrix seed.

| Tab | Human action | API | Chat tool | Status |
|---|---|---|---|---|
| Home | view stats | `GET /api/dashboard/stats` | `metrics.query` (weak) | 🟡 |
| Brief | read / triage | `GET /api/brief`, `POST …/triage` | `daily_brief.read`; **no triage tool** | 🟡 / 🔴 |
| Decisions | approve/reject/execute | `PATCH /api/decisions` | **no tool** (pending-actions is a different table) | 🔴 TAB-G01 |
| Work items | create / decide | `POST /api/work-items`, `…/[id]/decision` | **no create/decide tool** | 🔴 TAB-G02 |
| Insight | generate | `POST /api/insight` | **no tool** | 🔴 TAB-G03 |
| Analytics | range / export | `GET /api/analytics`, `…/export` | **no tool**; export ignores range (OPS-B10) | 🔴 |
| Growth | opportunity decide | `POST …/opportunities/[id]/decision` | growth list_* read-only | 🔴 TAB-G04 |
| Customer | open-loop patch | `PATCH …/open-loops` | `customer-ops.list_*` read-only | 🔴 TAB-G05 |
| Employees | archive / PATCH / crew | `PATCH /api/employees/[id]`, `POST /api/agent/crew` | crew yes; archive **window.prompt UUID** (UI-B19), no tool | 🔴 TAB-G06 |
| Listings / inquiries / showings | CRUD | `/api/listings|inquiries|showings` | `re.listings_*` / `inquiry_*` / `showing_book` | 🟡 (pack) |
| Brain | create / PATCH / delete / reindex | `/api/brain`, `…/reindex` | cognee remember/search; **no disable/delete/reindex tool** | 🔴 TAB-G07 |
| Plans | approve / cancel / edit / execute | `/api/ask-ai/plan|approve|revise|execute` | chat *is* the surface; `/plans` missing edit (UI-B03) | 🟡 |
| Conversations | reply / pause / resolve / assign | `POST …/messages`, `PATCH …/[id]` | whatsapp/gmail send; **no pause/resolve/assign tool** | 🔴 TAB-G08 |
| Connectors | connect / disconnect / BYOK / ping | `/api/integrations` | `connectors_status` read-only status + live Nango ping (core read tool); connect/disconnect stay human-only on `/connectors` (RBAC gap BIZ-S02 is the route's, not the tool's) | 🟢 TAB-G09 |
| Packs / skills | install / config / toggle | `/api/packs`, `/api/skills` | **no tool**; skills unused at runtime (BIZ-G08) | 🔴 |
| Settings | org / members / autonomy / widget | `/api/settings*` | **no tool** | 🔴 TAB-G10 |
| Billing | checkout / portal / cancel | `/api/billing*` | `billing.usage` (broken column BIZ-B14) | 🔴 |
| Audit | filter | `GET /api/audit-logs` | **no tool** | 🔴 |
| Observability | approve pending / alerts | page + `PATCH` | **no tool**; silent fail (UI-B08) | 🔴 |
| DSR | export / delete | `/api/dsr/*` | **no tool** (must stay human + confirm) | ⛔ keep human |
| Onboarding | wizard steps | `/api/onboarding*` | **no tool** | 🟡 |
| Admin | suspend / impersonate / kill / purge | `/api/platform/*` | **must never** be a tenant tool | ✅ omit |

---

## 7. Blueprint engines — schedule, UI, chat, honesty

From `periodic-registry.ts` + activities the aborted audit reached. Sweeps are boot fan-out `continueAsNew`, not Temporal Schedules (OPS / `12` §4.3).

| Engine | Entrypoint | Cadence | Writes | UI | Chat tool | Bug / gap |
|---|---|---|---|---|---|---|
| GrowthWatcher / signals | `growth-watcher.ts`, `activities/growth.ts` | ~4 h | `lead_intent_signals` | Growth tab | no; inherits WEB-B15 | companyName = news hostname (`signals.ts:39`) — **ENG-B01** |
| MarketScout | `MarketScoutWorkflow` | registry | HubSpot contacts via raw `executeProvider` | opportunity cards | no | hardcoded fit 0.5 / score 55 (`growth.ts` ~scout) — **ENG-B02**; Apollo page=1 forever — **ENG-G01**; GDPR write without basis — **ENG-S01** |
| Meeting dossier | `MeetingDossierWorkflow` | registry | Slack + `growth_meeting_dossiers` | — | no | Slack channel default `#general` (RT-B06) — **ENG-B03**; `web_extract` unsanitised into Slack — **ENG-S02** |
| Nurture | `NurtureWorkflow` | registry | outbound | — | no | via `executeProvider` (EMP-S02) |
| Dormant revival | `DormantLeadRevivalWorkflow` | **never started** (EMP-G02) | — | — | `growth.list_dormant_leads` | DISTINCT ON `c.id` + ORDER BY id → random 40 — **ENG-B04** |
| ReplySorter | `ReplySorterWorkflow` | ~20 min | Slack | — | no | last 20 Gmail only — **ENG-B05** |
| Open-loop / recovery | `open-loop-monitor`, `CustomerRecoveryWorkflow` | registry | loops + sends | Customer tab | `customer-ops.list_*` | kill switch only here (EMP-S01) |
| Morning check | `morning-check.ts` | boot + interval | brief | Brief | `daily_brief` | delivers on every worker boot (OPS-B06) |
| Stuck work | `stuck-work.ts` | registry | `work_items` | Work items | no | no orgId guard (OPS-B11) |
| Rep follow-up SLA | `rep-followup-sla.ts` | registry | Slack | — | no | raw send (EMP-S02) |
| Workload balancer | `workload-balancer.ts` | registry | assignments | — | no | raw send |
| Meeting prep | `meeting-prep.ts` | 24 h | guest emails | — | no | emails forever (EMP-B08) |
| Reconciliation | `system-reconciliation` | registry | discrepancies | — | `operations.*` | — |
| Rent / showing reminders | those workflows | registry | messages | — | `re.*` | — |
| Owner briefing | `OwnerBriefingWorkflow` | not per-org (OPS-G05) | WhatsApp | — | no | — |
| Outage buffer | `outage-buffer.ts` | **0 importers** (EMP-G05) | — | — | no | — |

---

## 8. Findings — tabs and engines

| ID | Sev | Issue | Fix | Status |
|---|---|---|---|---|
| TAB-G01 | **P0** | Approve/reject a decision cannot be done from chat (except broken `pending-actions`) | one approval tool → same executor as 1.9 | 🔴 |
| TAB-G02 | P1 | Cannot create/list/decide work items from chat | `work_items.list|create|decide` | 🔴 |
| TAB-G03 | P2 | Insight generate human-only | `insight_run` or keep human | 🔴 |
| TAB-G04 | P1 | Growth opportunity decide human-only | reuse approval tool | 🔴 |
| TAB-G05 | P1 | Open-loop patch human-only | `customer_ops.update_loop` through executor | 🔴 |
| TAB-G06 | P1 | Archive/handoff employee human-only + UUID prompt | picker + `employees.archive` | 🔴 |
| TAB-G07 | P1 | Brain disable/delete/reindex human-only | tools with audit (MEM-S07) | 🔴 |
| TAB-G08 | P1 | Pause/resolve/assign conversation human-only | `conversations.set_status` / `assign` | 🔴 |
| TAB-G09 | P1 | Connect/disconnect not from chat | already a product rule via OAuth cards; add **status** tool only | 🟢 `connectors_status` (services/workflows/src/tools/connectors.ts) |
| TAB-G10 | P2 | Settings/autonomy human-only | read tool; writes stay UI | 🔴 |
| ENG-B01 | P1 | Signal company = publisher hostname | resolve via Apollo/CRM before persist | 🔴 |
| ENG-B02 | P1 | MarketScout scores hardcoded | compute from ICP + signals | 🔴 |
| ENG-B03 | P2 | Dossier Slack → `#general` | require configured channel | 🔴 |
| ENG-B04 | P1 | Dormant query random by UUID | `ORDER BY updated_at`, start the workflow | 🔴 |
| ENG-B05 | P2 | ReplySorter misses mail past 20 | Gmail `q=` + history cursor | 🔴 |
| ENG-G01 | P1 | Apollo scout always page 1 | cursor + ICP filters | 🔴 |
| ENG-S01 | P1 | Scout writes HubSpot contacts with no consent/suppression | lawful-basis flag + suppression list | 🔴 |
| ENG-S02 | P1 | Extracted page posted to Slack unfenced | sanitise; confirm `send` | 🔴 |

---

## 9. Fix order

1. **SRCH-G06 + G01 + G07** — ⌘K + `conversation_search` (tsv on messages) + debounce. This is what buyers type first after "search the web".
2. **SRCH-G02 + G03 + G05 + TAB-G01 + TAB-G02** — work-item / audit / plan search + one chat approval/create path (Wave 1.9).
3. **SRCH-B01 + ENG-B01..B04 + ENG-S01** — listings SQL; signal/scout honesty; start DormantLeadRevival.
4. **TAB-G04..G08** — Growth/Customer/Brain/inbox twins through the executor (never raw `executeProvider`).
5. **SRCH-E01** — saved searches, highlights, locale stemming.

Do not add a chat tool for DSR delete, platform admin, or connector disconnect. Those stay human.
