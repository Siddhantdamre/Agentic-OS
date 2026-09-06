# Debug session — what was found and what was fixed

Branch: `siddhant/debug-session-two`
Base: joined with `DarexAI-AI-Startup/Agentic-Os-SaaS@7f9953e`

Every number below was measured on the running stack, not estimated. Where a
fix is unverified, that is stated rather than glossed.

---

## The one-line summary

Fourteen defects, all of the same family: **the software knew something true and
told the user something false.** Not crashes — crashes are easy, they announce
themselves. These were confident, plausible, wrong answers, which is the only
failure mode that actually costs a customer.

The gate went from 71/74 to 72/74 passing. 617 unit tests pass. Two suites still
fail on model capacity, not code.

---

## 1. The reply gate was deleting the customer's own products

The mechanism filter carried `\w+\s+table\b`, meant to catch a leaked database
identifier like `billing_invoices table`. It matches **any** word before
"table", and stripping is sentence-level. So on a furniture retailer:

```
"Our solid oak dining table seats six and is priced at 45,000 rupees."
  ->  ""
```

Coffee table, side table, console table, dressing table — every sentence
silently deleted, on the tenant whose entire catalogue is furniture. The
completion suite stayed green throughout, because none of its six seeded facts
name a table product.

It surfaced from a test written to prove the *opposite* point: that a newly
added rule would not do this.

**A gate that deletes correct answers is worse than the leak it prevents.** The
leak is visible in a transcript; the deletion is not.

---

## 2. Silence after promising an answer

A slow turn sends an interim acknowledgement — "Just checking that for you, I
will have an answer shortly." That is a promise. Measured, conversation
`28f8fa06`:

```
23:18:16  customer   What was your total revenue last financial year?
23:18:47  assistant  Just checking that for you — I will have an answer shortly.
          (nothing, ever)
```

Cause: a child agent turn that **threw** hit the catch block and sent a service
apology. One that **returned** `success: false` marked needs_attention and
returned `savedByWorkflow: true` with `replyMessage` undefined — so the workflow
saved nothing, the caller trusted the flag and saved nothing, and nobody
noticed.

Both paths now speak. `check-never-silent.js` pins it, and allows silence only
for a deliberate human handoff (`human_dispatch`, `hitl_rejected`), never for an
agent failure.

---

## 3. "We found nothing" vs "we could not look"

Three separate instances of the same bug, each of which made the product state a
falsehood about the business:

**The decision brief.** Both halves were wrapped in `catch { internal = []; }`.
An empty list is indistinguishable from an empty workspace, so a database
timeout produced:

> *"this workspace holds no data of its own on the question … Upload the
> relevant policy or records and ask again."*

Their records may be complete. They were told their business knows nothing about
its own pricing, then sent to re-upload files they already had, because of an
outage nobody mentioned.

**Fact extraction.** `if (out.error || !out.content) return []` — a failed model
call read as empty records. The brief contradicted itself in one output:

```
NO RECOMMENDATION — Nothing was found on either side.
Based on 4 of your records, most recently updated today.
```

Four records retrieved, nothing found. Only the freshness line gave it away.
Fixing it immediately surfaced the true cause of a live run — `not_configured` —
which had been invisible behind the empty list for as long as it existed.

**Gmail.** `fetchRealGmailMessagesFull` returned `[]` both for an empty inbox and
for a failed call, and all four call sites then reported:

```
status: 'executed'
message: "Fetched 0 real live emails from connected Gmail account"
```

On an outage the tool reported **success** and zero email, and the agent told the
owner their inbox was empty. An owner who acts on "you have no new enquiries"
loses real business, and nothing would ever show Gmail had been down.

---

## 4. A business's own records contradicting each other

Conflict detection compared internal against **external** only. A workspace
holding a January policy handbook saying installation takes 7–10 days and a
March price list saying 3–4 produced two unrelated facts, side by side, with
nothing saying they cannot both be true.

A reader takes whichever they saw first. An agent quoting from it promises four
days on a ten-day job.

Internal disagreement is *more* common than internal-versus-market: every
business has a policy PDF, a website, a price list and a sales email last
reconciled at different times. It is also easier to act on, because both sides
belong to the owner. So each side now names its document:

```
installation lead time: your own records disagree —
policy-handbook-january.pdf says 8.5 days, price-list-march.xlsx says 3.5 days.
```

**This is the company register's I-15**, listed as open. It is closed here.

---

## 5. Numbers compared without their units

