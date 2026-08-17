# Phases — 00 Map to future-scope 13

This file maps [`docs/future-scope/13-phased-roadmap.md`](../../future-scope/13-phased-roadmap.md)
onto this plan’s four execution buckets. Future-scope 13 remains the
phase numbering (6–18). This plan does not invent a second roadmap.

**Audit 2026-08-14:** Immediate and most Near items are in code.
Do not rebuild M1–M5, O1–O6, C3–C5, S1–S6, P1–P2.

Linked from [../README.md](../README.md) and
[../05-workstream-index.md](../05-workstream-index.md).
Documentation only.

---

## 1. How to read the two numbering systems

| This plan | Future-scope 13 | Intent |
|-----------|-----------------|--------|
| [01-phase-immediate.md](./01-phase-immediate.md) | Remaining Phase 6 hygiene + Phase 6 start | Work from **today** |
| [02-phase-near.md](./02-phase-near.md) | Phase 6 exit + 7 + 8 + 10 start | Memory done; insight; scale skeleton; Wave A/B |
| [03-phase-mid.md](./03-phase-mid.md) | Phases 9, 11, 12, 13, 14 | Billing, RE packs, playbooks, Wave 2 |
| [04-phase-complete.md](./04-phase-complete.md) | Phases 15–18 + “complete OS” bar | Enterprise + pull waves |

Phases 0–5 are **done in code**. Phases 6–10 are **mostly in code**
(see [../02-gap-analysis.md](../02-gap-analysis.md) §0.1). Do not
reopen them. Remaining: operator creds, inbound retrieve activity,
WorkItem HITL wait, RE quality bar, Wave 2 RFC, residency, pull waves.

**Never skip Phase 6.** Future-scope `13` and `01` §5 are binding.
A realtor demo without recall is theater.

---

## 2. Absorbed hygiene (do not rebuild)

Future-scope `13` still lists Phase 6 / Phase 9 bullets that
current-working `16` already closed. Full table:
[../02-gap-analysis.md](../02-gap-analysis.md) section 0.

| Future-scope 13 bullet | Plan treatment |
|------------------------|----------------|
| Mount custom skills | **Done** in working tree (R1 = land on default branch + rebuild) |
| Commit `infra/docker/sandbox/` | **Partial** — I2 still open |
| Delete hermes route | **Done** — do not list |
| Chatwoot → agent | **Done** (`fireInboundAgent`). WorkItemWorkflow (O1/O2) is still missing |
| Finish GBP / Meet / GA4 / GSC stubs | **Done** as executors. C2 catalog hints still open |
| Fix Meta webhook URL in settings | **Done** — do not list as Phase 9 |
| Inbox outbound actually sends | **Done** — do not list as Phase 9 |
| Invite emails | **Partial** — B1 |
| Dedicated Langfuse Redis | **Partial** — A1 ClickHouse still flaky |

---

## 3. Phase 6–18 → work items

### Phase 6 — Memory & RAG (never skip)

**Still open:** M6 live eval;
C6 leftovers shipped (live creds ops); P3 live-verify; H1 token;
C1 OAuth IDs; A1 ClickHouse; I5/I6 staging apply.

**Hygiene still open:** I1 migrate 009–011; C1 OAuth IDs; H1 Meta
token; R1 land sandbox/skills; C2 catalog hints.

**Exit (unchanged):** returning contact retrieved on a new thread;
eval #7 style; disconnected sources honest; two-org RLS vector test.

**Research that must not block:** hybrid vector+FTS, temporal fact
columns, async extract. Not Mem0 Cloud, not Neo4j, not GraphRAG on
the webhook.

### Phase 7 — Insight engine

A3, K4, A4. Exit: “Review Action” enqueues Temporal; numbers match
SQL; no LLM scanning raw message tables.

### Phase 8 — Scale, realtime, prod skeleton

I3 Redis bus, H7, S1 if not already, S5 rate limits, I4, I5, I6,
A1. Exit: two dashboard replicas both receive `needs_attention`;
restore drill documented; Langfuse traces persist.

### Phase 9 — Polish, billing, onboarding-as-pack

B1, B2, B3, U5, U6, P1, P2. **Do not** re-list Meta URL or inbox
send. Exit: stranger signup → pack → connect WhatsApp → first AI
reply with memory (token permitting).

### Phase 10 — Connector registry + Wave A/B

C3, C4, C5, C6. GBP/Meet/GA4/GSC executors already exist — registry
and UI remain. Exit: registry-driven UI; Salesforce or Zoho sync
contacts; e-sign confirm class works.

### Phase 11 — Real estate brokerage v1 (India wedge)

P3, U4, C7 Sheets inventory. **Blocked on M6.** Exit: “2BHK in X
under Y” returns only sheet rows; zero matches does not invent;
showing books on Calendar; pack quality bar `03` §11.

### Phase 12 — RE expansion

P4. Exit: two markets documented; rent reminder from SoR + PSP
webhook; site-visit no-show.

### Phase 13 — Event bus maturity + named playbooks

O5, O6, O7, H5, E3, U2. Exit: inbound Chatwoot+WhatsApp+Gmail parse
all create work items; nurture cancels on reply.

### Phase 14 — Wave 2 packs

P5. Exit: at least two Wave 2 packs live; onboarding choices work.

### Phase 15 — Enterprise + marketplace preview

S7, S6, B5, E6 audit role. Exit: SSO for a test IdP; auditor cannot
call `pay` tools.

### Phases 16–18 — pull

P6, R6 computer-use last resort, H4/H6 as demand. Clinic-ops
default no PHI. Not a year-one sales commitment.

---

## 4. Parallel work that is not a phase

From future-scope `13`:

- Real OAuth client IDs in Nango UI (C1) — ongoing.
- Meta token rotation (H1) — ops.
- Eval-runner CI from Phase 6 onward (A2).
- `BUILD_STATE.md` + current-working updates every ship.
- Absorb shipped rows into [../02-gap-analysis.md](../02-gap-analysis.md)
  with dates.

---

## 5. Calendar (indicative, not a promise)

Copied from future-scope `13` so this plan does not invent dates:

| Quarter | Future-scope phases | This plan bucket |
|---------|---------------------|------------------|
| Q1 | 6 + hygiene + 10 start | Immediate → near |
| Q2 | 7, 8, 11 (RE IN wedge) | Near → mid |
| Q3 | 9, 12, 13 | Mid |
| Q4 | 14, 15 start | Mid → complete |
| Y2 | 16–18 as pull | Complete / pull |

If capacity is one team: **never skip Phase 6**. Skip Wave 4 first.

---

## 6. Alternatives we reject

From future-scope `13` “Alternatives in the world”:

1. Ship RE pack first — theater without RAG.
2. Buy Mastra/Letta and skip the kernel — dual runtime.
3. Insight before memory — templates without recall.
4. Connector spray (Wave E) first — stubs already lie.
5. Voice/computer-use as launch — last resort.

Related: [01-phase-immediate.md](./01-phase-immediate.md),
[../execution/03-build-order.md](../execution/03-build-order.md).
