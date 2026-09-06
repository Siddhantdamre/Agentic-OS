# 06 — Integrations and the Action Bus

The action layer is where an assistant becomes an employee. It is also where a
mistake is expensive, which is why authorisation, risk classification and
honesty are enforced in data rather than in prompts.

---

## 1. Five principles, each with an enforcement mechanism

| Principle | Enforced by |
|---|---|
| **Never fake a success** | `honesty-connectors.yaml` goldens with explicit `negativeOutput`, plus `wave-b-c6-honesty.test.ts` |
| **Authorisation is data, not prompt** | `ai_employees.tool_allowlist TEXT[]`, resolved in `tool-executor.ts` |
| **One broker for OAuth** | Nango; no token handling in tool code |
| **Risk decides the execution path** | `tools/risk.ts` + `plan-steps.ts` |
| **The catalogue is data** | `connector_defs` (`014`) |

---

## 2. The catalogue — 50+ executors

`services/workflows/src/tools/`, grouped:

**Google (17)** — Gmail, Calendar, Drive, Docs, Sheets, Slides, Forms, Tasks,
Contacts, Chat, Meet, Maps, Analytics, Search Console, Business Profile, Ads,
Cloud.

**Microsoft (2)** — Outlook, Calendar.

**CRM / support (5)** — HubSpot, Salesforce, Zoho, Intercom, Zendesk.

**Messaging (4)** — WhatsApp, Slack, Twilio, Google Chat.

**Commerce / finance (4)** — Stripe, Razorpay, Shopify, QuickBooks.

**Documents / signing (3)** — Notion, DocuSign, Leegality.

**Engineering (2)** — GitHub, Sandbox.

**Data / web (7)** — database query, `sql_analytics`, org SQL connections, web
search, web extract, file ops, metrics, risk.

**Vertical** — `tools/realestate/` (MLS + realestate), `tools/public/rera.ts`.

Connector services in `services/connectors/` wrap OAuth/BYOK plumbing for Gmail,
Calendar, Google Ads, Meta Ads, HubSpot, WhatsApp and Razorpay.

### Registry discipline

`tools/index.ts` is a registry of provider modules with a documented rule:
*"WS-14 adds new files here and a matching ProviderKey case — do not grow
`tool-executor.ts`."* The executor stays small; providers stay isolated. A
50-provider system with a monolithic executor becomes unreviewable within a
quarter.

---

## 3. Risk classification — the spine of the action layer

```ts
// tools/risk.ts
type ToolRisk = 'read' | 'draft' | 'send' | 'pay' | 'sign' | 'publish' | 'delete';

confirmForRisk(risk): boolean
  read, draft                              → false
  send, pay, sign, publish, delete         → true
```

Exhaustiveness is enforced with a `never` check, so adding a risk class without
deciding its confirm behaviour is a **compile error**, not a runtime surprise.

### Risk decides three separate things

| Decision | Rule |
|---|---|
| **Human confirm?** | `confirmForRisk(risk)` |
| **Durable execution?** | `isDurablePlanRisk(risk)` — same split, different consequence |
| **Extra pack-level confirm?** | `compliance.extraConfirmClasses: [send, pay, sign]` in `core-b2b` |

A plan containing any durable-risk step goes to `PlanExecuteWorkflow` **in its
entirety**, not step by step. Partial durability would leave the read steps
outside the workflow's replay history and make the run unrecoverable.

### Failing closed

`planRequiresDurableExecute()` first asks the registry via
`resolveToolRisk(tool, action)`, then falls back to string heuristics:
`send_email`, `send_whatsapp`, `send_message`, any `send` verb on gmail /
whatsapp / slack / twilio, and any `pay`, `charge`, `sign`, `publish`, `delete`.

A tool that forgot to declare its risk class is still treated as dangerous.
That is the correct default direction for this specific decision.

Disabled steps (`enabled === false`) are excluded from the scan, so unchecking a
send step in the UI genuinely downgrades the execution path rather than
theatrically.

