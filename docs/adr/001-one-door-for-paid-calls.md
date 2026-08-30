# 1. Every paid model call goes through one function

**Status:** Accepted

## Context

The per-tenant budget gate worked. It read the meter, decided to degrade, recorded the
event and selected the free-tier alias. The turn then spent paid tokens anyway.

Five other call sites - the critic, the reviser, memory write-back, the crew planner,
market research - each read `process.env.LITELLM_MODEL` directly, which is the paid
alias, and none of them had ever heard of the budget. Every link was correct and the
chain was not.

## Decision

`llm/gateway.ts` is the only function permitted to reach the proxy. It requires an
`orgId` typed as required rather than optional-with-a-default, resolves the model from
the workspace budget instead of the environment, and attributes every request.

`lint-llm-gateway.js` fails the build if any other file posts to `chat/completions`.

## Consequences

A sixth call site cannot be written without either using the door or deliberately
deleting the lock, and deleting the lock is a visible act in a diff.

The door is also the natural place to measure spend: the cost signal on every
supervision row is a counter incremented at the exact line past which a call costs
money.

Cost: one indirection on every model call, and a lint that occasionally annoys someone
adding a legitimate new path.

## What breaks if you remove it

Budget enforcement becomes advisory. An over-budget tenant is degraded on one path and
billed at full price on the next, and nobody notices until the invoice arrives.

## Evidence

The lint found two production paths nobody knew about on the day it was written:
`apps/dashboard/lib/litellm-client.ts` and `activities/orchestration.ts`.
