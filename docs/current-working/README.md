# Darex — Current Working State (from code)

> Snapshot of what the **existing codebase actually does** as of **2026-08-13**.
> Written from live source (`apps/`, `services/`, `infra/`), not from older docs.
> Older write-ups in `documentation/` and `BUILD_STATE.md` remain useful history;
> **this folder is the current map.**

Darex is a multi-tenant AI-employee SaaS. AI employees answer business questions,
act on connected tools (Gmail, Calendar, HubSpot, WhatsApp, SQL, sandbox, …),
and **confirm before running multi-step plans**.

## How to read this folder

| File | What it answers |
|------|-----------------|
| [00-status-at-a-glance.md](./00-status-at-a-glance.md) | One-page working / not-working matrix |
| [01-system-overview.md](./01-system-overview.md) | Product, monorepo, runtime pieces |
| [02-architecture-diagrams.md](./02-architecture-diagrams.md) | All mermaid diagrams in one place |
| [03-e2e-ask-ai.md](./03-e2e-ask-ai.md) | Classify → simple stream **or** plan-confirm-execute |
| [04-e2e-auth-onboarding.md](./04-e2e-auth-onboarding.md) | Login, register, OAuth, org, onboarding |
| [05-e2e-integrations.md](./05-e2e-integrations.md) | Nango OAuth, connectors UI, test proxy |
| [06-e2e-webhooks-inbox.md](./06-e2e-webhooks-inbox.md) | WhatsApp, Chatwoot, SSE inbox |
| [07-e2e-agent-runtime.md](./07-e2e-agent-runtime.md) | Temporal vs direct, atomic-agent, MCP bridge |
| [08-tools-catalog.md](./08-tools-catalog.md) | Every tool: real API vs notConnected vs stub |
| [09-dashboard-pages.md](./09-dashboard-pages.md) | Every UI route and what it talks to |
| [10-api-reference.md](./10-api-reference.md) | Every API route: method, real vs stub |
| [11-database-tenancy.md](./11-database-tenancy.md) | Tables, RLS, session scoping |
| [12-infrastructure.md](./12-infrastructure.md) | Docker services, ports, env |
| [13-what-works.md](./13-what-works.md) | Verified working paths (from code + BUILD_STATE) |
| [14-what-does-not-work.md](./14-what-does-not-work.md) | Gaps, stubs, expired tokens, missing files |
| [15-env-and-run.md](./15-env-and-run.md) | Commands to boot and verify |
| [16-updates-2026-08-13.md](./16-updates-2026-08-13.md) | Changelog: last commit → 13 Aug working tree (includes plan wrap-up) |
| [19-updates-2026-09-02.md](./19-updates-2026-09-02.md) | Changelog: `0cd87b1` → `8c3035d`. Routing, recurring work, briefings, employee activity, and the operational traps found the hard way |
| [20-shift-run-2026-09-02.md](./20-shift-run-2026-09-02.md) | The first real shift run: three attempts, the model-group dead end that made four agents report nothing, and the six duties that finally produced work |
| [21-updates-2026-09-02-evening.md](./21-updates-2026-09-02-evening.md) | Changelog: `8c3035d` → `b8c6303`. The stale env file that would have deployed with no model key, a quarter of verification that never ran, the realtime bus that never published, and market context with provenance. First measured reliability: 58/60 |
| [22-updates-2026-09-03.md](./22-updates-2026-09-03.md) | Changelog: `077582d` -> `0a45f82`. The agents could not search the web and never could; deep research; the gate that had never run on Windows; a bug triage loop; and the supervision lint that read one file of sixteen |
| [23-updates-2026-09-03-evening.md](./23-updates-2026-09-03-evening.md) | Changelog: `66c2974` -> `962a8e7`. Four declarations that did not match reality: a tool the agent could not call, two role vocabularies that never met, a risk field read by nothing, and four gate failures that blamed the answer for being late |

Path from today to the complete OS (documentation only, not shipped):
[`docs/plan/`](../plan/README.md). Written later on 13 Aug. Start at
that README. What was written and the first five build items are in
[16](./16-updates-2026-08-13.md) (last follow-up).

## Source of truth order

1. **This folder** — current working map.
2. **`BUILD_STATE.md`** — session log of fixes and live verifications.
3. **`AGENTS.md`** — short agent cheat-sheet.
4. **`docs/future-scope/`** — what we intend to become.
5. **`docs/plan/`** — how we get there. If this folder and future-scope
   disagree on **what exists**, this folder wins. If they disagree on
   **what to build next**, future-scope wins (memory first; never skip
   Phase 6).
6. **`documentation/`** — older standalone docs (some claims are stale).

## Quick status (2026-08-13)

**Phases 0–5 are implemented in code.** Ask AI plan-confirm-execute, atomic-agent
runtime, Nango connectors, WhatsApp inbound, Temporal worker, and SSE inbox
updates all exist and have been live-verified at least once.

**Not production-ready:** several OAuth providers need real client IDs in the
Nango UI; Meta WhatsApp outbound token is expired; Insight is rule-based, not
LLM; realtime SSE is in-process only (one Node process). Runtime DB role is
`darex_app`. Operator must still run `pnpm db:migrate` for 009–011 on older DBs.
