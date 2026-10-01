# Darex → Enterprise-complete: full gap, bug and build plan (2026-09-27)

> ### 📊 Master Audit Completion Status
>
> | Status | Count | Percentage |
> |---|:---:|:---:|
> | 🟢 **Done (Verified)** | 20 | 3.3% |
> | 🟡 **Pending / In Progress** | 42 | 7.0% |
> | 🔴 **Not Done (Open)** | 538 | 89.5% |
> | ⛔ **Blocked (Human/Infra)** | 1 | 0.2% |
> | **Total Findings** | **601** | **100.0%** |

This folder is the single plan for taking Darex / DareXAI One from "working
product with real backends" to an **enterprise-grade autonomous AI workforce**
that a second, third and hundredth tenant can pay for. It supersedes the
priority roll-ups in `docs/new-109-pg-plan/gap26sept/00-summary.md` and
`docs/saas-conversion/00-summary.md` for *ordering*; those folders stay the
per-row evidence trackers.

Method: every domain below was re-audited against the **code on branch
`feat/close-109-plan-gaps` at commit `334c6e9`** (plus uncommitted SaaS
control-plane work already on disk). Claims in `BUILD_STATE.md` were treated
as hypotheses and verified in source. Every finding carries `file:line`.
Nothing here was fixed — this is a plan, not a changelog.

Status legend used everywhere: 🟢 works and is verified in code · 🟡 exists
but incomplete / unproven live · 🔴 missing or human-blocked.

## Current Reality vs. Enterprise-Complete Target State

### 1. Executive Verdict (TL;DR)
DareXAI One today is **a functioning, full-stack product with real backends, not an AI mockup or prototype**. However, **it is not yet safe to sell to paying enterprise tenants**. The gap is not missing features or UI screens; the gap is **systemic governance, security gates that are bypassed on secondary paths, fragmented approval states, lack of tenant PII redaction, and missing enterprise identity primitives (SSO/SCIM)**. 

If all 538 open findings and 42 pending items are closed according to the build plan ([`12-build-plan-waves.md`](12-build-plan-waves.md)), DareX transforms from an early-stage startup SaaS into a **bank-grade Autonomous AI Workforce OS** capable of passing SOC 2 Type II, ISO 27001, and Fortune 500 vendor risk assessments.

---

### 2. Today's Reality (Without Pending & Not-Done Items)

#### What Truly Works & Is Built Today:
- **Tenant Isolation Foundation**: 99 database tables partitioned across tenants via PostgreSQL Row-Level Security (RLS) with session-scoped GUC (`app.current_org_id`) set by `getScopedClient()`.
- **Live Agent Runtime**: TrueForge core engine paired with an MCP bridge exposing ~70 connector tools (Gmail, Google Calendar, HubSpot, Stripe, Slack, WhatsApp, Shopify, database queries, and web research). Tools follow the honest `notConnected` contract rather than hallucinating success.
- **Asynchronous Execution**: 36 Temporal workflows handling durable multi-step plans, background sweeps, and crew executions.
- **Ask AI Chat Interface**: Functional front door supporting Auto-routing, Pick-One employee locking, and Team collaboration (up to 3 agents) with multi-step plan generation and SSE streaming.
- **Critical Patches Shipped (2026-09-28)**:
  - Sandboxed code execution fails closed without host `/bin/bash` fallback or leaking `process.env`.
  - `gatePayRbac` blocks non-privileged users from executing financial tools (`stripe_create_charge`, `razorpay_create_payment_link`, refunds).
  - Session epoch validation (`users.session_epoch`) prevents revoked sessions from accessing platform admin routes.
  - Per-turn model token cost is captured and written to the spend ledger.

#### The Operational Reality & Risks of Operating Without the 538 Open Gaps:
1. **Guards Exist in Code, But Are Bypassed on Secondary Paths**:
   - The confirmation and autonomy gate (`tool-gate.ts`) protects direct chat tool invocations, but **plan steps** (`execute/route.ts`), **webhook replies**, and **six periodic activities** call raw provider execution directly, bypassing employee allowlists and confirm requirements.
