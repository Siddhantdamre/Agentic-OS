# 23 — Design Spec: Procedures and the Playbook Compiler

> Status: **specification, partially seeded.** `org_playbook_promotions` exists
> and stores promoted plans; generalisation does not. This is `09` Tier 1.3 —
> the feature that takes us out of the loop for every customer's every workflow.

---

## 1. Problem statement

A company's real knowledge is the sequence of moves its best operator makes
without thinking. Today those sequences are Temporal workflows **we** write.
Fifteen of them exist. Every new customer workflow is an engineering ticket.

That does not scale in two directions at once: we cannot add verticals fast
enough, and we cannot serve the long tail of per-customer variation inside a
vertical. Two brokerages in the same city chase leads differently, and both are
right about their own business.

### What already exists

`org_playbook_promotions` (`020`):

```sql
playbook_id  TEXT   CHECK (playbook_id LIKE 'org.%')
name         TEXT   CHECK (char_length(btrim(name)) BETWEEN 3 AND 80)
plan_id      UUID   REFERENCES agent_plans(id)
steps        JSONB
summary      TEXT
named_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT
UNIQUE (org_id, playbook_id)
```

A user names a plan that worked and it is stored. The namespace, the uniqueness,
and the authorship provenance are all correct. **What is missing is that
`steps` holds the concrete payloads of one run** — "email priya@example.com
about unit 402" — not a reusable procedure.

Replaying it verbatim emails Priya again. It is a recording, not a program.

---

## 2. The procedure object

```sql
CREATE TABLE IF NOT EXISTS procedures (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID REFERENCES orgs(id) ON DELETE CASCADE,  -- NULL = pack-provided
  procedure_key   TEXT NOT NULL,        -- 'org.*' or 'pack.*'
  version         INTEGER NOT NULL DEFAULT 1,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'draft',
                  -- draft | active | paused | archived
  trigger         JSONB NOT NULL DEFAULT '{}'::jsonb,
  parameters      JSONB NOT NULL DEFAULT '[]'::jsonb,
  preconditions   JSONB NOT NULL DEFAULT '[]'::jsonb,
  steps           JSONB NOT NULL DEFAULT '[]'::jsonb,
  guardrails      JSONB NOT NULL DEFAULT '{}'::jsonb,
  success         JSONB NOT NULL DEFAULT '{}'::jsonb,
  source          TEXT NOT NULL,        -- pack | recorded | described | learned
  derived_from_plan_id UUID REFERENCES agent_plans(id) ON DELETE SET NULL,
  created_by_user_id   UUID REFERENCES users(id) ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT procedures_version_unique UNIQUE (org_id, procedure_key, version),
  CONSTRAINT procedures_key_ns CHECK (
    (org_id IS NULL AND procedure_key LIKE 'pack.%') OR
    (org_id IS NOT NULL AND procedure_key LIKE 'org.%')
  ),
  CONSTRAINT procedures_status_chk CHECK (
    status IN ('draft','active','paused','archived')
  )
);
```

The namespace `CHECK` extends the existing `playbook_id LIKE 'org.%'` rule
(`19` D14) into both directions: a pack procedure cannot be org-scoped, and an
org procedure cannot impersonate a pack one. Collision between "what we ship"
and "what the customer wrote" is the kind of bug that is invisible until it
silently overrides a compliance step.

**Versions are immutable.** Editing an active procedure creates version N+1.
Runs record which version executed, so a run six months old is still explainable
against the definition that actually produced it — the same instinct as
`audit_events.prompt_hash`.

### The five JSONB blocks

```jsonc
// trigger
{ "kind": "event",     "event": "inquiry.created" }
{ "kind": "schedule",  "cron": "0 9 * * 1-5", "timezone": "Asia/Kolkata" }
{ "kind": "condition", "watcher": "commitment.breach" }
{ "kind": "manual" }

// parameters — typed, validated with the Zod already in the tree
[ { "name": "contact",  "type": "entity_ref", "entity_type": "person", "required": true },
  { "name": "listing",  "type": "entity_ref", "entity_type": "asset",  "required": false },
  { "name": "tone",     "type": "enum", "values": ["formal","warm"], "default": "warm" } ]

// preconditions — evaluated against the entity graph before step 1
[ { "fact": "core.contact.do_not_contact", "equals": false },
  { "fact": "core.contact.email", "exists": true } ]

// steps
[ { "id": "s1", "kind": "tool",     "tool": "gmail", "action": "draft_email",
    "payload": { "to": "{{contact.email}}", "subject": "About {{listing.unit}}" } },
  { "id": "s2", "kind": "judgement", "prompt": "Is this draft appropriate given the thread?" },
  { "id": "s3", "kind": "approval",  "role": "owner", "when": "risk >= send" },
  { "id": "s4", "kind": "tool",     "tool": "gmail", "action": "send_email" },
  { "id": "s5", "kind": "wait",     "duration": "P3D", "cancel_on": ["inbound"] },
  { "id": "s6", "kind": "tool",     "tool": "hubspot", "action": "update_contact" } ]

// guardrails
{ "allowed_tools": ["gmail","hubspot","google-calendar"],
  "max_cost_minor": 5000, "currency": "INR",
  "respect_quiet_hours": true,
  "max_runs_per_day": 50,
  "escalate_to": "role:ops_head" }

// success
{ "all_steps_completed": true, "fact_written": "core.contact.last_contacted" }
```

