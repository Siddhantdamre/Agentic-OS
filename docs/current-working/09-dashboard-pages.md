# 09 — Dashboard pages

App Router. Route groups `(auth)`, `(dashboard)`, `(onboarding)` are not in URLs.
Chrome: `components/shell/AppShell.tsx` (Home, Ask AI, Conversations, Employees,
Insight, Analytics, Integrations, Connectors; Settings via profile area).

## Pages

| URL | File | Talks to | Status |
|-----|------|----------|--------|
| `/` | `(dashboard)/page.tsx` | `/api/dashboard/stats`, `/api/conversations?status=needs_attention` | **Works** — real KPIs. Quick Ask AI redirects to `/ask-ai?q=`. `?warmup=true` is a fake progress bar. |
| `/ask-ai` | `(dashboard)/ask-ai/page.tsx` | `/api/ask-ai`, plan PATCH, revise, execute SSE | **Works** — see [03](./03-e2e-ask-ai.md) |
| `/conversations` | `(dashboard)/conversations/page.tsx` | conversations APIs + SSE | **Works** |
| `/employees` | `(dashboard)/employees/page.tsx` | `/api/employees`, stats, `AutonomousActionConsole` | **Works** — auto-seeds Sarah/Emma/Marcus |
| `/insight` | `(dashboard)/insight/page.tsx` | `/api/insight` | **Partial** — rule templates, not LLM |
| `/analytics` | `(dashboard)/analytics/page.tsx` | `/api/analytics` | **Works** — real SQL. Fallback numbers (`99.4%`) only until fetch returns. |
| `/integrations` | `(dashboard)/integrations/page.tsx` | integrations + Nango + test | **Works if connected** |
| `/connectors` | `(dashboard)/connectors/page.tsx` | same + WhatsApp modal | **Works if connected** |
| `/connectors/[id]` | `(dashboard)/connectors/[id]/page.tsx` | `/api/integrations/test` | **Works if connected** |
| `/settings` | `(dashboard)/settings/page.tsx` | `/api/settings` | **Partial** — rename works; invite has no email; Meta webhook URL wrong |
| `/login` | `(auth)/login/page.tsx` | `/api/auth/login`, OAuth | **Works** |
| `/register` | `(auth)/register/page.tsx` | `/api/auth/register` | **Works** |
| `/onboarding/name` | `(onboarding)/onboarding/name/page.tsx` | Zustand store | **Works** |
| `/onboarding/team-size` | `.../team-size/page.tsx` | store | **Works** |
| `/onboarding/business-type` | `.../business-type/page.tsx` | store | **Works** |
| `/onboarding/channels` | `.../channels/page.tsx` | `POST /api/org/create` | **Works** |

## Layouts

- `app/layout.tsx` — cream theme.
- `(dashboard)/layout.tsx` — AppShell.
- `(auth)/layout.tsx` — dark shell.
- `(onboarding)/layout.tsx` — wizard + `GrowthTree`.

## Middleware

Cookie `darex_session` on pages only. Does not protect API routes (those use
`getScopedClient`). Does not require onboarding.

## Chat / agent components

| Component | Role |
|-----------|------|
| `PlanCard` | Approve / cancel / toggle steps |
| `DraftPanel` | Accept / revise draft |
| `ExecutionStrip` | Plan-run progress |
| `ActionPermissionCard` | Per-action approve → `/api/agent/tools` |
| `ReasoningStrip` | Planner reasoning |
| `FormattedMarkdownResponse` | AI markdown |
| `AutonomousActionConsole` | Employee-page agent run |
