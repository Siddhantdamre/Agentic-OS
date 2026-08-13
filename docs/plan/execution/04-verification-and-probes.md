# Execution — 04 Verification and probes

How we know a piece is real. Honesty rule from AGENTS.md and
future-scope `14`: missing OAuth or inventory → `notConnected` /
empty cite, never a fabricated row.

Linked from [../README.md](../README.md). Documentation only.

Sources: current-working `00`, `12`, `15`;
`documentation/09-verification-checks.md`; workstream 11.

---

## 1. Keep the existing probes

Do not replace these. They are the regression floor.

| Script | What it proves today | Watch |
|--------|----------------------|-------|
| `infra/scripts/check-phase0.js` | 17/17 foundation containers (Postgres+pgvector, Temporal, Redis, Nango, Langfuse, LiteLLM) | Must stay green after S1 and M1 |
| `infra/scripts/check-phase2.js` | 17/17 connector connect + proxy + webhook log | Extend when C3 registry lands; do not weaken honesty |
| `infra/scripts/check-phase3.js` | 6/6 Chatwoot HMAC ingest + RLS + inbox | Must stay after `fireInboundAgent` and O2 |
| `infra/scripts/check-auth-nango.js` | 3/3 register → login → integrations | Must stay after SuperTokens/S7 |
| `infra/scripts/e2e-live-llm.js` | Inbound + LLM persist; outbound Meta 401 until H1 | After H1, outbound steps must be real sends or honest skip — never fake success |

Commands (from current-working `15`):

```bash
node infra/scripts/check-phase0.js
node infra/scripts/check-phase2.js
node infra/scripts/check-phase3.js
node infra/scripts/check-auth-nango.js
node infra/scripts/e2e-live-llm.js
```

---

## 2. New probes this plan requires

| Script (name as shipped) | When | Proves |
|--------------------------|------|--------|
| `check-phase6-memory.js` | M1–M6 | Embed job off webhook; retrieve prefix present; empty org returns empty; disconnected source honest |
| Two-org vector test | M1 + S1 | Org A embeddings never returned to Org B as `darex_app` |
| Two-replica SSE | I3/H7 | Both dashboard processes receive `needs_attention` |
| Connector goldens | C3+ | Connected action; revoked token; never-configured provider — all three paths |
| Returning-contact eval | M6 / A2 | New thread cites a prior fact; inventing the fact fails CI |
| Pack goldens `05` §11 | P3 | `node infra/evals/runner.js re-brokerage.yaml` — fixture 2BHK subset; `*-live` seeds `re_listings` + RLS |
| Billing isolation | B2 | Org A cannot read Org B invoices; unsigned webhook rejected |
| DSR two-org | S6 | Delete A leaves B vectors |

Prefer adding files under `infra/scripts/` and YAML under
`evals/` (Promptfoo or equivalent). Do not put evals on the
Ask AI request path.

---

## 3. Honesty goldens (every connector surface)

Run the same three cases on Ask AI simple, Ask AI complex,
WhatsApp, and Chatwoot:

1. **Connected** — real provider response or a recorded fixture
   from that provider, never a hand-written “success” in the
   executor.
2. **Revoked / expired token** — `status:'error'`,
   `connected:false`, setup URL. Meta outbound today is this
   case until H1.
3. **Never configured** — same honesty; pack install must not
   flip this to connected.

Fail the build if any path returns `{success:true}` without
calling the provider.

---

## 4. Tenancy probes

- Session `app.current_org_id` set and **reset on release**
  (existing `getScopedClient` contract).
- After S1: repeat RLS tests as `darex_app`, not superuser.
- Memory: two-org insert + retrieve + `/brain`.
- Pack entities: `re.listing` rows for Org A invisible to Org B.
- Billing and DSR as in section 2.

A green test that used the `darex` superuser is not production
proof.

---

## 5. Journey → probe map

| Journey | Primary proof |
|---------|----------------|
| J1 simple Ask AI | `e2e-live-llm` shape + connector goldens + R2 prefix assertion |
| J2 complex plan | Manual/automated plan with two independent steps; reject has no side-effect |
| J3 WhatsApp | `e2e-live-llm` + H1 outbound; duplicate webhook idempotent |
| J4 Chatwoot | `check-phase3` + agent-after-200; bad HMAC 401 |
| J5 connectors | `check-phase2` extended + three honesty goldens |
| J6 allowlists | Employee without `gmail.send` cannot send |
| J7 tenancy | Two-org vector + `darex_app` RLS |
| J8 RAG / brain | `check-phase6-memory` + M6 eval |
| J9 orchestration | Kill worker mid-workflow; Temporal resumes |
| J10 insight | Card number = SQL; Review Action enqueues |
| J11 onboarding | Re-install pack is no-op |
| J12 owner WA | Customer number cannot approve |
| J13 RE | Sheet goldens; no invented listing id |
| J14 billing | Signed webhook; isolated invoices |
| J15 Sheets | Eval fails extra listing ids |
| J16 inbox send | Revoked token ≠ `{success:true}` |
| J17 invite | URL works without Resend |
| J18 DSR | Delete A leaves B |

---

## 6. What we do **not** accept as proof

- Screenshots of invented CRM/inventory data.
- Insight cards whose numbers are LLM guesses over `messages`.
- “Connected” badges from pack install or catalog hints.
- Superuser-only RLS tests after S1 is declared done.
- A single-process SSE demo as Phase 8 exit.
- Skipping `e2e-live-llm` outbound by asserting success in code.

---

## 7. When a probe is red

1. If the failure is credentials (Meta, Nango client id), mark
   **ops-blocked** in current-working with the provider name.
   Do not “fix” it by stubbing success.
2. If the failure is a hang, pool deadlock, or RLS leak, treat
   as a ship blocker (AGENTS.md).
3. Update [../02-gap-analysis.md](../02-gap-analysis.md) the
   same day.

Related: [00-end-to-end-journeys.md](./00-end-to-end-journeys.md),
[01-definition-of-done.md](./01-definition-of-done.md),
[`../../current-working/15-env-and-run.md`](../../current-working/15-env-and-run.md).
