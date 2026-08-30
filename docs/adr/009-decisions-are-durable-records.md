# 9. A human decision is a durable record; the signal is a bonus

**Status:** Accepted

## Context

`WorkItemWorkflow` waits two minutes for an approval signal. Humans do not answer in
two minutes: when the approvals queue shipped, the 24 requests waiting had timed out
thirteen days earlier.

If the workflow signal were the mechanism, every approval given by a real person on a
real schedule would be lost.

## Decision

The decision is written to `approval_requests` first and signalled to Temporal second.
The signal is best-effort; the durable record is the product. It is what updates the
trust ledger, what an audit reads, and what lets the work be re-driven.

Signalling first and recording second would mean a crash between the two loses the
human's decision while the agent acts on it, which is the worst available ordering.

## Consequences

An approval answered thirteen days later still works, so the queue is safe to leave
overnight. The interface says so: the heading is "Handed to you", not "Waiting on you".

Cost: the agent's original turn has already ended, so acting on the decision is a
separate piece of work rather than a continuation.

## What breaks if you remove it

Approvals become a race against a two-minute timer that no human can win, and the
product quietly requires an operator to sit watching a queue.

## Evidence

`api/approvals/[id]/route.ts`, where the ordering and the reason are written down.