2. **Untrusted Code and SQL Boundary Leaks**:
   - `database_query` checks for `select` or `with`, allowing writable Common Table Expressions (`WITH d AS (DELETE FROM ...) SELECT ...`) and `set_config` manipulation.
   - The Docker sandbox container shares the same Docker network (`darex-net`) as Postgres, Nango, and LiteLLM.
3. **Fragmented Approvals & Duplicate Executions**:
   - Five different approval surfaces exist (`/api/decisions`, `/api/agent/pending-actions`, `/api/ask-ai/approve`, WhatsApp replies, and Work Items) running through two separate executors.
   - Reconnecting to a running non-durable plan re-runs steps. Durable plans lack a sticky cancellation check before each stage.
4. **Data Privacy & GDPR Art. 17 Violations**:
   - Raw user transcripts and customer facts are ingested into Cognee and external vector stores without automated PII redaction.
   - The DSR "Right to be Forgotten" workflow purges SQL rows, but leaves data behind in Cognee, Langfuse traces, SuperTokens, and Nango.
5. **Runaway Financial Exposure**:
   - Organization spend caps are evaluated only when someone visits `/billing`. Background sweeps and crew agents do not fail closed when daily budgets are exceeded.
6. **Enterprise Procurement Rejections**:
   - Authentication relies on global social OAuth and email/password. There is no per-org SAML/OIDC SSO, no SCIM user de-provisioning, and no tamper-proof append-only audit trail for compliance teams.

---

### 3. The Target State: If Done (When All Gaps Are Closed)

When Waves 0 through 4 in [`12-build-plan-waves.md`](12-build-plan-waves.md) are completed, DareXAI One achieves its full blueprint vision:

1. **The Canonical One-Turn Contract ([`17-one-turn-contract.md`](17-one-turn-contract.md))**:
   - Every single AI action—whether triggered from Ask AI chat, a plan step, an incoming WhatsApp webhook, a child crew worker, or a 2 AM scheduled sweep—funnels through **one unified gate** (`executeAutonomousToolAction`).
   - Every call strictly enforces schema validation, caller-derived employee identity (never model-dictated), exact allowlist match, tenant kill-switch, rollout stage, autonomy tier, RBAC, budget availability, and critic checks.
2. **Ask AI as the Universal Enterprise Front Door**:
   - Every dashboard tab action (decisions, work items, CRM lookups, listings, billing usage) has a twin tool callable from Ask AI chat.
   - Multi-step plans feature per-step argument preview, individual risk badges, and reversible rollbacks.
3. **Zero-Trust Multi-Tenancy & Data Security**:
   - Ephemeral micro-sandboxes with no network egress and dropped Linux capabilities.
   - Database queries run exclusively under a dedicated PostgreSQL read-only role with transaction-level rollbacks.
   - Automated PII scrubbing before any text reaches vector embedding or LLM context. Full cross-store GDPR DSR deletion across SQL, vectors, Cognee, and provider logs.
4. **Enterprise Identity & Lifecycle Management (SOC 2 Ready)**:
   - Dedicated per-tenant Okta, Azure AD, and Google Workspace SSO with Just-In-Time (JIT) group-to-role mapping.
   - SCIM 2.0 automatic provisioning and immediate offboarding.
   - Comprehensive append-only audit logging (`tool_invocations`) recording actor, payload hash, cost, latency, and approver for every action.
5. **Autonomous 24/7 Workforce With Closed-Loop Governance**:
   - Ten specialized AI employees (Growth, Customer Support, Operations, Executive, Sales, Marketing, Research, Finance, etc.) autonomously perform their defined jobs ([`18-employee-jobs.md`](18-employee-jobs.md)) without human babysitting.
   - AI employees escalate *decisions*, not conversations.
   - Hard, distributed budget caps (Redis token bucket + per-employee spend limits) ensure zero runaway API costs.

---

### 4. Side-by-Side Dimension Comparison

