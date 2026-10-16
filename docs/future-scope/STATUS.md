# Future scope vs the codebase

Date: 2026-09-27. Compared `docs/future-scope/` (written as a forward map, snapshot mostly 2026-08-13) to the repo. Phases 0–5 are already done and are **not** in this percent.

## 42% of the future program is in the repo

**42%** — phases 6–18, equal weight, scored on code that exists and is wired.

**58%** — the six brain layers (perception through learning). The core OS is further along than the later industry waves.

| | Count | Share of phases 6–18 |
|---|---|---|
| 🟢 Done | 0 phases | A phase is green only when its exit criteria in `13-phased-roadmap.md` are met. None are. |
| 🟡 Partial | 9 phases | 6, 7, 8, 9, 10, 11, 12, 13, 15 |
| 🔴 Not started | 4 phases | 14, 16, 17, 18 |

Arithmetic: (75+70+60+55+70+65+30+60+15+35+5+0+0) / 13 = **540 / 13 = 42%**.

🟢 means the capability is in this repo and called from a real path. A missing OAuth client id in the Nango UI does not turn a real executor red. 🟡 means schema, a page, or one path exists and the phase exit is still open. 🔴 means it is not in the repo.

This is a code reading, not a live customer proof. `BUILD_STATE.md` is the verification log.

---

## Phases 6–18

| Phase | % | | What is in the repo | Still open |
|---|---:|---|---|---|
| 6 Memory & RAG | 75 | 🟡 | `org_memory`, employee / entity / conversation memory, edges, `knowledge_sources`, `ingestion_jobs`. `retrieveMemory` on Ask AI. `/brain` search and save. `EmbedWorkflow`. Cognee search / remember. | Embedding spaces still unaligned (Postgres vs Cognee). Entity and employee tier params are not passed by callers. Redaction before embed is not a closed gate. |
| 7 Insight engine | 70 | 🟡 | `insight-engine.ts` metrics registry. Cards with a named workflow. `InsightActionWorkflow` starts `StaleChaseWorkflow` and `OwnerBriefingWorkflow`. | Not a full semantic warehouse. Langfuse cost is not on every card. |
| 8 Scale & prod skeleton | 60 | 🟡 | Redis pub/sub on the SSE hub. Separate Langfuse Redis. `darex_app` through PgBouncer. Rate limits. Terraform modules (VPC, RDS, Redis, secrets, HTTPS). `/api/health/ready`. | Two dashboard replicas receiving the same event is not proved. Restore drill is a module note, not a recorded drill. |
| 9 Billing & onboarding | 55 | 🟡 | Billing page, `billing_meters`, Stripe and Razorpay tools, `billing_usage`. Invite email via Resend. Business-type onboarding page. Pack install. | No mobile app. Signup does not yet land a stranger on a pack, a connected WhatsApp, and a memory-grounded first reply. |
| 10 Connector registry | 70 | 🟡 | `connector_defs`. Executors split under `services/workflows/src/tools/`. Real clients for Meet, GA4, Search Console, Business Profile (list locations), Outlook, Calendar (Microsoft), Salesforce, Zoho, QuickBooks, DocuSign, Leegality, Twilio SMS, Maps. | Instagram is missing. Business Profile is list-locations, not reviews and posts. Several P0 providers still need human OAuth client ids. |
| 11 Real estate brokerage v1 | 65 | 🟡 | Pack `real-estate-brokerage` is `live`. Tables `re_listings`, `re_inquiries`, `re_showings`, `rera_cache`. Pages for listings, inquiries, showings. ISA / showing / listing employees in the pack manifest. `re_showing_book`. RERA lookup. Fair-housing critic on send. | Golden eval set is not a CI gate. A live “2BHK under Y” WhatsApp match against sheet rows is not proved here. |
| 12 Real estate expansion | 30 | 🟡 | `pm_leases`, `pm_charges`. Rent-reminder list tool. Packs `real-estate-pm` and `real-estate-developer` exist as `live = false`. | No Follow Up Boss, no licensed MLS, no AppFolio / Buildium. US and developer exit criteria are open. |
| 13 Work items & playbooks | 60 | 🟡 | Work-items page. `NurtureWorkflow` with cancel-on-reply signal. Critic gate can block a send. Promoted playbooks can match a plan. | Owner WhatsApp approvals are not a path. Not every inbound channel creates a work item. |
| 14 Wave 2 packs | 15 | 🔴 | Catalog rows for agencies, ecommerce, saas-gtm, prof-services. Shopify executor exists. All four packs are `live = false`. | Exit wants two live Wave 2 packs. None are. |
| 15 Enterprise | 35 | 🟡 | SSO start and callback routes (SAML/OIDC). Audit page and append-only audit events. Skills page. Auditor role in the human-roles migration. | No data-residency pin. No third-party pack store. “Auditor cannot call pay tools” is not proved. |
| 16 Wave 3 packs | 5 | 🔴 | Nothing for wholesale, recruiting, or hospitality beyond the generic core. | Sheets wedge, ATS, and GBP hospitality flows are unbuilt. |
| 17 Voice & computer-use | 0 | 🔴 | No LiveKit, Deepgram, Whisper, or browser-runner in the runtime. | Optional last resort. Correctly not started. |
| 18 Wave 4 packs | 0 | 🔴 | No construction, education-ops, clinic-ops, or insurance pack. | After a compliance review. Correctly not started. |

