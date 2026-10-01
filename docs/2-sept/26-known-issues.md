# 26 — Known Issues Register

Every known defect, limitation, and hazard in one place, with severity, evidence
and the fix. Sourced from `BUILD_STATE.md`, the migration comments, the code, and
the gaps identified across `06`–`09`.

**Severity:** 🔴 blocks production for a real customer · 🟠 causes a bad
experience or a support ticket · 🟡 hygiene, cost, or future risk.

---

## 1. Open — infrastructure and operations

### 🔴 I-01 · Langfuse trace persistence is flaky under load
**Symptom.** Traces ingest correctly (201) but some do not persist to
ClickHouse. Observability is intermittently blind.
**Cause.** Langfuse's BullMQ side-queues hit Redis socket timeouts on the shared
Redis instance at ~100 clients.
**Impact.** Cost attribution and "what did the agent do" are unreliable —
precisely when a customer asks.
**Fix.** Dedicated Redis for Langfuse. **Now** phase.

### 🔴 I-02 · SSE is single-process; a second dashboard replica misses events
**Symptom.** With two replicas, only one receives `needs_attention`; half of
users see no live updates.
**Cause.** Realtime hub state is per process.
**Impact.** Blocks horizontal scaling entirely.
**Fix.** Redis pub/sub behind the stream. `check-two-replica-sse.js` already
exists to verify. **Now** phase.

### 🟠 I-03 · No rate limits on public or authenticated endpoints
**Impact.** The public widget is anonymous and internet-facing; a scanner or a
loop can burn LLM spend with no ceiling. Maps to OWASP LLM04.
**Fix.** Rate limits per IP, per site key, per org. **Now** phase.

### 🟠 I-04 · Backups exist; PITR and a rehearsed restore do not
**Impact.** A backup never restored is not a backup.
**Fix.** pgBackRest behind `restore-drill.sh`; run the drill, record the
wall-clock time. **Now** phase.

### 🟡 I-05 · Alerting is five hand-rolled scripts
`alerting-connector-401s`, `queue-lag`, `langfuse-ingest`, `rls-job`, `run`.
No routing, no deduplication, no on-call.
**Fix.** Prometheus + Alertmanager (`20` §9).

### 🟡 I-06 · No OpenTelemetry propagation across services
Traces are stitched by hand across dashboard → worker → tools.

---

## 2. Open — correctness and safety

### 🔴 I-07 · Idempotency keys are not threaded into every write executor
**Symptom.** A Temporal retry of a write tool can duplicate the external side
effect — send the same email or invoice twice.
**Cause.** `idempotency_keys` exists and is passed at the workflow boundary, but
individual executors do not all derive and check a key.
**Impact.** A duplicated customer email is a support ticket; a duplicated
payment is worse.
**Fix.** Every mutating executor derives a key from
`(org, plan/step, payload digest)` and checks before calling the provider.
Days of work, highest value-per-hour item open. **Now** phase.

### 🔴 I-08 · No compensation for partially executed plans
**Symptom.** A four-step plan failing at step three leaves the world
half-changed. `completed_with_errors` reports it honestly; nothing can undo it.
**Impact.** The customer must manually work out what happened and reverse it.
**Fix.** Per-step compensation definitions; partial state visible and actionable
in the plan UI. Phase C.

### 🔴 I-09 · Prompt-injection defences are incomplete
Shipped: authorisation is a DB array, the confirm gate, no-network sandbox,
redaction, the critic. Missing: adversarial framing at call sites, first-time
recipient confirmation, injection detection as audit events, a red-team golden
suite.
**Impact.** Acceptable at L2 (a human sees everything irreversible). **Blocking**
for anything above. See `25` §4.

### 🟠 I-10 · Scope drift is only detected at execution time
**Symptom.** Gmail `draft_email` returned 403 `insufficient scopes` because the
token was minted before `gmail.compose` was added.
**Cause.** `connector_defs.scopes` declares what is required; nothing compares it
against what was granted.
**Impact.** A connector looks connected and fails on first real use — the worst
possible moment.
**Fix.** Compare required vs. granted at connect time and on a schedule; surface
`scope_insufficient` with a reconnect prompt. Add a golden. **Now** phase.

### 🟠 I-11 · No spend budgets at execution
Fan-out is capped by count (3/3/10) but not by cost. One expensive step can
exceed any budget. `billing_meters.soft_limit`/`hard_limit` are the right home.

### 🟠 I-12 · Connector 401s are ops-only
`alerting-connector-401s.js` tells us; nothing tells the customer to reconnect.
They experience it as a task failure.

### 🟡 I-13 · No automated check that every tenant table has an RLS policy
The rule is enforced by review. A CI query over `pg_policies` versus tables
carrying `org_id` would make it mechanical. Guards the company-ending failure
class; an afternoon of work.

### 🟡 I-14 · `audit_events` is not append-only at the grant level
The application holds UPDATE/DELETE. An audit trail the app can rewrite is not
evidence. One grant change.

---

## 3. Open — product gaps that read as bugs

### 🟠 I-15 · Memory answers are prose, so conflicting facts silently average
Two contradictory chunks both retrieve and the model produces one confident
sentence. There is no mechanism by which the system could know it did that.
**Fix.** `21` — the entity graph and fact model.

### 🟠 I-16 · The same person on WhatsApp and email is two half-memories
No entity resolution across identifiers.
**Fix.** `21` §6.

### 🟠 I-17 · A promoted playbook replays literal payloads
`org_playbook_promotions.steps` holds one run's concrete values. Replaying it
emails the same person again.
**Fix.** `23` §3 — generalisation with per-substitution confirmation.

