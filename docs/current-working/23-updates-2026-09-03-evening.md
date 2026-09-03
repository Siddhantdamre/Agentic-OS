# 23 — Updates, 3 September 2026 (evening)

Changelog for `66c2974` → `962a8e7`. Written from `git`, live source, container
logs, and queries run against the running database.

Callers: indexed from [README.md](./README.md). Not imported by application code.

---

## Scope

Four commits, four defects. Every one of them was a **declaration that did not
match reality** — a tool the agent was told it had, a role vocabulary that never
met itself, a risk field read by nothing, and three checks asserting on a message
the product had labelled as provisional.

| Commit | Subject |
|---|---|
| `0b18297` | a tool declared to the agent with an action that does not exist |
| `2cd6747` | three of the five employees a new workspace gets could never do standing work |
| `962a8e7` | four gate failures that said the answer was wrong when the answer had not arrived |

---

## 1. The flagship trio could never do standing work

There are **two role vocabularies** in this product and nothing made them meet.

| source | role string |
|---|---|
| pack manifests | `Sales / front-of-house` |
| dashboard `DEFAULT_ROSTER` | `Sales & Lead Gen` |

`dutyForRole` is an exact string match. The duty table read as complete — eight
duties covering all six pack roles — while three of the five roles a **brand-new
workspace** is seeded with matched nothing in it:

```
Sarah    Sales & Lead Gen        -> NO DUTY
Emma     Customer Support        -> NO DUTY
Marcus   Marketing & Analytics   -> NO DUTY
Research Research                -> ok
Finance  Finance                 -> ok
```

`DEFAULT_ROSTER` is not a fixture. `/api/employees` inserts it whenever an org
has no employees, so Sarah, Emma and Marcus are the first employees any new user
ever sees — and they were exactly the employees the duties feature was built to
rescue. From `duties.ts`'s own header: *"an employee with no inbound traffic did
nothing at all, forever."*

Duties now carry an explicit `aliases` list. **Aliases, not normalisation**: the
tempting fix is to strip punctuation so both strings reduce to "sales", but a
duty is a standing instruction to act on a real business's data unattended, and a
similarity test is how an employee ends up doing a job nobody assigned it. The
tests assert `Sales Engineer` and `Analytics` still resolve to nothing.

`check-duty-coverage.js` starts from the other end: it enumerates every role
string the product is **capable of writing** into `ai_employees` and asserts each
resolves. Reading the duty table could never have caught this — the table looked
complete throughout.

---

## 2. A tool declared to the agent that it could not call

95 tools are declared in `mcp-bridge.ts`, each naming a provider key and an
action. Both are plain strings, so the compiler checks neither.

`file_ops` was declared with `action: 'auto_execute'` — an action the module has
never implemented. It survived because the bridge special-cases `file_ops` and
reads the action from the caller instead, so the declared action was simply dead.
A dead declaration is indistinguishable from a working one until somebody removes
the special case not knowing it is load-bearing.

Also removed: `toolDef.risk` and `toolDef.confirm`, assigned at registration and
**read by nothing**. Dead fields that look like a permission control are worse
than no fields — a reader assumes the bridge classifies risk and stops looking
for where it really happens. Worse, they were computed from the *declared*
action, so `file_ops` resolved as `read` whether the call wrote a file or not.

Risk is enforced in two live places, both seeing the real action:
`mod.risk(action)` at execution time, and `planRequiresDurableExecute` choosing
Temporal over HTTP.

`check-tool-declarations.js` covers the class. **It also asserts its own
arithmetic, because the first version did not**: it reported 6/6 while verifying
90 of 95, because its import regex required the braces to hold exactly one name,
so `import { mls, realestate } from './realestate/…'` resolved to nothing. A
checker with a blind spot shaped like the bug it hunts is worse than no checker.

---

## 3. Four gate failures that blamed the answer for being late

The full gate reported `NOT SOUND — 4 of 67 suites failed`, all with one
signature:

```
[FAIL] answer contains the uploaded fact ("Bay 70")
       — Just checking that for you — I will have an answer shortly.
```

The product was right the whole time. That sentence is the **interim
acknowledgement**, and `reply-gate.ts` is explicit that it is *"an interim
message, NOT a fallback. The real answer still follows when it lands."*

