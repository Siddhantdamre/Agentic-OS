# 01 — Product Overview

## 1. The product in one line

**Darex is the operating brain of a business: AI employees that share one
memory, one permission model, and one action bus across every tool the company
already uses.**

---

## 2. The problem, stated precisely

Small and mid-sized businesses do not lack software. They suffer from two
compounding failures:

### 2.1 Context fragmentation

The answer to "what did we promise this customer?" is distributed across an
email thread, a WhatsApp chat, a CRM note, a spreadsheet, and one person's
memory. No system holds the union. The cost is invisible because it is paid in
small increments: every question re-answered, every context re-assembled, every
new hire re-taught.

The sharpest version: **when a person leaves, their context leaves with them.**
A brokerage that loses a senior agent loses the history of forty relationships,
and there is no system that can hand it to their replacement.

### 2.2 Execution leakage

The work that *follows* an answer — send the quote, book the visit, update the
CRM, remind them Friday — is manual, repetitive, and drops silently. Nobody
notices a follow-up that did not happen. There is no error message for a
forgotten commitment.

### 2.3 Why existing tools do not fix it

| Category | Why it falls short |
|---|---|
| CRM | Records state, executes nothing, and is only as good as the data someone remembers to enter |
| Inbox / chat tools | Move messages; hold no memory across channels |
| Automation (Zapier, n8n) | Deterministic triggers only; cannot handle "reply appropriately to this ambiguous message" |
| In-app copilots | Live inside one product; cannot book the calendar *and* update the CRM *and* remember it next month |
| Hiring a coordinator | Cost scales linearly; context does not accumulate anywhere durable |

---

## 3. What Darex does

Six capabilities in a loop:

1. **Perceives.** Eight inbound webhook routes (WhatsApp, owner-WhatsApp,
   Chatwoot inbox, Gmail, Instagram, SMS, outbound receipts, billing), a public
   web widget, scheduled connector syncs with cursors, and document ingestion.
2. **Remembers.** Four hybrid-indexed memory tiers (org, employee, entity,
   conversation) plus a typed relation graph, all RLS-scoped, all with
   provenance and citations back to the source.
3. **Reasons.** A classifier decides simple answer versus multi-step job.
   Multi-step jobs become an explicit, inspectable plan with named tools.
4. **Confirms.** Anything irreversible — `send`, `pay`, `sign`, `publish`,
   `delete` — waits for human approval, and the approval can happen on WhatsApp.
5. **Acts.** Approved plans execute as durable Temporal workflows against 50+
   real tool executors, with per-step results and honest failures.
6. **Learns.** Every run is traced, scored against goldens, and written back to
   memory so the next run starts warmer.

---

## 4. Who buys it

| Segment | The specific pain | Entry pack |
|---|---|---|
| **Real-estate brokerages (India-first)** | Lead response speed decides the commission; WhatsApp is the channel; inventory and site visits are the workflow; RERA compliance is non-optional | `re-brokerage-in` |
| **Property management firms** | Rent reminders, maintenance tickets, owner reporting — pure repetition on a monthly cycle | `real-estate-pm` |
| **Agencies and professional services** | Client communication, proposals, follow-up chase, reporting | `core-b2b` |
| **SMB operations teams generally** | Inbox triage, CRM hygiene, scheduling, reporting | `core-b2b` |

### The buyer, and what that constrains

Almost always the **owner or head of operations** — not IT. Consequences that
shape every product decision:

- Onboarding must be self-serve; there is no implementation team.
- Value must be visible in the first session, not the first quarter.
- Nothing may require a developer, ever.
- **The buyer lives on their phone.** An approval that needs a laptop does not
  happen. This is why owner-WhatsApp approval exists and why the mobile brief is
  on the roadmap.
- Trust is personal. This is their business's inbox and their money.

---

## 5. Why "AI employee" and not "chatbot" or "copilot"

| | Chatbot | Copilot | **Darex AI employee** |
|---|---|---|---|
| Scope | One conversation | One application | The whole tool stack |
| Memory | Session | Session or per-file | Org / employee / entity / conversation, durable |
| Action | None | Suggests; human copies | Executes, with a confirm gate on irreversible steps |
| Identity | Generic | Generic | A named employee with a role, persona, and enforced tool allowlist |
| Reliability | Best effort | Best effort | Temporal-durable, resumable, bounded retries |
| Accountability | None | None | `audit_events` with approver, model, prompt hash, trace id |
| Restraint | None | None | Quiet hours, fan-out caps, typed cancel reasons, a critic |

