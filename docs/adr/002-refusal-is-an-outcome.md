# 2. A refusal is a correct outcome, never a failure

**Status:** Accepted

## Context

Supervision records what the agent did on every task. The obvious schema has one
success state and everything else as failure, which files a deliberate security refusal
alongside a crash.

## Decision

`doerOutcome` is one of `replied`, `refused`, `escalated` or `failed`. A refusal
outranks an escalation, and neither is `failed`.

The classification is by construction rather than by judgement: a refusal is identified
by the reply being one of our own canned refusal constants, not by a classifier guessing
whether some text looks like one.

## Consequences

Refusal rate and failure rate are separate numbers and can move in opposite directions,
which is the entire point.

Cost: four states to reason about instead of two, and canned refusals must stay
constants rather than generated text.

## What breaks if you remove it

The safest agent scores worst. That number then gets used to argue for weakening the
refusals, which is the outcome this exists to prevent.

## Evidence

`supervision/trio.ts`. The ordering is pinned by a test named
"A REFUSAL IS NOT A FAILURE".
