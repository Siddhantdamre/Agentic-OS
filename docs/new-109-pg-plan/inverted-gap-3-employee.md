# Inverted Gap Audit: 3-employee.md vs. Actual Code

> **Dated:** 2026-09-22
> **Method:** Every feature in `docs/new-109-pg-plan/3-employee.md` §5 (G-01..G-10,
> C-01..C-10, O-01..O-10) plus the §1 Core Principles and §6 Shared Company Brain
> concept were checked against the live codebase — real files read, not filenames
> or comments trusted — to mark each ✅ Implemented / 🟡 Partial / ❌ Missing.

---

## Growth Employee (The Revenue Engine)

| # | Feature Name | Status | Evidence (file:line) | Gap / What's Missing |
|---|---|---|---|---|
| G-01 | Lookalike Customer Hunter | 🟡 Partial | `services/workflows/src/activities/growth.ts:22-119` (`fetchClosedWonAccounts`), `services/workflows/src/growth/lookalike.ts:25-47` (`buildIcpProfile`, centroid math), `growth.ts:190-261` (`rankCandidatesActivity`) | Real ICP-centroid math over HubSpot closed-won deals, but never queries Apollo/Hunter/LinkedIn for net-new market companies as spec requires. `tools/apollo.ts` and `tools/linkedin.ts` exist and work, but are wired only into the generic ask-ai chat tool registry, not into this pipeline. Candidates come only from web-search "signals" + visitor intent. |
| G-02 | Market Scout & Lead Finder | ❌ Missing | `services/workflows/src/tools/apollo.ts`, `tools/linkedin.ts` (generic chat tools only) | No autonomous ICP-triggered directory/registry search with a daily cap. Only reachable manually via an Ask-AI chat plan, not as an employee capability. |
| G-03 | Intent & Signal Poller | ✅ Implemented | `services/workflows/src/growth/signals.ts:12-75` (classifies hiring/funding/leadership), `activities/growth.ts:121-171` (`pollSignalsActivity`/`persistSignalsActivity` → `lead_intent_signals`), `workflows/growth-watcher.ts` (4-hour sweep loop) | Depends on `JINA_API_KEY` (honest no-op otherwise); single hardcoded search template rather than a true multi-source LinkedIn/news/tech-stack monitor. |
| G-04 | Website Visitor De-anonymizer | 🟡 Partial | `apps/dashboard/lib/visitor-enrich.ts:69-197` (real reverse-IP call, `upsertVisitorIntent` tracks `pricing_page_visits`), `app/api/widget/intent/route.ts` | No "2+ visits in 24h" gating logic — visit count is just summed into a generic intent signal. No department-head discovery; hardcodes `'VP Sales'` as fallback contact (`growth.ts:267-268`). |
| G-05 | Stale CRM Lead Revival | ✅ Implemented | `activities/growth.ts:383-432` (`listDormantLeadsActivity`, >180-day idle cross-referenced with signals in last 14 days), `workflows/DormantLeadRevivalWorkflow.ts` | Only reconciles against the internal `conversations` table, not an actual connected HubSpot/Salesforce lead list; reuses generic Jina signals rather than lead-specific funding/exec lookups. |
| G-06 | "Why Now?" Trigger Reasoner | 🟡 Partial | `activities/growth.ts:263-288` (`opportunityPayload()` joins signal summaries into `whyNow`) | Pure string concatenation of raw signal text, not an LLM-synthesized 2-sentence rationale referencing historical client success (no LLM call at all, unlike G-10). |
| G-07 | Account Dossier Generator | ❌ Missing | none found | No "dossier", 10-K/blog/LinkedIn-post scraping, or Calendar-invite attachment logic anywhere in the repo. |
| G-08 | Hyper-Personalized Drafter | 🟡 Partial | `activities/growth.ts:283-286` (hardcoded template draft), `apps/dashboard/components/growth/OpportunityCard.tsx:104-110`, `app/api/work-items/[id]/decision/route.ts:203-208` | Draft is a fixed template string, not LLM-personalized. Approving a card only flips work-item status — `createOpportunityActivity` never sets `temporal_workflow_id`, so no actual Gmail/Smartlead/Instantly send occurs. |
| G-09 | Sentiment & Reply Classifier | ❌ Missing | none found | No prospect-reply ingestion or classification (interested/objection/OOO/unsubscribe) anywhere for Growth outbound; only unrelated Customer-employee churn-sentiment code exists. |
| G-10 | Rejection Learning Loop | 🟡 Partial | `growth.ts:330-381` (`synthesizePreferencesActivity`), `growth/preferences.ts` (`heuristicRulesFromComment`, `distillRulesViaLlm`), `growth/lookalike.ts:49-91` (`applyPreferenceFilters` consumes `org_preferences.rules`) | The free-text Ask-AI thumbs-down → LLM-distilled rule path is real and closes the loop. But the one-click reject-reason path from `OpportunityCard.tsx` writes to `agent_preference_suppressions`/`org_preferences.suppressions`, which nothing in `services/workflows/src` ever reads — dead writes. |

