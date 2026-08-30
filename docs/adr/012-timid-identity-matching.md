# 12. Identity matching is timid; ambiguity never merges

**Status:** Accepted

## Context

Cross-channel identity means the same human recognised across WhatsApp, email and web,
so history and erasure follow the person rather than the handle.

A wrong merge shows one customer another customer's messages. That is the worst
outcome available to this system, and it is not reversible: once two conversations share
a person, nothing records that they were once separate.

## Decision

Matching is deliberately conservative. Placeholder handles (`unknown`, `anonymous`,
`guest`, `-`) are never confident. Gmail dots and plus-tags are not merged. Foreign
numbers are kept whole and never re-homed to a local country code.

The uniqueness constraint is on the raw spelling, not the normalised one, so two
different people who normalise alike stay separate.

## Consequences

The system under-merges: one human may appear as two people until an operator says
otherwise. That is the correct direction to be wrong.

Cost: cross-channel history is less complete than a greedier matcher would produce.

## What breaks if you remove it

A customer sees a stranger's conversation, and no migration can undo it.

## Evidence

Migration 041 and `identity/identity.ts`. The backfill is preview-by-default and prints
every proposed merge with the spellings that produced it, because "1,400 conversations
resolved to 900 people" is not checkable by eye and "these five spellings became one
person" is.
