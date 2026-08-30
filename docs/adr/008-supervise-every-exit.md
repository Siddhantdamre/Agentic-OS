# 8. Supervision is recorded on every exit, including crashes

**Status:** Accepted

## Context

Supervision was written at a single point near the end of the work item. There were ten
`return` statements before it - six failures, two cancellations, one escalation to a
human and one success - and not one of them recorded anything.

The trio therefore reported only on tasks that ran cleanly to the end, which is the
population needing the least supervision. The guard made it worse: it checked only
`status = 'done'`, while the failure path maps to `needs_attention` and cancellation to
`cancelled`, so eight of the ten holes were invisible to the very check meant to catch
them.

## Decision

Recording happens in a wrapper around the workflow body. No `return` inside it can skip
supervision and a thrown activity cannot either.

Signals the body knew are passed out through a draft; anything it never reached is
derived from the result, so an escalation reports as escalated rather than as a guess.

## Consequences

A finished task with no supervision row is a defect by definition, in all three
terminal statuses.

Cost: one extra activity call per work item, and a wrapper that must not swallow errors
on the way out.

## What breaks if you remove it

The quality record covers only the happy path, so it measures how often nothing went
wrong and reports that as quality.

## Evidence

`lint-supervision-coverage.js`, proven by reintroducing the defect and watching it fail
before trusting it to pass.