| Dimension | Current State (3.3% Done / 89.5% Open) | Target Enterprise State (100% Complete) |
|---|---|---|
| **Target Customer** | Early adopters, internal testing, single-tenant pilots | Global enterprises, Fortune 500, regulated fintech/healthcare/proptech |
| **Tool Execution Gating** | Enforced on direct chat; bypassed on plans and background sweeps | **One Turn Contract**: Universal, unbypassable gate for all callers |
| **Code Sandboxing** | Safe fallback blocked, but sandbox container shares network with DB | Zero-network, ephemeral, cap-dropped execution per tenant |
| **SQL Query Safety** | `startsWith('select')` (vulnerable to writable CTEs and `set_config`) | Read-only Postgres user role, transaction timeouts, AST validation |
| **Approval Lifecycle** | 5 fragmented tables/routes; approvals can hang or re-execute | 1 unified approval state machine across Web, Mobile, and WhatsApp |
| **Data Privacy & GDPR** | SQL data purged; Cognee, vector DBs, and traces retain PII | Automated PII redaction + complete multi-store DSR cryptographic erasure |
| **Identity & Access** | Email/password + global Google/GitHub OAuth; manual invite only | Per-tenant SAML 2.0 / OIDC SSO, SCIM 2.0 auto-deprovisioning, Org MFA |
| **Spend Governance** | Real per-turn cost recorded, but caps fail open; meters check on UI load | Hard real-time spending ceilings that fail closed; distributed Redis rate limits |
| **AI Employee Reliability** | Static prompt personas; prone to context loss on long threads | Idempotent execution, stateful thread compaction, verifiable delegation protocols |
| **Audit & Compliance** | 24 of 148 API routes log audit events; tool logs are console-only | Append-only, exportable `audit_events` and `tool_invocations` for all mutations |

---

## Files

| # | File | What it covers |
|---|------|----------------|
| 00 | `00-index.md` | This page. Reading order, legend, how to use the plan |
| 01 | `01-executive-summary.md` | Where the product actually is, the ten things that block enterprise, the build order |
| 02 | `02-ask-ai-chat.md` | The front door: classify → plan → confirm → execute, modes, mentions, hand-offs, streaming, plan lifecycle |
| 03 | `03-ai-employees.md` | The ten roster employees + custom: what each can do, routing, crews, governance, blueprint deltas |
| 04 | `04-agent-runtime-and-tools.md` | TrueForge loop, MCP bridge, tool catalog reality table, executor honesty, autonomy gate, usage gate |
| 05 | `05-memory-brain.md` | The shared brain: write/read paths, Cognee, embeddings, redaction, citations, forget |
| 06 | `06-channels-conversations-realtime.md` | WhatsApp / Chatwoot / Gmail / Slack / SMS / widget, inbox, SSE hub |
| 07 | `07-security-auth-tenancy-compliance.md` | RLS matrix, auth/MFA/SSO/SCIM, RBAC, tenancy leaks, audit, DSR, platform admin |
| 08 | `08-billing-packs-onboarding-connectors.md` | Metering, plans, Stripe/Razorpay, packs/skills, stranger-to-value onboarding, OAuth lifecycle |
| 09 | `09-observability-workflows-infra-tests.md` | Metrics honesty, tracing, Temporal reality table, approvals map, CI, test harness |
| 10 | `10-frontend-ux.md` | Page inventory, dead buttons, missing states, IA, design system, a11y, performance |
| 11 | `11-enterprise-readiness-checklist.md` | The SOC2 / procurement / SLA checklist an enterprise buyer will send, mapped to code |
| 12 | `12-build-plan-waves.md` | Ordered execution plan: waves, dependencies, per-wave definition of done, agent-parallelisable work packets |
| 13 | `13-master-tracker.md` | Every finding ID from files 02–11 (+ WEB- from 14) in one table with severity, owner surface, status |
| 14 | `14-web-research-and-search-capability.md` | Every search surface (web, internal, CRM, maps, vertical, memory): reality tables, honesty contract, Research loop, capability enhancements |
| 15 | `15-in-product-search-and-tab-coverage.md` | ⌘K / API `q=` / FTS indexes / Ask AI as finder / tab action → chat tool / engine honesty |
| 16 | `16-tool-family-depth.md` | Per-connector implemented vs enterprise-expected actions, registry drift, depth sprints |
| 17 | `17-one-turn-contract.md` | The one function every chat turn, plan step, webhook, crew child, and sweep must pass through, in order, with the tests that prove it |
| 18 | `18-employee-jobs.md` | What each of the ten employees does from chat and on a schedule, with proving prompts |
| 19 | `19-working-system-contracts.md` | Memory, channels, identity, money, and approvals as one path, plus the ten checks that mean the product works |
| 🟡 | `pending.md` | Action list of all 42 yellow (half-finished) items with code locations, missing parts, and exact steps to turn green |

