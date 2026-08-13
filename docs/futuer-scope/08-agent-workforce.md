# 08 — Agent workforce (employees, skills, multi-agent)

Darex’s product is **AI employees**, not a single chatbot. This file
is how the workforce scales from Sarah/Emma/Marcus to a company brain
with specialists, without forking the runtime.

---

## 1. Frozen vocabulary

See also `03`. Recap:

- **Employee** — persona, allowlist, skills, memory scope, channels.
- **Skill** — `SKILL.md` playbook mounted into atomic-agent.
- **Tool** — MCP action.
- **Router** — chooses employee(s) for a work item.
- **Manager agent** — optional meta-employee that only plans/assigns.
- **Critic** — read-only reviewer before send/publish/sign.
- **Human** — owner/admin; always can takeover inbox.

Rule 7 from the original spec still holds: **never hardcode a role
into shared infra**. New employee = config.

---

## 2. Today vs OS

| Today | OS |
|-------|----|
| 3 seeded employees | Pack-seeded + custom |
| Allowlist union bug was fixed | Keep union + connected channels + core |
| 11 SKILL.md **not mounted** | Dockerfile COPY + per-org enable |
| One agent turn on WhatsApp | Router → employee → maybe critic → send |
| Ask AI is “the org” | Ask AI can @mention an employee or “auto” |
| No eval | Golden conversations per employee |

---

## 3. Core roster (every org)

| Id | Default name | Mission | Default skills |
|----|--------------|---------|----------------|
| `sales` | Sarah | Pipeline, outreach drafts, qualify | gmail, calendar, crm, whatsapp |
| `support` | Emma | Tickets, SOP answers, escalate | gmail, tickets, kb, whatsapp |
| `ops` | Marcus | Numbers, sheets, sandbox analysis | sheets, drive, metrics, sandbox |
| `research` | (new) | Cite web + docs | web, drive, notion |
| `finance` | (new) | Invoices, payment links, **confirm pay** | stripe/razorpay read, books read |

Owner may disable finance. Research is read-heavy.

---

## 4. Vertical rosters (seeds)

### Real estate brokerage

`re.listing_coord`, `re.isa`, `re.showing_coord`, `re.tc`,
`re.marketing`, `re.briefer`.

### Property management

`pm.leasing`, `pm.resident`, `pm.dispatch`, `pm.owner_rel`.

### Agency

`ag.am`, `ag.media`, `ag.reporting`, `ag.creative_ops`.

### SaaS

`saas.sdr`, `saas.ae_assist`, `saas.csm`, `saas.support`.

### E-com

`ecom.cx`, `ecom.ops`, `ecom.retention`.

Full jobs are in `04`/`05`. Each seed YAML includes example utterances
for the router.

---

## 5. Skill system (make the 11 playbooks real, then grow)

**Immediate:** copy `infra/docker/atomic-agent/custom-skills/**` into
the atomic-agent image and verify `gmail-playbook` actually changes
behavior.

**Skill format** (already started):

```yaml
name: re-isa-qualify
requires_tools: [mcp.darex.whatsapp_send, mcp.darex.listings_search]
dangerous: false
```

Rules inside SKILL.md: when to call tools, when to escalate, never
invent inventory, citation format.

**Skill layers:**

1. Core playbooks (gmail, calendar, sheets, drive, notion, nango,
   payments, sales-crm, support-tickets, ecommerce) — exist on disk.
2. Vertical playbooks (`re-isa`, `re-fair-housing`, `pm-emergency`).
3. Org playbooks — owner-uploaded SOP (markdown) indexed in memory
   and optionally promoted to a skill after review.

Version skills. Eval-runner blocks deploy if golden set regresses.

---

## 6. Routing

Classifier today: simple vs complex. Future **also**:

```
route(work_item) -> { employeeId, confidence, reason }
```

Signals: channel, pack, keywords, entity type, last assignee, SLA,
language, emergency flags (PM leak).

Low confidence → Emma-like support **or** needs_attention, per org
setting. Do not round-robin blindly.

Ask AI: if user says “ask Marcus to …”, lock employee. Else auto.

---

## 7. Multi-agent patterns (use sparingly)

atomic-agent is one loop. Multi-agent is **Temporal orchestration of
multiple loops**, not a new framework.

| Pattern | When | How |
|---------|------|-----|
| Solo | Simple Q, inbound FAQ | One employee |
| Plan-confirm | Complex / irreversible | Existing Ask AI path |
| Planner → specialists | “Launch this listing” | Manager plan with steps tagged to employees; confirm once |
| Critic gate | send/publish/sign | Second LiteLLM JSON: policy check; fail → revise or human |
| Research then act | “Comps for this asset” | Research employee read-only, then ISA drafts |
| Parallel | Independent plan steps | Already live (`stageSteps`) |

Do **not** spawn 8 agents per WhatsApp “hi”. Cost and latency will
kill the product. Default is solo + memory.

---

## 8. Human-in-the-loop

Classes that always confirm (unless org lowers — never for `pay`/`sign`
without explicit owner setting and audit):

- `send` to a new counterparty on first message optional; org toggle.
- `publish` ads, GBP, listing portals.
- `pay`, `delete`, `sign`.
- Price changes, inventory sold/rented flags.
- Anything critic flags (fair housing, RERA missing).

Webhook auto-reply: allowed for `read` + FAQ from memory. If the
draft includes a price or legal promise, **pause** to needs_attention
even if Ask AI would have shown a plan card.

Inbox takeover: human reply disables auto for that thread (TTL or
until “resume AI”).

---

## 9. Memory scope per employee

Employees can read org memory. They write:

- employee_memory (how they work),
- entity_memory (facts about contacts/listings),
- not other employees’ private scratch.

A listing coordinator should not send WhatsApp if allowlist omits it.
Allowlist is the real isolation; prompts are not.

---

## 10. Evaluation and quality

Per employee + pack:

- Golden transcripts (see `05` §11).
- Online: thumbs in UI, CSAT if collected, tool error rate, confirm
  reject rate (high reject = bad planner).
- Langfuse: cost per work item, latency, traces.
- Drift: weekly job compares recent summaries vs SOP embeddings.

Promotion: a successful confirmed plan can be saved as an org skill
(“do this again”) — human names it.

---

## 11. Computer-use / browser (last resort)

Some SoRs have no API (old Tally, portal dashboards). Pattern:

- Playwright in `browser-runner` sandbox, org credentials in vault,
  confirm every write, video/trace to audit, domain allowlist.
- Prefer CSV export the owner uploads.

Do not advertise “we log into anything” as the default muscle.

---

## 12. What “max agent things” means here

Use the **maximum of the Darex agent stack**, not a zoo of new
orchestrators:

- atomic-agent for tool loops,
- LiteLLM for JSON (classify, plan, critic, memory extract),
- Temporal for durable multi-step and HITL,
- MCP `mcp.darex.*` for all actions,
- skills as SOPs,
- employees as config,
- Langfuse as the learning tape.

If a proposal adds LangGraph, CrewAI, AutoGen, or a second MCP
bridge per vertical: reject. The workforce is configuration on this
stack.
