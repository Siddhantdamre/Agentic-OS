# 03 — Industry operating system (the pack model)

The way Darex covers “all B2B” without becoming 40 codebases is the
**vertical pack**. This document is the pack spec.

---

## 1. Definition

A **pack** is a versioned, installable overlay on the Brain OS:

```
pack = employees + entity schemas + connectors (enabled) + workflows
     + skills/playbooks + KPIs + compliance gates + onboarding copy
```

The kernel (auth, RLS, Nango, Temporal, atomic-agent, confirm bus,
memory API) does not change when a pack is installed.

An org may run **one primary pack** plus optional add-on packs
(e.g. Brokerage + Property Management, or Agency + E-commerce). Packs
must not fight over the same `entity_type` names; use namespaced types
(`re.listing`, `pm.work_order`, `ag.retainer`).

---

## 2. Generic B2B core (installed for every org)

Before any industry pack, every org gets **Core B2B**:

### Employees (seed; owner can rename)

| Default name | Role | Typical allowlist |
|--------------|------|-------------------|
| Sarah | Sales / front-of-house | gmail, calendar, crm, whatsapp, web_search |
| Emma | Support / success | gmail, tickets, whatsapp, kb, calendar |
| Marcus | Ops / analyst | sheets, drive, db_query, sandbox, web |

These already exist as a roster prototype. Core pack **version 2**
adds: Finance assistant (read invoices, payment links — confirm to send),
and Research assistant (web + docs + cite).

### Core entities

`contact`, `company`, `deal`, `ticket`, `document`, `event`, `invoice`
(lightweight — even if CRM is the real SoR, Darex keeps a projection).

### Core workflows

- Inbound message → retrieve memory → reply or needs_attention.
- Ask AI simple / complex.
- Stale deal / ticket chase (scheduled).
- Daily owner briefing.
- “Draft then confirm then send” for email/WhatsApp.

### Core connectors (P0)

WhatsApp, Gmail, Calendar, Drive/Docs/Sheets, one CRM (HubSpot already;
Salesforce/Zoho as P1), Slack, Stripe or Razorpay, web_search.

If the org connects nothing, the OS still answers from memory + SQL +
web, and **says** what is not connected.

---

## 3. Pack file layout (proposed)

```
packs/
  core-b2b/
    pack.yaml
    employees/*.yaml
    entities/*.json
    workflows/*.ts          # Temporal workflow names + trigger map
    skills/*/SKILL.md
    kpis.yaml
    compliance.yaml
    onboarding.md
  real-estate-brokerage/
    ...
  real-estate-pm/
    ...
  real-estate-cre/
    ...
  agencies/
  saas-gtm/
  wholesale/
  recruiting/
```

`pack.yaml` sketch:

```yaml
id: real-estate-brokerage
version: 1.0.0
extends: core-b2b
markets: [IN, US, AE, GB]
entities: [re.listing, re.inquiry, re.showing, re.offer, re.closing]
connectors:
  required: []          # never block onboarding
  recommended: [gmail, google-calendar, whatsapp, google-business-profile]
  optional: [follow-up-boss, kvcore, docusign, meta-ads]
confirm_extra:
  - class: sign
  - class: publish_listing
  - class: price_change
kpis:
  - inquiries_24h
  - showings_this_week
  - listing_days_on_market
  - offer_to_close
```

Installing a pack is a Temporal workflow: seed employees if missing,
register entity schemas, enable connector recommendations in UI, attach
skills to the atomic-agent org profile, register scheduled workflows.
It is **idempotent**. Uninstall disables schedules and hides UI; it does
not delete conversations.

---

## 4. Entity schema rules

Every pack entity is JSON Schema stored in DB:

- Always includes `org_id` in the row; schema describes the payload.
- Foreign keys to `contacts` / `work_items` where possible.
- `source` + `source_ref` (e.g. MLS number, HubSpot id) for idempotent upsert.
- `embedding` optional; large text lives in memory tables.
- No PII in logs; redact in `channel_logs`.

Example: `re.listing` (see `05-real-estate-vertical.md` for full fields)
must store **asking price as received from source**, never as a model
guess. If source is stale, status is `stale` and the agent must say so.

---

## 5. Employee vs skill vs tool vs workflow

Confusion here creates spaghetti. Freeze the vocabulary:

