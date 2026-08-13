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

- [ ] R1 Skills + sandbox on default branch; image rebuilt after skill edits
- [ ] R2 `buildGroundedUserMessage` includes retrieveMemory on Ask AI simple, complex, and inbound
- [ ] R3 Per work-item session keys
- [ ] R4 A mounted skill changes observed behavior in an eval
- [ ] R5 Risk metadata on the executor gateway
- [ ] R6 No second employee runtime added

### 02 Orchestration (O)

- [ ] O1 `work_items` + `work_events` with RLS
- [ ] O2 WorkItemWorkflow (wrap or replace AutonomousAgentWorkflow — decision recorded)
- [ ] O3 Activity rules on every side-effect
- [ ] O4 Plan execute via Temporal when risk ≥ send
- [ ] O5 OwnerBriefing + StaleChase
- [ ] O6 Playbook matcher; nurture cancels on reply
- [ ] O7 HITL Temporal signal

### 03 Memory (M)

- [ ] M1 Schema + RLS + WITH CHECK
- [ ] M2 embed-worker; never on webhook thread; `EMBEDDING_MODEL` fail-fast
- [ ] M3 retrieveMemory returns cited snippets or empty
- [ ] M4 Write-back after successful turns
- [ ] M5 `/brain` search + cite
- [ ] M6 Returning-contact eval + two-org vector test

### 04 Connectors (C)

- [ ] C1 OAuth client IDs + Gmail re-connect (ops)
- [ ] C2 Catalog hints match executors
- [ ] C3 Registry tables; UI reads registry
- [ ] C4 tool-executor split; 62 tools still honest
- [ ] C5 Outlook + Calendar completeness
- [ ] C6 One CRM + one e-sign + Maps
- [ ] C7 Sheets inventory SoR (mid); later waves as pull

### 05 Knowledge (K)

- [ ] K1 Drive `knowledge_sources` + `ingestion_jobs`
- [ ] K2 File ingest v1 cites
- [ ] K3 Sync-worker cursors
- [ ] K4 Semantic metrics registry; no raw SQL on request path
- [ ] K5 Public official fetch + cache (cite; never inventory)

### 06 Channels (H)

- [ ] H1 Meta token rotated; Console webhook live
- [ ] H2 Unified `channel_key` on messages
- [ ] H3 Gmail push + portal email parse
- [ ] H4 Instagram / SMS as pull
- [ ] H5 Owner WhatsApp distinct number
- [ ] H6 Public widget as pull
- [ ] H7 Redis SSE with two replicas

### 07 Security (S)

- [ ] S1 Apps run as `darex_app`
- [ ] S2 Confirm classes on webhook path
- [ ] S3 `audit_events` + who approved
- [ ] S4 Redaction before embed
- [ ] S5 Demo-auth prod fail + rate limits
- [ ] S6 DSR export/delete
- [ ] S7 SSO SAML

### 08 Employees (E)

- [ ] E1 Allowlist union does not regress
- [ ] E2 Router
- [ ] E3 Critic gate
- [ ] E4 Research + Finance seeds
- [ ] E5 @employee decision recorded and implemented
- [ ] E6 Human roles including auditor

### 09 Dashboard UX (U)

- [ ] U1 Citations on Ask AI
- [ ] U2 Plans / work-items inbox
- [ ] U3 `/brain` chrome
- [ ] U4 Pack modules (RE first)
- [ ] U5 Onboarding → pack + real warm-up
- [ ] U6 Mobile + a11y

### 10 Observability (A)

- [ ] A1 Langfuse persistence stable
- [ ] A2 Eval-runner CI from Phase 6
- [ ] A3 Insight engine (not templates)
- [ ] A4 Cost per org + drift
- [ ] A5 Promote plan → org skill

### 11 Infra (I)

- [ ] I1 Migrations 009–011 applied
- [ ] I2 Sandbox committed; stale READMEs fixed
- [ ] I3 Redis event bus
- [ ] I4 PgBouncer + pool discipline
- [ ] I5 Terraform starter + backup restore drill
- [ ] I6 Alerting + new probes
- [ ] I7 Split ingest host (later; optional for “complete”)

### 12 Research adoption (L)

- [ ] L1 ADOPT list used in Phase 6–8 (Promptfoo, hybrid retrieve later)
- [ ] L2 STUDY patterns only (no vendor SoR)
- [ ] L3 WATCH items stay named-phase
- [ ] L4 REJECT list not violated (no Composio, Mem0 Cloud, second runtime)
- [ ] L5 Review gate on new dependencies

### 13 Packs (P)

- [ ] P1 Core B2B versioned pack + idempotent install
- [ ] P2 Onboarding maps type → packs
- [ ] P3 RE brokerage IN wedge + `03` §11 quality bar
- [ ] P4 RE expansion (two markets)
- [ ] P5 Two Wave 2 packs live or explicit beta
- [ ] P6 Wave 3–4 RFC then pull

### 14 Billing / learning (B)

- [ ] B1 Invite email when key set; URL always works
- [ ] B2 Darex subscription billing; no escrow
- [ ] B3 Meters match traces
- [ ] B4 Learning loop; no cross-org training
- [ ] B5 Marketplace **preview** only; no public store

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
- [ ] C6 at least one CRM or honest notConnected
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
