# 5. Budgets are denominated in tokens, not currency

**Status:** Accepted

## Context

LiteLLM's dollar accounting for these OpenRouter routes was measured at $0.0032
recorded against roughly $14 actually charged. A budget enforced on that number is not
a budget.

## Decision

Per-tenant limits are counted in tokens. Currency is derived for display only and never
gates anything.

## Consequences

Limits must be re-derived when model pricing changes, because a token cap is not a
money cap.

Cost: an operator setting a budget thinks in rupees and has to be shown a translation
that is approximate.

## What breaks if you remove it

Spend control silently stops working the day a provider's accounting drifts, and the
first symptom is an invoice nobody predicted.

## Evidence

Migration 027 records the measurement that prompted this.
