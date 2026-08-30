# 10. No rate is quoted from a sample too small to mean anything

**Status:** Accepted

## Context

Every dashboard in this class reports percentages from the first handful of events.
Two tasks, one intervention, and the panel says 50%.

## Decision

Rates return `null` below `MIN_SAMPLE`, and the interface renders the absence rather
than a zero. The headline says how many observations exist instead.

Denominators are chosen for meaning, not convenience: loop closure is measured over
interventions, not over all tasks, because "how often did being judged teach it
something" is only answerable where it was actually judged.

## Consequences

New workspaces see counts rather than percentages for a while.

Cost: a demo looks emptier, and someone will ask why the number is missing.

## What breaks if you remove it

Percentages computed from noise get quoted in sales conversations and then defended.

## Evidence

`summariseSupervision`, with a test asserting `null` rather than 50% from two tasks,
and another asserting loop closure is 6/12 rather than 6/100.
