# Operations

How to run Darex day to day: what to check, what breaks, what each alarm
means, and how to recover. Deployment and first-time setup live in
[DEPLOY.md](DEPLOY.md) and [SETUP.md](SETUP.md).

Every number in this document was measured on a running deployment. Where a
figure depends on your usage, the command that produces it is given rather
than a number to copy.

---

## The three commands

| Question | Command | Costs |
|---|---|---|
| Is the build sound? | `node infra/scripts/verify.js` | nothing |
| Is it safe to demo *right now*? | `node infra/scripts/preflight.js` | a few tokens |
| How long does the budget last? | `node infra/scripts/spend-guard.js` | nothing |

### `verify.js` — everything provable without spending money

```bash
node infra/scripts/verify.js
```

Runs nine suites and prints one verdict. On the reference deployment:

```
  workflow unit tests          282/282   reply gates, grounding, claim extraction
  env loader                     9/9     credentials resolve the way compose resolves them
  spend guard maths              7/7     burn rate refuses to extrapolate from noise
  sql parameter lint             —       every $N has exactly one argument
  tenant scope lint              —       no tenant table read without an org filter
  quality rules                 23/23    the reply scorer agrees with hand-labelled examples
  tenant registry isolation     14/14    one tenant cannot see, name or write another
  memory retrieval              11/11    two orgs retrieve their own facts and nothing else
  operator edit learning        10/10    a correction outranks the document it corrects
  learning loop end-to-end      11/11    a correction through the real HTTP route becomes knowledge
  impact / outcome ledger       13/13    the renewal number is arithmetic, not a feeling
  inbound end-to-end             8/8     signed webhook to stored conversation
  infrastructure alarms          4/6     queue, connectors, RLS, Langfuse, budget, ledger
```

`--fast` skips the five suites that need the containers.

Four things it deliberately does **not** check, because they need live model
calls and therefore credit. It names them at the end of every run rather than
passing over them quietly:

```bash
node infra/scripts/completion-suite.js       # answer quality on real questions
node infra/scripts/multiturn-suite.js        # multi-turn conversations
node infra/scripts/reliability-completion.js # repeated runs, same questions
node infra/scripts/latency-probe.js          # latency under load
```

### `preflight.js` — is it safe to put in front of someone

Read-only, seconds, exits non-zero on a blocker. Run it before every demo.
It checks configuration, services, migrations, knowledge-base contents,
retrieval mode, LLM budget, provider independence, and each model tier
**individually**.

The tier table is the part worth reading closely:

```
LLM TIERS
  [WARN]  tier 1  openrouter paid unavailable  — OpenrouterException ...
  [WARN]  tier 2  openrouter paid unavailable  — OpenrouterException ...
  [ OK ]  tier 3  openrouter free  — answers
  [ -- ]  tier 4  deepseek direct  — not configured (optional)
  [ -- ]  tier 5  groq direct  — not configured (optional)
  [WARN]  chain answers only via FALLBACK — atomic-agent-deepseek is carrying
          traffic, not tier 1 openrouter paid
```

Each tier is probed with `fallbacks: []` so a dead tier cannot hide behind a
working one, and the chain is probed separately. Before that, this table
reported tier 1 as healthy while it returned 402 on every real call — the free
tier was silently carrying the demo.

### `spend-guard.js` — how many days of budget are left

```bash
node infra/scripts/spend-guard.js          # record a sample and report
node infra/scripts/spend-guard.js --json   # for a dashboard or a cron job
```

**Money comes from the provider, volume comes from LiteLLM.** This split is not
stylistic. Over one 7-day window LiteLLM recorded **$0.0032** of spend across
~2,300 calls while OpenRouter charged roughly **$14** for the same traffic:
LiteLLM prices calls from its own model table, which has no correct entry for
these OpenRouter routes, and correctly records $0.00 for the `:free` tier —
which carried 40 million tokens in that window. An alarm built on
`LiteLLM_SpendLogs.spend` reports "spending nothing" right up to the moment
everything stops.

So burn rate is derived from consecutive readings of the provider's own usage
figure, stored in `provider_spend_snapshots` (migration 027). Two samples an
hour apart are needed before it will report a rate; under an hour it says so
instead of extrapolating noise.

It runs as part of `alerting-run.js`, which is the intended cadence — each run
records a sample, and a burn rate is only as good as its sampling.

---

## The compounding loop

Three things make the agent better at *this* business over time. All three now
run; none of them did a week ago. If any one stops, the product stops
improving and starts being replaceable.