| Concept | What it is | Example |
|---------|------------|---------|
| **Tool** | Atomic MCP action | `gmail.send_email`, `re.listings.search` |
| **Skill / playbook** | SOP the model reads: when to call which tool | `gmail-playbook`, `re-showing-coordinator` |
| **Employee** | Persona + allowlist + memory scope + default skills | “Aisha — Leasing coordinator” |
| **Workflow** | Durable Temporal graph | `ShowingScheduleWorkflow` |
| **Plan** | LLM-generated, human-confirmed, then executed | “Email these 3 buyers + update CRM” |
| **Pack** | Bundle of the above | `real-estate-pm` |

Adding a realtor “Listing agent” is **zero kernel changes** (existing
rule). It is a YAML employee + skills + allowlist.

---

## 6. Onboarding: business type becomes pack install

Today’s wizard: name → team size → business type → channels.

Future: business type maps to pack(s):

| Wizard choice | Packs installed |
|---------------|-----------------|
| Agency / studio | `core-b2b` + `agencies` |
| SaaS / software | `core-b2b` + `saas-gtm` |
| Real estate — brokerage | `core-b2b` + `real-estate-brokerage` |
| Real estate — property mgmt | `core-b2b` + `real-estate-pm` |
| Real estate — developer | `core-b2b` + `real-estate-developer` |
| E-commerce | `core-b2b` + `ecommerce` |
| Professional services | `core-b2b` + `prof-services` |
| Other / not sure | `core-b2b` only |

Channels still create `channels` rows. Pack then **recommends**
connectors with setup URLs, never marks them connected.

Warm-up screen (spec Phase 9) should show real progress: employees
seeded, pack installed, connectors waiting, first memory backfill
queued.

---

## 7. KPI and Insight contract

Packs do not write React charts. They register **metrics**:

```yaml
- id: re.showings_completed
  sql: |  # or semantic metric name
    select count(*) from work_items
    where org_id = $org and type = 're.showing' and status = 'done'
      and updated_at >= $from
  insight_copy: "Showings completed"
  recommended_action: enqueue ShowingFollowupWorkflow
```

Insight engine (Phase 7) evaluates metrics on a schedule, produces
cards, and the **Review Action** button starts a **named workflow**,
never a free-form agent with production credentials and no plan.

---

## 8. Compliance as data, not as vibes

`compliance.yaml` per pack lists:

- extra confirm classes,
- banned phrases (fair housing, guaranteed returns, medical claims),
- required disclosures,
- data classes that cannot be sent to web_search,
- retention (listing inquiries vs tax records),
- market-specific modules (`IN-RERA`, `US-FairHousing`, `GDPR`, `DPDP`).

The executor / planner loads these as **hard constraints** into the
grounded user message and as validators after the model drafts text.
Validators are code, not “please don’t”.

---

## 9. Multi-pack orgs

A developer who also brokers: `real-estate-developer` + `real-estate-brokerage`.

Rules:

- Shared contacts.
- Separate work_item types.
- Employees can be allowed both packs’ tools.
- Memory retrieval is filtered by entity type unless query is global.
- Billing: primary pack + add-on.

Conflict resolution: if two packs define `daily_briefing`, merge
sections; do not run two duplicate Temporal crons without a combiner.

---

## 10. Marketplace later (Phase 15+)

Third parties may publish packs/skills **only** if:

- they run in our executor (no arbitrary outbound from sandbox),
- they cannot read raw tokens,
- they pass eval-runner,
- tenant admin must install,
- we review compliance.yaml.

Until then, only first-party packs. Do not build a public skill store
before memory, confirm, and audit are solid.

---

## 11. Pack quality bar (exit criteria to call a vertical “live”)

A pack is live when:

1. Onboarding installs it idempotently.
2. At least 3 employees with distinct allowlists.
3. At least 5 golden conversations pass eval-runner.
4. Disconnected recommended connectors produce honest replies.
5. At least 2 durable workflows (not just chat).
6. Memory write-back stores the vertical’s primary entity.
7. Compliance validator catches at least one known-bad draft in tests.
8. Docs: pack README + connector list + “what we never invent”.

Real estate brokerage is the first pack that must clear this bar.
Other industries in `04-b2b-verticals.md` are designed to the same bar,
phased by `13-phased-roadmap.md`.

---

## 12. Alternatives in the world (instead of “vertical packs”)