**The framing is a product constraint, not marketing.** An employee has a name,
a job description, limited permissions, a manager who approves risky actions,
and a record of what they did. Each maps to a real system:

| Employee concept | Implementation |
|---|---|
| Name and job description | `ai_employees.name`, `.role`, `.persona JSONB` |
| Limited permissions | `ai_employees.tool_allowlist TEXT[]`, enforced in `tool-executor.ts` |
| A manager who approves | The confirm gate, `audit_events.approver_user_id` |
| A record of what they did | `audit_events`, `work_events`, Langfuse traces |
| Being told what not to do | Persona refusals: *"never invent pipeline amounts"* |
| Being paused or fired | `status: provisioning \| active \| paused`, with thread reassignment |

---

## 6. Product surfaces

| Surface | What it is for |
|---|---|
| **Ask AI** | The primary surface. Question in; grounded cited answer or an approvable plan out, streamed. |
| **Employees** | The roster: create, configure role, persona, skills, tool allowlist. |
| **Brain** | Inspect what the company's memory actually contains; search it; see citations. |
| **Conversations / Inbox** | Unified multi-channel threads with agent replies. |
| **Connectors / Integrations** | OAuth and BYOK connection management with honest status. |
| **Plans** | Pending and executed plans, per step, with results. |
| **Work items** | The human queue for anything an agent escalated. |
| **Insight / Analytics** | Computed metrics with a named executable action. |
| **Skills** | Reusable competencies mounted into the agent runtime. |
| **Listings / Inquiries / Showings / Rent reminders** | Vertical surfaces installed by real-estate packs. |
| **Settings / Billing / Audit / DSR** | Governance and commercial surfaces. |

---

## 7. What makes it defensible

1. **Memory compounds.** Every month of use makes the brain more valuable and
   more expensive to replace. Features are copyable; a company's own accumulated
   context is not. This is the moat.
2. **Packs, not forks.** A vertical is a YAML bundle — employees, entities,
   workflows, KPIs, compliance, goldens, onboarding — installed by
   `InstallPackWorkflow`. Days, not a product fork.
3. **Honesty as architecture.** A disconnected connector returns
   `{status:'error', connected:false, setupUrl:'/connectors'}`, enforced by
   goldens that write down the exact plausible lie. Products that fake it get
   one trust failure and churn.
4. **Durable execution.** A multi-step job survives restarts, rate limits, and
   hours-long human approval. Prompt-loop competitors cannot make this promise.
5. **Tenancy from day one.** RLS with `FORCE` and `WITH CHECK` on every org
   policy, proven with a two-org test including vector search. Retrofitting
   tenancy into an AI product is close to a rewrite.
6. **The confirm gate is a feature, not friction.** It is the reason an owner is
   willing to connect their inbox and their payment provider at all.

---

## 8. The competitive frame

The buyer does not compare Darex to another SaaS tool. They compare it to
**hiring another coordinator**. That sets the price ceiling and the proof
burden — and it means the metrics that matter are hours saved, commitments met,
and response time, not seats or messages.

Against the plausible alternatives:

| Alternative | Where we win | Where they win |
|---|---|---|
| A horizontal AI assistant | Vertical depth, real actions, tenancy, memory | Brand, breadth, price |
| A vertical SaaS adding AI | Cross-tool reach; we are not confined to one system of record | Existing distribution and data |
| Automation platforms | Judgement on ambiguous input; memory | Deterministic reliability, huge connector catalogues |
| Doing nothing | Everything, eventually | Zero cost, zero risk today |

"Doing nothing" is the real competitor for an SMB, which is why time-to-first-
cited-answer matters more than any feature comparison.

---

## 9. Non-goals

- Not a general chatbot playground — every capability ties to org data.
- Not a model lab — models route through LiteLLM and are replaceable.
- Not an IT-led enterprise deployment product (yet) — see roadmap Phase D/F.
- **Not autonomous by default.** Confirm-before-irreversible is a permanent
  stance, not a beta safety rail that autonomy will one day remove. The autonomy
  ladder raises levels per procedure on evidence; it never removes the gate on
  `pay` and `sign`.
- Not a system of record replacement — Darex reads and writes the customer's
  existing systems rather than asking them to migrate.
