# Darex — Full Gap Audit Summary (2026-09-26)

Master index for every file in this folder. Each domain file has full
file:line evidence, "what works / broken / missing / to add", and its own
P0/P1/P2 list. This file is the roll-up — read the domain file before
fixing anything, don't fix off this summary alone.

Core finding across the whole audit: **this is not a broken product.**
Almost every domain has real DB-backed logic, real RLS, real provider
calls (Stripe/Razorpay, Nango OAuth, SuperTokens, Langfuse, Temporal).
The gaps cluster in three repeating patterns:
1. Backend built correctly, **zero frontend UI** to use it (audit log, DSR, autonomy tier editing, plan history).
2. Enforcement/authorization layer missing where the mechanic already exists (usage caps computed but not enforced, RBAC gates inconsistent, no rate limiting/MFA).
3. Dead/unwired code sitting next to the live path (duplicate cold-start seeds, unwired employee-gate.ts, hardcoded stub metrics rendering as fake-healthy).

---

## P0 — blocks core flow / breaks trust / security (fix first)

| # | Domain | Issue | File |
|---|---|---|---|
| 1 | Observability | `outboundPerCustomer: 0` / `predictedMinusActual: null` hardcoded — spam-cap and calibration-drift tiles always render fake-healthy | observability.md |
| 2 | Audit Log | Fully built, RBAC-gated, Langfuse-linked audit trail has **zero frontend page** — nobody can view it in-product | audit-log.md |
| 3 | Org/Tenancy | Kill-switch + rollout-stage RBAC ✅ Done (see org-tenancy.md tracker #2); remaining P2: switcher UI / deletion saga / edge quotas | org-tenancy.md |
| 4 | Auth | Zero rate limiting / lockout / MFA on login, register, reset-password, OAuth, SSO — open to brute-force/credential-stuffing | auth.md |
| 5 | Autonomy (tab) | `AutonomySettings.tsx` never calls the working `PATCH /api/settings/autonomy` — no UI to change autonomy tiers at all | autonomy.md |
| 6 | Autonomy (tab) | "Pending" list only displays items — no Approve/Reject wired to the working `PATCH /api/decisions` path | autonomy.md |
| 7 | DSR | Zero frontend UI anywhere for GDPR delete/export — internal API only | dsr.md |
| 8 | DSR | Delete has no confirmation gate, fully synchronous, no recovery if it times out mid-loop (stuck at `running` forever) | dsr.md |
| 9 | Billing | `usageBlocked` hard-cap computed but never enforced in agent/tool execution path — usage billing has observability, no teeth | billing.md, 00-workspace-connectivity.md |
| 10 | Brain | UI does keyword-only search while the agent's real retrieval is hybrid-vector over the same table — user-facing search silently weaker than what the AI actually uses | 00-workspace-connectivity.md |
| 11 | Home vs Analytics | Two different "Automation Rate" formulas computed off the same tables — dashboard and analytics can show contradicting numbers | 00-workspace-connectivity.md |
| 12 | Webhooks | Gmail/Instagram/SMS have zero outbound send path — advertised as two-way channels, inbound-only in reality | webhooks.md |
| 13 | Realtime | 🟢 Resolved: `/api/stream/events` degrades to 10s DB polling (conversations, plans, work items) when Redis is down; `useRealtimeStream` reconnects with backoff + jitter and polls through `onFallbackTick`. Was: SSE hard-503s with zero degraded/polling fallback — total realtime blackout | realtime-stream.md |

## P1 — degrades trust or UX, not core-breaking

- Packs: install logic duplicated byte-for-byte in two files (desync risk); onboarding recommends a non-live `'ecommerce'` pack that 400s on install. (`packs.md`)
- Integrations: only Google/Meta/GitHub have real OAuth client IDs; HubSpot/Stripe/Notion/Slack/Shopify/Zendesk/Intercom need registration; Wave A/B provider list (Microsoft, Salesforce, DocuSign, Twilio…) is placeholder-only. `NEXT_PUBLIC_NANGO_PUBLIC_KEY` unset blocks 100% of OAuth connects. (`integrations-connectors.md`)
- Settings/Auth: no audit trail of settings changes; GET/DELETE on autonomy/pending/suppressions have no role check. (`settings.md`)
- Employees: unvalidated `tool_allowlist`, no per-employee performance metrics (only org-wide `*`), hard-delete orphans `work_items`. (`employees.md`)
- Work Items: only GET + narrow decision action — no manual create/reassign/priority change; no RBAC on GET/decision routes; no dedicated Work Items page (side-filter only). (`work-items.md`)
- Onboarding: no RBAC on backfill/config endpoints (any member can trigger). (`onboarding.md`)
- Conversations: unbounded `GET /messages` query (no LIMIT); hard 50-cap with no pagination on conversation list; raw driver errors leaked via `catch (err: any)`. (`conversations.md`)
- Widget: polling hard-stops after 60s (slow replies never shown); `/api/widget/intent` has no rate limit and skips the pack-install gate other widget routes enforce. (`widget.md`)
- Agent governance: `employee-gate.ts` + `employee-metrics.ts` fully built, well-tested, **zero callers repo-wide** — dead code; `cold-start.ts` duplicated by hand in `employee-provision.ts` instead of imported; a confusingly-named second file (`onboarding-cold-start.ts`) is the one actually wired. (`agent-governance.md`)
- Plans: "Edit params" wired on Ask AI chat page but not passed as a prop on `/plans/page.tsx` — button silently never renders there even though other docs mark this "done"; completed/cancelled plans vanish from `/plans` on refresh (query filters them out, no history view). (`plans.md`)
- Connectors: grid doesn't warn before opening a doomed OAuth popup when `oauthConfigured===false`; Interactive API Runner only has real test specs for 7 of the full connector registry. (`connectors.md`)
- Cross-tab: only 2 of 22 tabs are subscribed to the SSE event bus despite 5 independent domain audits flagging the same missing-SSE gap; three overlapping approval tables (`agent_pending_actions` / work-items-as-decision / `/api/settings/pending`) instead of one canonical table; employee metrics keyed on role string, not employee UUID. (`00-workspace-connectivity.md`)
- Health: `/api/health` is liveness-only — no readiness/dependency checks (Postgres/Temporal/Nango/Langfuse/MCP bridge), no UI status indicator. (`health.md`)
- Analytics: `roi`/`cost-health`/`calibration` routes are real backend, zero frontend consumers — dead UI surface. (`analytics.md`)

## P2 — polish, defer

Dashboard home cost tile, brief push digest/inline actions, widget theming/typing indicator, realtime presence signal, new-chat UI only exposing 2 of 6 wired channels, static `CATEGORIES` array drifting from backend catalog, missing test files for `periodic-registry.ts`/`quiet-hours.ts`. Full detail in each domain file.

---

## Full file index (38 domain docs + this summary)

Core AI: `ask-ai.md` `brain.md` `insight.md` `decisions.md` `agent-runtime.md` `crew-workflows.md` `agent-governance.md` `plans.md`
Messaging: `webhooks.md` `conversations.md` `widget.md` `realtime-stream.md`
Account/tenancy: `billing.md` `org-tenancy.md` `auth.md` `settings.md` `autonomy.md` `dsr.md`
Integrations: `integrations-connectors.md` `connectors.md` `packs.md` `skills.md`
Employee/ops: `employees.md` `onboarding.md` `work-items.md` `customer.md`
Real estate vertical: `listings.md` `showings.md` `inquiries.md` `rent-reminders.md` `growth.md`
Observability/reporting: `analytics.md` `dashboard-home.md` `home.md` `observability.md` `health.md` `audit-log.md` `brief.md`
Cross-cutting: `00-workspace-connectivity.md` (how tabs wire together end to end + build order for shared primitives)

## Suggested fix order

1. Kill-switch/rollout RBAC gap + auth rate-limit/MFA (security, fast, isolated).
2. Wire usage-gate enforcement at the tool-executor choke point (highest blast radius per connectivity doc).
3. Autonomy tab: add tier-write UI + approve/reject actions (unblocks the product's core "human oversight" pitch).
4. Audit log + DSR frontend pages (backend already done, pure UI work).
5. Fix the two hardcoded observability stub metrics (delete false confidence).
6. Adopt one shared SSE hook across tabs, one canonical approval table, one audit-emit helper (mechanical, per connectivity doc build order).
7. Everything else in each domain's own P1/P2 list, by domain owner.