### 🟠 I-18 · A plan can wait indefinitely for an absent approver
No delegation, no out-of-office, no watcher on approval age. The work simply
stops, silently.
**Fix.** `22` `plan.awaiting_approval` watcher (cheap, no dependencies), then the
approval matrix in `09` §2.6.

### 🟡 I-19 · `ask_ai_feedback` and `agent_plans.feedback` are collected and unused
Up/down votes and revision instructions — the two best quality signals the
product generates — feed nothing.
**Fix.** The edit-as-label loop, `04` §9.

### 🟡 I-20 · No coverage map
The customer cannot see what the brain does *not* know. `knowledge_sources`
already tracks `status` and `last_synced`.

### 🟡 I-21 · Sync polls where providers offer webhooks
`connector_defs.webhook_events` is declared but underused.

### 🟡 I-22 · No batch operations
Chasing 200 leads is 200 tool calls — slow and expensive.

---

## 4. Open — quality and process

### 🟠 I-23 · Goldens exist but block nothing
Six promptfoo suites, no CI merge gate. A regression can ship.
**Fix.** Wire into CI. **Now** phase.

### 🟠 I-24 · No per-procedure goldens
A workflow can regress with no test noticing.
**Fix.** Auto-generate from successful runs (`23` §8).

### 🟡 I-25 · No cost or latency regression tracking
A prompt change that triples token spend or doubles latency passes silently.
"Ask AI simple stays in-class" is a code comment, not an assertion.

### 🟡 I-26 · No scope-drift golden
The exact bug in I-10 would recur undetected.

### 🟡 I-27 · No red-team suite
The highest-severity risk class is entirely untested. Garak probes are a ready
source.

---

## 5. Ops-blocked (code complete, credentials missing)

### 🟠 I-28 · Nine connectors need real OAuth client IDs
Slack, HubSpot, Stripe, Notion, Shopify, Zendesk, Intercom, Zoho, QuickBooks.
Leegality needs a BYOK token.
**Not an engineering defect.** Register in the Nango UI (`:3003`), run
`seed-nango-configs.sql`, restart `nango-server`. Tracking it as "product
incomplete" hides how much of the action layer is finished.

---

## 6. Environment hazards — documented, not defects

### H-01 · `docker compose` must be called with `--env-file` pointing at the root `.env`
Compose derives the project directory from the compose file's own folder, so
root `.env` values silently fall back to in-file defaults — wrong ports, wrong
secrets, a stack that looks up and is not.
**Mitigation.** Always use `./start.sh`, `pnpm infra:up`, or `compose-cmd.sh`.

### H-02 · Postgres applies `POSTGRES_PASSWORD` only on first init of an empty volume
Editing `.env` afterwards does not rotate it; every service then fails auth.
**Mitigation.** `ALTER USER` (`17` §7), or wipe the volume deliberately.

### H-03 · Embedding dimension is immutable in place
`vector(1536)` must equal `EMBEDDING_DIM`. Mixing dimensions in one column is
unrecoverable; changing the model needs a migration plus a re-embed job.

### H-04 · A missing `app.current_org_id` returns empty results, not an error
Confusing to debug. The correct failure direction, and worth knowing before
debugging "why is this list empty".

### H-05 · Reasoning models must have reasoning disabled at structured call sites
Otherwise they spend the whole `max_tokens` on `reasoning_content` and return
empty `content` — a 90-second hang that looks like a network problem.

---

## 7. Resolved — kept because the cause recurs

| ID | Issue | Root cause | Lesson |
|---|---|---|---|
| R-01 | Every plan step failed "not in allowed tool list" | Allowlist resolved from one arbitrary active employee (`LIMIT 1`) | An org's capability is the **union** of its employees and connections |
| R-02 | UI showed 14/14 connectors connected; Nango had 4 | `POST /api/integrations` upserted `status='connected'` with a guessed connection id; `GET` trusted those rows | Never write `connected` from anything but a real broker connection |
| R-03 | Every tool reported `connected:false` | `NANGO_SECRET_KEY` overridden by a later-loaded `.env` with a non-UUID placeholder | Verify with a **live round trip**, not a config check |
| R-04 | Classifier hung 90s+, returned wrong types | classify/plan called the agent loop, which injects the full tool grammar into what should be a plain JSON completion | Structured-output call sites get a plain client |
| R-05 | Langfuse always empty | `timestamp` sent inside `body` instead of at event level; worker `LANGFUSE_HOST` pointed at `localhost` inside Docker | Stop swallowing errors — `.catch(()=>{})` hid it for weeks |
| R-06 | `code_execution` never worked | Pointed at a dead sandbox on `:8080`, which is the Temporal UI in this stack | Health-check the thing you depend on |
| R-07 | Phase 3 checks regressed to 4/6 | Webhook secret enforcement added; the check script sent no HMAC | Verification scripts are code and break with the code |
| R-08 | `web_search` returned nothing | Jina began requiring an API key | Unset credential must produce an honest error, never fake results |

---

## 8. Priority order

**Ship now — cheap, each closes a real hole**
I-07 idempotency · I-13 RLS coverage check · I-14 append-only audit ·
I-03 rate limits · I-10 scope drift · I-23 goldens in CI

**Ship now — unblocks scale**
I-01 Langfuse Redis · I-02 SSE pub/sub · I-04 restore drill

**Gates autonomy above L2**
I-09 injection defences

**Needs the entity graph**
I-15 · I-16 · I-18 (the watcher half is cheap and can precede it)

**Phase C**
I-08 compensation · I-11 spend budgets · I-17 generalisation · I-24 goldens

**Hygiene**
I-05 · I-06 · I-19 · I-20 · I-21 · I-22 · I-25 · I-26 · I-27

**Operations, not engineering**
I-28