| Loop | Where a human touches it | What it produces |
|---|---|---|
| Corrections | "Improve this reply" on any agent message | a priority-100 memory that outranks the document it corrects |
| Gaps | the Brain page, top section | a `faq` memory phrased the way customers actually ask |
| Measurement | the dashboard home panel | autonomous-resolution rate, and its direction |

```bash
node infra/scripts/run-outcome-ledger.js   # also runs inside alerting-run.js
```

Closes conversations that have gone quiet, splits them into *autonomous* and
*needed a human*, and materialises the ledger. Every write is idempotent, so
running it twice changes nothing and running it late loses nothing. 2 seconds
across 53 orgs.

Two rules this deliberately obeys, because breaking either turns the headline
number into a lie:

- **An escalated conversation is never closed by going quiet.** It is waiting
  on somebody. Closing it would count an unmet obligation as a success.
- **`resolved_at` is the last message time, not the sweep time.** Otherwise a
  missed run shifts every recorded close time and the reported numbers change
  on re-run — a customer's ROI must not depend on cron punctuality.

`CONVERSATION_QUIET_HOURS` (default 24) is how long silence must last before a
conversation counts as finished. Lower it and you will inflate the rate by
counting customers who were merely asleep.

### What the impact number may and may not claim

`GET /api/impact` reports teaching and trend side by side and never multiplies
them into a claim. Without a holdout arm there is no control group, so the
strongest honest statement is *"these moved together"*. The response says so
explicitly in `causal.comparisonAvailable`, and the UI prints the caveat rather
than burying it.

A holdout means deliberately withholding the agent from a slice of real
customers. That is a decision a business makes, never a default a script turns
on — `holdoutPercent` stays 0 unless someone asks for it.

---

## Monitoring

```bash
node infra/scripts/alerting-run.js
```

Five probes; any failure exits non-zero.

| Probe | What a failure means |
|---|---|
| queue lag | Running workflows above `QUEUE_LAG_MAX` (default 50), or Temporal/Nango-redis unreachable. Work is arriving faster than the worker drains it. |
| connector 401s | Connector auth failures in container logs over 24 h. A customer's Gmail/HubSpot token has expired. |
| RLS job | Tenant isolation is not enforced for `darex_app`. **Stop and investigate before anything else.** |
| Langfuse ingest | Traces are not being recorded. The product still works; you are flying blind on quality. |
| spend guard | Under a day of LLM budget at the current burn, or the balance is already gone. |

Run it on a schedule — hourly is enough, and it costs nothing but a few
database queries and one HTTPS call.

---

## What actually breaks, in order of likelihood

### 1. The LLM balance runs out

By a wide margin the most common outage, and the one that hurts most, because
it presents as **silence** rather than an error. Observed: the balance reached
zero mid-run and 11 of 12 test conversations got no reply at all.

**Detect:** `spend-guard.js` days ahead; `preflight.js` immediately.

**Fix now:** top up at <https://openrouter.ai/credits>.

**Fix properly:** add a second payment rail, so one empty wallet cannot take
every tier down at once.

```env
# infra/.env — either or both. Absent keys are skipped instantly by the router,
# so adding nothing breaks nothing.
DEEPSEEK_API_KEY=...   # platform.deepseek.com
GROQ_API_KEY=...       # console.groq.com — has a real free tier
```

The chain is ordered so that consecutive tiers never share a failure mode:

| Tier | Model | Survives |
|---|---|---|
| 1 | `deepseek/deepseek-chat` via OpenRouter | normal traffic |
| 2 | `openai/gpt-4o-mini` via OpenRouter | a single vendor's outage |
| 3 | `nvidia/nemotron-3-ultra:free` via OpenRouter | an empty OpenRouter balance |
| 4 | `deepseek/deepseek-chat` direct | OpenRouter being down entirely |
| 5 | `groq/llama-3.3-70b-versatile` direct | having no payment method at all |

Tiers 1–3 bill the same account, so tiers 4 and 5 are what make this a real
failover rather than three models on one exhausted balance.

### 2. The knowledge base is empty, or the wrong things are in it

The agent is working correctly and has nothing to answer from. `preflight.js`
reports the document count; an empty base is a warning, not a blocker, because
"I don't know" is the correct answer to a question with no source.

Upload through the dashboard's Brain page. PDF, DOCX and plain text are
supported; a scanned PDF with no text layer is reported as such rather than
ingested as an empty document.

### 3. A tenant's connector token expires

Surfaces as `connector 401s`. The agent says it cannot reach that service
rather than inventing an answer. Reconnect from the dashboard's Connections
page.

### 4. Docker Desktop stops

