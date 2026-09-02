# 17. Recurring work schedules itself; it only needs starting

**Status:** Accepted

## Context

Nothing in this system ran on a timer. No cron, no Temporal Schedule; the only
`setInterval` calls were an SSE keepalive and a widget embed.

`insight-engine` — which dispatches `StaleChaseWorkflow`, `NurtureWorkflow` and the
owner briefing — fires only when a human loads `/analytics`, `/insight` or Ask AI. So a
product sold as an autonomous workforce did nothing whatsoever unless somebody opened a
page.

`OwnerBriefingWorkflow` had produced zero rows in its entire history.
`MarketResearchWorkflow` was worse: referenced only in `workflows/index.ts`, registered
with the worker and started by nothing, anywhere.

## Decision

Do not add a scheduler. The workflows already are one.

`OwnerBriefingWorkflow` ends each run by sleeping until its next scheduled hour and
calling `continueAsNew`, which is a durable cron that survives worker restarts and
keeps workflow history bounded. `MarketResearchWorkflow` does the same via
`repeatEveryHours`. They were missing a first start and nothing else.

`infra/scripts/start-recurring-work.js` performs that start, once per org, with a
deterministic workflow id (`owner-briefing:<orgId>`) so running it twice is a no-op
rather than a second daily briefing loop.

It starts loops only for workspaces with more than one active employee and at least one
conversation. Test suites provision a workspace per run and leave it behind — there are
52 orgs named "Bright Leaf Interiors" with one employee each — and 52 permanent
briefing loops would be noise nobody reads. The filter is deliberately conservative: it
skips a genuine new customer until their first conversation arrives, which is the right
way round. Starting a briefing loop is easy; noticing fifty stray ones later is not.

## Consequences

A recurring workflow is now durable state, not configuration. Stopping one means
terminating a Temporal workflow, not editing a crontab, and the list of what is running
lives in Temporal rather than in the repository.

Adding an org to the schedule requires running the starter again. That is a deliberate
manual step: the alternative is a boot hook that quietly starts loops for every org
that ever existed.

## What breaks if you remove it

Every proactive capability reverts to firing only when a human opens a page, which
means the autonomy claim is false and the owner briefing table stays empty forever.

## Evidence

First briefings ever recorded, 2 September 2026: "1 unworked inquiries, 3 open
conversations, 1 threads need attention" for Sharma Properties, and a matching row for
Zoho. The `3` agrees with what Ask AI and `/insight` reach independently.

Commit 8c3035d.
