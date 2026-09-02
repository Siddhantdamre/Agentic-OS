# 16 — API Surface

Every route under `apps/dashboard/app/api/`. Grouped by function, with the
product rule each group enforces. Routes are Next.js App Router handlers; org
context is resolved from the authenticated session on every one of them.

## 1. Reasoning — Ask AI

| Route | Purpose |
|---|---|
| `POST /api/ask-ai` | The main entry: classify, then answer or plan |
| `POST /api/ask-ai/plan` | Generate a plan explicitly |
| `POST /api/ask-ai/revise` | Revise a plan or draft from human feedback |
| `POST /api/ask-ai/execute` | Execute an approved plan (SSE stream) |
| `POST /api/ask-ai/feedback` | Up/down vote → `ask_ai_feedback` |

**Execution split enforced here:** `/execute` checks
`planRequiresDurableExecute(steps)`. Read/draft plans stream over SSE from the
route. Any `send | pay | sign | publish | delete` step hands the whole plan to
`PlanExecuteWorkflow` and the route streams the workflow's progress instead.
A dashboard restart mid-send therefore cannot drop the send.

**Allowlist belt-and-suspenders:** `/execute` passes an explicit
`toolAllowlist` built from the plan's own step tools plus core tools, in
addition to the org-level union resolved inside `tool-executor.ts`.

## 2. Agents

| Route | Purpose |
|---|---|
| `POST /api/agent/run` | Run an agent task directly |
| `GET /api/agent/stream` | Stream agent output |
| `POST /api/agent/crew` | Launch a crew (capped at 3 specialists) |
| `GET /api/agent/tools` | What tools are available to this org right now |

`/api/agent/tools` is the honest capability endpoint — it reflects the resolved
union (employee allowlists ∪ core tools ∪ actually-connected connectors), so
the UI cannot advertise a capability the executor would refuse.

## 3. Employees

`GET|POST /api/employees` · `GET|PATCH|DELETE /api/employees/[id]` ·
`GET /api/employees/stats`

`stats` is the beginning of the employee scorecard described in `05` §7.

## 4. Memory — the brain

| Route | Purpose |
|---|---|
| `GET /api/brain` | Search org memory across tiers, with citations |
| `GET /api/brain/[id]` | Open one memory row and its provenance |
| `POST /api/brain/reindex` | Re-embed / re-ingest a source |

`reindex` respects `content_hash`, so it is cheap when nothing changed.

## 5. Conversations

`GET /api/conversations` · `GET /api/conversations/[id]` ·
`GET|POST /api/conversations/[id]/messages`

## 6. Connectors and integrations

| Route | Purpose |
|---|---|
| `GET|POST /api/integrations` | List and connect; state comes from the broker, never from a local guess |
| `POST /api/integrations/nango-token` | Mint a session token for the OAuth popup |
| `POST /api/integrations/test` | Live "test connection" — only for `connector_defs.testable` |
| `POST /api/integrations/whatsapp` | BYOK credential capture |
| `POST /api/integrations/razorpay` | BYOK credential capture |
| `GET /api/integrations/webhooks` | Which webhook events this org receives |

**The rule this group exists to enforce:** `GET /api/integrations` derives
`connected` from a real broker connection. A historical bug had it trusting
local `org_connectors` rows written optimistically by the connect handler — the
UI showed 14/14 connected while the broker held four. Connection state is read
from the source of truth, always.

## 7. Inbound webhooks

`POST /api/webhooks/whatsapp` · `chatwoot` · `gmail` · `instagram` · `sms` ·
`owner-whatsapp` · `outbound` · `billing`

Rules that apply to all of them:

1. **Verify the signature first.** Chatwoot uses HMAC-SHA256 over the exact
   `JSON.stringify(body)` as `x-chatwoot-signature: sha256=<hex>`.
2. **Persist, return 200, then process.** Providers retry aggressively; a slow
   agent must never cause duplicate deliveries.
3. **Tenant comes from the mapping table** (`chatwoot_inbox_map`, channel key),
   never from a body field.
4. **Deduplicate** on `messages.channel_key` via `idx_messages_org_channel_key`.

`owner-whatsapp` is the notable one: it signals `approveWorkItem` /
`rejectWorkItem` on a running `WorkItemWorkflow`. The owner approves an agent
action **from WhatsApp**, without opening the dashboard. This is the highest-
leverage approval surface the product has.

## 8. Public widget

`POST /api/widget/session` · `POST /api/widget/message` ·
`GET /api/widget/tools` · `GET /api/widget/listings/search`

Served to anonymous visitors on a customer's public site. Tenant is derived
from a **hash of the site key** in `widget_embed_tokens`. The widget's tool
surface is separately scoped — a public visitor cannot reach the org's full
tool set.

## 9. Vertical surfaces

`GET|POST /api/listings` · `/api/inquiries` · `/api/showings` ·
`/api/rent-reminders` · `/api/packs/listings`

Installed by real-estate packs; back `re_listings`, `re_inquiries`,
`re_showings`, `pm_charges`.

## 10. Work and insight

`GET|PATCH /api/work-items` — the human queue.
`GET /api/insight` — insight cards, each naming an executable workflow.
`GET /api/analytics` and `GET /api/analytics/cost` — metrics and per-org LLM
cost from Langfuse.

Analytics and insight read the same metrics registry, so the two surfaces
cannot report different numbers for the same question.

## 11. Packs

`GET /api/packs` · `POST /api/packs/install` → `InstallPackWorkflow`.

## 12. Auth

`ALL /api/auth/[[...path]]` (Supertokens) plus `forgot-password`,
`reset-password`, `invite/[token]`, `oauth/[provider]`,
`oauth/callback/[provider]`, `sso`, `sso/[provider]`, `sso/callback/[provider]`.

SSO routes exist — enterprise identity is scaffolded, not absent.

## 13. Org and governance

`POST /api/org/create` · `GET|POST /api/org/onboarding` ·
`GET|POST /api/settings` · `GET /api/audit` ·
`POST /api/dsr/export` · `POST /api/dsr/delete`

## 14. Billing

`GET /api/billing` · `POST /api/billing/checkout` ·
`GET /api/billing/meters` · `POST /api/billing/portal` ·
`POST /api/webhooks/billing`

Provider-agnostic across Stripe and Razorpay, which matters for India-first
distribution.

## 15. Realtime and health

`GET /api/stream/events` — SSE for live updates.
`GET /api/health` — the probe `start.sh` waits on.
`GET /api/dashboard/stats` — the home surface.

**Known constraint:** SSE currently holds state per process. Two dashboard
replicas do not both receive `needs_attention` until events go through Redis
pub/sub. `infra/scripts/check-two-replica-sse.js` exists to verify this when it
lands.

---

## API-level conventions to keep

1. Org from session, never from body — the widget's site-key hash is the one
   documented exception, and it is a hash lookup, not a caller-supplied id.
2. Webhooks: verify, persist, 200, then process asynchronously.
3. Any route that can trigger a `send | pay | sign | publish | delete` hands
   off to Temporal rather than executing inline.
4. Connection and capability endpoints report the truth from the source of
   truth, even when the truth is "not connected".
5. Streaming endpoints emit monotonic sequence numbers so clients can resume.
