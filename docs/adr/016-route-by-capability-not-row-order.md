# 16. Work is routed by capability, never by row order

**Status:** Accepted

## Context

Inbound employee selection was one query:

```sql
SELECT id, name, role, persona, tool_allowlist FROM ai_employees
 WHERE org_id = $1 AND status = 'active' LIMIT 1
```

No `ORDER BY`, no role match, no capability match. Every inbound message went to
whichever row the planner happened to return first, so there was no routing at all.

The effect had been sitting in the data for months and nobody read it that way. In the
demo workspace one employee held every recorded action and the other eight held none —
0 actions and 0 threads each — while their tool allowlists described them as
specialists in different things. Nothing failed. No test went red. The roster looked
staffed, the permission model was genuinely enforced, and the throughput of eight
employees was zero.

Without an `ORDER BY` it was not even a consistent arbitrary choice: the same message
could route differently across replays.

## Decision

Route on the one capability signal available before a model runs — the channel the
message arrived on, which the allowlist already encodes. Prefer an employee holding
that channel's tool, then the broader allowlist, then oldest first so the choice is
reproducible.

An unmatched channel still reaches somebody. Losing an inbound customer message is
worse than routing it imperfectly.

This is deliberately not a skills model. It does not read the message. It removes the
case where work lands on an employee that provably cannot do it, and nothing more.

## Consequences

Routing is now reproducible, which means it is testable — the same message selects the
same employee on replay.

It is still coarse. Two employees who both hold `whatsapp` are separated only by
allowlist breadth and age, which is arbitrary in a different way. That is acceptable
because the failure it prevents is categorical (an employee that cannot work the
channel) and the one it leaves is a preference.

## What breaks if you remove it

One employee per workspace silently absorbs all work while the rest sit idle, and the
roster becomes decoration. The symptom is invisible in every test, because each test
creates its own fixtures and never asks whether work is distributed the way the design
claims.

## Evidence

`infra/scripts/check-inbound-routing.js` — 7/7, registered in `verify.js`. It proves
the ordering where position and capability disagree: an email routes to the Gmail
holder even though that employee is the newest and narrowest in the workspace.

Commit 232308d.
