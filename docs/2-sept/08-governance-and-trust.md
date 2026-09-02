# 08 — Governance, Security and Trust

Trust is the product. A system that reads a company's inbox and can spend its
money earns access only by being auditable, bounded, and honest. Every control
here is enforced in data or in the database — not in a prompt.

---

## 1. Tenancy

### The policy, applied to every tenant table

```sql
ALTER TABLE t ENABLE ROW LEVEL SECURITY;
ALTER TABLE t FORCE  ROW LEVEL SECURITY;
CREATE POLICY t_org_isolation ON t
  USING      (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON t TO darex_app;
```

Each clause closes a specific hole:

| Clause | Without it |
|---|---|
| `ENABLE` | No isolation at all |
| `FORCE` | The table **owner** bypasses the policy — and migrations run as owner |
| `USING` | Cross-tenant **reads** |
| `WITH CHECK` | Cross-tenant **writes** — a tenant can insert rows into another org |
| `darex_app` grant | Applications run as superuser and bypass everything |

`WITH CHECK` was added across the board in `008_rls_with_check`. The write hole
is the one most systems miss, because read isolation is what gets tested.

### Org resolution

Session → `org_id` (`009_auth_tenancy`) → `SET app.current_org_id` on the
connection. Never from a request body.

**One documented exception:** the public widget resolves tenant from a **hash of
a site key** in `widget_embed_tokens`. It is a hash lookup against a table, not
a caller-supplied identifier, which is why it is safe to embed on a customer's
public website.

### Proof

`002_rls_test.sql` and `infra/scripts/check-memory-rls.sql` assert two-org
isolation, including for vector search. Keeping vectors in Postgres rather than
an external store is what makes that assertion possible at all.

### The known sharp edge

A missing GUC yields **empty results**, not an error. That is confusing to debug
and it is the correct failure direction: a query that forgets its org context
returns nothing rather than everything.

**Standing rule:** any new table holding tenant data ships with its RLS policy
in the **same migration**. A migration adding a tenant table without a policy is
a defect, not a follow-up.

---

## 2. Authorisation — three independent layers

```
1. Human role        (human_roles, 019)          what a person may see and approve
2. Employee allowlist (ai_employees.tool_allowlist TEXT[]) what an AI employee may call
3. Org connection    (org_connectors.status)     what the company authorised at the provider
```

A tool call must pass **all three**. None of them are readable or writable from
prompt content, which is why the strongest injection defence in the product is
structural rather than textual.

---

## 3. The confirm gate

### How it works

1. Multi-step work becomes an explicit `agent_plans` row: `summary`, ordered
   `steps JSONB`, `reasoning`, and a `draft` of the artifact to be produced.
2. The plan is human-readable before it is machine-executable.
3. `confirmForRisk(risk)` decides whether approval is required:
   `read | draft` → no; `send | pay | sign | publish | delete` → yes.
4. Packs can widen the gate: `core-b2b` declares
   `extraConfirmClasses: [send, pay, sign]`.
5. Approval is recorded — `audit_events.approver_user_id` and `confirm_id`.
6. `agent_plans.feedback` carries a revision instruction, so the human can edit
   the draft and re-plan instead of a binary yes/no.
7. `current_step` makes partial execution observable, and
   `completed_with_errors` reports partial failure honestly.

### Where approval happens

- The dashboard PlanCard.
- **WhatsApp** — `/api/webhooks/owner-whatsapp` signals `approveWorkItem` /
  `rejectWorkItem` on the running `WorkItemWorkflow`.

The second matters more than it sounds. The buyer is an owner or operations head
who lives on their phone. An approval that requires opening a dashboard does not
happen, and an approval that does not happen means the agent stalls.

### What is still owed

- **Per-tool risk tiers in the gate itself** — the classes exist; the gate does
  not yet differentiate a ₹500 payment from a ₹5,00,000 one.
- **Spend limits attached to approval.**
- **Re-approval when a plan is revised after partial execution.**
- **First-time-recipient confirmation** as an injection defence.

---

## 4. Audit

`audit_events` (`016`) is the most information-dense table in the schema:

| Column group | Columns | Question answered |
|---|---|---|
| Actor | `actor_type`, `actor_user_id`, `actor_employee_id`, `actor_component` | Who or what did this |
| Context | `work_item_id`, `plan_id` | What piece of work it belonged to |
| **Authority** | `confirm_id`, **`approver_user_id`** | **Who authorised it** |
| Action | `tool`, `action`, `risk_class` | Exactly what was attempted |
| Provenance | `model`, **`prompt_hash`** | Which model and prompt version produced it |
| Trace | `langfuse_trace_id` | The full execution trace |
| Outcome | `result_status` | What happened |

Indexed on `(org_id, created_at DESC)`, `(org_id, kind)`,
`(org_id, approver_user_id)`, `(org_id, langfuse_trace_id)`.

Two columns carry disproportionate weight:

- **`prompt_hash` + `model`** — when a prompt change starts producing bad
  actions, every action it produced is identifiable months later. This is also
  the mechanism that would let us revoke facts extracted by a bad prompt version
  once the fact model lands.
- **`approver_user_id`** — "who authorised this?" always has an answer. Indexed,
  so it is answerable per approver as well as per action.

### Parallel event stream: `work_events`

Every inbound work item carries its own append-only lifecycle:

```
inbound_received → memory_retrieved → employee_routed → agent_started
  → agent_replied | agent_failed | needs_attention
  → confirm_requested → confirm_approved | confirm_rejected
  → critic_blocked
  → memory_writeback → embed_enqueued
```