---

## 4. The connector registry (`connector_defs`, `014`)

Global (not tenant-scoped), keyed by `key`:

| Column | Purpose |
|---|---|
| `nango_key` | The broker's integration id |
| `name`, `category`, `icon`, `description` | Catalogue presentation |
| `auth_mode` | `oauth` \| BYOK variants |
| `risk_class` | Default risk for this connector's actions |
| `confirm_policy` | When a human confirm is required |
| `vertical_tags TEXT[]` | Which packs surface it |
| `mcp_tools TEXT[]` | Tool names exposed over MCP |
| `extra_connect_fields JSONB` | BYOK form definition — data-driven UI |
| `extra_test_fields JSONB` | "Test connection" form |
| `executor_status` | Is the executor actually implemented? |
| `testable BOOLEAN` | Is "test connection" meaningful here? |
| `scopes TEXT[]` | Required OAuth scopes |
| `env_vars JSONB` | What operations must configure |
| `webhook_events TEXT[]` | Events this connector can push |

Three consequences:

1. **Adding a connector to the UI needs no dashboard deploy.**
2. **`executor_status` prevents advertising a connector whose executor does not
   exist** — the catalogue cannot outrun the code.
3. **`scopes` makes scope drift detectable.** The Gmail `draft_email` 403 came
   from a token minted before `gmail.compose` was added to the config. With
   required scopes in the registry, that becomes a comparison against the
   granted scopes rather than a production surprise. *(The comparison is not
   implemented yet — see gaps.)*

---

## 5. Connection states, honestly

| State | Meaning | What the agent says |
|---|---|---|
| `not_configured` | No provider app registered for this tenant | "That connector isn't set up yet" |
| `disconnected` | Configured, no org connection | "Gmail isn't connected — connect it on /connectors" |
| `connected` | A real Nango connection with a live token | Uses it |
| `scope_insufficient` | Connected, token lacks the scope | "Reconnect Gmail to grant compose access" |
| `error` | Provider returned a failure | The real error, not a paraphrase |

The shape returned for a non-connected tool:

```json
{"status":"error","data":{"connected":false},"setupUrl":"/connectors"}
```

**`setupUrl` is part of the contract.** An honest error that leaves the user
stuck is only half the requirement — the goldens assert the remediation path,
not just the failure.

### The bug this rule exists because of

`POST /api/integrations` once upserted `status='connected'` with a guessed
`nango_connection_id` without creating a real broker connection, and `GET`
trusted those rows. The UI showed 14/14 connected while Nango held four. Every
tool then reported `connected: false` and the product looked broken and
dishonest simultaneously.

**Rule now:** `connected` is only ever written from a real broker connection —
never from a seed, never inferred from a UI click.

Compounding it, `NANGO_SECRET_KEY` resolved to a non-UUID placeholder because
`infra/.env` and `services/connectors/.env` (loaded last) overrode the real dev
UUID in `apps/dashboard/.env.local`. Nango rejects non-UUID keys
(`invalid_secret_key_format`), so no token could be fetched at all. Two
independent faults produced one symptom — which is why the verification script
does a **live round trip** rather than checking a config value.

---

## 6. Authorisation at execution time

```
allowed(tool) =
     tool ∈ ⋃ (tool_allowlist of ALL active ai_employees)
  ∨  tool ∈ core tools
  ∨  tool ∈ connectors with org_connectors.status ∈ (connected, active)
```

Core tools, always allowed: `web_search`, `web_extract`, `database_query`,
`db_query`, `sql_analytics`, `file_ops`, `file_system`, `workspace_file`,
`sandbox`, `code_execution`, `execute_code`.

On the plan-execute path, an explicit `toolAllowlist` (the plan's own step tools
plus core tools) is passed as a second, narrower gate.

Three independent server-side layers must all pass: **human role → employee
allowlist → org connection**. Prompt content grants nothing, which is the
strongest prompt-injection defence in the product.

---

## 7. Sandbox

`infra/docker/sandbox` — node 20 + python 3.