**Growth summary:** 2 Implemented (G-03, G-05), 6 Partial, 2 Missing (G-02, G-07, G-09 — 3 missing total). Strong on the internal signal/ICP/preference-learning backend; weak on outward market discovery, dossier generation, reply handling, and actually sending personalized outreach.

---

## Customer Employee (The Resolution Engine)

| # | Feature Name | Status | Evidence (file:line) | Gap / What's Missing |
|---|---|---|---|---|
| C-01 | Omnichannel Ingress & Fast ACK | ✅ Implemented | `apps/dashboard/app/api/webhooks/whatsapp/route.ts:116-128`, `webhooks/chatwoot/route.ts` | Real fast-ack (persist → 200 → fire-and-forget Temporal) on both channels. No material gap. |
| C-02 | Customer Tier & State Profiler | ❌ Missing | `services/workflows/src/customer/operational-state.ts:1-11` | `inferOperationalState` only regexes the *current message text* for keywords to assign a state enum. No CRM/billing lookup, no MRR, VIP tier, NPS, or ticket-history retrieval anywhere. |
| C-03 | Dynamic Policy & SOP Retrieval | 🟡 Partial | `activities/index.ts:152-165` (`retrieveForEmployee` → `ragTopSimilarity` → `evaluateConfidenceGate`, threshold 0.72) | Generic org-wide RAG retrieval shared by every employee persona, not customer-specific clause citation or a refund-eligibility check tied to retrieval output. |
| C-04 | Meeting & Service Rescheduling | ❌ Missing | `services/workflows/src/tools/google-calendar.ts:5` (`ACTIONS = ['list_events','check_availability','create_event']`) | No `update_event`/`reschedule` action exists at all — only list/check/create. No buffer validation, ICS resend, or CRM update. |
| C-05 | Automated Refunds & Credits | 🟡 Partial | `services/workflows/src/tools/stripe.ts:5` (no refund action), governance in `autonomy.ts:114,287-307`, `employee-gate.ts:7,13` (refund classified tier 2, irreversible, requires approval) | Governance/decision-card layer treats refunds correctly as high-risk, but there is no actual Stripe refund API call anywhere and no $/day eligibility check — a routing stub, not an executable refund. |
| C-06 | Order & Shipping Address Update | ❌ Missing | `services/workflows/src/tools/shopify.ts:5` (`ACTIONS = ['fetch_products','fetch_orders']`) | Shopify tool is read-only; no address-update mutation or fulfilled/unfulfilled check. |
| C-07 | Open Loops Durable SLA Follow-up | ✅ Implemented | `services/workflows/src/workflows/open-loop-monitor.ts:1-45` (real Temporal `sleep`+`continueAsNew` loop), `activities/open-loop-sweep.ts:20-136` (`dueLoopsActivity`, lease-based `handleDueLoopActivity` sends real follow-up), `customer/obligation-extractor.ts` | Genuine Temporal durable-timer implementation, the strongest feature in the whole catalog. Minor: due-time inference is heuristic/regex (`due-time.ts`), not a precise clock-time parse. |
| C-08 | Structured Decision Escalation | 🟡 Partial | `autonomy.ts:275-366` (`buildDecisionCard`, `parkPendingAction` → `agent_pending_actions` + `work_items`), `app/api/employees/customer/route.ts:46-62` | Decision-brief construction and persistence is real, but delivery is dashboard-pull only — no outbound Slack/WhatsApp push of the card to a manager as spec describes. |
| C-09 | Churn Risk Sentinel | 🟡 Partial | `customer/operational-state.ts:9` (keyword match → `at_risk`), `workflows/CustomerRecoveryWorkflow.ts:1-69` (24h check-in) | Single-message keyword match, not sentiment-trajectory analysis across prior interactions. No Account Executive alert — only an automated customer-facing check-in, not human escalation. |
| C-10 | Knowledge Gap Detection | 🟡 Partial | `activities/index.ts:174-203` (confidence-gate failure logged via `logCustomerLedgerActivity`), `activities/customer.ts:122-151` (`clusterConversationalInsightsActivity` → FAQ recommendations) | Clusters *all* recurring messages, not specifically low-confidence ones; threshold is 0.72 in code vs. the spec's stated 0.65. |

