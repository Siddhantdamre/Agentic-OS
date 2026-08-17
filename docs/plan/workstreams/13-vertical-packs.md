# Workstream 13 — Vertical packs

The way Darex covers “all B2B” without 40 codebases is the
**vertical pack**. The kernel does not change when a pack is
installed.

Linked from [../05-workstream-index.md](../05-workstream-index.md).
Documentation only.

---

## 1. Current reality

Sources: `docs/current-working/04-e2e-auth-onboarding.md`,
`09-dashboard-pages.md`. Future-scope `03` §6.

- Onboarding stores business type. It does **not** install a pack.
- Sarah/Emma/Marcus is a roster prototype, not a versioned pack.
- No `packs/` tree, no `org_packs`, no `re.listing` entities, no
  `compliance.yaml`.
- Ecommerce `SKILL.md` exists on disk; it is not an ecom pack.

---

## 2. Target

Sources: `docs/future-scope/03-industry-operating-system.md`,
`04-b2b-verticals.md`, `05-real-estate-vertical.md`,
`13` Phases 9/11/12/14/16/18.

```
pack = employees + entity schemas + connectors + workflows
     + skills + KPIs + compliance + onboarding copy
```

Quality bar (`03` §11): idempotent install; 3 employees; 5 golden
conversations; honest disconnected; 2 durable workflows; memory
write-back; compliance catches a known-bad draft; pack README.

Waves: W0 Core B2B; W1 Real estate first deep; W2 agencies/ecom/
SaaS/prof-services; W3 wholesale/recruiting/hospitality; W4
heavier compliance; W5 RFC only.

RE wedge: Sheets + WhatsApp + Gmail first. Do not wait on MLS.
Never invent price, RERA, inventory, or “payment received”.

---

## 3. Gaps

**Audit 2026-08-14:** P1/P2 **done**. P3 **partial** (UI scheduling
wired 2026-08-14; `pack.yaml` `live: false` until §11 Calendar +
live DB listing evals are green). P4–P5 **deferred** (RFC).
`packs/RFC-wave-2-4.md`.

Everything pack-shaped is **missing** except the default roster
and onboarding business-type field. **Never ship RE before
Phase 6 memory.**

---

## 4. Work items

### P1 — Pack schema + InstallPackWorkflow + Core B2B v1

- **Where:** `packs/core-b2b/`; `015_packs.sql`;
  `InstallPackWorkflow`.
- **DoD:** New org gets Core B2B once. Re-install is a no-op.
  Uninstall does not delete conversations.

### P2 — Onboarding maps type → packs

- **Depends on:** P1, U5.
- **DoD:** Realtor choice recommends connectors; never marks them
  connected.

### P3 — Real estate brokerage v1 (India wedge)

- **What:** `re.listing` / `re.inquiry` / `re.showing`. Sheets
  inventory. ISA + showing coordinator. Filters first, then
  vector. Calendar showings. RERA/fair-housing validators.
  Goldens `05` §11. Listings UI (U4).
- **Depends on:** M3, M6, Maps, WhatsApp outbound, Sheets
  inventory, router.
- **DoD:** “2BHK in X under Y” returns only sheet rows. Zero
  matches does not invent. Quality bar `03` §11.

### P4 — RE expansion (US + PM + developer)

- **What:** FUB or US CRM; licensed MLS only; PM rent reminder +
  PSP webhook; developer site-visit no-show.
- **DoD:** Two markets documented. “I paid” without PSP webhook
  does not close a charge.

### P5 — Wave 2 packs

- **What:** agencies, ecommerce, saas-gtm, prof-services — quality
  bar or explicit beta.
- **DoD:** At least two live; onboarding choices work.
  Not-licensed-advice disclosure on prof-services.

### P6 — Wave 3–4 as pull

- **What:** RFC before code. Clinic-ops default no PHI. Education
  minors controls.
- **DoD:** Compliance review (`12`) before Wave 4 sales.

---

## 5. End-to-end connections

Memory must exist or the pack is theater. Connectors recommended,
never faked. Employees YAML (08). Workflows names (02).
Compliance data (07). UI modules (09). Evals (10).

---

## 6. Non-goals

Fork per vertical. MLS/escrow/Zillow. Portal scrape. Clinical
diagnosis. Public skill store before Phase 15.

---

## 7. Verification

Quality bar is DoD. Goldens `05` §11. Disconnected Sheets →
notConnected. Two-org listings never leak. Eval-runner blocks
invented inventory.

Related: [03-memory-rag-brain.md](./03-memory-rag-brain.md),
[04-integrations-and-connectors.md](./04-integrations-and-connectors.md),
[`../../future-scope/05-real-estate-vertical.md`](../../future-scope/05-real-estate-vertical.md).
