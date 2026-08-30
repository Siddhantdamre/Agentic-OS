# 3. Silence is never recorded as success

**Status:** Accepted

## Context

Conversations are closed by a quiet sweep: the business spoke last and the customer did
not come back inside the quiet window. On this deployment 652 of 719 conversations are
marked `resolved` for that reason.

A customer who got exactly what they needed and one who gave up and went to a
competitor produce an identical row.

## Decision

Absence of signal resolves to `unknown` - a terminal state that is neither success nor
failure. Reported rates exclude it, and the size of the unknown bucket is published
beside them in the same size type.

## Consequences

Early reporting will say "we do not know" about most conversations. That is accurate
and uncomfortable, and the discomfort is load-bearing.

Cost: the headline number gets smaller and harder to sell.

## What breaks if you remove it

Quality metrics measure how often people stop talking, and a team can improve the
metric by being less engaging.

## Evidence

`satisfaction/signal.ts` and `check-satisfaction.js`. Running it produced the honest
number - 3 readable replies - and refused to quote a rate from 3.
