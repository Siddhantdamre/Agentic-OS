# Execution — 01 Definition of done

Checklists per workstream and per plan bucket. A box is done
only when the workstream file’s DoD is met **and** the journey
prove-step does not fabricate connector or inventory data.

Linked from [../README.md](../README.md). Documentation only.

---

## How to tick a box

1. Work item merged (or operator step recorded in current-working).
2. Probe or eval named in
   [04-verification-and-probes.md](./04-verification-and-probes.md)
   is green, or a dated exception exists.
3. `BUILD_STATE.md` + current-working updated the same ship.
4. Gap row in [../02-gap-analysis.md](../02-gap-analysis.md) moved
   to **done** or **ops-blocked** with a name.

---

## Workstream checklists

### 01 Runtime (R)

- [x] R1 Skills + sandbox on default branch; image rebuilt after skill edits
- [x] R2 `buildGroundedUserMessage` includes retrieveMemory on Ask AI simple, complex, inbound child turn, and WorkItem parent activity
- [x] R3 Per work-item session keys
- [x] R4 A mounted skill changes observed behavior in an eval (`infra/evals/skill-playbook.yaml`)
- [x] R5 Risk metadata on the executor gateway
- [x] R6 No second employee runtime added (CI deny-list)

### 02 Orchestration (O)

- [x] O1 `work_items` + `work_events` with RLS
- [x] O2 WorkItemWorkflow (wrap; Q1 recorded in workflow comments)
- [x] O3 Activity rules on every side-effect
- [x] O4 Plan execute via Temporal when risk ≥ send
- [x] O5 OwnerBriefing + StaleChase (code; per-org cron not live-proven)
- [x] O6 Playbook matcher; nurture cancels on reply
- [x] O7 HITL Temporal signal — PlanExecute + WorkItem inbound `condition()` wait **before send/pay/sign tools** (not only the channel reply)

### 03 Memory (M)

- [x] M1 Schema + RLS + WITH CHECK
- [x] M2 embed-worker; never on webhook thread; `EMBEDDING_MODEL` fail-fast
- [x] M3 retrieveMemory returns cited snippets or empty
- [x] M4 Write-back after successful turns
- [x] M5 `/brain` search + cite
- [ ] M6 Returning-contact eval + two-org vector test — **partial**: YAML + probe exist; parent `retrieveMemoryActivity` wired; live eval not green

### 04 Connectors (C)

- [ ] C1 OAuth client IDs + Gmail re-connect (ops)
- [x] C2 Catalog hints match executors (registry-driven)
- [x] C3 Registry tables; UI reads registry
- [x] C4 tool-executor split; tools still honest
- [x] C5 Outlook + Calendar completeness (ops: Azure client id)
- [x] C6 One CRM + one e-sign + Maps — SF + Zoho CRM + DocuSign + Leegality + Maps + Twilio + QuickBooks executors (2026-08-14). Live OAuth/BYOK still ops.
- [ ] C7 Sheets inventory SoR — **partial**: RE tools + listings filter UI; live sheet/Ask AI verify open

### 05 Knowledge (K)

- [x] K1 Drive `knowledge_sources` + `ingestion_jobs`
- [ ] K2 File ingest v1 cites — **partial**: virus-scan stub
- [x] K3 Sync-worker cursors
- [x] K4 Semantic metrics registry; `metrics.query`
- [x] K5 Public official fetch + cache — RERA public tool exists

### 06 Channels (H)

- [ ] H1 Meta token rotated; Console webhook live (**ops-blocked**)
- [x] H2 Unified `channel_key` on messages
- [ ] H3 Gmail push + portal email parse — **partial**: route exists
- [ ] H4 Instagram / SMS as pull — **partial**: webhook routes
- [ ] H5 Owner WhatsApp distinct number — **partial**: route; needs number
- [x] H6 Public widget embed JS + snippet — persist → 200 → WorkItem; no body `org_id`
- [x] H7 Redis SSE with two replicas (bus done; replica drill not recorded)

### 07 Security (S)

- [x] S1 Apps run as `darex_app`
- [x] S2 Confirm classes on webhook path
- [x] S3 `audit_events` + who approved
- [x] S4 Redaction before embed (embed path)
- [x] S5 Demo-auth prod fail + rate limits
- [x] S6 DSR export/delete
- [ ] S7 SSO SAML — **partial**: routes; test IdP unproven

### 08 Employees (E)

- [x] E1 Allowlist union does not regress
- [x] E2 Router
- [x] E3 Critic gate
- [x] E4 Research + Finance seeds
- [x] E5 @employee decision recorded and implemented (org-union)
- [x] E6 Human roles including auditor