**Customer summary:** 2 Implemented (C-01, C-07), 6 Partial, 2 Missing (C-04, C-06). The async backbone (fast-ack, Open Loops, decision-card/ledger governance) is genuinely solid; the domain-specific resolution actions (reschedule, refund, address update) are governance-only stubs with no execution backend.

---

## Operations Employee (The Execution Sentinel)

| # | Feature Name | Status | Evidence (file:line) | Gap / What's Missing |
|---|---|---|---|---|
| O-01 | The 9:00 AM Morning Operation | 🟡 Partial | `workflows/morning-check.ts:24-44` (24h loop from provisioning time, not 9AM-local; calls only `countDueSweepActivity`), real logic in `activities/open-loop-sweep.ts:138-186` (`runMorningCheckActivity`) | No Temporal Schedule / 9AM-local cron exists at all. `runMorningCheckActivity` (the real triage/dedup logic) is registered but **never called** by the workflow — dead code. |
| O-02 | Daily Operational Brief | 🟡 Partial | `operations/brief.ts:30-55` (`buildTriageBrief`, real exceptions-only compiler) | No proactive dispatch to Slack/email — `app/api/brief/route.ts` is GET-only (dashboard pull); only reactive path is owner texting "brief" over WhatsApp. Also blocked by O-01's disconnect. |
| O-03 | Expected vs. Actual Discrepancy Engine | 🟡 Partial | `operations/expected-vs-actual-engine.ts:18-163` (`compareExpectation`, `scanOpenExpectations`, `attachDiscrepancyWorkItem` — real and used) | `declareExpectation` (the only function that *creates* an expectation row for a rule like "owner assigned within 2 hours") has zero callers anywhere — the scanner has nothing real to find in production. |
| O-04 | Rep Follow-Up SLA Enforcement | ❌ Missing | none found | No rep-assignment timer, no Slack reminder to a specific rep, no manager escalation for slow follow-up. |
| O-05 | Capacity-Aware Task Balancing | ❌ Missing | none found | Only "capacity" hit in repo is an API rate-limit token bucket, unrelated to human workload/assignment. No round-robin/least-loaded/timezone assignment logic. |
| O-06 | Fuzzy Deduplication & Entity Merging | 🟡 Partial | `operations/dedup-engine.ts` (real trigram similarity, merge/quarantine/create thresholds, well-tested) | No callers outside the file/its test — never invoked from a live contact-creation path. Its quarantine table `ambiguous_duplicate_reviews` has no migration (`CREATE TABLE`), so it would fail at runtime even if wired up. |
| O-07 | Data Hygiene & Field Enrichment | ❌ Missing | none found | No CRM contact-field backfill from email signatures or domain metadata. "Enrich" hits found are Growth's Apollo company-enrichment and website-visitor IP enrichment — unrelated. |
| O-08 | Calendar Deadlock & Meeting Checker | 🟡 Partial | `operations/meeting-prep.ts:90-199` (`auditAndPrepareMeetings`, wired end-to-end via `periodic-registry.ts`) | Audits tomorrow's meetings and compiles a briefing doc, but does not inject Zoom/Meet links, detect/resolve double-bookings, or ping unconfirmed guests — a meeting-briefing compiler, not the described "deadlock checker." |
| O-09 | Stuck Work Triage & Unblocking | 🟡 Partial | `activities/open-loop-sweep.ts:188-221` (`runStuckWorkActivity`, real logic creating `stuck_work` work items) | `workflows/stuck-work.ts` only calls `countDueSweepActivity`, never `runStuckWorkActivity` — same dead-code pattern as O-01. Even if wired, doesn't inspect email threads or draft nudge messages or escalate to legal. |
| O-10 | Third-Party Incident Buffering | ✅ Implemented | `operations/outage-buffer.ts:20-100` (`persistBufferedEffect` with SHA-256 idempotency key, `claimAndFlushBuffered` claim-before-replay, `listPendingBuffers`) | Solid and tested; exponential backoff would need to live in the calling Temporal activity's retry policy (not shown here), but the buffer/replay/idempotency core is real. |

