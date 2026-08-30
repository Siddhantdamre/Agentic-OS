# 13. Erasure follows the person, not the conversation

**Status:** Accepted

## Context

A deletion request names a human, not a row. Deleting by conversation id leaves the
same person's messages under three other handles.

## Decision

`erase_person(org, any handle)` resolves the handle to a person and erases every
conversation from every handle they are known by, including what the agent learned
about them.

A catalogue test asserts the erase function names every table that stores personal
data, sourced from the schema rather than from a hand-written list.

## Consequences

Adding a table that stores personal data fails the erasure test until it is wired in.
That test has now caught four new tables.

Cost: every new personal-data table costs a line in the erase function.

## What breaks if you remove it

Erasure is partial and the product cannot honestly answer a deletion request.

## Evidence

Migration 038 and 041. During the identity work the catalogue test caught
`lead_followups` and `task_supervision` on the days they were created.