```
POST /execute {language, code, timeoutMs}
  → {result: {stdout, stderr, exitCode}}
```

Unprivileged user, hard timeout, **no outbound network, no DB access**.
Languages: `node`, `python`, `bash`. Verified live: python `6*7=42`, node
`1+1=2`, bash `hi there`.

This is how the brain does analysis it has no tool for — reshape a CSV, compute
a schedule, transform an API response.

**The network isolation is not negotiable.** Code execution is exactly what a
prompt injection targets, and a sandbox with network access is an exfiltration
channel. The cost is that fetching a URL must be `web_extract` *then* sandbox,
as two steps. Correct trade.

Historical note: `code_execution` previously pointed at a dead
`@agent-infra/sandbox` on `localhost:8080`, which in this stack is the Temporal
UI. Code execution never worked and failed confusingly rather than honestly.

---

## 8. MCP — Darex as a capability provider

Tools are exposed as `mcp.darex.*` through the MCP bridge (`:8790`), under the
same allowlist and audit rules as internal calls. `connector_defs.mcp_tools`
declares which tool names each connector publishes.

This makes Darex a **provider** of capability, not only a consumer: any
MCP-capable client — an IDE, a desktop assistant, another agent — can drive
Darex actions with tenancy and confirm still enforced server-side. It is a
distribution channel that adds no new attack surface, because authorisation does
not move.

---

## 9. Idempotency

`idempotency_keys` (org-scoped, with `expires_at` and an expiry index) is passed
through `WorkItemWorkflowInput.idempotencyKey` and
`PlanExecuteWorkflowInput.idempotencyKey`.

Temporal guarantees at-least-once activity execution. Without a key, a retried
"send invoice" sends twice. With one, the second attempt is a lookup.

**Gap:** the key exists at the workflow boundary but is not uniformly threaded
into every write tool. Every executor that mutates external state should derive
and check one. This is the highest-value small fix in the action layer.

---

## 10. Gaps in the action layer

| Gap | Consequence | Notes |
|---|---|---|
| **Idempotency not threaded into every write tool** | A retry can duplicate an external side effect | Table and workflow plumbing already exist |
| **No compensation / rollback** | A 4-step plan failing at step 3 leaves the world half-changed; `completed_with_errors` reports it honestly but offers no undo | Needs per-step compensation definitions |
| **Scope-drift detection not implemented** | The `draft_email` 403 class of bug recurs | `connector_defs.scopes` holds the required data |
| **No spend budgets at execution** | Fan-out is capped by count (3/3/10), not by cost; one expensive step can blow any budget | `billing_meters.soft_limit`/`hard_limit` are the right home |
| **Connector health is ops-only** | A 401 surfaces as a task failure to the user | `alerting-connector-401s.js` exists; the org-facing "reconnect Gmail" prompt does not |
| **No bulk / batch operations** | Chasing 200 leads is 200 tool calls | Needs a batch contract per provider |
| **Polling where webhooks exist** | `SyncWorkflow` polls providers that could push | `connector_defs.webhook_events` is declared but underused |
| **Voice and IVR absent** | The highest-signal SMB channel is invisible | See `20` §5 |
| **No document intake pipeline** | A dropped PDF contract becomes text, not obligations | See `20` §4 |

---

## 11. Ops-blocked (code complete, credentials missing)

Slack · HubSpot · Stripe · Notion · Shopify · Zendesk · Intercom · Zoho ·
QuickBooks need real OAuth client IDs registered in the Nango UI (`:3003`).
Leegality needs a BYOK `X-Auth-Token`.

`infra/scripts/seed-nango-configs.sql` applies configs idempotently — Gmail
scopes (`gmail.send gmail.readonly gmail.compose gmail.modify`), Intercom and
Notion (`read write`), Drive/Docs/Sheets upserts. Run it, then
`docker compose restart nango-server`.

Track this as an **operations** task. Carrying it as "product incomplete" hides
how much of the action layer is genuinely finished.
