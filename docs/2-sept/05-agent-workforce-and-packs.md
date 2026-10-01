# 05 — Agent Workforce and Packs

## 1. What an AI employee is

A persisted configuration, not a prompt. `ai_employees` (`001`, `011`):

| Column | Meaning | Enforcement |
|---|---|---|
| `name` | The identity users refer to | Mention matching in the router |
| `role` | Job description | Shapes routing and the system prompt |
| `persona JSONB` | Tone, constraints, refusals | Injected into the prompt |
| `tool_allowlist TEXT[]` | Exactly which tools it may call | **Enforced in `tool-executor.ts`** |
| `graph_id` | The agent graph it runs | Runtime selection |
| `status` | `provisioning \| active \| paused` | Paused employees stop routing immediately |

**The allowlist being a database column is the most important design choice in
the workforce model.** A jailbroken prompt still cannot call a tool that is not
in this array, because the check happens in the executor against a row, not
against text a model can be persuaded to ignore.

### The persona carries refusals, not just tone

Every shipped employee declares what it must never do:

| Employee | Persona |
|---|---|
| **Sarah** (Sales / front-of-house) | "Enthusiastic sales specialist. Qualify leads, draft follow-ups, **never invent pipeline amounts**." |
| **Emma** (Support / success) | "Empathetic support agent. Answer from memory and tickets. **Never invent order status**." |
| **Marcus** (Ops / analyst) | "Ops analyst. Sheets, Drive, and metrics.query only. **Never invent KPIs**." |
| **Aisha** (Buyer ISA) | "Qualify WhatsApp and portal leads. Filters first, then source timestamp. **Never invent inventory, price, or RERA**." |

The honesty doctrine reaches down into the roster. Each refusal names the
*specific* thing that employee would be tempted to fabricate — which is far more
effective than a generic "be truthful" instruction.

### Allowlists are narrow on purpose

```yaml
Sarah:   [gmail, whatsapp, hubspot, google-calendar, web_search]
Emma:    [gmail, whatsapp, google-calendar]
Marcus:  [google-sheets, google-drive, metrics, web_search]
Aisha:   [whatsapp, gmail, google-calendar, re, google-sheets]
```

Emma cannot touch HubSpot. Marcus cannot send WhatsApp. Sarah cannot read Drive.
The org-level union (`03` §5) means the *org* can do all of it — but each
employee's own turns stay inside its own list, which is what makes the roster
meaningful rather than decorative.

---

## 2. Routing — who answers?

`route-employee.ts` is **pure and isolate-safe**: no Node, no `pg`, no `fetch`.
It returns:

```ts
{ destination: 'employee' | 'human' | 'dispatch',
  employeeId, employeeName, employeeRole, employeePersona,
  toolAllowlist, confidence, reason, rosterKey, locked }
```

### The rules, in priority order

1. **Explicit mention wins.** `ask @name to …` (`ASK_TO_RE`) and bare
   `@mention` (`AT_MENTION_RE`).
2. **Greetings short-circuit.** `GREETING_RE` matches hi / hello / hey / yo /
   hola / **namaste** / good morning / thanks / cheers. No crew, no tools, no
   model spend on "hi". A surprising fraction of inbound is exactly this.
3. **Emergencies route to a human.** `EMERGENCY_RE` matches gas leak, carbon
   monoxide, CO alarm, burst pipe, water leak, flood, fire, smoke, sparks, no
   heat, no power, electrical fire, after-hours emergency. These go to
   `human`/`dispatch` and **never** to an ISA or a sales employee.
4. **Roster-key weighting.** `sales | support | ops | research | finance |
   dispatch | other`, matched by weighted keyword patterns against the
   employee's role — **not by hardcoded employee ids**.
5. **`preferredEmployeeId`** is a hint from the prior assignee or a webhook
   default, documented explicitly as **"NOT a name lock"**.
6. **Always solo.** A single request never fans out. Crews are explicit and
   separate.
7. **No confident owner → human.** Never a guess.

Rule 3 deserves emphasis: a property-management emergency reaching a sales
qualification flow is not a routing inconvenience, it is a habitability
incident. Encoding it as a pattern in a pure, tested module — rather than hoping
a model notices — is the right level of paranoia.

---

## 3. Crews — multi-agent under contract

`CrewWorkflow` (166 lines) with `crew-contract.ts`:

- **`MAX_CREW_SPAWN = 3`**, enforced by `capCrewSpecialists()`. A hard cap.
  Unbounded agent fan-out is how token budgets die and how three agents
  confidently contradict each other.
- **Deterministic child ids**: `crewChildWorkflowId(parentId, index, employeeId,
  employeeName)`, sanitised and length-capped, so a Temporal replay addresses
  the same children.
- **A synthesis contract**, not a conversation. `buildCrewSynthesisPrompt()`
  instructs the manager to combine specialist reports, **not** redo their tool
  work, **say so honestly if a specialist hit `notConnected`**, and never
  mention Temporal, crews, or internal routing.

This is deliberately **not** an open agent swarm. Free-form inter-agent chat
burns tokens and produces confident nonsense; a declared output per member with
a synthesis step produces an answer.

---

## 4. Skills

Named, reusable competencies mounted into the agent runtime, sitting between
"prompt" and "tool": a skill knows *how* to accomplish something with tools the
employee already has. Managed on `/skills`, and guarded by
`infra/evals/skill-playbook.yaml`.

---

## 5. Packs — a vertical is a bundle, not a fork

