# Workstream 07 — Security, compliance, and tenancy

If tenancy or confirm slips, the product is over. Every new table
and connector inherits this file.

Linked from [../05-workstream-index.md](../05-workstream-index.md).
Documentation only.

---

## 1. Current reality

Sources: `docs/current-working/04-e2e-auth-onboarding.md`,
`11-database-tenancy.md`, `14-what-does-not-work.md`,
`16-updates-2026-08-13.md`, `AGENTS.md`.

- Every tenant table has `org_id`. RLS FORCE + WITH CHECK
  (migration 008). `getScopedClient` sets session GUC and RESET
  on release. Body `org_id` rejected. Webhooks use SECURITY
  DEFINER resolvers (010).
- App still defaults to superuser `darex`. `darex_app` granted in
  011 — not switched.
- SuperTokens + Postgres scrypt. `ALLOW_DEMO_AUTH` still dangerous.
- Ask AI confirm exists. Webhook auto-reply does **not** pause on
  `send`/`pay`/`sign`.
- Audit is `channel_logs`. No data-class tags, SSO, SCIM, DSR.

---

## 2. Target

Sources: `docs/future-scope/12-security-compliance-tenancy.md`,
`14`, `13` Phases 8/9/15.

- Run as `darex_app`. Roles: owner / admin / member / auditor /
  employee-service. Dual-layer: allowlist ≠ who may invoke.
  `/brain` uses the same RLS as tools.
- Confirm classes on **all** paths. Data classes block PII →
  web_search and KYC embed. Minors: extra ACL; never sexual
  content involving minors (illegal; stop).
- SSO on SuperTokens (Phase 15). DSR export/delete including
  vectors. `audit_events` with who approved. Prod fail if demo
  auth is on. Rate limits per org.

---

## 3. Gaps

**Audit 2026-08-14 + S7 wiring 2026-08-14:** S1–S6 **done**. S7
**partial** — SuperTokens SAML/OIDC via env; `SUPERTOKENS_SAML_TEST_IDP=true`
enables localhost Boxy defaults in non-prod only; password login
stays on when SSO is unset; prod forbids the test-IdP flag.
Live login still needs a human to run Jackson + mocksaml (or paste
real Boxy client id/secret). SCIM and residency **missing**.

RLS + no body org_id **done**. `darex_app` **partial**. Webhook
confirm, data classes, SSO, DSR, audit role, demo-flag prod fail
**missing**.

---

## 4. Work items

### S1 — Run as `darex_app`

- **What:** `DB_USER=darex_app` on dashboard, worker, bridge.
  Grants on new tables as they land.
- **Where:** compose; `apps/dashboard/lib/db.ts`.
- **DoD:** App is not superuser. Isolation test still passes.

### S2 — Confirm classes on webhook path

- **What:** Price, legal promise, `pay`/`sign`/`publish`, or
  pack-banned phrases → `needs_attention`, do not send.
- **Where:** `lib/inbound-agent.ts`; critic (workstream 08).
- **Depends on:** R5, O2.
- **DoD:** Future-scope `05` goldens 4, 8, 9.

### S3 — `audit_events` + who approved

- **What:** Persist approver, model, tools, Langfuse id. Auditor
  cannot call `pay`.
- **DoD:** After a send, owner can see who approved.

### S4 — Data-class tags + redaction

- **What:** Block `pii` → Jina. Do not embed KYC. Never store PAN.
- **Depends on:** M1.
- **DoD:** Unit tests for strip + skip.

### S5 — Demo-auth prod fail + rate limits

- **What:** Production + `ALLOW_DEMO_AUTH=true` refuses boot.
  Per-org RPS / Ask AI concurrency / embed queue.
- **DoD:** Public channel cannot dump all customers via injection.

### S6 — DSR export/delete

- **What:** Export org rows + memory + files. Delete includes
  vectors.
- **DoD:** After delete, retrieveMemory is empty. Neighbor org
  untouched.

### S7 — SSO SAML (Phase 15)

- **What:** SuperTokens SAML/OIDC. Do not replace SuperTokens.
- **DoD:** Test IdP login. Auditor cannot `pay`.

---

## 5. End-to-end connections

Every new table: `org_id` + WITH CHECK. Memory two-org vector test
is a security test. Packs load `compliance.yaml`. Billing seats
are not a tenancy boundary.

---

## 6. Non-goals

Schema-per-tenant; replacing SuperTokens; OpenFGA unless needed;
HIPAA on by default; storing PAN; cross-org training.

---

## 7. Verification

Keep `test_rls_isolation()`. Add two-org vector, confirm goldens,
demo-flag boot test, DSR round-trip. Gitleaks in CI.

Related: [03-memory-rag-brain.md](./03-memory-rag-brain.md),
[08-employees-roles-and-org.md](./08-employees-roles-and-org.md).