Five step kinds — `tool`, `judgement`, `approval`, `wait`, `branch` — is
deliberately small. Every additional kind is a new execution path, a new failure
mode, and a new thing the compiler must be able to produce. `wait` with
`cancel_on` reuses the `NurtureCancelReason` vocabulary that already exists.

### Guardrails reuse existing primitives

| Guardrail | Backed by |
|---|---|
| `allowed_tools` | The employee allowlist mechanism (`tool-executor.ts`) |
| `max_cost_minor` | `billing_meters.hard_limit` |
| `respect_quiet_hours` | `quiet-hours.ts` |
| `max_runs_per_day` | The same fan-out-cap instinct as `MAX_STALE_CHASE` |
| `escalate_to` | `work_items` + `human_roles` |

**Nothing new is required at the platform level except the object itself.** That
is the test of whether this design fits the system: if a guardrail needed a new
enforcement engine, the procedure model would be fighting the platform.

---

## 3. Path A — Record ("always do this")

The user approves a plan that worked and clicks **Always do this**.

### The generalisation algorithm

```
input: agent_plans row (steps with concrete payloads)
       + the entities that were in scope for that run

1. COLLECT   every literal in every step payload
2. MATCH     each literal against in-scope entity facts
                "priya@example.com"  → contact.email        (exact)
                "402"                → listing.unit         (exact)
                "About unit 402"     → contains listing.unit (partial)
                "warm regards"       → no match             (constant)
3. PROPOSE   replace matched literals with {{param.path}};
             infer the parameter list from what was replaced
4. CONFIRM   show the user each substitution, side by side:
                to: priya@example.com  →  {{contact.email}}   [keep] [make constant]
5. CLASSIFY  each step's risk via resolveToolRisk; carry it into the definition
6. GUARDRAIL pre-fill allowed_tools from the steps actually used,
             max_cost from the observed run cost × 3
7. SAVE      as procedures(source='recorded', version=1, status='draft')
```

**Step 4 is the whole design.** Automatic generalisation without confirmation
produces a procedure that emails the wrong person on its first real run, and the
customer never trusts the feature again. Showing each substitution takes fifteen
seconds and converts a guess into a decision the user made.

Partial matches ("About unit 402") are the tricky case: offer the substitution
but default to **keeping the literal**, because a wrong partial replacement
corrupts a subject line in a way nobody notices until a customer receives it.

### Migration from `org_playbook_promotions`

Existing rows become `procedures(source='recorded', status='draft')` with all
literals intact and no parameters — a valid, runnable, non-general procedure.
The user is prompted to generalise it. Nothing existing breaks.

---

## 4. Path B — Describe (plain-language SOP)

The user writes:

> "When a new inquiry comes in from the website, check if we have the property.
> If we do, WhatsApp them within 10 minutes with the details and ask when they
> want to visit. If we don't, tell them honestly and ask what else they're
> looking for. Either way log it in the CRM."

### The compiler

```
1. SEGMENT     split into ordered clauses; identify trigger, branches, actions
2. GROUND      map each action to a (tool, action) pair from the ORG'S ACTUALLY
               AVAILABLE tools — never the full catalogue
3. SCORE       confidence per mapping
4. GAPS        anything unmapped becomes an explicit question, not a guess
5. RENDER      show the compiled procedure next to the original text
6. CONFIRM     the user fixes mappings inline
7. SAVE        procedures(source='described', status='draft')
```

Grounding against the org's *available* tools rather than the catalogue matters:
compiling "log it in the CRM" to `hubspot.update_contact` for an org with no
HubSpot connection produces a procedure that fails on first run with a
`notConnected` error. Better to surface the gap at compile time — *"you said log
it in the CRM; you don't have a CRM connected. Connect one, or should I log it
to a Google Sheet?"* — which also converts a connector.

The planner already does the hard half of this: it maps intent to
`{tool, action, payload}` on every complex Ask AI request. The compiler is that
capability pointed at a paragraph instead of a request, with the output
persisted rather than executed.

### The honest failure