**What Darex does:** installable YAML overlay (employees + entities +
workflows + skills + KPIs + compliance) on one kernel. Not 40 apps.

| # | Alternative | Why it can be better | Why we still do ours | Refs |
|---|-------------|----------------------|----------------------|------|
| 1 | **Odoo modules / Odoo Industry** | Real accounting, inventory, manufacturing; huge app store | We sit *above* Odoo as SoR via Nango, not replace ERP | [github.com/odoo/odoo](https://github.com/odoo/odoo), Odoo 18 industry apps |
| 2 | **ERPNext / Frappe** (Python, GPL) | Cleaner OSS ERP; domain modules (healthcare, education, manufacturing) | Same: integrate, do not become ERPNext | [frappe/erpnext](https://github.com/frappe/erpnext) |
| 3 | **Salesforce Industry Clouds** (Financial, Health, RE Cloud) | Deep objects, compliance, AppExchange | Closed; we would be a thin Einstein wrapper; no WhatsApp-first IN | Salesforce Industry Cloud docs |
| 4 | **Twenty CRM custom objects** | Modern OSS Salesforce; GraphQL; AI chat with CRM | CRM is a connector, not the OS | [twentyhq/twenty](https://github.com/twentyhq/twenty) (~25k★) |
| 5 | **Fork the product per vertical** (separate RE SaaS) | Faster realtor demo; simpler schema | Kills the OS thesis; every bug fixed 4 times | Anti-pattern; see `00` non-goals |

**Five things to steal anyway**

1. Odoo: pack.yaml = module manifest (`depends`, `data`, views).
2. ERPNext: DocType JSON ≈ our `entities/*.json`.
3. Salesforce: record types + validation rules ≈ compliance.yaml **as code**.
4. Twenty: custom objects without migrating Postgres schema every pack — JSON schema + projection tables.
5. Quality bar §11 is our AppExchange review. Do not ship a pack that fails it.

Article: “Open Source CRM & ERP 2026” (Odoo, ERPNext, Twenty, SuiteCRM, EspoCRM).

### Open-source GitHub — this file only (packs / ERP / CRM modules)

Cal.com / Documenso → `05`. Medusa / Saleor → `04`. Chatwoot → `11`. Odoo is listed **only here**.

| Repo | Similar to | We take |
|------|------------|---------|
| [odoo/odoo](https://github.com/odoo/odoo) | Industry modules on one kernel | `pack.yaml` manifest (`depends`, data, views) |
| [frappe/erpnext](https://github.com/frappe/erpnext) | DocTypes + workflows per domain | `entities/*.json` |
| [frappe/frappe](https://github.com/frappe/frappe) | Framework under ERPNext | Metadata-driven forms, not PHP/Python runtime |
| [twentyhq/twenty](https://github.com/twentyhq/twenty) | Custom objects, modern CRM | Projection tables, not schema fork |
| [salesagility/SuiteCRM](https://github.com/salesagility/SuiteCRM) | Classic OSS CRM modules | Entity names for core pack |
| [espocrm/espocrm](https://github.com/espocrm/espocrm) | Self-host CRM + metadata | Pack metadata, not PHP runtime |
| [Dolibarr/dolibarr](https://github.com/Dolibarr/dolibarr) | SMB ERP (invoices, CRM, stock) | Core-pack object list |
| [akaunting/akaunting](https://github.com/akaunting/akaunting) | OSS accounting | Books pack entities; Tally/Zoho stay SoR |
| [invoiceninja/invoiceninja](https://github.com/invoiceninja/invoiceninja) | Invoicing app | Invoice projection, not a PSP |
| [budibase/budibase](https://github.com/Budibase/budibase) | Internal apps from tables | Pack admin screens later |
| [appsmithorg/appsmith](https://github.com/appsmithorg/appsmith) | Same internal-app idea | WATCH; dashboard stays Next.js |
| [nocodb/nocodb](https://github.com/nocodb/nocodb) | Airtable-on-Postgres | Sheets wedge UI, not a second SoR |
| [baserow/baserow](https://github.com/bram2w/baserow) | Same | Same |
| [directus/directus](https://github.com/directus/directus) | Headless CMS + ACL | Pack content types |

Cal.com / Documenso → `05`. Medusa / Saleor → `04`. Chatwoot → `11`.
