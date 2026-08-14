# Workstream 11 — Infra, deploy, and ops

The stack runs fully in Docker Compose today. Production shape
(Terraform, HTTPS, multi-instance, PgBouncer) is Phase 8 and is
not started.

Linked from [../05-workstream-index.md](../05-workstream-index.md).
Documentation only.

---

## 1. Current reality

Sources: `docs/current-working/12-infrastructure.md`,
`15-env-and-run.md`, `14-what-does-not-work.md`, `16`.

- 19 compose services. Dedicated `langfuse-redis`. Sandbox context
  in the working tree (untracked vs `99b5f04`).
- Migrations 001–011; operator must apply 009–011.
- Probes: `check-phase0/2/3.js`, `check-auth-nango.js`,
  `e2e-live-llm.js`.
- No Terraform, no HTTPS multi-instance, no PgBouncer, no Redis
  pub/sub, no alerting. Pool max 10.

---

## 2. Target

Sources: `docs/future-scope/13` Phase 8, `02` §8 and §11, `12` §11.

Redis pub/sub SSE. `darex_app`. PgBouncer. Terraform starter.
Backups + restore drill. Alerting. Two dashboard replicas both
receive `needs_attention`.

---

## 3. Gaps

**Audit 2026-08-14:** I2/I3/I4/S1 **done**. I5/I6 **partial**
(scripts). I7 **deferred**.

Compose + probes **done**. Langfuse Redis **done**. Sandbox/skills
**partial** (git). Redis bus, Terraform, PgBouncer, HTTPS,
alerting, `darex_app` switch **missing**.

---

## 4. Work items

### I1 — Operator boot hygiene

- **What:** `pnpm db:migrate`; rebuild sandbox + atomic-agent;
  align Nango UUID.
- **DoD:** Phase 0/2/3/auth probes green on a clean machine.

### I2 — Commit sandbox + fix stale READMEs

- **What:** Track `infra/docker/sandbox/`. Fix inbox README.
  AGENTS.md tool count 49→62.
- **DoD:** Fresh clone runs `code_execution`.

### I3 — Redis event bus

- **What:** H7. Topics `org:{id}`.
- **DoD:** Two dashboard replicas both toast.

### I4 — PgBouncer + pool discipline

- **DoD:** Load test does not deadlock. Isolation holds.

### I5 — Terraform starter + backups

- **Where:** `infra/terraform/`.
- **DoD:** Restore drill dated in BUILD_STATE. No secrets in
  module.

### I6 — Alerting + new probes

- **What:** Queue lag, connector 401s, RLS job, Langfuse ingest.
  `check-phase6-memory.js` when M6 exists.
- **DoD:** Forced outbound 401 still logs.

### I7 — Split ingest host (later)

- **What:** Traefik/Caddy so webhooks do not share Next.js.
- **DoD:** Webhook p99 not tied to LLM latency.

---

## 5. End-to-end connections

Used by all workstreams. Packs must not add a second compose
kernel.

---

## 6. Non-goals

Multi-region active-active in year one. Replacing Postgres.
NATS until Redis pub/sub fails.

---

## 7. Verification

Keep existing probe scores. Add two-replica SSE, restore drill,
`darex_app` connect, phase-6 memory probe. Never commit `.env*`.

Related: [06-channels-and-surfaces.md](./06-channels-and-surfaces.md),
[07-security-compliance-tenancy.md](./07-security-compliance-tenancy.md).
