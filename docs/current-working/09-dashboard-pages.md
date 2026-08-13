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
| `/employees` | `(dashboard)/employees/page.tsx` | `/api/employees`, stats, `CrewSpawnPanel`, `AutonomousActionConsole` | **Works** — auto-seeds Sarah/Emma/Marcus; crew spawn is explicit |
| `/insight` | `(dashboard)/insight/page.tsx` | `/api/insight` | **Partial** — rule templates, not LLM |
| `/analytics` | `(dashboard)/analytics/page.tsx` | `/api/analytics` | **Works** — real SQL. Fallback numbers (`99.4%`) only until fetch returns. |
| `/integrations` | `(dashboard)/integrations/page.tsx` | integrations + Nango + test | **Works if connected** |
| `/connectors` | `(dashboard)/connectors/page.tsx` | same + WhatsApp modal | **Works if connected** |
| `/connectors/[id]` | `(dashboard)/connectors/[id]/page.tsx` | `/api/integrations/test` | **Works if connected** |
| `/settings` | `(dashboard)/settings/page.tsx` | `/api/settings` | **Works** — rename; invites via `org_invites` + copyable link; webhook URLs correct |
| `/login` | `(auth)/login/page.tsx` | `/api/auth/login`, OAuth | **Works** |
| `/register` | `(auth)/register/page.tsx` | `/api/auth/register` | **Works** |
| `/forgot-password` | `(auth)/forgot-password/page.tsx` | `/api/auth/forgot-password` | **Works** |
| `/reset-password` | `(auth)/reset-password/page.tsx` | `/api/auth/reset-password` | **Works** (reachable while signed in) |
| `/invite/[token]` | `(auth)/invite/[token]/page.tsx` | `/api/auth/invite/[token]` | **Works** (reachable while signed in) |
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

Cookie `darex_session`. Unauthenticated **API** routes (except public auth/
webhooks/health) return 401. Pages redirect to `/login`. Invite accept and
reset-password remain reachable while signed in. Does not require onboarding
from DB state (uses onboarding cookie).

## Chat / agent components

| Component | Role |
|-----------|------|
| `PlanCard` | Approve / cancel / toggle steps |
| `DraftPanel` | Accept / revise draft |
| `ExecutionStrip` | Plan-run progress |
| `ActionPermissionCard` | Per-action approve → `/api/agent/tools` |
| `ReasoningStrip` | Planner reasoning |
| `FormattedMarkdownResponse` | AI markdown |
| `CrewSpawnPanel` | Employees-page multi-agent spawn (`POST /api/agent/crew`) |
| `AutonomousActionConsole` | Employee-page agent run |
