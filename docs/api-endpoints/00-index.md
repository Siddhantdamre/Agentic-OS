# API endpoints

Full inventory of the Darex HTTP API as implemented in `apps/dashboard`. Use this when replacing the frontend. The browser talks to these routes. Org id always comes from the signed session, not from a body or query `org_id`.

Inventoried 218 handlers in 149 route files on 2026-09-27 (auth catch-all aliases counted as separate client paths; nested calendar-watch and google-calendar duplicates included).

## How to call them

See [conventions.md](./conventions.md) for cookies, roles, errors, and streaming.

## Areas

| Doc | Handlers | Paths |
| --- | ---: | ---: |
| [Auth](./auth.md) | 18 | 16 |
| [Ask AI](./ask-ai.md) | 13 | 7 |
| [Agent runtime](./agent.md) | 7 | 6 |
| [Conversations](./conversations.md) | 5 | 3 |
| [Employees](./employees.md) | 11 | 6 |
| [Brain (knowledge)](./brain.md) | 8 | 4 |
| [Brief, decisions, and work items](./brief-decisions-work.md) | 12 | 9 |
| [Growth, listings, showings, inquiries, rent](./growth-listings.md) | 28 | 16 |
| [Billing](./billing.md) | 5 | 5 |
| [Settings](./settings.md) | 9 | 5 |
| [Onboarding and organization](./onboarding-org.md) | 16 | 10 |
| [Integrations](./integrations.md) | 11 | 7 |
| [Analytics and dashboard](./analytics-dashboard.md) | 7 | 7 |
| [Packs and skills](./packs-skills.md) | 8 | 6 |
| [Audit and data subject requests](./audit-dsr.md) | 6 | 6 |
| [Realtime stream](./stream.md) | 4 | 3 |
| [Public widget and embed](./widget-embed.md) | 15 | 7 |
| [Inbound webhooks](./webhooks.md) | 16 | 13 |
| [Platform admin](./platform.md) | 14 | 14 |
| [Health and observability](./health-observability.md) | 5 | 5 |
| [Conventions](./conventions.md) |  |  |
| [Internal services](./internal-services.md) |  |  |

## Every path