## How to use this plan

1. Read `01` for the picture and `12` for the order.
2. Implement from `17` → `18` → `19`. Those three files are the target
   behaviour. Files `02`–`16` are the evidence (the `file:line` and the
   finding IDs). Do not close a row from a one-line fix sketch if it
   contradicts the contract.
3. Pick a work packet from `12`. Each packet lists the finding IDs it closes.
4. Open the domain file, confirm the `file:line` still shows the gap (the tree
   moves fast; `BUILD_STATE.md` is newer than any doc).
5. Fix, verify (typecheck → the test named in `17` §9 or `19` §8 → live in
   the browser), then flip the row in `13` **and** the originating tracker in
   `gap26sept/` / `saas-conversion/` in the same commit as the code and
   `BUILD_STATE.md`.
6. Human-only items (OAuth client IDs, keys, DNS, licences, Postgres up) stay
   🔴 with the reason. Never fake them.

## Finding ID scheme

| Prefix | Domain | File |
|---|---|---|
| `ASK-` | Ask AI chat | 02 |
| `EMP-` | AI employees / crews | 03 |
| `RT-` | Agent runtime / tools | 04 |
| `MEM-` | Memory / brain | 05 |
| `CH-` | Channels / conversations / realtime / widget | 06 |
| `SEC-` | Security / auth / tenancy / compliance / platform | 07 |
| `BIZ-` | Billing / packs / onboarding / connectors | 08 |
| `OPS-` | Observability / Temporal / infra / tests | 09 |
| `UI-` | Frontend | 10 |
| `ENT-` | Enterprise-only capabilities with no home in 02–10 | 11 |
| `WEB-` | Web / internal / vertical / enrichment search | 14 |
| `SRCH-` | In-product / tenant search & ⌘K | 15 |
| `TAB-` | Dashboard tab action with no chat twin | 15 |
| `ENG-` | Growth / Customer / Operations engine | 15 |
| `TOOL-` | Per-connector missing enterprise actions | 16 |

Suffix letters: `B` bug · `S` security · `G` functional gap · `E` enterprise
readiness gap. `SEC-` additionally uses `A` auth · `R` RBAC · `T` tenancy ·
`C` compliance · `P` platform admin · `I` infra. Example: `ASK-B03`, `SEC-T07`.

Totals at audit time: **600 findings, 68 P0** (roll-up at the end of `13`; WEB- in `14`; SRCH/TAB/ENG in `15`; TOOL- in `16`).
Status column in `13` adds ⛔ for "blocked on a human".

## Ground truth this plan is built on

- `AGENTS.md` §4a (direction), `CLAUDE.md` (commit rules).
- `BUILD_STATE.md` top ~300 lines (2026-09-27 entries).
- `docs/new-109-pg-plan/gap26sept/*.md` (38 domain trackers) and
  `employees/*.md` (10 role specs).
- `docs/saas-conversion/*.md` (control plane, migrations 115–122).
- `docs/db-mem-27-sept/*.md` (DB + memory pass).
- `docs/future-scope/STATUS.md` (42% of the forward program in repo).
- Source: `apps/dashboard` (148 API routes, 38 pages), `services/workflows`
  (36 workflows, ~70 tool modules, 1.9k-line MCP bridge), `infra/db/migrations`
  001–122.

## Known environment state at audit time

- Postgres container down; migrations `115`–`122` on disk, **not applied**.
- No browser verification possible in this pass; "🟢" therefore means
  "verified in code", not "clicked in prod".
- Human blockers unchanged: Nango OAuth client IDs for HubSpot, Stripe,
  Notion, Slack, Shopify, Zendesk, Intercom, Microsoft, Salesforce, Zoho,
  Apollo, LinkedIn; `NEXT_PUBLIC_NANGO_PUBLIC_KEY`; Stripe/Razorpay production
  keys; `darex_platform` password; first `platform_admins` row; admin + custom
  domain DNS; licensed MLS; Meta token rotation; `GOOGLE_ADS_DEVELOPER_TOKEN`.
