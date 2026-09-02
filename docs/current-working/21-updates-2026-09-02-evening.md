# 21 — Updates, 2 September 2026 (evening)

Date: **Wednesday 2 September 2026**, evening through night (IST).

Changelog for `8c3035d` → `b8c6303`, plus the market-context work and the first
measured reliability figure. Written from `git`, the live source, container
logs, and queries run against the running database.

Callers: indexed from [README.md](./README.md). Not imported by application
code. No data files.

---

## Scope

Nine commits. Four fixed things that were silently broken, three added
capability, two are documentation.

| Commit | Subject |
|---|---|
| `ebbbc60` | docs: routing, scheduling and research decisions (ADR 16–18) |
| `20ddc34` | give every employee a job it does without being asked |
| `708e368` | look it up before accepting "I don't know" |
| `cfe802f` | give every model group a fallback, not just the front door |
| `4bc33b2` | docs: the first real shift run and its three failures |
| `e841bc6` | stop every compose command from declaring an empty model key |
| `702b485` | make agent work visible — in the ledger and as it happens |
| `bef0a87` | stop the readiness check failing the demo it is meant to protect |
| `b8c6303` | give every employee the market it is working in |

---

## The measured number

`infra/scripts/simulate-shifts.js`, ten rounds, six employees, **no retries**:

```
EMPLOYEE   REPORTED  SECS med  REPLY LEN
Emma       10/10     30        214–264
Marcus     10/10     33        286–286
Research   10/10     25        745–847
Sarah      10/10     25        105–114
Aisha       9/10     20        179–381
Meera       9/10     20         66–381

58 of 60 runs produced a real report (97%).
```

The first **42 runs were clean**. Marcus produced a byte-identical answer on
all ten rounds; Sarah varied by nine characters. That is what stable looks like
on a fixed question.

**Both failures were one upstream event**: `Upstream error from Nvidia: Service
temporarily overloaded`. The provider actually failed **18 times** — the
fallback chain fixed in `cfe802f` absorbed sixteen of eighteen. The two that got
through did so because `GROQ_API_KEY` and `DEEPSEEK_API_KEY` are unset, leaving
the free tier with nowhere to fall. A free Groq key is the single cheapest way
to close that gap.

---

## 1. Every compose command declared an empty model key

`compose-cmd.sh` looked for an env file at `$ROOT/.env`. **Both files exist**: a
stale root `.env` from 16 August whose `OPENROUTER_API_KEY` is an empty
placeholder, and `infra/.env` from 31 August holding the real 73-character key.
Every compose command through the wrapper used the stale one.

Nothing appeared broken, because running containers keep their values in memory.
The next `up -d` or any rollback would have recreated LiteLLM **with no
OpenRouter key**, failing at the exact moment somebody was deploying.

An empty placeholder outranking a real value is the same failure that once put
two `OPENROUTER_API_KEY` lines in one file and let the blank one win. Rule: the
env beside the compose file is the env for that compose file.

After the fix, `check-config-drift` passes with 83 keys matching across 14
services.

---

## 2. A quarter of our verification was not running

`check-config-drift.js` had been reporting this correctly — *"declared len 0,
running len 73"* — and was **not in `verify.js`**. That was the third time in one
day a real defect sat behind a checker nobody ran, after CI red on four pushes
and `demo-ai-employee.js` going red unnoticed.

`lint-check-coverage.js` ends the class: every `check-*.js` and `lint-*.js` must
either appear in `verify.js` or carry an `EXCLUDED-FROM-VERIFY` marker in its own
header. Staying out of the gate now requires stating your case in writing.

Fourteen orphans were **triaged, not counted**:

| Outcome | Scripts |
|---|---|
| **Added to the gate (9)** | config drift, outcome ledger, agent reply e2e, reply gate live, connector auth honesty, memory phase 6, document upload, upload formats, two-replica SSE |
| **Excluded with a reason (5)** | demo-ready (advisory), deploy-recovery (destructive), phase0 (optional containers), phase2 (needs WhatsApp credentials), phase3 (stale cookie path) |

`check-outcome-ledger.js` alone carried **32 assertions that had never run**. It
was missing the `loadRepoEnv()` call every other check has, so it died with a
SASL password error that read like a broken ledger rather than a missing
variable.

Gate: **48 checkers, 5 written exclusions, nothing silently outside it.**

---

## 3. The work was recorded and unreachable

Six employees ran duties three times each. All eighteen runs landed in
`channel_logs` with the employee's name, and `agent_actions` held **none** of
them — so `/employees/[id]`, a page whose entire job is showing what an employee
did, was blank for every one.

The cause sat between two correct decisions. A duty deliberately does not persist
a message, because it is not a customer conversation. The ledger ingests replies
from `messages` and tools from `proxy_call`. Neither covers a duty, and nothing
noticed, because both halves behaved exactly as written.

The ledger now ingests `AGENT_EXECUTION` as `duty_run`, attributed by
`employeeId` from the payload rather than a join on name — there are 52
employees called "Sarah" in this database. Migration **044** adds `duty_run` to
the `action_kind` CHECK constraint, which rejected the insert; the constraint is
kept rather than widened to text, because it is why a typo fails loudly instead
of creating a category nothing reads.

Before: only Priya had attributed actions. After: all six employees do.

---

## 4. The realtime bus had never published anything

The SSE route worked. The dashboard subscribed correctly per org.
`publishOrgEvent` was called from every activity that should announce something.

