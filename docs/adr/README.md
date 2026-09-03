# Architecture decisions

Why the boundaries are where they are. Each record says what invariant it
protects, what it costs, and what breaks if you remove it.

These are not aspirations. Every one of them was written after something went
wrong, and the Evidence section names the incident or the check that pins it.

| # | Decision |
|---|---|
| 1 | [Every paid model call goes through one function](001-one-door-for-paid-calls.md) |
| 2 | [A refusal is a correct outcome, never a failure](002-refusal-is-an-outcome.md) |
| 3 | [Silence is never recorded as success](003-silence-is-unknown.md) |
| 4 | [Tenant isolation is forced RLS with named doors through it](004-doors-not-holes.md) |
| 5 | [Budgets are denominated in tokens, not currency](005-budgets-in-tokens.md) |
| 6 | [Tool authorisation is enforced below the prompt](006-capability-below-the-prompt.md) |
| 7 | [An auxiliary service may remove a capability, never the product](007-optional-services-degrade.md) |
| 8 | [Supervision is recorded on every exit, including crashes](008-supervise-every-exit.md) |
| 9 | [A human decision is a durable record; the signal is a bonus](009-decisions-are-durable-records.md) |
| 10 | [No rate is quoted from a sample too small to mean anything](010-withhold-rates-below-sample.md) |
| 11 | [A shipped capability with zero rows fails the build](011-dormant-capability-fails-the-build.md) |
| 12 | [Identity matching is timid; ambiguity never merges](012-timid-identity-matching.md) |
| 13 | [Erasure follows the person, not the conversation](013-erasure-by-person.md) |
| 14 | [Deterministic gates decide; a model may only tighten](014-deterministic-first-model-to-tighten.md) |
| 15 | [The local suite runs what CI runs](015-verification-runs-what-the-gate-runs.md) |
| 16 | [Work is routed by capability, never by row order](016-route-by-capability-not-row-order.md) |
| 17 | [Recurring work schedules itself; it only needs starting](017-recurring-work-schedules-itself.md) |
| 18 | [Searching and reading are separate capabilities](018-searching-and-reading-are-separate.md) |
| 19 | [A market fact carries its source, or it does not exist](019-market-facts-carry-their-source.md) |
| 20 | [Search has a floor that needs no credential](020-search-has-a-keyless-floor.md) |
| 21 | [The repair loop diagnoses; it never edits](021-the-repair-loop-never-edits.md) |
