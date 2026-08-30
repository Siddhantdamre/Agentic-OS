# 14. Deterministic gates decide; a model may only tighten

**Status:** Accepted

## Context

A conversation on this deployment measures roughly 99,000 tokens across three model
calls. Making every check an LLM call would multiply that for no correctness gain.

More importantly, the checks that matter most - fair-housing steering, guaranteed
returns, invented legal promises - are pattern rules. They do not need a model and they
cannot be argued out of a verdict.

## Decision

Heuristics always run. A model is consulted only to tighten a verdict the deterministic
layer already allowed, never to loosen one it refused. If the model is unavailable the
heuristics stand alone, which forfeits a chance to block and never creates a chance to
allow.

Whether a model was consulted is tracked as a cost signal, not a quality one.

## Consequences

Compliance behaviour is reproducible and testable without spending money, and it works
when the provider is down.

Cost: pattern rules need maintaining, and they will miss phrasings a model would catch.

## What breaks if you remove it

Safety becomes probabilistic and expensive at the same time, and an outage at the
provider becomes a compliance outage.

## Evidence

`activities/critic-check.ts`. The cost signal is counted at the gateway, so it covers
the critic call and every revision in the loop.
