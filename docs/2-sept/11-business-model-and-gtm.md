# 11 — Business Model and Go To Market

## 1. What the customer is buying

Not seats. **Capacity and reliability**: work that happens without being
remembered, and context that survives staff turnover.

The comparison the buyer makes is **versus hiring another coordinator**, not
versus another SaaS tool. That sets the price ceiling, the proof burden, and the
metrics that matter — hours saved, commitments met, response time — rather than
seats or message counts.

---

## 2. Packaging

| Tier | For | Includes |
|---|---|---|
| **Starter** | Solo operators, micro-teams | `core-b2b`, 1–2 employees, core connectors, Ask AI, confirm-execute, memory |
| **Business** | 5–25 seat SMBs | Full roster, all connectors, one vertical pack, insights, work items, autonomy to L3 |
| **Vertical** | Industry-specific | Business plus the vertical pack, its compliance rules, KPIs and procedures |
| **Enterprise** | 50+ seats | SSO/SCIM, audit export, residency, custom packs, SLA, dedicated support |

Packaging maps to the pack architecture rather than to a feature matrix, which
keeps the price list stable as features ship.

---

## 3. Pricing shape

Three components, deliberately:

1. **Platform fee** per org per month — the brain: memory, tenancy, connectors,
   audit.
2. **Employee fee** per active AI employee — the unit the buyer intuitively
   compares to a salary, and the unit that grows with value delivered.
3. **Usage** — metered LLM and tool consumption above a generous included
   allowance, shown transparently in-product.

`billing_meters` already carries `soft_limit`, `hard_limit`, `truncated`, and
`meter_kind`; `billing_subscriptions` is provider-agnostic across Stripe and
Razorpay, which matters for India-first distribution.

### Rules that protect the model

- **Usage must never surprise.** A cost page and a budget alarm ship *before*
  usage-based billing does. A surprising invoice in month two costs more than
  the revenue it captured.
- **Do not price per message or per seat only.** Both misalign with the value,
  which is completed work.
- **The included allowance must be large enough** that the first two months are
  never a billing conversation.
- **Margin is a product metric.** Per-org gross margin after LLM and tool cost
  must be visible internally from day one; Langfuse already attributes cost per
  org.

---

## 4. Motion

**Land.** One painful, high-frequency workflow in one vertical. For Indian
brokerage: *inbound lead response on WhatsApp within sixty seconds, with the
full context of that buyer.* Value is visible in the first hour, and it is a
workflow where the alternative — a human watching a phone all day — is
obviously worse.

**Expand.** More connectors → more memory → more procedures → more employees →
higher autonomy. Each step increases switching cost **honestly**, because each
step increases the brain's coverage of the business.

**Defend.** Memory depth and the procedure library. Both are customer-specific
and non-portable. Neither is a feature a competitor can ship.

### Why land-with-one-workflow beats land-with-a-platform

An owner cannot evaluate "an operating brain". They can evaluate "did the lead
get answered in under a minute with the right context". Sell the second; the
first is what they discover they bought.

---

## 5. Onboarding as product

Onboarding is a pack (`onboarding.md`, `connectors.required/recommended`,
`org_onboarding`), not a hardcoded wizard.

Target first session:

1. Sign up, pick industry → the pack installs employees, entities, KPIs,
   compliance, workflow bindings.
2. Connect one high-signal source — inbox or WhatsApp.
3. Ingestion runs; `/brain` fills visibly. **The coverage map is the progress
   bar.**
4. Ask the first question, get a **cited** answer from the company's own data.
5. Approve the first plan and watch it execute.

**Time-to-first-cited-answer is the north-star onboarding metric.** Past ten
minutes, the funnel leaks. `core-b2b` declaring `connectors.required: []` is
deliberate — an org can reach step 4 without completing any OAuth.

---

## 6. Metrics

### Activation
- Time to first cited answer
- Connectors connected in week one (target ≥ 3)
- First plan approved and executed
- Brain coverage percentage at day 7

### Engagement
- Daily brief open rate
- Approvals per active user per week
- Share of inbound conversations touched by an AI employee
- Approvals from WhatsApp vs. dashboard (a proxy for the product fitting the
  buyer's real day)

### Quality
- **Draft edit rate** — falling means learning is working; the single best
  quality signal the product generates
- Approval rate per procedure — falling means the planner is drifting
- Escalation rate to work items — rising means confidence is miscalibrated
- Golden pass rate per pack; **honesty suite must be 100%, always**
- Critic block rate

### Value
- Hours saved: procedure runs × a measured manual baseline
- Response time before and after
- Commitments met on time before and after

### Commercial
- Employees per org, procedures per org, memory volume per org
- Gross margin per org after LLM and tool cost
- Net revenue retention driven by employee and pack expansion

### Trust
- Incidents per thousand autonomous actions
- Fabrication rate found in spot-checks — target zero
- Mean time to reconnect after a connector 401

---

## 7. Proof assets to build

1. **A published hours-saved methodology.** Claimed ROI without a stated method
   is discounted to zero by serious buyers. Publish the formula, including its
   assumptions.
2. **A per-customer monthly value report**, generated by the product itself from
   `audit_events` and procedure runs.
3. **A public evals and honesty page.** The `negativeOutput` technique — writing
   down the exact lie the system must not tell — is a differentiator at a moment
   when competitors demo simulated results. Publishing the suite is both a
   marketing asset and an ecosystem contribution (`20` §10).
4. **Two reference deployments per vertical** before scaling that vertical.
5. **A security one-pager** mapping RLS, the confirm gate, allowlists, audit and
   the sandbox to the OWASP LLM Top 10 — buyers above ten seats will ask.

---

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **Model costs outrun price** | Cost-aware routing, caching, per-org budgets, margin dashboard; LiteLLM makes model swaps cheap |
| **One bad autonomous action loses an account** | Autonomy ladder, risk classes, incident demotion, kill switch, confirm gate that never lifts on `pay`/`sign` |
| **Prompt-injection incident** | Tier-2 defences gated to land before autonomy above L2; authorisation already lives in the database, not the prompt |
| **Platform vendors ship the same thing** | Depth in vertical packs and company-specific memory — neither is something a horizontal vendor will build |
| **Vertical concentration in real estate** | `core-b2b` keeps the horizontal path open; pack architecture makes the second vertical cheap |
| **Trust lost through one fabricated answer** | The honesty doctrine, enforced by goldens, personas, and the crew synthesis prompt; never relaxed for a demo |
| **Usage-based billing surprise** | Cost page and budget alarms ship first; generous included allowance |
| **Key-person dependency on our side** | `BUILD_STATE.md`, this doc set, and decision logs written for a cold reader |
| **Regulatory shift in the primary market** | `compliance.yaml` per pack with `marketModules`; no KYC in memory by construction |