"What is the agent doing with this message right now" is a database query, not a
log grep. `critic_blocked` being a first-class kind means a blocked reply is
visible rather than a silent no-op.

### Coverage still to expand

Access events (login, org switch, connector connect/disconnect), data events
(memory write, fact correction, export, deletion), governance events (autonomy
level change, allowlist change, role change), and security events (injection
detection, auth failure, rate-limit trip). Audit must also become exportable and
queryable by a non-engineer.

---

## 5. The critic

`WorkItemWorkflow` calls `criticCheck` before a reply leaves the building and
can emit `critic_blocked`. A second opinion on outbound content, recorded as an
observable outcome.

This is the right place to enforce pack-level `bannedPhrases` — `core-b2b`
declares `[guaranteed returns, assured returns]`, which is a securities-
compliance issue in the Indian market, not a style preference.

---

## 6. Restraint — outbound controls

| Control | Value | File |
|---|---|---|
| Quiet hours | 21:00 → 08:00 default, org timezone, wrap-around aware | `quiet-hours.ts` |
| `hoursUntilQuietEnd()` | Reschedules to the window's end rather than dropping the message | `quiet-hours.ts` |
| `MAX_NURTURE_FANOUT` | 3 touches per lead | `quiet-hours.ts` |
| `MAX_STALE_CHASE` | 10 threads per run | `quiet-hours.ts` |
| `MAX_CREW_SPAWN` | 3 specialists per crew | `crew-contract.ts` |
| Cancel reasons | `inbound \| takeover \| do_not_contact \| rejected \| emergency_stop` | `quiet-hours.ts` |

Five named stop conditions — including human takeover and a global emergency
stop — is the minimum bar for any automated outbound sequence. A nurture flow
that cannot be stopped is a spam cannon with the customer's brand on it.

---

## 7. Privacy and data rights

| Control | Status |
|---|---|
| Redaction before embedding | Shipped — PII not needed downstream never enters the vector store |
| Blocked data classes | Declared per pack: `core-b2b` blocks `kyc`, `pan`, `aadhaar` |
| No KYC columns in memory tables | Enforced by absence, documented in `013_memory_rag` |
| DSR export / delete | `dsr_requests` + `/api/dsr/export`, `/api/dsr/delete` |
| Retention per vertical | Declared in each pack's `compliance.yaml` |
| Secrets not in error columns | Stated rule for `ingestion_jobs.error` |
| Market modules | `core-b2b` declares `[GDPR, DPDP]` |

The no-KYC decision is worth restating: the primary vertical handles identity
documents daily. The cheapest way to never leak them from a vector store is for
them never to enter it. That is a compliance control expressed as a schema
absence, and it cannot be undone by a bug.

**Still owed:** a full deletion cascade across memory, edges, facts, traces and
object storage; data residency options; per-org encryption keys; a published
sub-processor list and DPA.

---

## 8. Compliance posture

| Item | State |
|---|---|
| Tenant isolation | Shipped and tested (two-org, including vectors) |
| Audit trail | Shipped; coverage expanding |
| DSR handling | Surfaces exist |
| Retention per vertical | Declared in packs |
| Encryption in transit | Yes |
| Encryption at rest | Infrastructure-dependent; needs to be explicit |
| SSO | Routes scaffolded (`/api/auth/sso/*`) |
| SCIM | Not started |
| SOC 2 | Not started — the gate for mid-market |
| DPA / sub-processors | Not published |
| India data residency | Relevant to the primary vertical; unaddressed |
| HIPAA-class handling | Only if a healthcare pack ships |

SOC 2 readiness is the gate between SMB self-serve and any deal above roughly
fifty seats. It is a roadmap item with a lead time measured in quarters, not an
afterthought.

---

## 9. Reliability guarantees

1. **Durable execution.** Irreversible work survives worker restarts and
   resumes.
2. **Fast webhook acknowledgement.** Verify → persist → 200 → process.
3. **Bounded retries.** 3 attempts, 2s initial interval, `startToCloseTimeout`
   3m, `scheduleToCloseTimeout` 8m. A permanently failing step becomes a work
   item, not a silent drop.
4. **Deduplication.** `messages.channel_key` unique per org.
5. **Idempotency.** `idempotency_keys` with expiry.
6. **Quiet hours** on outbound.
7. **Honest failure.** An error is reported with its real message.

---

## 10. The honesty doctrine

Stated explicitly because it is the easiest thing to compromise and the most
fatal to lose.

1. Never report an action as done unless the tool confirmed it.
2. Never present a simulated result as a real one.
3. Never claim a connector is connected without a live broker connection.
4. Never paper over a missing scope, a rate limit, or a 401.
5. When the brain does not know, say so and name what would let it know.

Each has enforcement behind it: goldens with an explicit `negativeOutput`, the
live honesty module test, the `connected`-from-broker-only rule, the
`setupUrl` in every not-connected response, and the constant empty-memory block
(*"If a fact is missing, say it is missing. Tools still run."*).

It reaches into the packs as well. Every shipped employee persona carries a
refusal: *"never invent pipeline amounts"*, *"never invent order status"*,
*"never invent KPIs"*, *"never invent inventory, price, or RERA"*. And into the
crew synthesis prompt: *"If a specialist hit notConnected, say so honestly"* —
because synthesis is exactly where a model is tempted to smooth over a failure.

**These stay. The commercial argument is simple: the failure mode of an honest
error is a support ticket; the failure mode of a confident lie is a lost account
and, in a regulated vertical, a liability.**
