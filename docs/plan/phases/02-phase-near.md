# Phase — Near (Phase 6 exit through 8 + 10 start)

This bucket finishes memory so it is no longer theater, then
starts insight, the scale skeleton, and the connector registry
plus Wave A/B. Real-estate pack is still **out**.

**Audit 2026-08-14: MOSTLY DONE in code.** Remaining: M6 live eval,
Zoho/Leegality, two-replica drill, Langfuse ClickHouse.

Linked from [00-phase-map.md](./00-phase-map.md).
Documentation only.

---

## 1. Goal of this bucket

Exit future-scope Phase 6, then land enough of Phases 7, 8, and 10
that a second dashboard replica works and connectors are
registry-driven. Do not wait to finish every Wave B provider
before starting insight, but **do** finish M6 before P3.

---

## 2. Finish Phase 6 (M4–M6, U1, U3, S4)

| # | Task | Depends | DoD |
|---|------|---------|-----|
| M4 | MemoryWriteBack activity after successful turns | M3, Temporal | Entity/conversation rows appear; webhook still returns 200 first |
| M5 | `/brain` inspector v1 (search + cite) | M3 | Owner sees cited snippets; empty org is empty, not invented |
| U3 | `/brain` chrome in dashboard | M5 | Nav + page exist; no fake “knowledge base” counts |
| U1 | Citations on Ask AI answers | M3, R2 | Simple and complex paths show source ids or “no memory” |
| S4 | Redaction before embed | M2 | Secrets/PII patterns stripped; two-org vector test still holds |
| M6 | Returning-contact eval (Phase 6 exit) | M4, A2 | New thread retrieves prior fact; disconnected source stays honest |

Phase 6 exit (binding, from future-scope `13`):

- Returning contact context retrieved on a new thread.
- Eval #7 style case is green.
- Disconnected sources still honest.
- Two-org RLS vector test passes.

---

## 3. Phase 7 start — insight that is not templates

| # | Task | Depends | DoD |
|---|------|---------|-----|
| K4 | Semantic metrics registry (YAML from packs later; Core B2B first) | M1 | `metrics.query` is the only analytics path; raw SQL not on the request path |
| A3 | Scheduled aggregation + insight cards from real numbers | K4, O5 helpful | “Review Action” enqueues Temporal; numbers match SQL |
| A4 | Langfuse cost per org on cards | A1 | Card cost matches traces within documented tolerance |

Do not LLM-scan raw `messages` tables. That is a Phase 7 reject.

---

## 4. Phase 8 — scale skeleton

| # | Task | Depends | DoD |
|---|------|---------|-----|
| I3 | Redis pub/sub for SSE / `needs_attention` | existing Redis split | Two dashboard replicas both receive the event |
| H7 | Wire inbox/Ask AI SSE to the bus | I3 | Killing one Node process does not drop the other replica’s stream contract |
| S1 | Finish `darex_app` if not done in immediate | I1 | App is not superuser |
| S5 | Demo-auth prod fail + rate limits | S1 | Prod refuses demo auth; burst webhooks 429 honestly |
| I4 | PgBouncer + pool discipline | S1 | No pool deadlock on SSE (AGENTS.md rule) |
| I5 | Terraform starter: VPC, RDS, Redis, secrets, HTTPS | — | Staging apply documented; not required for local Phase 6 |
| I6 | Alerting: queue lag, 401 connectors, RLS job | I3, C3 | Alert fires in staging drill |
| A1 | Langfuse ClickHouse / persistence stable | dedicated Redis already | Traces survive compose restart |

Phase 8 exit: two replicas receive `needs_attention`; restore
drill documented; Langfuse traces persist.

---

## 5. Phase 10 start — registry + Wave A/B

| # | Task | Depends | DoD |
|---|------|---------|-----|
| C3 | `connector_defs` / `org_connectors` / `sync_cursors` | S1 | UI reads registry, not a hardcoded stale hint list |
| C4 | Split `tool-executor.ts` into modules | C3 helpful | Same 62 tools; file size no longer a single blob |
| C5 | Wave A: Outlook + Calendar completeness | C1, C3 | Outlook connect is real or honest-missing client id |
| C6 | Wave B P0: Salesforce **or** Zoho, DocuSign **or** Leegality, Maps geocoding, Exotel/Twilio as needed | C3, S2 | One CRM syncs contacts; e-sign uses confirm class |
| E2 | Specialist router (employee pick) | M3, R2 | Inbound + Ask AI route by intent; allowlist still union (E1) |
| K1–K3 | Drive/file ingest + sync cursors | M2, C3 | Ingest job cites; never pretends Drive is connected |

GBP/Meet/GA4/GSC executors already exist. Do not rebuild them.
C2 (catalog hints) should already be done in immediate.

---

## 6. Orchestration that can proceed in parallel

| # | Task | Note |
|---|------|------|
| O1 / O2 | `work_items` + WorkItemWorkflow | May wrap `AutonomousAgentWorkflow`; open question in [../execution/02-risks-and-open-questions.md](../execution/02-risks-and-open-questions.md) |
| O3 | Activity rules on every side-effect | Confirm classes on webhook path start (S2) |
| R3 | Per work-item session keys | After O2 |
| R5 | Risk metadata on executor gateway | Feeds S2 / O4 |

---

## 7. Explicitly not in this bucket

- P3 RE pack (wait for M6).
- B2 billing (mid / Phase 9).
- Owner WhatsApp H5 (mid / Phase 13).
- SSO S7, marketplace B5.
- Wave E vanity connectors.

---

## 8. Exit to “mid”

Near is done when Phase 6 exit is recorded in current-working,
two-replica SSE works or has a dated exception, connector UI is
registry-driven, and at least one of Salesforce/Zoho is a real
sync or an honest notConnected with setupUrl.

Then [03-phase-mid.md](./03-phase-mid.md).

Related: [../workstreams/03-memory-rag-brain.md](../workstreams/03-memory-rag-brain.md),
[../workstreams/04-integrations-and-connectors.md](../workstreams/04-integrations-and-connectors.md),
[../workstreams/11-infra-deploy-and-ops.md](../workstreams/11-infra-deploy-and-ops.md).
