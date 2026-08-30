# 15. The local suite runs what CI runs

**Status:** Accepted

## Context

CI was red on four consecutive pushes while the local suite reported 36 of 37 green.

The cause was a test asserting a raw `INSERT INTO orgs`, which migration 028
deliberately made impossible. But the reason it went unnoticed for four pushes is that
`verify.js` ran none of what CI runs: no typecheck, no lint, no fresh-database
isolation suite.

## Decision

`verify.js` runs the typecheck, the lint and the isolation suite that GitHub Actions
runs. The typecheck is a single `typecheck:ci` script that both call, so the two cannot
drift apart.

A verification suite that does not run what the gate runs is not verification; it is a
second opinion nobody asked for.

## Consequences

The local run takes several minutes longer.

Cost: real, and paid on every run. The alternative is a green local suite that means
nothing.

## What breaks if you remove it

Local green and gate green stop meaning the same thing, and the gap is discovered by
whoever is on call.

## Evidence

Commit 8aaaddb, and the emails that prompted it.