---

## Six layers (`00-vision-ai-brain-os.md`)

Average **58%**.

| Layer | % | | In the repo |
|---|---:|---|---|
| 1 Perception | 45 | 🟡 | WhatsApp, Gmail, Slack, Chatwoot ingest plus inbound agent, Twilio SMS, calendar, Sheets/Drive/Docs, Notion, web search and extract, Maps. |
| 2 Memory | 70 | 🟡 | Hierarchical tables, hybrid search, brain inspector, embed worker, Cognee graph remember/search. Decay and conflict handling are thin. |
| 3 Reasoning | 75 | 🟡 | Classify → plan → confirm → execute. Roster routing. Crew cap 3. Ask AI Auto / Pick one / Team. Morning brief and stale-chase workflows. |
| 4 Action | 55 | 🟡 | Named tools, org allowlists, honest `notConnected`, confirm classes, connector registry. The catalog is dozens of tools, not the hundreds in `06`. |
| 5 Governance | 65 | 🟡 | RLS, autonomy approve/reject, append-only audit, DSR export/delete, rate limits, SSO routes, fair-housing critic. No SCIM. No residency. |
| 6 Learning | 40 | 🟡 | Langfuse traces, observability page, org cost tables, playbook promotion from a winning plan. No online eval CI. No “employee is drifting” alert. |

---

## Owner surfaces (`00` §5)

| Surface | | Notes |
|---|---|---|
| Home / daily brief | 🟡 | `/` and `/brief`. `OwnerBriefingWorkflow` exists. |
| Ask the business | 🟢 | `/ask-ai` retrieves memory and runs tools. Mode lock is server-side. |
| Inbox | 🟢 | `/conversations`. Needs-attention is wired. |
| Employees | 🟢 | Roster, personas, allowlists, hand-offs, crew from the page and from chat. |
| Brain | 🟡 | `/brain` search, save, reindex. Citations are not the full “what do we know” product. |
| Insight | 🟡 | `/insight` builds cards from registered metrics and can enqueue a named workflow. |
| Connectors | 🟢 | Registry-backed catalog. Disconnect and BYOK stay honest. |
| Plans | 🟢 | `/plans`. Confirm, execute, compensation columns. |
| Work items | 🟢 | `/work-items` plus SLA sweep. |
| Packs | 🟡 | `/packs`. Two live packs. Install failure rolls back. |
| Billing | 🟡 | `/billing`. Meters exist. Seat commerce is not a closed signup. |
| Audit | 🟢 | `/audit`. Append-only grants. |
| Skills | 🟡 | `/skills` and `org_skills`. Not a mounted playbook runtime on every turn. |
| Analytics | 🟡 | `/analytics` SQL aggregates. Not the vertical KPI warehouse. |
| Mobile / owner WhatsApp | 🔴 | No owner “text your business” app or approval channel. |
| Listings, inquiries, showings | 🟡 | Real estate pages exist. Pack quality bar is not closed. |

---

## Success test (`00` §8)

The vision says Darex is the Brain OS only when **all five** are true for a new org. They are not.

| # | Test | |
|---|---|---|
| 1 | Connect 3+ systems and use them | 🟡 Tools exist. A stranger onboarding is not proved. |
| 2 | Inbound reply from memory, owner not in the loop | 🟡 Inbound agent and `retrieveMemory` exist. Not proved on a live WhatsApp thread. |
| 3 | Multi-step work survives process death | 🟢 Temporal plan execute, nurture, and brief workflows. |
| 4 | “What do we know?” returns cited memory, never invented facts | 🟡 Brain search plus honest `notConnected`. Not a single cited answer across memory and the system of record. |
| 5 | Switching pack changes employees and entities, not the runtime | 🟡 `core-b2b` and `real-estate-brokerage` install on the same kernel. Only those two are live. |

---

## What the August docs still call missing, and the code now has

`01-from-today-to-os.md` is stale. These rows moved:

| August gap | Now |
|---|---|
| No RAG pipeline, pgvector unused | 🟡 Memory tables, retrieve, brain UI, embed worker |
| Insight is rule templates only | 🟡 Metric cards and named Temporal actions |
| Chatwoot does not call the agent | 🟡 Inbound agent path exists |
| Realtime is one Node process | 🟢 Redis pub/sub on the hub |
| Member invite has no email | 🟢 Resend invite mail |
| Billing not started | 🟡 Billing page, meters, Stripe / Razorpay |
| No Salesforce, Zoho, DocuSign, Maps, Twilio | 🟡 Executors exist; OAuth client ids are still a human step |
| Google Meet, GA4, Search Console, Business Profile are stubs | 🟡 Real HTTP clients, honest disconnect |
| No specialist router, no multi-agent, no morning brief | 🟢 Roster, crew cap 3, `OwnerBriefingWorkflow` |
| atomic-agent is the runtime | The runtime is TrueForge. The doc still says atomic-agent. |

Still red, matching the August list: Instagram, Messenger, voice, Exotel, MLS, Follow Up Boss, SCIM, owner WhatsApp, computer-use, Wave 3 and Wave 4 packs.
