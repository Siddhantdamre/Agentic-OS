# GPT-6 Astra Quality Architecture

Status: implementation branch `feat/gpt6-astra-quality-core-2026-10-01`

## Decision

Darex uses GPT-6 Astra as the high-reasoning layer for planning, classification, revision, critique, decision briefs and synthesis.

The existing Atomic Agent remains the execution runtime for the customer-facing tool loop until its OpenAI provider is migrated to the Responses API. This is intentional: OpenAI's current GPT-6 guidance requires Responses for function calling with Astra, while Chat Completions remains suitable for non-tool Astra calls.

## Request contract

- Model: `gpt-6-astra`
- Darex LiteLLM alias: `darex-astra`
- Default reasoning effort: `high`
- Astra Chat Completions calls use `max_completion_tokens`, not `max_tokens`.
- Astra reasoning calls do not send temperature/top_p.
- Credential: `OPENAI_API_KEY`, supplied only through deployment environment.

## Why this is better than a global model swap

The agent's value is not text generation alone. Darex already has durable business memory, a world model, decision briefs, approvals and an outcome ledger.

Astra should therefore reason over those artifacts:

`intent -> evidence -> world state -> options -> policy -> decision -> execution request -> observed outcome`

The execution layer remains deterministic where possible. The model proposes; Darex records, authorizes, executes and verifies.

## Quality contract

Every high-impact Astra result should carry:

1. Evidence used.
2. Evidence freshness.
3. Unresolved contradictions.
4. Confidence/uncertainty as a factual limitation, not a decorative score.
5. Recommended next action.
6. Whether human approval is required.
7. Expected outcome and verification condition.

## Next migration

The next major engineering step is a native Responses provider for the Atomic Agent:

- preserve Darex tool schemas and tenant-scoped allowlists;
- translate MCP tools to Responses function tools;
- persist/replay response items and reasoning state safely;
- execute tool calls through the existing authorization gateway;
- return tool outputs as Responses input items;
- record the complete intent/evidence/authorization/action/outcome chain.

Do not bypass Darex authorization merely because the Responses API can call a function.

## Cost discipline

Astra is expensive enough that it should not be used blindly for every token:

- `low`: routing, simple classification, quick revision.
- `medium`: normal planning and synthesis.
- `high`: consequential decisions, contradiction analysis, difficult research.
- `xhigh`/`max`: reserved for explicitly quality-critical workflows after benchmark evidence.

The production default in this branch is `high` because this branch is the quality-first configuration. Cost-aware routing remains a deployment policy, not a hidden model downgrade.

## Security

The API key is never stored in this document, Git, Docker images, or generated artifacts. The credential supplied during development must be rotated before production because it was exposed in chat.

## Acceptance benchmark

Before calling Astra production-ready, run the representative Darex suite:

- multi-turn customer support;
- contradictory CRM/memory facts;
- approval-required financial action;
- calendar booking with missing business facts;
- tenant isolation;
- stale evidence;
- tool refusal;
- provider timeout/failover;
- outcome verification;
- recovery after a partially completed action.

Measure answer correctness, unsupported-claim rate, tool-selection accuracy, latency, token cost, recovery rate, and human takeover rate.