Measured on the live database: **45 of 47** interim acks were followed by a real
answer.

Three e2e checks waited for the first new assistant message and asserted on it.
They read the ack, found no facts in it — there are none in it by design — and
reported the answer as wrong. That sends an operator to debug retrieval when the
truth is latency.

`lib/await-reply.js` is one helper, not three copies. It skips the documented
ack, reads the ten most recent assistant rows rather than the newest one (the ack
and the answer can land inside one poll interval), and distinguishes the two ways
of getting nothing:

| outcome | meaning |
|---|---|
| saw an ack, no answer | **latency** — names the free tier's measured 28–38s |
| no assistant row at all | the agent never replied; nothing was produced |

All three green after the fix, with the evidence in the output:

```
check-upload-e2e       8/8   "agent replied — 88.0s, after an interim ack"
                             answer carried the uploaded fact "Bay 10"
check-e2e-agent-reply  8/8   "59s, after an interim ack"
check-upload-formats   6/6   PDF and DOCX facts both carried
```

---

## The model tier, measured

Why the ack now fires on nearly every turn. Timed inside the worker container,
same request, twenty-token reply:

| model group | served by | latency |
|---|---|---|
| `atomic-agent-fallback` | gpt-4o-mini (paid) | **2 s** |
| `atomic-agent` | nvidia nemotron **:free** | **28–38 s** |
| `atomic-agent-deepseek` | nvidia nemotron :free | 27 s |

A hypothesis worth recording because it was **wrong**: a single sample suggested
the `reasoning: { enabled: false }` parameter caused a hang. Six repeats showed
28–32 s with it and 36–38 s without — the field is innocent, and the free model
is simply slow. One sample would have produced a confident wrong commit.

### The failover chain is shorter than it looks

From LiteLLM's own logs: `DEEPSEEK_API_KEY` and `GROQ_API_KEY` are **unset**, and
the router still dispatches to both tiers and takes 401s — with two retries and a
cooldown on each. `atomic-agent-groq` is the chain's terminal link and has no
fallback after it:

```
No fallback model group found for original model_group=atomic-agent-groq
Available Model Group Fallbacks=None
```

So a chain that reads five deep is really three deep and ends in a guaranteed
error. Not fixed here: it needs credentials, which are the operator's to set.

Also in the hot path of every call: `success_callback: ["langfuse"]` pointing at
`darex-langfuse-server`, which has been exited for 22 hours. Every request logs
an error to a dead host.

---

## The day the disk filled

`C:` reached **0 bytes free** mid-session, which failed tool calls with `ENOSPC`
and wedged the Docker daemon — `docker info`, `docker ps` and `docker volume ls`
all returned nothing.

Worth writing down, because the empty listings looked exactly like total data
loss and were not: **a daemon that does not answer returns the same empty output
as a daemon with nothing to report.** `docker_data.vhdx` was intact at 96.1 GB
throughout. After clearing 17.5 GB of Windows temp and restarting Docker Desktop,
all thirteen containers came back healthy with every volume attached, and the
database was unchanged — 75 orgs, 721 conversations, 807 agent actions, 1,149
memory rows.

Two things were noticed on the way back up: two employees are stuck in
`provisioning` status from the crash, and Docker's VHDX is 96 GB against 8.9 GB
free on the host.

---

## State at the end of 3 September 2026

**Verified:**

- Web search works with no credential; deep research retrieves and cites
- 4 of 4 previously-failing gate suites now pass, with their evidence quoted
- 95 of 95 tool declarations resolve to a real module and a real action
- 11 of 11 creatable roles resolve to a duty
- 29/29 duty tests, 547+ workflow unit tests, typecheck clean
- 57 checkers, none silently outside the gate

**Open, and the operator's to close:**

- `DEEPSEEK_API_KEY`, `GROQ_API_KEY` unset — two dead links in the failover chain
- Paid tier answers in 2 s; the free tier serving today takes 28–38 s
- pnpm not installed, so the two CI-parity suites cannot run
- Langfuse callbacks in the hot path of every model call, pointing at a dead host
- 61 of 65 tools waiting on credentials; Nango holds 0 configs
- No deployment, no customers. The workspace is seeded and labelled DEMO