`comparable()` required a value and a subject and never looked at the unit. An
internal "2 percent" and an external "150000 INR" about the same subject were
compared as bare numbers, and the claim line rendered the external number using
the *internal* unit:

> *"your records say 2 percent, the market says 150000 percent"*

A number nobody wrote, in a unit nobody used, shown to an owner as a
disagreement to act on.

Comparison is now unit-aware and reconciles scale rather than refusing it,
because this market writes money three ways: **51,000 / 0.51 lakh / 0.0051
crore** are one amount, and a unit-blind check calls two of them a 100× error.

The first version of the rule blocked whenever *either* side lacked a unit, and
was wrong — research findings usually carry none, so it silently stopped
comparing almost everything and three existing tests went from `conflict` and
`recommendation` to `withheld`. Refusing to compare is not the safe default it
looks like; it moves the failure somewhere less visible.

---

## 6. The evidence had no date

The brief sets a business's own records beside today's market data and compares
them as peers — only fair if they are contemporaneous. An eighteen-month-old
price list against a figure scraped this morning yields a confident "you are
under market" that is really just elapsed time, and it reads exactly like
insight.

Retrieval had *always* computed this: every memory query selects `updated_at`
and a `stale` flag. Nothing carried it to the reader. Now printed directly under
the verdict, taken from the database rather than asked of a model.

---

## 7. The agent did not know which business it worked for

The first line of every system prompt was, literally:

```
You are Kabir, an AI employee of the DarEX organisation
00dc55bd-4063-47e2-8aa1-5350202f6863.
```

A UUID. Nothing said the business sells furniture, or houses, or what it is
called — although the onboarding wizard collects exactly that and `orgs` /
`org_onboarding` have held it all along.

That is the cause beneath a symptom already in the multi-turn results: the agent
asking a **customer** for the business's own showroom address. It was not being
evasive. It did not know where it worked.

Identity now comes first, before role, persona and tools, because everything
after it depends on it — "our delivery area" is meaningless until you know
whose. It degrades honestly: an unnamed workspace gets no invented industry,
since a guess would make the agent answer as the wrong kind of business.

---

## 8. The agent was never told the standard it was marked against

`infra/scripts/quality-rules.js` scores every reply against ten mechanical rules
— money symbols, thousands separators, answer-first, no hedging, no markdown,
length, truncation. The system prompt's entire guidance on quality was:

> *"Keep replies professional, warm and natural."*

The standard existed only in the marking scheme. Agents were graded on rules
they had never seen and corrected after the fact by a gate that strips their
output. A model will write "₹2,500" instead of "2500 rupees" if told once.

The personas had the mirror problem: all six were prohibitions and nothing else
— *never invent pipeline amounts / order status / KPIs / inventory / a booked
slot / price, area, or RERA*. No definition of a good answer anywhere. **An
agent told only what not to say optimises toward saying little**, and
safe-but-empty is exactly the GAVE UP column the completion suite counts.

Every prohibition kept; each role now also states what outstanding work from
that role contains. `check-output-standard.js` pins the two together and
**failed on its first run** — `no_internal_terms` and `no_internal_ids` were
scored but taught nowhere. That is the drift it exists to catch.

---

## 9. The owner's screen was our architecture diagram

The reply gate stops an agent telling a *customer* about databases and tools.
Nothing applied the same rule to the dashboard, and it had drifted further than
the agent ever did:

```
login page     "Phase 3 Ready • Postgres RLS • Self-Hosted Stack"
integrations   "Nango Connector Execution Drawer"
connectors     "Nango Tenant Isolation Credentials"  "Idempotent Temporal Activity"
insight        "From Langfuse traces for this org."
```

Nango is our OAuth broker. A furniture retailer connecting Gmail has no idea
what that is. The **login page** announced our build phase and our database's
row-level security to prospects before they signed in.

Two were real bugs rather than wording: the webhook field printed
`http://localhost:3000/...` — a dead address on any real deployment, in the one
field that exists to be copied — and the Nango connection id was shown to users.

15 user-visible internal terms → 0, with a gate check and four reviewed
exceptions. The test is **who is reading**, not whether a word sounds technical:
"Webhook URL" stays, because a developer wiring up their own provider needs
exactly that word.

Audited alongside and found **not** broken, so left alone: every button is
wired. 138 buttons, 137 handlers, zero stubs or TODOs, and every `/api` path a
component fetches resolves to a route.

---

## 10. A vendor outage was deleting customers' documents

Ingestion computed every vector **before** writing any row, so when the
embedding provider was down the throw happened first and nothing was stored. The
customer's uploaded file simply never became knowledge.