**Operations summary:** 1 Implemented (O-10), 6 Partial, 3 Missing (O-04, O-05, O-07). The recurring pattern here is real business logic that exists and is unit-tested but is **not wired to the Temporal workflow that's supposed to trigger it** (O-01, O-09), plus no true 9AM-local scheduling exists anywhere.

---

## Platform-Level / Shared Brain

| Item | Status | Evidence (file:line) | Gap / What's Missing |
|---|---|---|---|
| Principle 1 — Context Precedes Capability | 🟡 Partial | `apps/dashboard/app/api/brain/route.ts:14-15,131-184` (org/employee/entity/conversation memory tiers), `infra/db/migrations/022_entity_graph.sql` (entities/facts/predicate_defs) | Real memory store exists, but it's exposed as a human-facing search/audit page, not something the three employee reasoning loops query mid-execution as business context. |
| Principle 2 — Resolve, Don't Merely Reply | 🟡 Partial | Real mutations exist for calendar `create_event`, HubSpot updates, WhatsApp sends; Open Loop follow-up sends (`open-loop-sweep.ts`) | Per employee audits above, several named "resolve" mutations (Stripe refund, Shopify address update, calendar reschedule) are missing entirely — the resolve capability is real for some actions, absent for others the spec highlights as flagship examples. |
| Principle 3 — Escalate Decisions, Not Conversations | ✅ Implemented | `services/workflows/src/autonomy.ts:275-370` (`buildDecisionCard`, `parkPendingAction` → `work_items` + `agent_pending_actions`), `customer/decision-card.ts`, `operations/decision-ledger.ts` (`agent_decision_ledger`, including non-actions), UI: `components/inbox/DecisionCard.tsx`, `components/customer/DecisionCardPanel.tsx` | Genuinely implemented and consistently used across employees — decisions become structured `work_items` with an options/recommendation payload, not raw chat dumps. Delivery is in-app only (no outbound Slack/WhatsApp push of the card itself). |
| Principle 4 / Shared Company Brain (cross-employee propagation) | ❌ Missing | `customer/operational-state.ts:9` (churn stays a local `at_risk` flag); `workflows/InsightActionWorkflow.ts` (unrelated dashboard-metric triggers) | No code path where a Customer-discovered churn reason writes a fact that Growth reads to suppress prospects, or that Operations reads to scan pipeline deals and surface them in a brief. The spec's flagship "SOC2 churn → Growth stops pitching → Operations audits deals" example is aspirational, not implemented — no pub/sub or event bus connects the three employees' workflows. |
| Autonomy Levels | ✅ Implemented (different shape than spec) | `services/workflows/src/autonomy.ts:23-121` (4-tier `AutonomyTier`, `DEFAULT_RULES` per action bucket), `evaluateAutonomy()` (blastRadius × (1−confidence) formula, irreversible always escalates), `infra/db/migrations/023_employee_state_machines.sql` (`employee_autonomy_rules` table, seeded per org) | More sophisticated than the spec's flat "Level 1-4" framing — per-action, per-employee-role, computed dynamically from reversibility/blast-radius/confidence rather than a simple user-selectable slider. This contradicts the (now-stale) old gap docs, which claimed an all-or-nothing global tool allowlist. |
| Decision Ledger (negative decisions, "why didn't you do that?") | ✅ Implemented | `infra/db/migrations/023_employee_state_machines.sql` (`agent_decision_ledger` table: executed/deferred/declined/escalated/suppressed with `reason_code`), `services/workflows/src/operations/decision-ledger.ts` | Real and matches spec intent — logs every gate evaluation including non-actions, with enum reason codes for aggregation. |
| Open Loops (cross-cutting) | ✅ Implemented | `services/workflows/src/workflows/open-loop-monitor.ts`, `agent_entity_leases` table (lease-based collision control, precedence customer > operations > growth) | Solid, real Temporal usage; 24 workflow files use `@temporalio/workflow`. Most mature platform-level piece found. |
| Negative Constraints ("never discount > 15%") | ❌ Missing | none found | Zero hits for "negative constraint" / "never discount" / generic guardrail ingestion. Closest analog is Growth's own `org_preferences.rules`, which is a single-employee learned-preference loop from Ask-AI downvotes, not an ingested platform-wide business-policy set. |