### 09 Dashboard UX (U)

- [x] U1 Citations on Ask AI
- [x] U2 Plans / work-items inbox
- [x] U3 `/brain` chrome
- [x] U4 Pack modules (RE first)
- [x] U5 Onboarding → pack + real warm-up (Wave 2 RFC)
- [ ] U6 Mobile + a11y — **partial**: `components/a11y/*`; no recorded 375px pass

### 10 Observability (A)

- [ ] A1 Langfuse persistence stable — **partial**
- [x] A2 Eval-runner CI from Phase 6 (`infra/evals/`)
- [x] A3 Insight engine (not templates) — code enqueue
- [x] A4 Cost per org + drift
- [x] A5 Promote plan → org skill

### 11 Infra (I)

- [x] I1 Migrations 009–011 applied (files exist; operator still runs on older DBs)
- [x] I2 Sandbox committed; stale READMEs fixed
- [x] I3 Redis event bus
- [x] I4 PgBouncer + pool discipline
- [ ] I5 Terraform starter + backup restore drill — **partial**: scripts exist
- [ ] I6 Alerting + new probes — **partial**: `alerting-*.js`
- [ ] I7 Split ingest host (later; optional for “complete”) — **deferred**

### 12 Research adoption (L)

- [x] L1 ADOPT list used in Phase 6–8 (Promptfoo YAML, hybrid retrieve, PgBouncer)
- [x] L2 STUDY patterns only (no vendor SoR)
- [x] L3 WATCH items stay named-phase
- [x] L4 REJECT list not violated (CI deny-list)
- [x] L5 Review gate on new dependencies (CI deny-list)

### 13 Packs (P)

- [x] P1 Core B2B versioned pack + idempotent install
- [x] P2 Onboarding maps type → packs
- [ ] P3 RE brokerage IN wedge + `03` §11 quality bar — **partial** (UI schedule + evals; not `live`)
- [ ] P4 RE expansion (two markets) — **deferred**
- [ ] P5 Two Wave 2 packs live or explicit beta — **deferred** (RFC)
- [x] P6 Wave 3–4 RFC then pull (`packs/RFC-wave-2-4.md`)

### 14 Billing / learning (B)

- [x] B1 Invite email when key set; URL always works
- [ ] B2 Darex subscription billing; no escrow — **partial**: org-isolated checkout + fail-fast; live PSP keys still human
- [x] B3 Meters match traces (code)
- [x] B4 Learning loop; no cross-org training
- [x] B5 Marketplace **preview** only; no public store

---

## Phase-bucket checklists

### Immediate ([../phases/01-phase-immediate.md](../phases/01-phase-immediate.md))

- [ ] I1, C1, H1 operator items done or named-blocked
- [ ] R1, I2 on default branch
- [ ] C2 catalog hints
- [ ] S1 merged or dated exception
- [ ] M1, M2 exist; M3/R2 merged
- [ ] A2 stub can fail closed
- [ ] Existing `check-phase0/2/3`, `check-auth-nango`, `e2e-live-llm` still green

### Near ([../phases/02-phase-near.md](../phases/02-phase-near.md))

- [ ] M4–M6; Phase 6 exit recorded in current-working
- [ ] U1, U3, S4
- [ ] K4 + A3 start; insight numbers match SQL
- [ ] I3 + H7 two-replica SSE or dated exception
- [ ] C3 registry-driven UI
- [x] C6 at least one CRM or honest notConnected — Zoho/SF + Leegality/DocuSign honesty goldens
- [ ] E2 router; E1 still holds

### Mid ([../phases/03-phase-mid.md](../phases/03-phase-mid.md))

- [ ] P1, P2, U5; Phase 9 stranger-signup exit
- [ ] B2, B3 in staging
- [ ] P3 quality bar; J13/J15 goldens green
- [ ] O5–O7, H5, U2
- [ ] P5 two Wave 2 packs or dated betas
- [ ] U6 basic mobile/a11y

### Complete ([../phases/04-phase-complete.md](../phases/04-phase-complete.md))

- [ ] Brain OS tests in [../00-executive-summary.md](../00-executive-summary.md) §1 for Core B2B and RE brokerage
- [ ] S7 + E6 Phase 15 exit
- [ ] S6 DSR
- [ ] B5 design only; no public store
- [ ] Every journey in [00-end-to-end-journeys.md](./00-end-to-end-journeys.md) has a prove note
- [ ] Phases 16–18 remain pull unless an RFC is accepted

Related: [03-build-order.md](./03-build-order.md).