Every other layer was already built for a missing vector: retrieval is hybrid
and handles it explicitly (`WHEN em.embedding IS NULL THEN 0`), the column is
nullable, 858 of 1,227 rows have no vector, and `backfill-embeddings.js` exists
to fill them. Ingestion was the only layer treating it as fatal.

With the embedding provider entirely unavailable:

```
[PASS] PDF landed in org_memory — null_embedding=true
[PASS] PDF answer carries the uploaded fact ("WRNTY-9692")
[PASS] stored without an embedding, as designed
```

Also: a spent daily quota was retried through three stacked layers (activity
loop × Temporal's 5 attempts × LiteLLM's 2) against a quota that cannot clear
today — 732 RateLimitErrors in one 15-minute window — and marked the job
`failed`, removing it from the queued sweep permanently. Now requeued.

**Deliberately not done:** failing over to a second embedding provider. Vectors
from another model live in a different space and are not comparable to rows
already indexed, so a "failover tier" would leave cosine similarity quietly
returning nonsense. Chat can fail over between vendors; an embedding index
cannot unless every row is re-embedded together.

---

## 11. A canned reply read as a tenant isolation breach

The e2e isolation check asked whether a reply's exact text appears in another
workspace's messages. Sound for an answer built from a tenant's own records —
two workspaces cannot independently write the same sentence about their own
pricing. Nonsense for a constant.

The never-go-silent fix (§2) made every failing turn emit the identical *"Sorry
— I'm having trouble getting to that right now"*, so the same string
legitimately appeared in dozens of workspaces and the gate reported a **tenant
isolation breach**. That is the most alarming thing this gate can say and it was
wrong, which is worse than saying nothing: an operator who chases a false alarm
once will not chase the real one.

Self-inflicted, and worth recording as the cost of §2.

---

## 12. Cost and latency: 30,022 → 23,949 prompt tokens per turn

A turn asking *"3 seater sofa price?"* sent **30,022 tokens**. The obvious
suspect was the 95 advertised MCP tools — and measuring proved that wrong: the
35 then-advertised tools accounted for only ~3,600.

The bulk is **skills**. 46 ship by default, 116,732 characters of `SKILL.md` ≈
32,000 tokens, paid on every single message — including `apple-notes`, `ffmpeg`,
`imagemagick`, `docker` and a weather lookup, on a furniture helpline. Disabled
14 that cannot apply to a business helpline in a Linux container; kept every
business playbook. **Measured drop: 6,073 tokens, 20%, on every turn forever.**

Separately, the tool list went 95 → 35 by not advertising connectors this
deployment has never configured — those can only ever answer `notConnected`, so
they cost prompt tokens and worse tool selection for nothing.

And each reply reserved **8,192 output tokens**. OpenRouter charges against
*reserved* max_tokens, not tokens used:

```
402 "You requested up to 8192 tokens, but can only afford 4340"
```

A two-sentence reply refused for budget it would never spend. Capping at the
router did nothing — LiteLLM treats `litellm_params.max_tokens` as a default an
explicit request overrides — so it had to be set at source
(`ATOMIC_AGENT_LLAMA_MAX_TOKENS`). That 402 is gone.

---

## 13. Testing: eight customers instead of eight assertions

Every existing suite asks one question and checks the answer contains a string.
That measures mechanics, and mechanics were never in doubt. Nothing measured
whether **the person on the other end got what they came for.**

`infra/scripts/journey-suite.js` runs eight people, each with a different reason
for writing and a different definition of being served: `rushed`, `anxious`,
`comparison`, `angry`, `codemix` (Hindi-English), `prober`, `vague`, `b2b`.

Each declares what it needs and what would **lose** it. A red flag is terminal
regardless of what else the reply got right, because that is how a customer
treats it: quoting the price correctly and inventing a discount in the same
message is not a partial success, it is a refund and a bad review.

Ships with `--self-test`, which grades known-good and known-bad replies with no
database, no network and no model call. **It caught a bug in its own grader on
the first run**: the `comparison` red flag matched inside its own negation, so
the correct reply *"I cannot match that offer, but…"* scored as a lost customer.
A grader that punishes the right answer is worse than no grader — and that was
the third appearance of this bug class in this repo.

`infra/scripts/seed-minimal-business.js` seeds a workspace small enough to hold
in your head: 18 facts, 5 policies, 10 customer messages, 4 tasks, and **three
deliberate contradictions**, each with a date and a source. Anyone can build a
knowledge base where retrieval finds the one right answer; nobody demonstrates
what happens when a business's own records disagree, which they always do.