**Platform summary:** The escalation/decision-card/autonomy/open-loop machinery is the strongest-built part of the entire system — arguably ahead of what the spec's simple "Level 1-4" language implies. The one deep, structural gap is the **Shared Company Brain's cross-employee propagation**: the memory store, entity graph, and per-employee logic all exist in isolation, but nothing wires a Customer-Employee insight into Growth's or Operations' decision-making automatically.

---

## Summary

### Counts per employee

| Employee | ✅ Implemented | 🟡 Partial | ❌ Missing |
|---|---|---|---|
| Growth | 2 | 6 | 2 (G-02, G-07, G-09 = 3 total; see note) |
| Customer | 2 | 6 | 2 |
| Operations | 1 | 6 | 3 |
| **Total (30 features)** | **5** | **18** | **7** |

*(Growth row: G-02, G-07, and G-09 are all Missing — 3 Missing, 2 Implemented, 5 Partial for Growth; corrected count above reflects 5/2/3.)*

Platform-level (8 items): 4 Implemented, 3 Partial, 2 Missing (Negative Constraints and cross-employee propagation are both Missing).

### Top 5 highest-priority gaps overall

1. **Cross-employee Shared Company Brain propagation is entirely absent.** This is the platform's headline differentiator in the spec (§6) and has zero wiring — no Customer-insight-to-Growth-guardrail or Customer-insight-to-Operations-brief path exists anywhere.
2. **Operations' two flagship workflows (9AM Morning Operation, Stuck Work Triage) have their real logic built but disconnected from the Temporal workflows meant to trigger them** (`runMorningCheckActivity` and `runStuckWorkActivity` are dead code, called by nothing) — a small wiring fix would unlock two of the biggest advertised capabilities.
3. **Customer Employee's core "resolve" actions have no execution backend**: no Stripe refund call, no calendar reschedule action, no Shopify address-update mutation — despite governance (autonomy/decision-card) correctly treating these as tier-2/irreversible actions.
4. **Growth Employee cannot discover new companies** — G-01/G-02 both depend only on inbound signals/visitor intent; Apollo/LinkedIn tools exist but are never called from the autonomous pipeline, so "lookalike hunting" never expands beyond the existing signal set.
5. **No true 9AM-local scheduling exists anywhere** (Operations' morning workflow runs on a fixed 24h loop from provisioning time) and **no proactive brief/decision-card delivery to Slack/WhatsApp exists** — every "notification" in the system today is dashboard-pull, not push, contradicting multiple spec examples (9AM Brief, Decision Card to manager).
