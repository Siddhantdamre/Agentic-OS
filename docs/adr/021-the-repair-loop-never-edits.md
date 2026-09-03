# 21. The repair loop diagnoses; it never edits

**Status:** Accepted

## Context

This repo has fifty-odd deterministic checkers, and each one knows what invariant it
protects and says so in its own header. That is the expensive half of self-repair, and it
was already built.

What did not exist was anything that reads a red gate and decides what it means. So a
failure sat in a terminal until a person read it, and in this repo's own history,
repeatedly, nobody did: CI was red on four consecutive pushes, `demo-ai-employee.js` went
red unnoticed, and `check-config-drift.js` correctly reported an empty model key to an
empty room.

## Decision

An automated triage loop runs the gate, classifies every failure, and — for confirmed
code defects only — asks a model to diagnose it.

**It never edits a file, commits, pushes, or runs a migration.** `self-repair.test.ts`
asserts the module's entire export surface and that no exported name suggests mutation.

### Why not apply the fix

The dangerous output of an automated repair loop is not a bad patch. A bad patch gets
caught.

It is a plausible patch that makes the checker pass by removing the invariant the checker
existed to protect. That failure is **unreviewable by construction**, because the thing
that would have caught it is what was changed. The repair prompt names this as the worst
possible answer and requires the invariant to be stated before any fix is proposed.

### Triage is deterministic; only the proposal is a model

ADR 14: deterministic gates decide, a model may only tighten. Classification decides
whether a human is woken up, so it is code with tests — and it costs nothing to run.

Every pattern in it is a failure actually observed in this repo, not a guess:

| kind | meaning | actionable |
|---|---|---|
| `environment` | a command missing from PATH, a package manager that cannot find itself, a refused connection, a named variable unset | yes |
| `upstream` | a provider overloaded or throttling | **no** |
| `code` | a compiler error, a failed assertion, a stale parser, a verification gap | yes |
| `unknown` | no rule matched | yes — a human classifies it |

`upstream` is deliberately not actionable. One measured run produced 18 upstream errors;
waking a person for another company's server is how an alarm stops being believed.

`unknown` and `code` are deliberately different buckets. Calling an unrecognised line a
code defect sends an agent to investigate a phantom, and a verdict is never "all clear"
while an unknown remains.

Environment and upstream are tested **before** code, because a type error inside a message
about a refused connection is still a refused connection.

## Consequences

Most red gate lines in this repo's measured history were never code. Sorting those out is
the majority of the value, and it is free — a workspace with no model credit still gets
correct triage.

A proposal must name both the invariant and a fix to be forwarded. A model that says
`CANNOT DIAGNOSE FROM THIS EVIDENCE` has its answer recorded and the raw failure
forwarded instead — a model asked for a patch always produces a patch, and the honest
refusal is more useful than the guess.

## What breaks if you remove it

A red gate goes back to being a thing that must be read by a person who happens to look.
That is the state in which four consecutive red CI runs went unnoticed.

## Evidence

Run against the live gate, 3 September 2026:

> `2 environment problems and no code defect. Nothing is wrong with the product.`

Both were `pnpm is not installed on this machine` — correctly the machine, not the code.

25/25 unit tests, including that the export surface cannot change anything and that
upstream failures are never marked actionable. 8/8 self-test parsing real runner output.

The self-test parser is *the same function* the script uses. The first version held its
own copy of the loop, and its self-test agreed with the bug in it — two copies of a parser
is the defect class this repo keeps finding, and a self-test is the worst possible place
for it.
