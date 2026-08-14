# Phase — Mid (Phases 9, 11–14)

Billing, pack onboarding, the first deep vertical (real estate),
event-bus maturity, and Wave 2 packs. **Blocked on Phase 6 exit
(M6 live eval).** Do not claim P3 if returning-contact eval is red.

**Audit 2026-08-14: SCAFFOLDING IN CODE.** P1/P2 exist. P3 pack YAML
+ listings/inquiries UI (showing + rent schedule) + goldens exist;
`pack.yaml` is `live: false`. `03` §11 still needs a Calendar-connected
showing and live listing evals `[PASS]` on a migrated DB (not skip). P5
is RFC. Billing APIs exist; Darex PSP keys are ops.

Linked from [00-phase-map.md](./00-phase-map.md).
Documentation only.

---

## 1. Goal of this bucket

A stranger can sign up, land in a pack, connect WhatsApp, and get
a memory-grounded reply. A realtor org on Sheets + WhatsApp +
Gmail can run inquiry → match → showing without invented
inventory. At least two Wave 2 packs exist or are explicit betas.

---

## 2. Phase 9 — polish, billing, onboarding-as-pack

| # | Task | Depends | DoD |
|---|------|---------|-----|
| P1 | Pack schema + InstallPackWorkflow + Core B2B v1 | O1 helpful | New org gets Core B2B once; re-install is a no-op |
| P2 / U5 | Onboarding maps business type → pack | P1 | Realtor recommends connectors; never marks them connected |
| B1 | Invite email default when `RESEND_API_KEY` set | already partial | Staging send received; URL always copyable |
| B2 | Darex subscription billing (Stripe and/or Razorpay) | S1, S5 | Paid plan in staging; invoices isolated by org; no escrow |
| B3 | Usage meters (LLM + WhatsApp) | A1, A4 | Meter matches traces; failed tools do not count as success |
| U6 | Mobile / responsive + a11y | U1 | Ask AI + inbox usable at 375px; basic a11y pass |
| — | Warm-up progress = real provisioning | P2, C3 | Bar reflects Nango + pack install, not a timer |

**Do not** re-list Meta URL or inbox outbound. Those are absorbed.

Phase 9 exit: stranger signup → pack → connect WhatsApp → first
AI reply with memory retrieve (token permitting).

---

## 3. Phase 11 — real estate brokerage v1 (India wedge)

| # | Task | Depends | DoD |
|---|------|---------|-----|
| C7 | Sheets inventory as SoR (honest if sheet missing) | C3, M6 | Rows only from the sheet |
| P3 | Entities `re.*`, ISA + showing coordinator, inquiry → match → showing, RERA/fair-housing validators, goldens `05` §11 | M6, C7, H1, E2, Calendar | “2BHK in X under Y” returns only sheet rows; zero matches does not invent; showing books on Calendar |
| U4 | Listings table + inquiry pipeline UI | P3 | Modules hide when pack uninstalled; conversations remain |

Pack quality bar (`03` §11) is the exit, not a logo wall.

Never invent price, RERA, inventory, or “payment received”.
Never scrape portals. Do not wait on MLS license.

---

## 4. Phase 12 — RE expansion

| # | Task | Depends | DoD |
|---|------|---------|-----|
| P4 | US CRM (FUB) or licensed MLS; `real-estate-pm`; developer pack | P3 | Two markets documented |
| — | Rent reminder from SoR + PSP webhook | P4, confirm class | “I paid” without webhook does not close a charge |
| — | Site-visit no-show workflow | P4, Calendar | Temporal timer; no invented attendance |

---

## 5. Phase 13 — event bus maturity + named playbooks

| # | Task | Depends | DoD |
|---|------|---------|-----|
| O5 | OwnerBriefingWorkflow + StaleChaseWorkflow | I3, M4 | Morning brief uses memory + metrics, not templates only |
| O6 | Playbook matcher + nurture timers | O2, R4 | Skip free-form plan when confident; nurture cancels on reply |
| O7 | HITL Temporal signal (owner approve/reject) | O2, S2 | Webhook `send`/`pay`/`sign` can pause |
| H5 | Owner WhatsApp on a **distinct** number | H1, O7 | Approvals do not collide with customer inbound |
| E3 | Critic gate on send/publish | E2, S2 | Known-bad draft blocked in eval |
| U2 | Work items UI (not only conversations) | O1 | Owner sees open work; closing is durable |
| O4 | Plan execute via Temporal when risk ≥ send | O3, S2 | Process death does not lose a confirmed send |
| E4 | Research + Finance seed employees | P1 | YAML only; allowlists enforced |
| E5 | Ask AI @employee + auto | E2 | Open question: mention-lock vs org-union — decide before ship |

Phase 13 exit: inbound Chatwoot + WhatsApp + Gmail parse all
create work items; nurture cancels on reply.

---

## 6. Phase 14 — Wave 2 packs

| # | Task | Depends | DoD |
|---|------|---------|-----|
| P5 | agencies, ecommerce (existing skill + Shopify CX), saas-gtm, prof-services | P1, M6, Wave D as needed | At least two live; others explicit beta with eval subset |
| — | Not-licensed-advice disclosure on prof-services | P5 | Eval catches a draft that gives binding legal/tax advice |

---

## 7. Learning loop (can start once A2 is green)

| # | Task | Depends | DoD |
|---|------|---------|-----|
| B4 | Thumbs + confirm-reject → promote plan (A5) | A2, A5 | No cross-org training; promotion is human-named |

---

## 8. Explicitly not in this bucket

- SSO / audit role / marketplace store (Phase 15).
- Wave 3–4 packs as a commitment (pull).
- Voice and computer-use (Phase 17).
- Becoming an MLS, escrow, or PSP.

---

## 9. Exit to “complete”

Mid is done when Phase 9 and Phase 11 exits are recorded in
current-working, and either Phase 14 exit or a dated “two betas”
note exists. Then [04-phase-complete.md](./04-phase-complete.md).

Related: [../workstreams/13-vertical-packs.md](../workstreams/13-vertical-packs.md),
[../workstreams/14-billing-evals-and-learning.md](../workstreams/14-billing-evals-and-learning.md),
[../workstreams/02-orchestration-and-workflows.md](../workstreams/02-orchestration-and-workflows.md).