```
packs/<pack-name>/
  pack.yaml        manifest: id, name, version, markets, live, entities,
                   connectors {required, recommended, optional}, employees,
                   workflows, kpis, compliance, onboardingCopy
  employees/       one YAML per employee
  entities/        the domain's entity types
  workflows/map.yaml   trigger → temporalWorkflowName bindings
  kpis.yaml        the metrics registry for this industry
  compliance.yaml  jurisdiction rules, retention, disclosures
  goldens/         eval cases that must pass
  onboarding.md    what to ask the customer during setup
  README.md
```

### The manifest, concretely (`core-b2b`)

```yaml
id: core-b2b
version: 1.0.0
markets: [IN, US, AE, GB]
live: true
entities: [contact, company, deal, ticket, document, event, invoice]
connectors:
  required: []
  recommended: [gmail, whatsapp, google-calendar]
  optional: [hubspot, google-sheets, google-drive, slack, stripe, razorpay, web_search]
workflows:
  - temporalWorkflowName: OwnerBriefingWorkflow
    triggers: [daily]
  - temporalWorkflowName: StaleChaseWorkflow
    triggers: [scheduled]
kpis:
  - id: core.inquiries_unworked
    insightCopy: Unworked inquiries waiting more than 2 hours.
    recommendedAction: Chase threads with no assistant reply.
compliance:
  extraConfirmClasses: [send, pay, sign]
  bannedPhrases: [guaranteed returns, assured returns]
  blockedDataClasses: [kyc, pan, aadhaar]
  marketModules: [GDPR, DPDP]
```

Four things a pack controls that would otherwise be platform code:

1. **`connectors.required` vs `recommended` vs `optional`** — onboarding is
   data. `required: []` for `core-b2b` means an org can start with nothing
   connected and still get value.
2. **`workflows[].triggers`** — trigger binding without a code change.
   `re-brokerage-in` binds `inquiry.book_showing` and `calendar.conflict` to
   `ShowingScheduleWorkflow`, and `pm.charge.due` to `RentReminderWorkflow`.
3. **`kpis[]`** — each KPI carries `insightCopy` and `recommendedAction`, so an
   insight card names an executable workflow rather than offering advice.
4. **`compliance`** — `extraConfirmClasses` widens the confirm gate;
   `bannedPhrases` (["guaranteed returns", "assured returns"] is securities
   compliance in India, not style); `blockedDataClasses` keeps KYC out of
   memory; `marketModules` selects GDPR/DPDP behaviour.

### Installation

`InstallPackWorkflow` + `packs/install-pack.ts` + `015_packs`. `org_packs.status`
is CHECK-constrained through `pending → installing → installed | failed →
uninstalling → disabled | uninstalled`. `packs.extends` supports inheritance;
`org_packs.is_primary` marks the vertical when several are installed.

Explicit `installing`/`uninstalling` states mean a partially applied pack is
visible rather than looking installed-but-broken.

### Shipped packs

| Pack | Employees | Notes |
|---|---|---|
| `core-b2b` | Sarah, Emma, Marcus | The horizontal baseline every org gets. Markets IN/US/AE/GB. |
| `re-brokerage-in` | Aisha (Buyer ISA), Kabir, Meera | Indian residential brokerage. `MARKETS.md` for market behaviour; RERA compliance; `rera_cache` for registry lookups. |
| `real-estate-pm` | — | RFC written, not built. Rent cycles, maintenance, owner statements, renewals, inspections. |

### Pack design rules

1. **A pack may not require a platform code change.** If it does, the platform
   is missing a primitive — build the primitive.
2. **Every pack ships goldens.** A pack with no evals cannot be installed.
3. **Compliance is per pack** because jurisdictions differ; the enforcement
   engine is platform-level.
4. **Packs compose:** `core-b2b` plus a vertical pack, never a vertical alone.
5. **Employees declare narrow allowlists**, and every persona names what it must
   never invent.

---

## 6. Pack candidates, ranked

| Pack | Why | Effort |
|---|---|---|
| `real-estate-pm` | RFC done, `pm_leases`/`pm_charges` and `RentReminderWorkflow` already exist, recurring-revenue customers | Low |
| `re-brokerage-commercial` | Same motion, larger deals, longer cycles | Low |
| `professional-services` | Agencies and consultancies — proposals, retainers, chase, reporting | Medium |
| `education-institute` | Admissions funnels behave structurally like brokerage funnels | Medium |
| `logistics-broker` | Quote → booking → exception management | Medium |
| `field-services` | Dispatch, job cards, invoicing; the emergency routing already exists | Medium |
| `healthcare-clinic` | High repetition, appointment-driven — but needs real compliance depth first | High |

---

## 7. The employee lifecycle we still owe customers

| Stage | Today | Needed |
|---|---|---|
| **Hire** | Create and configure | Pick a role from a pack, see exactly what it will and will not do, give it credentials, run a trial task before it goes live |
| **Train** | Nothing | Corrections become `employee_memory`; `ask_ai_feedback` and `agent_plans.feedback` already collect the signal and nothing consumes it |
| **Review** | `/api/employees/stats` | A weekly scorecard: tasks completed, approval rate, **edit rate**, escalations, cost |
| **Promote** | Nothing | Raise the autonomy level per procedure on evidence (`04` §6) |
| **Fire** | `status: paused`, delete | Clean thread reassignment plus an audit note — `work_items.assignee_employee_id` is already `ON DELETE SET NULL`, so work survives |

The review and promotion surfaces are what make the "AI employee" claim credible
to a buyer comparing against a salary. An employee you cannot appraise is not an
employee.
