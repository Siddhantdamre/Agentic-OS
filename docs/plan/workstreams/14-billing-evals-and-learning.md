# Workstream 14 — Billing, evals, and learning

Layer 6 (learning) plus Phase 9 billing and Phase 15 marketplace
preview. Evals start in Phase 6 (workstream 10); this file owns
the commercial and promotion loop.

Linked from [../05-workstream-index.md](../05-workstream-index.md).
Documentation only.

---

## 1. Current reality

Sources: `docs/current-working/00-status-at-a-glance.md`,
`14-what-does-not-work.md`. Future-scope `13` Phases 9/15.

- Billing: **not started**.
- Invites: copyable link; Resend if `RESEND_API_KEY`.
- Langfuse traces exist; no cost budgets, no playbook promotion,
  no marketplace.
- Stripe/Razorpay executors exist as **org tools** (payment
  links), not as Darex SaaS billing.

---

## 2. Target

Sources: `docs/future-scope/13` Phase 9 and 15, `00` §5 builder
surfaces, `03` §10 marketplace later, `08` §10.

- Billing via Stripe/Razorpay: plans, seats, usage meters (LLM +
  WhatsApp). Primary pack + add-on.
- Invite emails (Resend) as default when key set — already
  partial.
- Learning: traces → employee quality per org → failing tools →
  promote winning plans. Never silently train on tenant data for
  other tenants.
- Phase 15: SSO (S7), audit role, first-party skill versioning
  UI, **design only** for third-party packs. No public store
  until memory, confirm, and audit are solid.

---

## 3. Gaps

**Audit 2026-08-14 + B2 wiring 2026-08-14:** B3/B4/B5 **done** as
code. B2 **partial** — checkout/session is session-`org_id` only,
prod fail-fast + honest 503 when keys missing, `.env.example`
documents `DAREX_STRIPE_*` / `DAREX_RAZORPAY_*`. Live paid plan
still needs a human to paste Darex PSP test keys. B1 **partial**
without Resend key.

Invite link **partial**. Billing, meters, promotion UI,
marketplace **missing**. Eval-runner owned by workstream 10.

---

## 4. Work items

### B1 — Invite email default path

- **What:** If `RESEND_API_KEY` set, send; always return
  copyable URL (already). Document MAIL_FROM.
- **Where:** `lib/mail.ts`; settings.
- **DoD:** Staging send received. No email → URL still works.

### B2 — Billing v1

- **What:** Stripe (global) and/or Razorpay (IN) for **Darex
  subscription**, separate from org payment-link tools. Plans,
  seats, meter LLM tokens + WhatsApp conversations.
- **Where:** new `app/api/billing`; `orgs.plan` already exists
  as a column — wire it. Webhook signature + 200 first.
- **Depends on:** S1, rate limits.
- **DoD:** Stranger signup can hit a paid plan in staging.
  Failed payment does not leak another org’s invoices. Darex
  never holds client funds / escrow.

### B3 — Usage meters

- **What:** Read Langfuse + channel_logs. Soft limits then hard.
- **Depends on:** A1, A4.
- **DoD:** Meter matches traces within a documented tolerance.
  Disconnected tools do not increment “successful action”.

### B4 — Learning loop

- **What:** Thumbs in Ask AI; confirm-reject rate; promote plan
  (A5). Drift alert (A4).
- **DoD:** No cross-org training. Promotion is human-named.

### B5 — Marketplace preview (design only)

- **What:** First-party skill versioning UI. Written review
  process for third-party packs (executor only, no raw tokens,
  eval-runner, admin install). Do not build a public store.
- **Depends on:** P1, A2, S3.
- **DoD:** Design doc in current-working when Phase 15 starts.
  No unreviewed pack can run in a tenant.

---

## 5. End-to-end connections

Phase 9 exit: stranger signup → pack → connect WhatsApp → first
AI reply with memory (token permitting). That needs B2 + P2 +
H1 + M3.

---

## 6. Non-goals

Darex as PSP/escrow. Outcome-pricing copy of Sierra as year-one
commitment. Public skill store before audit is solid.

---

## 7. Verification

Billing webhook signature tests. Two-org invoice isolation.
Meters vs Langfuse. Invite without Resend still copyable.

Related: [10-analytics-observability.md](./10-analytics-observability.md),
[13-vertical-packs.md](./13-vertical-packs.md).