---

## 14. The machine itself was the bug

`C:` had **0.4 GB free of 455 GB**, and Docker's virtual disk was 96 GB of it.
The daemon had stopped responding entirely — `context deadline exceeded` on ping
— so builds and agent turns were failing in ways that looked like code problems
and were not.

Reclaimed without admin: cleared caches, `wsl --shutdown` released swap and
mapped files, enabled **sparse mode** so future frees return automatically,
pruned 21.59 GB of build cache and 7.13 GB of images. **0.40 → 4.41 GB free**,
with no volumes touched — 110 orgs, 1,787 messages and 1,227 memory rows all
verified present afterwards, all 14 services healthy.

The last ~60 GB needs Administrator: pruning frees space *inside* the virtual
disk, and only compacting returns it to Windows. `infra/scripts/reclaim-docker-disk.ps1`
does it, attaching the disk **readonly** so compaction cannot write to the
filesystem, and deliberately omitting `volume prune` — that is where the
database lives.

---

## What is still not working, plainly

**Conversational agent turns.** 23,949 prompt tokens against the available
key's ~8,400 ceiling means every customer message falls back to the service
apology. A 20% trim was real and is not close; **no further trimming closes a
15,000-token gap.** Two gate suites (`document upload`, `upload formats`) fail
for this reason and this reason only — every failure line is the fallback reply
working correctly.

The blocker is commercial, not technical, and it is precise:

| key | account | state |
|---|---|---|
| `…0e877252` | **paid** (`free_tier: false`) | key cap **$2**, remaining **$0** |
| `…3f510934` | free, never purchased | usable but free-tier ceiling |
| `…e09d3fa5` | free, never purchased | unusable |

Account funding and per-key cap are two separate settings.
`infra/scripts/check-openrouter-key.sh` answers both in one second.

**The decision brief works today** and was run end-to-end against the seeded
contradictions — it surfaced both sides and correctly withheld a
recommendation. That is a demonstrable feature right now.

**Langfuse trace persistence** remains the one advisory gate failure, matching
the company register's I-01: `langfuse-redis` and ClickHouse unreachable.

---

## Reconciliation with the company known-issues register

Four issues the register lists as open are closed on this branch, verified
against the gate run of the same commit:

| Register | Gate result |
|---|---|
| **I-02** SSE single-process, second replica misses events | `two-replica SSE` PASS · `realtime bus` 6/6 |
| **I-11** No spend budgets at execution | `per-tenant budget` 17/17 · `budget gate wired` 7/7 |
| **I-13** No automated RLS-policy check | `tenant registry isolation` 14/14 · `tenant scope lint` PASS |
| **I-15** Conflicting facts silently average | conflict is a finding, never averaged (§4) |

**I-15 is the one to notice.** It describes, almost word for word, the failure
this session spent its time on — and it is still marked open. Someone was going
to solve it twice.

Their **I-23**, *"Goldens exist but block nothing"*, is the interesting
difference in the other direction: this branch has 74 gate suites that do block.

## What the company has that this branch should take

The merge resolved 110 add/add conflicts to ours, on measurement: across the 93
conflicts this session never touched, ours had **2,748** lines theirs lacked and
theirs had **434** ours lacked. Those 434 are deferred, not discarded. Worth
reviewing individually:

- `3c82918` — log swallowed errors in plan updates, rollback, langfuse traces.
  **Take this one.** It is the same "do not swallow errors" instinct as §2 and
  §3; both sides reached it independently.
- `e04a52d` — dashboard port hardcoded in auth check script.

Already present here in evolved form: `4966b9a` (pre-push typecheck guard),
`ea2740c` (memory write-back embedding no-op).

---

## The through-line

Ten of the fourteen defects share one shape: **a failure was reported as a
fact.** An empty list meant "no records" instead of "could not read". A `[]`
meant "no email" instead of "Gmail is down". A stripped sentence meant "nothing
to say" instead of "we deleted your answer". Zero tools meant "nothing to do"
instead of "you hold none".

None of them crash. All of them are confident. That is why they survived a
73-suite gate and 600 unit tests — the tests asked *did it answer*, and the
answer was always yes.

The rule that came out of it, and the one worth keeping:

> **Distinguish "we found nothing" from "we could not look" — everywhere, every
> time.** They are different sentences to a user, they need opposite responses,
> and conflating them is how software becomes untrustworthy while every test
> still passes.
