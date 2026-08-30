# 6. Tool authorisation is enforced below the prompt

**Status:** Accepted

## Context

Passing a tool list into a system prompt and trusting the model to respect it is the
common pattern. It fails under prompt injection, and it fails silently.

The first matcher written here also had a real escalation bug: it compared with
`startsWith(tool + '-')` in the wrong direction, so holding `razorpay-refund-status`
granted `razorpay`.

## Decision

`tools/capability.ts` decides before the call is made. Grants widen downward only:
holding `razorpay` implies `razorpay-refund-status`, never the reverse.

Every tool maps to a risk class - read, draft, send, pay, sign, publish, delete - and
no default role holds pay, sign, or code execution.

## Consequences

Adding a tool means adding it to a role and a risk class. Forgetting means it is
refused rather than silently allowed, which is the correct direction to fail.

Cost: a genuinely new capability needs a code change, not a config toggle.

## What breaks if you remove it

A support employee can execute a payment if a customer asks convincingly enough.

## Evidence

`ROLE_HANDS`. Verified against a freshly provisioned tenant: three roles, zero matches
against payment or signing tools.