On Windows this happens on session teardown. `infra/scripts/harden-run.sh`
restarts the engine and resumes from the last completed case, because an
interrupted process is not a test failure.

---

## Retrieval: know which engine answered

```
RETRIEVAL
  [WARN]  semantic search is OFF — EMBEDDING_MODEL is empty — retrieval is keyword-only
  [ -- ]  no document embeddings — keyword search only (1126 documents)
```

On the reference deployment **0 of 1126 documents carry an embedding**, because
no embedding provider key is set. Retrieval ranks by
`0.4 × keyword + 0.6 × vector`, so that second term contributes nothing and the
system runs on full-text search alone.

It answers well that way — but nobody should describe this configuration as
semantic search. To turn it on:

```env
# infra/.env
GEMINI_API_KEY=...                       # the embedding route in litellm/config.yaml
EMBEDDING_MODEL=text-embedding-3-small
```

Then backfill: existing rows stay unembedded until they are re-ingested, and
`preflight.js` reports the percentage so a partial backfill is visible rather
than assumed.

`EMBEDDING_MODEL=` (explicitly empty) is the supported way to disable
embeddings. Leaving it unset in production is a fail-fast error instead, so a
missing variable can never silently degrade retrieval.

---

## Tenant isolation

Row-level security is enabled and **forced** on every tenant table, including
`orgs` itself. Forced matters on its own: without it the table owner skips the
policy, so the configuration reviews as protected and protects nothing.

```bash
node infra/scripts/check-orgs-rls.js   # 14 checks, database-level, no tokens
```

It asserts both halves — that a tenant cannot see, name, or write a neighbour,
and that the flows which legitimately run *before* any tenant context exists
still work. That second half is what keeps the first half deployed: a policy
that breaks signup gets reverted within a day, and then the hole is permanent.

Those flows go through named, individually granted `SECURITY DEFINER`
functions, each returning a single id and never a tenant attribute:

| Function | Used by |
|---|---|
| `org_provision(name, slug)` | signup, before a context can exist |
| `resolve_org_by_webhook_secret(secret)` | inbound webhook routing |
| `org_resolve_by_id_and_secret(id, secret)` | the `?org_id=&token=` webhook form |
| `resolve_active_org(id)` | confirming an org id from a header |
| `single_active_org_id()` | single-tenant convenience; NULL once a second org exists |

Anything else touching `orgs` must be scoped to the session's org.

---

## Cost

Ask the deployment rather than trusting a figure from a document:

```bash
node infra/scripts/spend-guard.js
```

It reports balance, burn per day, runway in days, and cost per LLM call —
derived from the provider's money and LiteLLM's call counts, because neither
source can produce it alone. It also prints the tier mix over 24 hours, and a
shift toward the free tier is the earliest visible sign that the paid tiers are
failing.

Note that one customer conversation is several LLM calls: the agent turn, any
tool-calling turns, the critic, and a revision if the critic blocks.

---

## Backup and restore

```bash
bash infra/scripts/restore-drill.sh
```

See [infra/scripts/restore-drill.md](infra/scripts/restore-drill.md). Run the
drill on a schedule — an untested backup is a belief, not a backup.

---

## Environment files

Three files are read, and a variable set in more than one is a real hazard:

| File | Purpose |
|---|---|
| `.env` | repo root, shared defaults |
| `apps/dashboard/.env.local` | dashboard-only overrides |
| `infra/.env` | compose substitution **and** the `env_file` for the containers |

Two rules, both enforced by `infra/scripts/lib/env.js` and reported by
`preflight.js`:

- **Within a file, the last occurrence wins** — matching Docker Compose.
  `OPENROUTER_API_KEY` is currently declared twice in `infra/.env`, empty on
  one line and real on the other, so which value reaches production depends on
  line order.
- **An empty value never shadows a real one across files.** Every consumer
  treats `""` and unset identically, so a leftover placeholder must not
  disable a credential that is correctly set elsewhere.

Both conditions are reported rather than silently repaired, because a
credential whose value depends on line order is a landmine either way.

Never commit any of these files. `infra/.env` is gitignored; confirm with
`git check-ignore -v infra/.env`.

---

## Escalation

1. `node infra/scripts/preflight.js` — is anything blocking right now?
2. `node infra/scripts/verify.js` — is the build itself sound?
3. `docker compose -f infra/docker-compose.yml logs --tail 200 worker dashboard`
4. Temporal UI at <http://127.0.0.1:8080> — a stuck workflow shows its exact
   failing activity and its retry history.
5. Langfuse — the full prompt, tool calls and reply for any conversation.

If the RLS probe fails, stop and investigate that first. Everything else can
wait; tenant isolation cannot.
