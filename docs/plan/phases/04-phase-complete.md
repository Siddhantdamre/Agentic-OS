# Phase — Complete OS (Phases 15–18 + remaining pull)

“Complete” is the Brain OS bar in future-scope `00` §8 plus the
pack quality bar in `03` §11 for **Core B2B** and
**real-estate-brokerage**. It is **not** every P3 connector, every
Wave 4 vertical, or a public skill store.

**Audit 2026-08-14: PARTIAL.** DSR, auditor, SSO routes, marketplace
preview exist. Missing: test IdP proof, residency design, SCIM.
Phases 16–18 remain pull.

Linked from [00-phase-map.md](./00-phase-map.md) and
[../00-executive-summary.md](../00-executive-summary.md).
Documentation only.

---

## 1. What “complete OS” means

A newly onboarded org in a supported vertical can:

1. Connect 3+ systems (WhatsApp + Gmail + CRM, or WhatsApp +
   Gmail + Sheets inventory).
2. Answer inbound with **memory-grounded** replies and honest
   `notConnected` when a tool is dark.
3. Run multi-step work as a confirmed plan or a durable Temporal
   workflow that survives process death.
4. Ask “what do we know about this lead / listing / tenant?” and
   get **cited** memory + live SoR data — never invented facts.
5. Switch industry pack and change employees, entities, and
   workflows — not the runtime, tenancy, or connector plane.

Plus enterprise: SSO for a test IdP; an auditor who cannot call
`pay` tools; billing that isolates invoices; eval-runner that
blocks invented inventory.

If those are true, remaining Wave 3–4 / voice / computer-use work
is **pull**, not a second product.

---

## 2. Phase 15 — enterprise + marketplace preview

| # | Task | Depends | DoD |
|---|------|---------|-----|
| S7 | SSO SAML on SuperTokens | S1, S5 | Test IdP login; password path still works for non-SSO orgs |
| E6 | Audit role | S3 | Auditor reads `audit_events`; cannot execute `pay` / `send` / `sign` |
| S6 | DSR export/delete | M1, S3 | Org export is scoped; delete does not leak another org |
| B5 | First-party skill versioning UI; **design only** for third-party packs | P1, A2, S3 | No unreviewed pack can run; no public store |
| — | Data residency flag (design; maybe still single-region) | I5 | Written design in current-working; no fake “EU pin” |

Phase 15 exit (future-scope `13`): SSO login for a test IdP;
auditor cannot call `pay` tools.

---

## 3. Phases 16–18 — pull only

| Phase | Work | Gate |
|-------|------|------|
| 16 Wave 3 | P6: wholesale Sheets+WhatsApp; recruiting ATS; hospitality GBP+WhatsApp | RFC before code (`04` §7). Memory still required. |
| 17 Voice + computer-use | Deepgram/Whisper inbound; owner voice briefing; browser-runner for API-less SoR with confirm | Last resort. APIs first. R6: do not add a second runtime. |
| 18 Wave 4 | construction, education ops, clinic-ops, insurance | Compliance review (`12`) first. Clinic-ops default **no PHI**. Education minors controls. Not a year-one sales commitment. |

Wave 5 remains RFC only (future-scope `04`).

---

## 4. Remaining kernel work that may still be open

These can trail Phase 15 without blocking the “complete OS” label
if dated exceptions exist in current-working:

- I7 split ingest host (later).
- H4 Instagram / SMS (routes exist; provider go-live). H6 public chat widget **done**.
- C7+ later CRM/MLS licenses that may never exist — Sheets wedge
  remains the honesty bar.
- A5 / B4 promotion loop polish.
- Langfuse ClickHouse if still flaky (A1).

---

## 5. What complete is **not**

- Every row in future-scope `06` integrations catalog.
- Licensed MLS in every market.
- Darex as escrow, PSP, or Zillow.
- A public third-party marketplace.
- Outcome-pricing copy of Sierra as a year-one commitment.
- Replacing atomic-agent, Nango, Temporal, or Postgres.

---

## 6. Success recording

When this bucket’s required items ship, update:

- `docs/current-working/` snapshot (new dated file).
- `BUILD_STATE.md`.
- [../02-gap-analysis.md](../02-gap-analysis.md) statuses.
- Future-scope `01` / `13` absorbed rows (when those docs are
  next edited — outside this plan’s write set).

Related: [../execution/00-end-to-end-journeys.md](../execution/00-end-to-end-journeys.md),
[../execution/01-definition-of-done.md](../execution/01-definition-of-done.md).