A compiler that cannot map a clause says so and asks. It does not silently drop
the clause. A procedure that quietly omits "log it in the CRM" is worse than one
that refused to compile, because the omission is invisible until an audit.

---

## 5. Path C — Learn (proposed, later)

Once the entity graph exists, repeated human patterns become detectable: the
same three actions, in the same order, after the same trigger, five times in a
fortnight. Darex proposes the procedure; the human confirms.

This is Path A with the recording done by observation instead of a button.
Gated behind `21` and behind Path A being demonstrably trusted — proposing
procedures before the customer trusts recorded ones is a good way to make both
features feel presumptuous.

---

## 6. Execution

A procedure run is a `PlanExecuteWorkflow` with the steps materialised from the
definition plus bound parameters. **It goes through the identical confirm gate,
risk classification, allowlist check, and audit path as any other plan.**

```sql
CREATE TABLE IF NOT EXISTS procedure_runs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  procedure_id    UUID NOT NULL REFERENCES procedures(id) ON DELETE RESTRICT,
  procedure_version INTEGER NOT NULL,
  plan_id         UUID REFERENCES agent_plans(id) ON DELETE SET NULL,
  trigger_ref     TEXT,
  parameters      JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT NOT NULL DEFAULT 'running',
  cost_minor      BIGINT NOT NULL DEFAULT 0,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ
);
```

`ON DELETE RESTRICT` on `procedure_id`: you cannot delete a procedure that has
runs. Archive it. The run history must stay explainable.

`procedure_version` is denormalised onto the run deliberately — the join is
cheap, but the run must remain interpretable even if the procedure row is later
archived.

### Preconditions gate the run, not the steps

Preconditions are evaluated once, before step 1. A precondition that fails means
the run does not start, and that non-start is recorded. Silent non-execution is
the failure mode that erodes trust in automation faster than errors do: nobody
notices the thing that did not happen.

---

## 7. Versioning and in-flight runs

A procedure with a `wait` step can be running for days. Editing the definition
must not corrupt it.

**Rule:** a run is pinned to the version it started with. Editing creates N+1;
in-flight runs finish on N. New triggers use the active version.

This is Temporal's own patching problem and the reason `19`'s open questions
list "workflow versioning strategy" — it must be solved *before* customers author
multi-day procedures, not after the first one breaks mid-flight.

---

## 8. Goldens, generated

Every successful run is a candidate golden: inputs, parameters, expected step
outcomes. The user confirms one as canonical, and it becomes the regression test
for that procedure.

This closes `18` §5's "no per-procedure goldens" gap **automatically** rather
than as a discipline nobody maintains. A procedure without goldens cannot be
promoted past `status='draft'` — the same rule as packs (`12` §11), applied at a
finer grain.

---

## 9. Authoring UX principles

1. **Show the compiled result next to the original.** The user must be able to
   see what Darex understood, in the same view as what they wrote.
2. **Confirm substitutions and mappings individually**, never in bulk.
3. **Dry run before activating.** Execute against the entity graph with all
   external tools mocked; show what *would* have happened.
4. **Draft by default.** A newly authored procedure is `draft` until the user
   activates it, and `draft` procedures never fire on triggers.
5. **Name it in the customer's words.** The 3–80 character name constraint from
   `org_playbook_promotions` carries over: a procedure a human cannot name is a
   procedure they cannot reason about.
6. **Show the guardrails at authoring time.** "This can spend up to ₹50 and can
   send email" is what makes a customer comfortable activating it.

---

## 10. Build order

1. Migrate `org_playbook_promotions` → `procedures` (concrete, no parameters).
   Runnable immediately; nothing breaks.
2. `procedure_runs` + execution through `PlanExecuteWorkflow`.
3. Manual trigger only. Prove execution before automating the trigger.
4. Path A generalisation with per-substitution confirmation.
5. Guardrail enforcement wired to the existing primitives.
6. Generated goldens; draft→active gate requires one.
7. Event and schedule triggers.
8. Path B compiler.
9. Versioning + in-flight pinning (must precede `wait` steps in customer hands).
10. Path C proposals, after `21`.

---

## 11. Risks

| Risk | Response |
|---|---|
| A generalised procedure emails the wrong person | Per-substitution confirmation; dry run; draft by default |
| A customer builds a procedure that spams their contacts | `max_runs_per_day`, quiet hours, and the confirm gate on `send` |
| Compiled procedure silently omits a clause | Compiler asks rather than drops; unmapped clauses block the save |
| Procedure sprawl — forty half-working drafts | Draft procedures never fire; surface unused ones for archiving |
| A pack update overwrites a customer's edits | Namespaces are disjoint; a customer edit of a pack procedure forks it to `org.*` |
| Versioning breaks a multi-day run | Runs pinned to their version; solved before `wait` ships to customers |