**Only the `dashboard` service had `REDIS_URL`.** The `worker`, which runs all
those activities, had none — and `publishOrgEvent` opens with:

```js
const target = redisTarget();
if (!target) return;
```

So every publish was a silent no-op: `owner.briefing`, `conversation_updated`,
`plan.step`, all of it, since the bus was written. That silence is *correct* — a
dead Redis must cost the live view, never the work — and it is exactly why nobody
noticed.

Verified end to end after the fix: a `redis-cli` subscriber on the org channel
received a real event naming Meera, her employee id, that the run was
self-directed and that it succeeded.

`LiveActivity` renders that feed on Home. It shows **nothing** until a real event
arrives — no skeleton rows, no sample activity. A live view that invents activity
to look busy defeats its own purpose.

---

## 5. The readiness check was failing the demo it protects

Two wrong answers, both the expensive direction.

**Wrong workspace.** Org selection ordered by conversation count alone, so it
chose `q_1786836142243211's Organization` — a fixture with 79 seeded
conversations and one employee — over the staffed workspace with nine. It then
reported NO-GO for problems the fixture had and the real workspace did not.

**Wrong verdict.** An exhausted paid balance produced "THE AGENT CANNOT ANSWER"
and stopped the demo. That is false: at that exact balance of −0.1999, six
employees produced real reports in ten consecutive rounds. The router carries a
zero-cost tier beneath the paid ones. Telling an operator their product is dead
the night before a presentation, when it works, is the most expensive kind of
wrong a readiness check can be.

Now reports **GO** on "Sharma Properties, Thane" — 9 employees, 9 conversations,
9 memory rows, shadow mode ON, every HTTP probe 200 under 50 ms.

---

## 6. Market context — business intelligence with provenance

See [ADR 19](../adr/019-market-facts-carry-their-source.md).

Every employee now carries the same market briefing into its duty, and every fact
carries its source. Enforced twice: `market-context.js` refuses an unsourced fact
at write time, and migration **045** adds a CHECK constraint so nothing that can
`INSERT` into `org_memory` can bypass the script.

Proven end to end. Three sourced facts recorded; Sarah asked what stamp duty a
female buyer pays in Thane:

> "A female buyer in Thane pays 5 % stamp duty on the agreement value, plus 1 %
> metro cess **(per igrmaharashtra.gov.in)**, and a registration fee of 1 %
> capped at ₹30,000 **(per our policy)**."

With the same facts loaded, Sarah's *duty* output was byte-identical to before —
correct, because stamp duty does not bear on "who asked and never got an answer".
Unchanged output looked like a bug and was checked rather than assumed.

---

## Earlier the same day

- **Duties.** Every employee has a standing job it performs unprompted. Two rules
  asserted rather than intended: a duty **looks and reports, never acts**, and it
  runs with the **minimum tool**, not the employee's authority — Sarah holds Gmail
  and WhatsApp; her duty runs with `database_query` alone.
- **Look it up before saying "I don't know."** Gated twice: `classifyAnswerability`
  decides whether a public source could hold the answer, ambiguity resolves to
  *internal*, and only findings corroborated by two independent publishers pass
  the reply gate. "Stamp duty in Thane" is looked up; "do you have anything in
  Chembur" never is, because searching the web for our own inventory would quote
  a competitor's flat as ours.
- **Model fallbacks.** The chain covered `atomic-agent` while the budget gate pins
  over-budget workspaces to `atomic-agent-deepseek`, which had nowhere to fall.
  The zero-cost floor now falls only to the other zero-cost tier — never onto a
  paid one, which would bill exactly the workspace the gate was protecting.

---

## State at the end of 2 September 2026

**Verified:**

- 58 of 60 agent runs reported (97%), no retries
- 48 checkers in the gate, 5 written exclusions, none silently outside
- 23/23 duty tests, 484+ workflow unit tests
- All six employees produce attributed `duty_run` actions
- The realtime bus carries real agent events end to end
- Market facts reach the agent and are cited by source
- Readiness: **GO**

**Blocked:**

- **Model credit.** The OpenRouter key was pasted into a chat transcript on
  2 September and must be rotated. The free tier answers; it is slower and can
  be rate-limited under sustained load.
- **`GROQ_API_KEY` unset** — the cheapest available reliability gain.
- **61 of 65 tools** waiting on account credentials. Nango holds 0 configs.
- **No deployment, no customers.** The demo workspace is seeded.

**Not visually verified:** the briefing panel and the live activity feed. Both
compile into the server and client bundles and their APIs return 401
unauthenticated, so they exist and enforce auth — but no human has looked at
either, because the browser session was lost and credentials are not mine to
type.

---

## Traps added to the operational record

- **A Docker build needs no containers running.** `docker compose stop` the
  non-essentials, build, bring them back. This worked where four consecutive
  attempts had failed.
- **`NODE_OPTIONS=--max-old-space-size=4096`** or TypeScript exits with
  `FATAL ERROR: Zone Allocation failed`.
- **Never run Node and a Docker build at once** on this machine.
- **Run one-off work inside a container.** The Docker port proxy drops host
  connections to Postgres, Temporal and Redis unpredictably after a restart;
  `docker compose restart <service>` re-establishes it.
- **`node -e` or `node < file`, not `node /path/file.js`,** inside a container —
  CommonJS resolves modules from the script's directory, and `/tmp` has no
  `node_modules` above it.
- **A query with no org context returns zero rows, not an error.** The first run
  of the simulation harness reported "0 EMPLOYEES" because it had not set
  `app.current_org_id`. That is the tenant wall working.