| Method | Path | Doc |
| --- | --- | --- |
| POST | `/api/agent/crew` | [agent](./agent.md) |
| GET | `/api/agent/explain` | [agent](./agent.md) |
| POST | `/api/agent/pending-actions` | [agent](./agent.md) |
| POST | `/api/agent/run` | [agent](./agent.md) |
| POST | `/api/agent/stream` | [agent](./agent.md) |
| GET | `/api/agent/tools` | [agent](./agent.md) |
| POST | `/api/agent/tools` | [agent](./agent.md) |
| GET | `/api/analytics` | [analytics-dashboard](./analytics-dashboard.md) |
| GET | `/api/analytics/calibration` | [analytics-dashboard](./analytics-dashboard.md) |
| GET | `/api/analytics/cost` | [analytics-dashboard](./analytics-dashboard.md) |
| GET | `/api/analytics/cost-health` | [analytics-dashboard](./analytics-dashboard.md) |
| GET | `/api/analytics/export` | [analytics-dashboard](./analytics-dashboard.md) |
| GET | `/api/analytics/roi` | [analytics-dashboard](./analytics-dashboard.md) |
| GET | `/api/ask-ai` | [ask-ai](./ask-ai.md) |
| POST | `/api/ask-ai` | [ask-ai](./ask-ai.md) |
| POST | `/api/ask-ai/approve` | [ask-ai](./ask-ai.md) |
| DELETE | `/api/ask-ai/conversations` | [ask-ai](./ask-ai.md) |
| GET | `/api/ask-ai/conversations` | [ask-ai](./ask-ai.md) |
| PATCH | `/api/ask-ai/conversations` | [ask-ai](./ask-ai.md) |
| POST | `/api/ask-ai/conversations` | [ask-ai](./ask-ai.md) |
| GET | `/api/ask-ai/execute` | [ask-ai](./ask-ai.md) |
| GET | `/api/ask-ai/feedback` | [ask-ai](./ask-ai.md) |
| POST | `/api/ask-ai/feedback` | [ask-ai](./ask-ai.md) |
| GET | `/api/ask-ai/plan` | [ask-ai](./ask-ai.md) |
| PATCH | `/api/ask-ai/plan` | [ask-ai](./ask-ai.md) |
| POST | `/api/ask-ai/revise` | [ask-ai](./ask-ai.md) |
| GET | `/api/audit` | [audit-dsr](./audit-dsr.md) |
| GET | `/api/audit-logs` | [audit-dsr](./audit-dsr.md) |
| POST | `/api/auth/forgot-password` | [auth](./auth.md) |
| GET | `/api/auth/invite/:token` | [auth](./auth.md) |
| POST | `/api/auth/invite/:token` | [auth](./auth.md) |
| POST | `/api/auth/login` | [auth](./auth.md) |
| GET | `/api/auth/logout` | [auth](./auth.md) |
| GET | `/api/auth/mfa` | [auth](./auth.md) |
| POST | `/api/auth/mfa` | [auth](./auth.md) |
| GET | `/api/auth/oauth/:provider` | [auth](./auth.md) |
| GET | `/api/auth/oauth/callback/:provider` | [auth](./auth.md) |
| POST | `/api/auth/register` | [auth](./auth.md) |
| POST | `/api/auth/reset-password` | [auth](./auth.md) |
| GET | `/api/auth/session` | [auth](./auth.md) |
| POST | `/api/auth/signin` | [auth](./auth.md) |
| GET | `/api/auth/signout` | [auth](./auth.md) |
| POST | `/api/auth/signup` | [auth](./auth.md) |
| GET | `/api/auth/sso` | [auth](./auth.md) |
| GET | `/api/auth/sso/:provider` | [auth](./auth.md) |
| GET | `/api/auth/sso/callback/:provider` | [auth](./auth.md) |
| GET | `/api/billing` | [billing](./billing.md) |
| POST | `/api/billing/checkout` | [billing](./billing.md) |
| GET | `/api/billing/meters` | [billing](./billing.md) |
| POST | `/api/billing/portal` | [billing](./billing.md) |
| PATCH | `/api/billing/subscription` | [billing](./billing.md) |
| GET | `/api/brain` | [brain](./brain.md) |
| POST | `/api/brain` | [brain](./brain.md) |
| DELETE | `/api/brain/:id` | [brain](./brain.md) |
| PATCH | `/api/brain/:id` | [brain](./brain.md) |
| POST | `/api/brain/:id` | [brain](./brain.md) |
| GET | `/api/brain/:id/revisions` | [brain](./brain.md) |
| GET | `/api/brain/reindex` | [brain](./brain.md) |
| POST | `/api/brain/reindex` | [brain](./brain.md) |
| GET | `/api/brief` | [brief-decisions-work](./brief-decisions-work.md) |
| POST | `/api/brief/:id/triage` | [brief-decisions-work](./brief-decisions-work.md) |
| GET | `/api/conversations` | [conversations](./conversations.md) |
| POST | `/api/conversations` | [conversations](./conversations.md) |
| PATCH | `/api/conversations/:id` | [conversations](./conversations.md) |
| GET | `/api/conversations/:id/messages` | [conversations](./conversations.md) |
| POST | `/api/conversations/:id/messages` | [conversations](./conversations.md) |
| GET | `/api/dashboard/stats` | [analytics-dashboard](./analytics-dashboard.md) |
| GET | `/api/decisions` | [brief-decisions-work](./brief-decisions-work.md) |
| PATCH | `/api/decisions` | [brief-decisions-work](./brief-decisions-work.md) |
| POST | `/api/decisions/sweep` | [brief-decisions-work](./brief-decisions-work.md) |
| GET | `/api/dsr` | [audit-dsr](./audit-dsr.md) |
| GET | `/api/dsr/:id/download` | [audit-dsr](./audit-dsr.md) |
| POST | `/api/dsr/delete` | [audit-dsr](./audit-dsr.md) |
| POST | `/api/dsr/export` | [audit-dsr](./audit-dsr.md) |
| GET | `/api/employees` | [employees](./employees.md) |
| PATCH | `/api/employees` | [employees](./employees.md) |
| POST | `/api/employees` | [employees](./employees.md) |
| DELETE | `/api/employees/:id` | [employees](./employees.md) |
| GET | `/api/employees/:id` | [employees](./employees.md) |
| PATCH | `/api/employees/:id` | [employees](./employees.md) |
| GET | `/api/employees/:id/activity` | [employees](./employees.md) |
| GET | `/api/employees/customer` | [employees](./employees.md) |
| GET | `/api/employees/customer/open-loops` | [employees](./employees.md) |
| PATCH | `/api/employees/customer/open-loops` | [employees](./employees.md) |
| GET | `/api/employees/stats` | [employees](./employees.md) |
| GET | `/api/growth/brief` | [growth-listings](./growth-listings.md) |
| POST | `/api/growth/listings/match` | [growth-listings](./growth-listings.md) |
| POST | `/api/growth/opportunities/:id/decision` | [growth-listings](./growth-listings.md) |
| GET | `/api/health` | [health-observability](./health-observability.md) |
| GET | `/api/health/diagnostics` | [health-observability](./health-observability.md) |
| GET | `/api/health/ready` | [health-observability](./health-observability.md) |
| GET | `/api/inquiries` | [growth-listings](./growth-listings.md) |
| POST | `/api/inquiries` | [growth-listings](./growth-listings.md) |
| DELETE | `/api/inquiries/:id` | [growth-listings](./growth-listings.md) |
| PATCH | `/api/inquiries/:id` | [growth-listings](./growth-listings.md) |
| GET | `/api/insight` | [growth-listings](./growth-listings.md) |
| POST | `/api/insight` | [growth-listings](./growth-listings.md) |
| GET | `/api/integrations` | [integrations](./integrations.md) |
| POST | `/api/integrations` | [integrations](./integrations.md) |
| POST | `/api/integrations/:provider/ping` | [integrations](./integrations.md) |
| GET | `/api/integrations/nango-token` | [integrations](./integrations.md) |
| POST | `/api/integrations/nango-token` | [integrations](./integrations.md) |
| GET | `/api/integrations/razorpay` | [integrations](./integrations.md) |
| POST | `/api/integrations/razorpay` | [integrations](./integrations.md) |
| POST | `/api/integrations/test` | [integrations](./integrations.md) |
| POST | `/api/integrations/webhooks` | [integrations](./integrations.md) |
| GET | `/api/integrations/whatsapp` | [integrations](./integrations.md) |
| POST | `/api/integrations/whatsapp` | [integrations](./integrations.md) |
| GET | `/api/listings` | [growth-listings](./growth-listings.md) |
| POST | `/api/listings` | [growth-listings](./growth-listings.md) |
| DELETE | `/api/listings/:id` | [growth-listings](./growth-listings.md) |
| GET | `/api/listings/:id` | [growth-listings](./growth-listings.md) |
| PATCH | `/api/listings/:id` | [growth-listings](./growth-listings.md) |
| POST | `/api/listings/sync` | [growth-listings](./growth-listings.md) |
| POST | `/api/observability/alerts/dispatch` | [health-observability](./health-observability.md) |
| GET | `/api/observability/metrics` | [health-observability](./health-observability.md) |
| GET | `/api/onboarding/backfill` | [onboarding-org](./onboarding-org.md) |
| POST | `/api/onboarding/backfill` | [onboarding-org](./onboarding-org.md) |
| GET | `/api/onboarding/observation` | [onboarding-org](./onboarding-org.md) |
| GET | `/api/onboarding/settings` | [onboarding-org](./onboarding-org.md) |
| PATCH | `/api/onboarding/settings` | [onboarding-org](./onboarding-org.md) |
| GET | `/api/onboarding/trajectory` | [onboarding-org](./onboarding-org.md) |
| POST | `/api/org/create` | [onboarding-org](./onboarding-org.md) |
| GET | `/api/org/kill-switch` | [onboarding-org](./onboarding-org.md) |
| PATCH | `/api/org/kill-switch` | [onboarding-org](./onboarding-org.md) |
| POST | `/api/org/kill-switch` | [onboarding-org](./onboarding-org.md) |
| GET | `/api/org/memberships` | [onboarding-org](./onboarding-org.md) |
| GET | `/api/org/onboarding` | [onboarding-org](./onboarding-org.md) |
| PATCH | `/api/org/onboarding` | [onboarding-org](./onboarding-org.md) |
| GET | `/api/org/rollout` | [onboarding-org](./onboarding-org.md) |
| PATCH | `/api/org/rollout` | [onboarding-org](./onboarding-org.md) |
| POST | `/api/org/switch` | [onboarding-org](./onboarding-org.md) |
| DELETE | `/api/packs` | [packs-skills](./packs-skills.md) |
| GET | `/api/packs` | [packs-skills](./packs-skills.md) |
| POST | `/api/packs` | [packs-skills](./packs-skills.md) |
| PATCH | `/api/packs/:id/config` | [packs-skills](./packs-skills.md) |
| POST | `/api/packs/install` | [packs-skills](./packs-skills.md) |
| GET | `/api/packs/listings` | [packs-skills](./packs-skills.md) |
| POST | `/api/platform/impersonation` | [platform](./platform.md) |
| GET | `/api/platform/impersonation/current` | [platform](./platform.md) |
| POST | `/api/platform/impersonation/end` | [platform](./platform.md) |
| GET | `/api/platform/observability` | [platform](./platform.md) |
| GET | `/api/platform/orgs` | [platform](./platform.md) |
| GET | `/api/platform/orgs/:orgId` | [platform](./platform.md) |
| POST | `/api/platform/orgs/:orgId/connectors/:id/disconnect` | [platform](./platform.md) |
| POST | `/api/platform/orgs/:orgId/kill-switch` | [platform](./platform.md) |
| PUT | `/api/platform/orgs/:orgId/overrides` | [platform](./platform.md) |
| POST | `/api/platform/orgs/:orgId/soft-delete` | [platform](./platform.md) |
| POST | `/api/platform/orgs/:orgId/suspend` | [platform](./platform.md) |
| POST | `/api/platform/orgs/:orgId/unsuspend` | [platform](./platform.md) |
| POST | `/api/platform/orgs/:orgId/users/:userId/revoke-sessions` | [platform](./platform.md) |
| GET | `/api/platform/search` | [platform](./platform.md) |
| GET | `/api/rent-reminders` | [growth-listings](./growth-listings.md) |
| POST | `/api/rent-reminders` | [growth-listings](./growth-listings.md) |
| POST | `/api/rent-reminders/charges` | [growth-listings](./growth-listings.md) |
| GET | `/api/rent-reminders/leases` | [growth-listings](./growth-listings.md) |
| POST | `/api/rent-reminders/leases` | [growth-listings](./growth-listings.md) |
| GET | `/api/settings` | [settings](./settings.md) |
| POST | `/api/settings` | [settings](./settings.md) |
| GET | `/api/settings/autonomy` | [settings](./settings.md) |
| PATCH | `/api/settings/autonomy` | [settings](./settings.md) |
| DELETE | `/api/settings/members/:id` | [settings](./settings.md) |
| PATCH | `/api/settings/members/:id` | [settings](./settings.md) |
| GET | `/api/settings/pending` | [settings](./settings.md) |
| DELETE | `/api/settings/suppressions` | [settings](./settings.md) |
| GET | `/api/settings/suppressions` | [settings](./settings.md) |
| GET | `/api/showings` | [growth-listings](./growth-listings.md) |
| POST | `/api/showings` | [growth-listings](./growth-listings.md) |
| DELETE | `/api/showings/:id` | [growth-listings](./growth-listings.md) |
| PATCH | `/api/showings/:id` | [growth-listings](./growth-listings.md) |
| GET | `/api/showings/calendar-watch` | [growth-listings](./growth-listings.md) |
| POST | `/api/showings/calendar-watch` | [growth-listings](./growth-listings.md) |
| GET | `/api/showings/calendar-watch/calendar-watch` | [growth-listings](./growth-listings.md) |
| POST | `/api/showings/calendar-watch/calendar-watch` | [growth-listings](./growth-listings.md) |
| GET | `/api/skills` | [packs-skills](./packs-skills.md) |
| PATCH | `/api/skills/:id` | [packs-skills](./packs-skills.md) |
| GET | `/api/stream/events` | [stream](./stream.md) |
| POST | `/api/stream/presence` | [stream](./stream.md) |
| DELETE | `/api/stream/push-subscribe` | [stream](./stream.md) |
| POST | `/api/stream/push-subscribe` | [stream](./stream.md) |
| POST | `/api/webhooks/billing` | [webhooks](./webhooks.md) |
| POST | `/api/webhooks/chatwoot` | [webhooks](./webhooks.md) |
| POST | `/api/webhooks/gmail` | [webhooks](./webhooks.md) |
| POST | `/api/webhooks/google-calendar` | [webhooks](./webhooks.md) |
| POST | `/api/webhooks/google-calendar/google-calendar` | [webhooks](./webhooks.md) |
| GET | `/api/webhooks/instagram` | [webhooks](./webhooks.md) |
| POST | `/api/webhooks/instagram` | [webhooks](./webhooks.md) |
| POST | `/api/webhooks/nango` | [webhooks](./webhooks.md) |
| POST | `/api/webhooks/outbound` | [webhooks](./webhooks.md) |
| GET | `/api/webhooks/owner-whatsapp` | [webhooks](./webhooks.md) |
| POST | `/api/webhooks/owner-whatsapp` | [webhooks](./webhooks.md) |
| POST | `/api/webhooks/rent-payment` | [webhooks](./webhooks.md) |
| POST | `/api/webhooks/slack/interactions` | [webhooks](./webhooks.md) |
| POST | `/api/webhooks/sms` | [webhooks](./webhooks.md) |
| GET | `/api/webhooks/whatsapp` | [webhooks](./webhooks.md) |
| POST | `/api/webhooks/whatsapp` | [webhooks](./webhooks.md) |
| OPTIONS | `/api/widget/intent` | [widget-embed](./widget-embed.md) |
| POST | `/api/widget/intent` | [widget-embed](./widget-embed.md) |
| GET | `/api/widget/listings/search` | [widget-embed](./widget-embed.md) |
| OPTIONS | `/api/widget/listings/search` | [widget-embed](./widget-embed.md) |
| GET | `/api/widget/message` | [widget-embed](./widget-embed.md) |
| OPTIONS | `/api/widget/message` | [widget-embed](./widget-embed.md) |
| POST | `/api/widget/message` | [widget-embed](./widget-embed.md) |
| OPTIONS | `/api/widget/session` | [widget-embed](./widget-embed.md) |
| POST | `/api/widget/session` | [widget-embed](./widget-embed.md) |
| GET | `/api/widget/stream` | [widget-embed](./widget-embed.md) |
| OPTIONS | `/api/widget/stream` | [widget-embed](./widget-embed.md) |
| GET | `/api/widget/tools` | [widget-embed](./widget-embed.md) |
| OPTIONS | `/api/widget/tools` | [widget-embed](./widget-embed.md) |
| POST | `/api/widget/tools` | [widget-embed](./widget-embed.md) |
| GET | `/api/work-items` | [brief-decisions-work](./brief-decisions-work.md) |
| POST | `/api/work-items` | [brief-decisions-work](./brief-decisions-work.md) |
| GET | `/api/work-items/:id` | [brief-decisions-work](./brief-decisions-work.md) |
| PATCH | `/api/work-items/:id` | [brief-decisions-work](./brief-decisions-work.md) |
| POST | `/api/work-items/:id/decision` | [brief-decisions-work](./brief-decisions-work.md) |
| POST | `/api/work-items/playbook` | [brief-decisions-work](./brief-decisions-work.md) |
| POST | `/api/work-items/sweep-sla` | [brief-decisions-work](./brief-decisions-work.md) |
| GET | `/embed/widget.js` | [widget-embed](./widget-embed.md) |

## Not part of this list

- Page routes under `apps/dashboard/app/(dashboard)`, `(auth)`, `(onboarding)`, `(platform)` are UI, not APIs.
- `services/workflows` is the agent worker. Its only HTTP surface is the MCP bridge, documented in [internal-services.md](./internal-services.md). The dashboard calls it server-side.
- `services/connectors` is a library. It has no HTTP server of its own.
- `apps/inbox` and `infra/docker/sandbox` are internal HTTP processes, documented in [internal-services.md](./internal-services.md). Do not call them from a replacement frontend.
- Nested duplicates exist and are listed because they are reachable: `POST/GET /api/showings/calendar-watch/calendar-watch` matches `.../calendar-watch`, and `POST /api/webhooks/google-calendar/google-calendar` matches `.../google-calendar`.
- Pack aliases: `POST /api/packs/install` matches `POST /api/packs`; `GET /api/packs/listings` matches `GET /api/listings`.
