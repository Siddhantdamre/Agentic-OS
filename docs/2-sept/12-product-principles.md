# 12 — Product Principles

Constraints, not aspirations. Each exists because violating it already cost
something, or obviously would. Each names its enforcement — a principle without
a mechanism is a wish.

---

### 1. Honesty over helpfulness

Never report an action as done unless a tool confirmed it. Never simulate a
result. Never claim a connector is connected without a live broker connection.
Never paper over a missing scope, a rate limit, or a 401. When the brain does
not know, say so and name what would let it know.

**Enforced by:** `honesty-connectors.yaml` and `disconnected-sheets-mls.yaml`
goldens with an explicit `negativeOutput`; `wave-b-c6-honesty.test.ts`;
`connected`-from-broker-only; `setupUrl` in every not-connected response; the
constant empty-memory block; employee persona refusals; the crew synthesis
instruction.

**Because:** the failure mode of an honest error is a support ticket. The
failure mode of a confident lie is a lost account — and in a regulated vertical,
a liability.

---

### 2. Confirm before irreversible

`send`, `pay`, `sign`, `publish`, `delete` wait for a human. Permanently. The
autonomy ladder raises levels per procedure on evidence; it never removes the
gate on `pay` and `sign`.

**Enforced by:** `confirmForRisk()` with a `never` exhaustiveness check;
`compliance.extraConfirmClasses` per pack; `audit_events.approver_user_id`.

---

### 3. Authorisation is data, not prompt

Capability comes from `ai_employees.tool_allowlist`, `human_roles`, and
`org_connectors.status`. No sentence in any prompt or any ingested document
grants a tool.

**Enforced by:** `tool-executor.ts` checking a `TEXT[]` column, three
independent server-side layers, and a plan-specific allowlist on the execute
path.

**Because:** this is the strongest prompt-injection defence in the product, and
it is structural rather than textual.

---

### 4. Tenancy in the same migration

A new tenant table ships with `ENABLE` + `FORCE` RLS and a `USING` +
`WITH CHECK` policy, and a `darex_app` grant, in the same change.

**Enforced by:** review, `002_rls_test.sql`, `check-memory-rls.sql`.

**Because:** `USING` alone leaves a cross-tenant *write* hole, `FORCE` is what
stops the owner bypassing the policy, and retrofitting isolation is a rewrite.

---

### 5. Verticals are packs, never forks

If a vertical needs a platform code change, the platform is missing a
primitive — build the primitive.

**Enforced by:** the pack manifest carrying connectors, workflow triggers, KPIs
and compliance as data; `InstallPackWorkflow`; `packs.extends`.

---

### 6. Durable by default for anything irreversible

Anything that touches the outside world irreversibly runs as a Temporal workflow
with bounded retries and a visible terminal state — including
`completed_with_errors`.

**Enforced by:** `planRequiresDurableExecute()`, which fails closed on
unclassified tools.

---

### 7. Nothing important on the request path

Extraction, embedding, aggregation and analysis run asynchronously. The request
path answers; it does not compute. Webhooks verify, persist, return 200, then
process.

**Enforced by:** `ingestion_jobs` (whose migration states the rule),
`EmbedWorkflow`, the webhook inbox, and the 1200ms retrieval budget.

---

### 8. Every answer carries citations

An uncited claim about the company's own data is a bug, and the citation must
open the source.

**Enforced by:** `source` + `source_ref` on every memory row; `retrieveMemory`
returning citations across five tiers; `/api/brain/[id]`.

---

### 9. Silence is a feature

Unsolicited output has a budget. Outbound has quiet hours, fan-out caps, and
typed cancel reasons.

**Enforced by:** `quiet-hours.ts` (21:00–08:00 default, `MAX_NURTURE_FANOUT=3`,
`MAX_STALE_CHASE=10`, five named cancel reasons), `MAX_CREW_SPAWN=3`.

**Because:** a brain that notifies constantly gets muted, and a muted brain is
churned.

---

### 10. Pure logic, effectful edges

New decision logic goes in an isolate-safe module with no Node, `pg` or `fetch`.
New side effects go in an activity.

**Enforced by:** the Temporal workflow isolate, and by `route-employee.ts`,
`quiet-hours.ts`, `crew-contract.ts`, `inbound-hitl.ts` and `plan-steps.ts` all
having tests that need no infrastructure.

**Because:** determinism requirements produced testability. That was luck once;
keeping it is a choice.

---

### 11. Evals before ships

A pack without goldens cannot be installed. A prompt or procedure change that
drops the golden pass rate does not ship. Every incident produces a golden —
write down what it wrongly said and assert it never says it again.

**Enforced by:** six promptfoo suites; the `negativeOutput` convention.
*Currently advisory — wiring goldens into CI as a merge gate is in the Now
phase.*

---

### 12. Fail closed on safety, open on capability

An unclassified tool is treated as dangerous. A missing org context returns
nothing rather than everything. A disabled knowledge source is not retrieved.
But an org's capability is the **union** of its employees and connections, not
the intersection — capability failures should be surfaced, not silently
narrowed.

**Enforced by:** the heuristic fallback in `planRequiresDurableExecute()`; RLS
returning empty on a missing GUC; the `disabled` source rule; the org-union
allowlist.

---

### 13. Write down why

`BUILD_STATE.md` records what changed and the reason, in the same change.
Decisions with lasting consequences go in `19`.

**Because:** the reasoning is worth more than the diff six months later — and
several of the sharpest designs in this codebase (the LiteLLM split, the union
allowlist, the reasoning-disabled flag) are non-obvious enough that a future
engineer would otherwise "simplify" them back into the bugs they fixed.

---

### 14. Boring where it counts

Postgres, Temporal, RLS, a self-hosted OAuth broker, vectors in the same
database as the records. Novelty belongs in the brain layer — never in the
substrate holding a customer's data.

**Enforced by:** the four invariants in `20` §0 gating every dependency.
