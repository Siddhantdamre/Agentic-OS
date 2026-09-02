# 19. A market fact carries its source, or it does not exist

**Status:** Accepted

## Context

An agent reading only internal rows can tell you a lead went quiet. It cannot tell you
the lead went quiet in the month stamp duty changed, and that second half is the
difference between a report and business intelligence.

So every employee needs the market it is working in. That is also the fastest way to put
a confident wrong number in front of a customer: a model handed unattributed context
treats it as its own knowledge and states it flatly. For a broker, an invented stamp-duty
rate is not an embarrassment, it is a liability.

## Decision

Market facts live in `org_memory` under `kind='market'`, and **every one carries its
source**. The source is shown to the model alongside the fact, with an explicit
instruction to name it in any sentence that relies on it.

Enforced twice, deliberately:

- `market-context.js` refuses an unsourced fact at write time.
- Migration 045 adds a CHECK constraint, so nothing that can `INSERT` into `org_memory`
  can bypass the script. A script is a convention; a constraint is a rule.

Scoped to `kind='market'` only. A summary, an FAQ or an SOP is the business describing
itself and needs no external provenance; a claim about the world outside does.

Every employee receives the **same** briefing. A sales agent and an ops analyst reading
different facts about one market is how two people in a company reach opposite
conclusions and both cite "the data".

The briefing is composed inside `planDuty`, not by callers. Two callers already built
the agent message themselves, so adding context to one would have silently left the
other blind — the same shape as the defect where six employees ran duties and none
reached the ledger.

## Consequences

Empty context produces an empty string, not "market context: none available". An agent
told it has no context apologises for that in the answer; an agent told nothing simply
answers from what it has.

Someone must curate the facts. That is a real cost and the right one: the alternative is
an agent inferring market conditions from its training data, which is stale, unsourced,
and unfalsifiable.

## What breaks if you remove it

Agents answer market questions from model priors with no citation, and nobody reading the
answer can tell which parts are grounded. The first wrong stamp-duty figure sent to a
buyer is indistinguishable from a correct one until it matters.

## Evidence

Verified end to end, 2 September 2026. An operator recorded three sourced facts; Sarah was
asked what stamp duty a female buyer pays in Thane and answered:

> "A female buyer in Thane pays 5 % stamp duty on the agreement value, plus 1 % metro cess
> (per igrmaharashtra.gov.in), and a registration fee of 1 % capped at ₹30,000 (per our
> policy)."

Two claims, two attributions — one to the government registry, one to the org's own policy.

With the same facts loaded, Sarah's *duty* output was byte-identical to before, because
stamp duty does not bear on "who asked and never got an answer". Unchanged output looked
like a bug and was checked rather than assumed.

`duties.test.js` 23/23, including that an unsourced fact never reaches the agent and that
every runnable employee receives an identical briefing. Commit b8c6303.
