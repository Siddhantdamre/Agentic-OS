# 11. A shipped capability with zero rows fails the build

**Status:** Accepted

## Context

Six times this codebase produced the same defect: a feature built, tested, and
unreachable in production. Most recently cross-channel identity, which had a schema, a
resolver, an erasure function, 14 passing assertions - and zero rows, because the
backfill was preview-by-default and nobody ever passed `--write`.

Every one of those suites passed the whole time. They pass because each creates its own
fixtures, exercises the layer and tears them down. None of them ever asked whether the
feature had produced a row on this deployment.

## Decision

`check-dormant-capability.js` asks exactly that. Each capability declares when it should
be expected to have produced something, so a blank install and an uninstalled vertical
pack are not false alarms.

`every-turn` fails when its trigger has occurred and the table is still empty.
`conditional`, `human` and `blocked` are reported but never failed - and a `blocked`
entry must name its blocker, because an undocumented exemption is how a dead feature
hides.

The registry must also cover every table in the database, so shipping a new table fails
the build until somebody records whether it should ever have rows.

## Consequences

Adding a table is now a two-line decision rather than a silent act.

Cost: the registry needs maintaining, and a legitimately dormant feature needs a
written reason.

## What breaks if you remove it

The seventh instance of the same defect ships, and is found by a customer.

## Evidence

Proven in both directions: green against healthy data, and red - naming
`contact_persons` - against a database where the defect was deliberately recreated.
