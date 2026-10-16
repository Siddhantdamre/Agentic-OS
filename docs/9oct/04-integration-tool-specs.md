# Wave 1 Integration Tool Specs (2026-10-09)

> Build specs for the Wave 1 integrations chosen in
> [`03-new-integrations-roadmap.md`](03-new-integrations-roadmap.md) §6.1.
> Nothing here is implemented yet. Every pattern cited below exists in code
> today; file paths are relative to the repo root.

---

## 0. Scope and how to use this document

- **§1** fixes the conventions every Wave 1 module follows: names, result
  shape, risk map, approval, allowlist placement, errors, rate limits, tests.
- **§2** is the step-by-step "how to add an integration" playbook, matching
  the real wiring of the last connector commits (`e0e32f14` Instagram,
  `15201583` Outlook/Slack/WhatsApp).
- **§3** holds the 20 integration specs plus the platform prerequisite
  (credential-type extension). Each spec has: purpose, auth and connection
  resolution, a tool table (chat tool name → provider action → risk →
  approval → endpoint), input JSON schemas, allowlist placement, error and
  `notConnected` behaviour, rate limits, and the tests to write.
- **§4** is the cross-cutting test matrix and **§5** the definition of done.

Schemas below are JSON Schema for readability. In code they are zod shapes in
`services/workflows/src/tool-definitions.ts` (see the `ToolDef` interface:
`name`, `description`, `schema: Record<string, z.ZodTypeAny>`, `tool`,
`action`). Every schema includes `org_id: z.string()` because existing
definitions do; `mcp-bridge.ts` strips it before registration and resolves the
tenant from signed headers, so it is never model-controlled. It is omitted
from the JSON below for brevity.

---

## 1. Conventions for every Wave 1 module

### 1.1 Naming

| Thing | Rule | Example |
|---|---|---|
| Provider key | kebab-case, matches the connector sign-in id and Nango alias key | `pipedrive`, `microsoft-teams`, `imap-mail` |
| Module export | camelCase of provider key | `microsoftTeams` |
| Module file | `services/workflows/src/tools/<provider-key>.ts` | `tools/microsoft-teams.ts` |
| Chat tool name | `<prefix>_<verb>[_<noun>]`, snake_case, ≤ 64 chars, prefix unique per provider | `pipedrive_list_deals`, `teams_send` |
| Provider action | snake_case verb phrase; chosen so persona-denial substrings in `role-capability.ts` apply where intended | `create_deal`, `send_channel_message`, `send_email` |

Action-name rules that matter because two subsystems match substrings:

1. **Risk.** Existing modules derive risk with `includes('read')` /
   `includes('list')` (see `tools/instagram.ts`, `tools/slack.ts`). That is why
   the Slack thread reply is named `send_reply`: "thread" contains "read".
   Wave 1 modules **do not** use substring risk. They use an explicit map
   (§1.3).
2. **Persona denial.** `PERSONA_DENIED_ACTIONS` in
   `services/workflows/src/tools/role-capability.ts` is still substring-based:
   operations is denied `send_email`, `send_channel`, `send_external`,
   `draft_email`; customer is denied `create_deal`, `update_deal`,
   `create_crm`, `cold`; marketing is denied `charge`, `create_charge`,
   `payout`; everyone except finance is denied `delete`; all but finance/customer
   are denied `refund`. Name actions so the intended denial fires:
   - outbound email sends end in `send_email` / `reply_email` /
     `draft_email` (note: `reply_email` does **not** contain `send_email`;
     add it to the operations list, see IMAP spec);
   - channel posts use `send_channel_message`;
   - CRM deal writes use `create_deal` / `update_deal`;
   - deletions and cancellations that are irreversible use `delete_*` or
     `cancel_*` (add `cancel` to the deny lists where noted).
   - avoid accidental hits: never name a read `list_charges` (marketing would be
     denied), never use "cold" in a name.

### 1.2 Result shape

Every `execute` returns `ToolExecutionResult` from `@darex/shared-types`:

```ts
{ tool: '<provider-key>', action: '<action>', status: 'executed' | 'error',
  message: string, data: unknown, timestamp: string }
```

- `message` is one plain sentence the model can repeat ("Found 12 open
  deals", "Replied on ticket 4412").
- `data` carries ids the next call needs (deal id, ticket id, message id,
  thread ts). Lists return `{ items, count, nextCursor? }` under a
  provider-specific key (`deals`, `tickets`, `messages`) like existing modules.
- Use the shared helpers in `services/workflows/src/tools/shared.ts`:
  `apiError`, `notConnected`, `revoked`, `nangoAuthError`,
  `isProviderUnauthorized`, `fetchWithTimeout`, `withOrgScopedClient`.
- Never return provider HTML or raw MIME to the model; strip to text and cap
  each text field (4,000 chars for a body, 300 for a snippet).

### 1.3 Risk map and approval

Use the `ToolRisk` classes from `services/workflows/src/tools/risk.ts`:
`read | draft | send | pay | sign | publish | delete | execute`.
`confirmForRisk` returns `true` (park for approval) for everything except
`read` and `draft`.

Wave 1 modules declare risk explicitly and fail closed:

```ts
const RISK: Record<(typeof ACTIONS)[number], ToolRisk> = {
  list_deals: 'read',
  create_deal: 'draft',
  // ...
};
function riskFor(action: string): ToolRisk {
  return (RISK as Record<string, ToolRisk>)[action.toLowerCase()] ?? 'send';
}
export const pipedrive: ToolModule = { actions: ACTIONS, risk: riskFor, confirm: confirmFromRisk(riskFor), execute };
```

Risk vocabulary used in the tables below:

| Spec label | `ToolRisk` | Parks? | Meaning |
|---|---|---|---|
| read | `read` | no | Fetch only |
| draft | `draft` | no | Internal, reversible write that reaches nobody outside the workspace (CRM record, internal note, task, draft email, new page) |
| send | `send` | **yes** | Reaches a person outside the employee's control (email, message, public reply, invite, campaign) |
| pay | `pay` | **yes** | Moves or commits money |
| publish | `publish` | **yes** | Makes content or access public/external (share link, public post, permission change) |
| delete | `delete` | **yes** | Irreversible removal or cancellation |

How approval actually happens (no new code needed):

1. `executeAutonomousToolAction` (`services/workflows/src/tool-executor.ts`)
   runs `runToolGate` (`services/workflows/src/tool-gate.ts`): kill switch →
   org runnable → employee card → allowlist → persona denial → registered
   action → skill tier → payload checks → critic and quiet hours for sends →
   `confirm` → park in `agent_pending_actions`.
2. The chat shows an approval card; on approve, the call re-enters with
   `approvedPendingActionId` and executes once.
3. The MCP bridge advertises `readOnlyHint` / `destructiveHint` from the same
   risk (`mcp-bridge.ts` `createServer`), and the TrueForge manifest requires
   approval for `@write` / `@destructive`.

Additional approval wiring per risk class (outside the module):

| Risk | Also add the provider to |
|---|---|
| send | `services/workflows/src/inbound-hitl.ts` `isSendRisk` regex (`\b<prefix>-send\b`), `apps/dashboard/lib/confirm-classes.ts` `SEND_TOOLS` |
| pay | `confirm-classes.ts` `PAY_TOOLS`; use the field name `amount` so `payloadDenial` in `tool-gate.ts` refuses a missing/zero amount |
| sign | `confirm-classes.ts` `SIGN_TOOLS` |
| publish | `confirm-classes.ts` `PUBLISH_TOOLS` |

Skill tiers: if the integration ships a first-party skill in
`services/workflows/src/skills/catalog.ts` (`FIRST_PARTY_SKILLS`), set
`minAutonomyLevel: 2` like the Gmail and Calendar playbooks. Sends below the
tier park instead of failing.

### 1.4 Allowlist placement

Three layers decide whether an employee may call a tool:

1. **Employee card** `ai_employees.tool_allowlist`, seeded from
   `DEFAULT_EMPLOYEE_ROSTER` in `apps/dashboard/lib/employee-provision.ts`.
   Existing orgs get new grants only through an additive backfill migration
   (pattern: `infra/db/migrations/112_growth_sales_employee_tools.sql`; latest
   migration today is `210_executive_workspace_tools.sql`, so Wave 1 starts at
   `211_`).
2. **Connected channels** are unioned in by `mergeRuntimeAllowlist`
   (`tool-executor.ts`) for channel-type providers (WhatsApp, Instagram).
   Telegram follows this path.
3. **Persona denial** `PERSONA_DENIED_TOOLS` / `PERSONA_DENIED_ACTIONS` in
   `role-capability.ts` removes tools/actions per persona family. A grant on
   the card overrides a tool-level denial (but not a `delete` denial).

`CORE_READ_TOOLS` in `tool-gate.ts` is **never** extended by a connector.
Remote MCP and webhook-in tools are never default-granted.

Each spec lists: **Default grant** (roster + migration), **Opt-in** (grantable
on the card), **Denied personas** (additions to `PERSONA_DENIED_TOOLS`).

### 1.5 Errors and `notConnected`

| Situation | Return | Helper |
|---|---|---|
| Nango has no connection (404 / unknown) or `NANGO_SECRET_KEY` unset | `status:'error'`, `data:{connected:false, setupUrl:'/connectors?connect=<id>'}`, message says not to invent data | `notConnected(tool, action, ts)` |
| Token refresh failed / provider 401 or 403 | `data:{connected:false, reason:'revoked'}` | `revoked(...)` or `nangoAuthError(...)` |
| Missing/invalid argument | `apiError` naming the field and the tool that supplies it ("thread_ts from slack_read_channel") | `apiError` |
| Provider 404 on an id | `apiError`, "No <thing> with id X" | `apiError` |
| Provider 429 | `apiError` with `data:{reason:'rate_limited', retryAfterSec}`. Do not sleep inside the module. | `apiError` |
| Provider 5xx / network error / abort | `apiError` with the status, no retry inside the module | `apiError` |
| Required connection config missing (subdomain, tenant id, cloud id) | `apiError` telling the admin to reconnect; never ask the model for it | `apiError` |

Never catch an error and return `notConnected` for a non-auth failure (the
Slack module's final `catch` does this today; do not copy it).

`setupUrl` only deep-links when the provider id is in
`CONNECTOR_SIGN_IN_IDS` and `TOOL_PROVIDER_PREFIXES`
(`packages/shared-types/src/connector-signin.ts`). Add both for every Wave 1
provider, including the chat-tool prefix (`teams` → `microsoft-teams`).

### 1.6 Timeouts, rate limits, idempotency

- All HTTP goes through `fetchWithTimeout` (12 s default
  `TOOL_HTTP_TIMEOUT_MS`, capped by the 15 s executor deadline, abort signal
  propagated). Never use bare `fetch`.
- The executor wraps every call in `withProviderRateLimit(orgId, baseTool,
  ...)` (`tools/provider-rate-limit.ts`). Defaults are capacity 20, refill
  2/s per org+provider. Each spec gives `RATE_LIMIT_<PROVIDER>_CAPACITY` /
  `_REFILL` values; add them to `deploy/env.production.example`.
- When `ctx.idempotencyKey` is set (plan steps and approved actions), send it
  where the provider supports an idempotency header. Where it does not,
  creates that could duplicate (deal, task, invoice, page) should search for
  an exact match created in the last 10 minutes before creating, and say so in
  the message.

### 1.7 Untrusted content

Email bodies, ticket text, chat messages, form responses and remote MCP
output are data from outside the org. Return them as data fields, never
concatenated into an instruction string, cap their length, and where a module
builds text that becomes model context, wrap it with `fenceUntrusted`
(`services/workflows/src/untrusted.ts`).

### 1.8 Connection config

Hosts, subdomains, tenant ids, cloud ids and data-centre prefixes come only
from the Nango connection (`connection_config` / `metadata`) or an admin-set
org setting. **Never from the tool payload.** (`tools/zendesk.ts` reads
`payload.subdomain` and `tools/shopify.ts` reads `payload.shopDomain`; do not
copy that.) Validate any configured host with `checkPublicUrl`
(`tools/safe-url.ts`) before use.

### 1.9 Tests every module ships

In `services/workflows/src/tools/<provider>.test.ts`, registered in the
explicit `"test"` list in `services/workflows/package.json` (tests not listed
there do not run):

1. **Risk map:** `resolveCallRisk('<provider>', action)` returns the expected
   `{ risk, confirm }` for every action (pattern:
   `messaging-actions.test.ts`).
2. **Tool wiring:** every chat tool name maps to `<provider>.<action>` in
   `TOOLS` (pattern: `messaging-actions.test.ts` "every new chat tool is
   defined against its provider action"), and the same names exist in the
   bridge list.
3. **Honest not-connected:** with `NANGO_SECRET_KEY` unset, each action
   returns `status:'error'` and `data.connected === false` (pattern:
   `stripe.test.ts`).
4. **Validators:** id/format validators reject path-traversal and garbage
   (pattern: `igRecipientId` test).
5. **URL/body builders:** pure functions that build provider URLs and bodies
   are exported and tested without network (pattern: `outlookListUrl`).
6. **Persona:** `roleCapabilityDenial` returns the expected denial for the
   personas listed in the spec (pattern: `role-capability.test.ts`).
7. **Payload denial** for `pay` tools (missing amount refused).

Live verification (`/ask-ai` against a real account) is recorded in
`BUILD_STATE.md` and flips the chat-coverage row to 🟢. Until then the row is
🟡 (unit-tested) at best.

---

## 2. Playbook: how to add an integration

Follow in order. One integration = one `feat(connectors)` commit (code,
tests, catalog, migration, chat-coverage, BUILD_STATE, gap doc row together),
per `CLAUDE.md` §2. Platform prerequisites (§3.0) are their own commits.

### Step 1 · Confirm the gap and the auth path

1. Re-run the absence grep from `03` Appendix A for the provider.
2. Confirm the Nango provider key against the running (pinned) Nango
   server's provider list. If missing, decide: Nango custom provider config,
   or BYOK in `channels.meta`.
3. Add a row to
   `docs/new-109-pg-plan/gap26sept/integrations-credentials-runbook.md`
   (console URL, redirect URI, scopes). Registering the OAuth app is
   human-only; mark it 🔴 until done.

### Step 2 · Write the module

Create `services/workflows/src/tools/<provider>.ts`:

```ts
import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { apiError, confirmFromRisk, fetchWithTimeout, isProviderUnauthorized,
         nangoAuthError, resolveNangoAuth, revoked } from './shared.js';

const ACTIONS = ['list_things', 'get_thing', 'create_thing'] as const;
const RISK: Record<(typeof ACTIONS)[number], ToolRisk> = {
  list_things: 'read', get_thing: 'read', create_thing: 'draft',
};
const riskFor = (a: string): ToolRisk => (RISK as Record<string, ToolRisk>)[a.toLowerCase()] ?? 'send';

/** Exported for tests. Provider ids are numeric; anything else never reaches a URL. */
export function thingId(v: unknown): string | null {
  const id = String(v ?? '').trim();
  return /^\d{1,20}$/.test(id) ? id : null;
}

async function execute(ctx: ToolActionContext) {
  const { orgId, actionName, timestamp } = ctx;
  const auth = await resolveNangoAuth(`${orgId}_<provider>`, ['<nango-key>']);
  if (auth.kind !== 'connected') return nangoAuthError('<provider>', actionName, timestamp, auth);
  // ...per-action handlers; on 401/403 return revoked(...)
}

export const provider: ToolModule = { actions: ACTIONS, risk: riskFor, confirm: confirmFromRisk(riskFor), execute };
```

For API-key or Basic providers use `resolveNangoCredentials` (§3.0) instead
of `resolveNangoAuth`.

### Step 3 · Register the provider

`services/workflows/src/tools/index.ts`: add the import, the `TOOL_MODULES`
entry, every alias in `PROVIDER_KEYS`, and the `moduleForProvider` case. The
`never` exhaustiveness check fails the build if a key has no case.

### Step 4 · Define chat tools

Add each tool to **both**
`services/workflows/src/tool-definitions.ts` `TOOLS` and the duplicated
`TOOLS` array in `services/workflows/src/mcp-bridge.ts` (until prerequisite
§3.0.3 removes the duplicate). Descriptions:

- say what it does, which id it needs and which tool supplies that id;
- end send/pay/publish/delete descriptions with "Goes to a human for approval
  first." (existing convention);
- keep under ~300 characters.

### Step 5 · Routing, inbound HITL, confirm classes

- `services/workflows/src/local-tool-select.ts`: add an intent regex →
  provider key pair (e.g. `[/pipedrive/i, 'pipedrive']`).
- `services/workflows/src/inbound-hitl.ts` `isSendRisk`: add the send
  pattern for any `send` action.
- `apps/dashboard/lib/confirm-classes.ts`: add to `SEND_TOOLS` /
  `PAY_TOOLS` / `SIGN_TOOLS` / `PUBLISH_TOOLS` as the risk requires.
- `services/workflows/src/tool-gate.ts` `payloadDenial`: add a rule only if
  the provider has a "no default" field like Slack's channel (e.g. Teams
  channel id).

### Step 6 · Connector surface

- `packages/shared-types/src/connector-signin.ts`: add the id to
  `CONNECTOR_SIGN_IN_IDS` and prefixes to `TOOL_PROVIDER_PREFIXES` (longer
  prefixes first).
- `apps/dashboard/lib/integrations-catalog.ts`: add an `INTEGRATION_CATALOG`
  item (`authMode`, `extraConnectFields` for subdomain/store URL, `scopes`,
  `envVars`, `webhookEvents`, `operatorHint`, `executorStatus`). Use
  `executorStatus: 'catalog_only'` until the OAuth app is registered and a
  live call has succeeded.
- `apps/dashboard/lib/connector-registry.ts` `CONNECTOR_REGISTRY_META`:
  `nangoKey`, `riskClass` (highest class of its tools; note this registry
  uses `write_sor` for system-of-record writes), `verticalTags`, `mcpTools`.
- `services/connectors/src/providers.ts`: `NANGO_PROVIDER_ALIASES` entry and
  a read-only `NANGO_PING_SPECS` entry (used by
  `/api/integrations/[provider]/ping` and `/api/integrations/test`).

### Step 7 · Employees

- `apps/dashboard/lib/employee-provision.ts` `DEFAULT_EMPLOYEE_ROSTER`: add
  the provider key to each **Default grant** employee.
- New migration `infra/db/migrations/2NN_<provider>_employee_tools.sql`:
  additive `UPDATE ai_employees SET tool_allowlist = ARRAY(SELECT DISTINCT
  unnest(COALESCE(tool_allowlist,'{}') || ARRAY['<provider>']))` scoped by
  role/name, `archived_at IS NULL`. Never remove org-added tools.
- `services/workflows/src/tools/role-capability.ts`: add **Denied personas**
  entries; extend `PERSONA_DENIED_ACTIONS` when an action name needs it.
- Update the matching `docs/new-109-pg-plan/gap26sept/employees/<role>.md`
  allowlist table.

### Step 8 · Tests

Write the tests in §1.9, add the compiled path to the `"test"` script in
`services/workflows/package.json`, then:

```bash
pnpm --filter @darex/workflows exec tsc --noEmit
pnpm --filter @darex/workflows build && pnpm --filter @darex/workflows test
pnpm --filter @darex/dashboard exec tsc --noEmit
pnpm --filter @darex/dashboard test
```

### Step 9 · Regenerate chat coverage

```bash
pnpm --filter @darex/workflows build
pnpm --filter @darex/workflows chat-coverage
```

This rewrites `docs/new-109-pg-plan/gap26sept/chat-coverage.md` with one row
per new tool (risk and approval columns come from `resolveCallRisk`; new rows
start 🔴; existing statuses are kept). `scripts/chat-coverage.test.ts` fails
CI if a tool has no row, so this step is mandatory. Set the new rows to 🟡
once the unit tests pass; 🟢 only after a live `/ask-ai` proof.

### Step 10 · Live verification

With a real test account connected through `/connectors`:

1. From `/ask-ai`, run each read tool and confirm real data.
2. Run each draft tool and confirm the record exists in the provider UI.
3. Run each send/pay/publish/delete tool, confirm it parks, approve it,
   confirm exactly one effect at the provider.
4. Disconnect in the provider's UI; confirm the next call returns the
   revoked message with the reconnect link.
5. Ask as a persona that is denied; confirm the hand-off/denial.

### Step 11 · Record it

- `BUILD_STATE.md`: new section at the top (date, what changed, why, what
  was verified, what was not).
- `docs/new-109-pg-plan/gap26sept/integrations-connectors.md`: tracker row.
- Commit with explicit paths (`git add <paths>`), message
  `feat(connectors): <verb> <provider> from Ask AI`, no AI attribution.

### File checklist (copy into the PR description)

```
services/workflows/src/tools/<provider>.ts
services/workflows/src/tools/<provider>.test.ts
services/workflows/src/tools/index.ts
services/workflows/src/tool-definitions.ts
services/workflows/src/mcp-bridge.ts
services/workflows/src/local-tool-select.ts
services/workflows/src/inbound-hitl.ts              (send tools only)
services/workflows/src/tool-gate.ts                 (payload rule, if any)
services/workflows/src/tools/role-capability.ts
services/workflows/src/skills/catalog.ts            (if a skill ships)
services/workflows/package.json                     (test list)
services/connectors/src/providers.ts
packages/shared-types/src/connector-signin.ts
apps/dashboard/lib/integrations-catalog.ts
apps/dashboard/lib/connector-registry.ts
apps/dashboard/lib/confirm-classes.ts               (send/pay/sign/publish)
apps/dashboard/lib/employee-provision.ts
infra/db/migrations/2NN_<provider>_employee_tools.sql
docs/new-109-pg-plan/gap26sept/chat-coverage.md     (regenerated)
docs/new-109-pg-plan/gap26sept/integrations-connectors.md
docs/new-109-pg-plan/gap26sept/integrations-credentials-runbook.md
docs/new-109-pg-plan/gap26sept/employees/<role>.md
BUILD_STATE.md
deploy/env.production.example                       (rate-limit env)
```

---

## 3. Integration specs

### 3.0 Prerequisite: credential types, connection config, single tool list

Three platform commits that unblock Wave 1. Each is its own commit.

**3.0.1 `resolveNangoCredentials`** (`services/workflows/src/tools/shared.ts`)

`resolveNangoAuth` only reads `access_token`, so API-key and Basic
connections look revoked. Add:

```ts
export type NangoCredentialState =
  | { kind: 'never-configured' }
  | { kind: 'revoked'; detail: string }
  | { kind: 'oauth'; accessToken: string; config: Record<string, unknown>; metadata: Record<string, unknown> }
  | { kind: 'api_key'; apiKey: string; config: Record<string, unknown>; metadata: Record<string, unknown> }
  | { kind: 'basic'; username: string; password: string; config: Record<string, unknown>; metadata: Record<string, unknown> };

export async function resolveNangoCredentials(
  connectionId: string | readonly string[],
  providerKeys: string | readonly string[],
): Promise<NangoCredentialState>;
```

Reads `credentials.type` (`OAUTH2`, `API_KEY`, `BASIC`), `connection_config`
and `metadata` from the same Nango `/connection/{id}` response, reuses the
60 s cache and the never-configured/revoked classification. Tests: one fixture
per credential type, a 404, a revoked body, a connection with no secret.

**3.0.2 `connectionConfigString`** helper: `(state, ...keys) => string | null`
reading only from `config`/`metadata`, plus `assertConfiguredHost(host,
suffix?)` built on `checkPublicUrl` that also enforces an expected suffix
(`.freshdesk.com`, `.atlassian.net`) when the provider has one.

**3.0.3 One tool list.** Make `mcp-bridge.ts` import `TOOLS` from
`tool-definitions.ts` and delete its copy. Test: the bridge registers exactly
the `TOOLS` names. After this lands, Playbook step 4 touches one file.

---

### 3.1 Generic webhook-in

**Purpose.** Let any external system (forms, lead portals, Zapier/Make/n8n,
payment gateways without a module) send events into Darex, and let employees
read them from chat. Unlocks Typeform, Calendly and Telegram inbound paths
below.

**Auth.** None outbound. Inbound: per-endpoint secret (32 random bytes,
shown once at creation, stored hashed for token mode and encrypted for HMAC
mode).

**Schema (migration `211_inbound_webhooks.sql`).**

```sql
CREATE TABLE inbound_webhook_endpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'generic',      -- generic | typeform | calendly | telegram | zapier | ...
  verify_mode TEXT NOT NULL CHECK (verify_mode IN ('hmac_sha256','header_token')),
  secret_enc BYTEA NOT NULL,
  signature_header TEXT NOT NULL DEFAULT 'x-darex-signature',
  event_kind TEXT NOT NULL DEFAULT 'generic',  -- lead | order | form_response | booking | message | generic
  mapping JSONB NOT NULL DEFAULT '{}'::jsonb,
  target_employee_id UUID REFERENCES ai_employees(id),
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE inbound_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  endpoint_id UUID NOT NULL REFERENCES inbound_webhook_endpoints(id) ON DELETE CASCADE,
  sender_event_id TEXT,
  payload JSONB NOT NULL,
  mapped JSONB,
  status TEXT NOT NULL DEFAULT 'received',     -- received | mapped | processed | failed
  error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (endpoint_id, sender_event_id)
);
-- ENABLE + FORCE RLS and org_id policy on both, same as other tenant tables.
```

The events table must be added to the DSR table list
(`services/workflows/src/dsr/tables.ts`, covered by `dsr/tables.test.ts`).

**Route.** `apps/dashboard/app/api/webhooks/inbound/[endpointId]/route.ts`:
read raw body (cap 256 KB) → look up endpoint by id (UUID check) → verify
(`timingSafeEqual`) → insert event (dedupe on `sender_event_id`) → return 200
→ fire-and-forget a Temporal workflow that maps and, if
`target_employee_id` is set, runs that employee solo (same rule as WhatsApp
inbound: never a crew). Rate cap 60/min per endpoint; 429 above.

**Tools.**

| Chat tool | Action | Risk | Approval | Source |
|---|---|---|---|---|
| `webhook_list_events` | `webhook-in.list_events` | read | no | `inbound_webhook_events` (RLS) |
| `webhook_get_event` | `webhook-in.get_event` | read | no | same |
| `webhook_replay_event` | `webhook-in.replay_event` | draft | no | re-runs mapping + target workflow |

```json
// webhook_list_events
{ "type": "object", "properties": {
  "endpoint": { "type": "string", "description": "Endpoint name or id; omit for all" },
  "kind": { "enum": ["lead","order","form_response","booking","message","generic"] },
  "since_hours": { "type": "number", "minimum": 1, "maximum": 720, "default": 24 },
  "limit": { "type": "number", "minimum": 1, "maximum": 100, "default": 20 } } }
// webhook_get_event
{ "type": "object", "required": ["event_id"], "properties": { "event_id": { "type": "string", "format": "uuid" } } }
// webhook_replay_event
{ "type": "object", "required": ["event_id"], "properties": { "event_id": { "type": "string", "format": "uuid" } } }
```

Endpoint creation, secret rotation and deletion are **not** chat tools; they
are owner/admin routes guarded by `lib/connector-rbac.ts`, and appear as tab
actions in chat-coverage.

**Allowlist.** Opt-in only (provider key `webhook-in`). Suggested grants:
Growth and Sarah for lead endpoints.

**Errors.** Unknown event id → `apiError`. Payload returned with
`fenceUntrusted` on string fields over 500 chars.

**Rate limits.** DB only; default bucket.

**Tests.** Signature verify (valid, wrong secret, tampered body, missing
header, timing-safe compare); replay dedupe on `sender_event_id`; body cap;
org resolved from endpoint not body; mapping JSONPath extraction; list tool
RLS scoping (query includes `org_id = $1`); DSR table registered.

---

### 3.2 Remote MCP client

**Purpose.** An admin connects any remote MCP server (vendor-hosted or
in-house) and grants its tools to chosen employees. Every call runs through
`runToolGate`. Design rationale in `03` §5.2.

**Auth.** Per server: `oauth` (MCP authorization: protected resource
metadata discovery, dynamic client registration when offered, PKCE; tokens
held in Nango as a custom OAuth connection or encrypted per org), `bearer`
(static token, encrypted), or `none`.

**Schema (migration `212_remote_mcp_servers.sql`).** `remote_mcp_servers`
and `remote_mcp_tools` as in `03` §5.2, RLS on `org_id`, plus
`remote_mcp_tools.approved_schema_hash TEXT` and `enabled BOOLEAN DEFAULT
false` (tools start disabled until an admin approves them).

**Runtime.** Provider key `remote-mcp`. Chat tool names are dynamic:
`mcp_<serverSlug>_<toolName>` sanitised to `[a-z0-9_]{1,64}`. Needs
per-session dynamic tools in `mcp-bridge.ts` (`03` §7.3) and the local turn
engine's tool list. The module:

1. Loads the server row (RLS) and the tool row; refuses if disabled or if
   the live schema hash differs from `approved_schema_hash`.
2. Opens a client with `@modelcontextprotocol/sdk` (Streamable HTTP first,
   SSE fallback), URL validated with `assertPublicUrl` at connect **and** at
   call time.
3. Validates arguments against the stored input schema.
4. Calls `tools/call` with the executor's abort signal and 12 s budget.
5. Returns text/structured content capped at 16 KB, fenced as untrusted.

**Static management tools (always present when the provider is granted).**

| Chat tool | Action | Risk | Approval | Notes |
|---|---|---|---|---|
| `mcp_list_servers` | `remote-mcp.list_servers` | read | no | Name, status, tool count per connected server |
| `mcp_list_tools` | `remote-mcp.list_tools` | read | no | Enabled tools for a server with their Darex risk |
| `mcp_<slug>_<tool>` (dynamic) | `remote-mcp.call:<slug>/<tool>` | per tool (§ risk rule) | per risk | The remote tool itself |

Risk rule per remote tool (stored in `remote_mcp_tools.risk`, recomputed only
when an admin edits it):

1. Admin override (raise freely; lower only with an audited checkbox).
2. Else, if the admin trusted this server's hints: `readOnlyHint: true` →
   `read`; `destructiveHint: true` → `delete`.
3. Else `send`.

```json
// mcp_list_tools
{ "type": "object", "required": ["server"], "properties": { "server": { "type": "string", "pattern": "^[a-z0-9-]{1,32}$" } } }
```

Dynamic tool schemas are the remote server's `inputSchema`, with
`additionalProperties: false` enforced and string lengths capped at 8,000.

**Allowlist.** Grant per server: `remote-mcp:<slug>` on the employee card.
`isToolAllowed` maps `mcp_<slug>_*` to that key. Never default-granted.
Persona denials still apply to the dynamic action name (a remote tool called
`delete_issue` is denied for every persona that denies `delete`).

**Errors.** Server unreachable → `apiError` "The <name> MCP server did not
respond"; auth expired → `revoked('remote-mcp', ...)` with setupUrl
`/connectors?connect=remote-mcp`; schema drift → `apiError` "Tool changed
since approval; an admin must re-approve it at /connectors".

**Rate limits.** `RATE_LIMIT_REMOTE_MCP_CAPACITY=10`, `_REFILL=1` per org
(applies across all servers; tune later per server).

**Tests.** Name sanitising and collision handling; risk rule truth table
(including "hints not trusted" → `send`); schema-hash drift disables the tool;
URL validation rejects private/loopback/metadata hosts and redirects to them;
description sanitising (control chars stripped, length capped); argument
validation rejects extra properties; dynamic name → provider mapping in
`isToolAllowed`; a stub MCP server (in-process, SDK server half) for
list/call round-trip.

---

### 3.3 IMAP / SMTP mailbox

**Purpose.** Read and reply on any standards-based mailbox (Zoho Mail,
Titan/GoDaddy, Hostinger, cPanel, Fastmail, iCloud). Emma and Customer can
then work inboxes for orgs not on Google or Microsoft.

**Auth.** Basic credentials (username + app password) plus
`imap_host`, `imap_port`, `smtp_host`, `smtp_port`, `tls_mode` in connection
config. Stored via Nango Basic if a generic Basic provider config is available
on the pinned Nango, else encrypted `channels.meta` (BYOK, `channel_type =
'imap-mail'`). Hosts validated as public at connect and at each call. TLS
certificate verification always on; plaintext ports refused.

**Provider key.** `imap-mail` (prefixes `imap`, `smtp`).

**Dependencies.** One IMAP client and one SMTP client library, pinned exact
versions, added only to `@darex/workflows`.

**Tools.**

| Chat tool | Action | Risk | Approval | Protocol call |
|---|---|---|---|---|
| `imap_fetch` | `fetch_emails` | read | no | `SELECT INBOX` (or folder), `SEARCH` (UNSEEN / FROM / SUBJECT / SINCE), `FETCH` envelope + 300-char preview |
| `imap_read_email` | `read_email` | read | no | `UID FETCH <uid> BODY.PEEK[]`, parse MIME → text, attachments listed by name/size only |
| `imap_draft_reply` | `draft_reply` | draft | no | Build RFC 5322 reply, `APPEND` to Drafts with `\Draft` flag |
| `imap_send_email` | `send_email` | send | **yes** | SMTP `MAIL FROM`/`RCPT TO`/`DATA`; then `APPEND` to Sent |
| `imap_reply_email` | `reply_email` | send | **yes** | Same as send with `In-Reply-To` and `References` from the original |

```json
// imap_fetch
{ "type": "object", "properties": {
  "folder": { "type": "string", "maxLength": 100, "default": "INBOX" },
  "unread_only": { "type": "boolean", "default": false },
  "from": { "type": "string", "maxLength": 200 },
  "subject": { "type": "string", "maxLength": 200 },
  "since_days": { "type": "number", "minimum": 1, "maximum": 90, "default": 7 },
  "limit": { "type": "number", "minimum": 1, "maximum": 50, "default": 20 } } }
// imap_read_email
{ "type": "object", "required": ["uid"], "properties": {
  "uid": { "type": "string", "pattern": "^[0-9]{1,10}$" },
  "folder": { "type": "string", "maxLength": 100, "default": "INBOX" } } }
// imap_draft_reply / imap_reply_email
{ "type": "object", "required": ["uid", "body"], "properties": {
  "uid": { "type": "string", "pattern": "^[0-9]{1,10}$" },
  "folder": { "type": "string", "maxLength": 100, "default": "INBOX" },
  "body": { "type": "string", "maxLength": 20000 },
  "reply_all": { "type": "boolean", "default": false } } }
// imap_send_email
{ "type": "object", "required": ["to", "subject", "body"], "properties": {
  "to": { "type": "array", "items": { "type": "string", "format": "email" }, "minItems": 1, "maxItems": 20 },
  "cc": { "type": "array", "items": { "type": "string", "format": "email" }, "maxItems": 20 },
  "subject": { "type": "string", "maxLength": 300 },
  "body": { "type": "string", "maxLength": 20000 } } }
```

Header-injection guard: reject CR/LF in `subject` and any address; build
headers with the library, never by string concatenation. Folder names are
quoted by the library (no raw IMAP command interpolation).

**Allowlist.** Default grant: Customer, Emma. Opt-in: Sarah, Executive.
Denied: none at tool level; **add `reply_email` to the operations entry in
`PERSONA_DENIED_ACTIONS`** (today operations denies `send_email` and
`draft_email` but not `reply_email`, which also lets `gmail.reply_email` and
`microsoft-outlook.reply_email` through for operations; confirm with the
operations spec owner before changing it, since it widens a denial).

**Approval extras.** Add `imap-mail` to `SEND_TOOLS` and `\bimap-send\b|
\bimap-reply\b` to `isSendRisk`. Sends pass critic and quiet hours (already
applied to `send` risk in `tool-gate.ts`).

**Errors.** Auth failure (`AUTHENTICATIONFAILED`, SMTP 535) → `revoked`.
DNS/connect failure → `apiError` naming the host the admin configured.
Message not found → `apiError` "No email with uid X in <folder>". Mailbox
quota (SMTP 552) → `apiError`.

**Rate limits.** `RATE_LIMIT_IMAP_MAIL_CAPACITY=10`, `_REFILL=1`. Max 1
concurrent IMAP session per org connection; providers lock out on parallel
logins.

**Tests.** Header-injection rejection; reply header builder (`In-Reply-To`,
`References`, `Re:` prefix not doubled); MIME → text (multipart/alternative
picks text/plain, HTML stripped); host validator rejects `127.0.0.1`,
`10.x`, `169.254.169.254`, `localhost`; risk map; not-connected; operations
persona denial for `send_email` (and `reply_email` if added).

---

### 3.4 Microsoft Teams

**Purpose.** Slack parity for Microsoft orgs: read channels and threads,
post messages and replies, post decision cards.

**Auth.** Nango `microsoft-teams` ✔ OAuth2 (falls back to `microsoft` key,
same alias pattern as `microsoft-outlook` in `providers.ts`). Delegated scopes:
`Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelMessage.Read.All`
(admin consent required), `ChannelMessage.Send`, `Chat.ReadWrite`,
`offline_access`. Tenant admin consent is a human step (🔴 per tenant).

**Provider key.** `microsoft-teams`; chat prefix `teams`.

**Tools.**

| Chat tool | Action | Risk | Approval | Graph endpoint |
|---|---|---|---|---|
| `teams_list_channels` | `list_channels` | read | no | `GET /v1.0/me/joinedTeams` then `GET /v1.0/teams/{team-id}/channels` |
| `teams_read_channel` | `read_channel` | read | no | `GET /v1.0/teams/{team-id}/channels/{channel-id}/messages?$top=N` |
| `teams_read_replies` | `read_replies` | read | no | `GET /v1.0/teams/{team-id}/channels/{channel-id}/messages/{message-id}/replies` |
| `teams_send` | `send_channel_message` | send | **yes** | `POST /v1.0/teams/{team-id}/channels/{channel-id}/messages` |
| `teams_reply` | `send_reply` | send | **yes** | `POST .../messages/{message-id}/replies` |
| `teams_post_decision_card` | `post_decision_card` | send | **yes** | `POST .../messages` with an Adaptive Card attachment (Approve/Reject open the Darex approval URL) |

Note `read_replies` not `read_thread`, and `send_reply` follows the Slack
precedent; with the explicit risk map the names no longer matter for risk, but
`send_channel_message` keeps the operations persona denial (`send_channel`)
consistent with Slack. **Check:** Operations has `slack` on its roster but
operations denies `send_channel`; match whatever the operations spec decides
for Slack.

```json
// teams_list_channels
{ "type": "object", "properties": { "team_id": { "type": "string", "pattern": "^[0-9a-f-]{36}$" } } }
// teams_read_channel
{ "type": "object", "required": ["team_id", "channel_id"], "properties": {
  "team_id": { "type": "string", "pattern": "^[0-9a-f-]{36}$" },
  "channel_id": { "type": "string", "pattern": "^19:[A-Za-z0-9_\\-]+@thread\\.(tacv2|skype)$" },
  "limit": { "type": "number", "minimum": 1, "maximum": 50, "default": 20 } } }
// teams_read_replies
{ "type": "object", "required": ["team_id", "channel_id", "message_id"], "properties": {
  "team_id": { "type": "string" }, "channel_id": { "type": "string" },
  "message_id": { "type": "string", "pattern": "^[0-9]{10,20}$" } } }
// teams_send
{ "type": "object", "required": ["team_id", "channel_id", "message"], "properties": {
  "team_id": { "type": "string" }, "channel_id": { "type": "string" },
  "message": { "type": "string", "maxLength": 20000 } } }
// teams_reply
{ "type": "object", "required": ["team_id", "channel_id", "message_id", "message"], "properties": {
  "team_id": { "type": "string" }, "channel_id": { "type": "string" },
  "message_id": { "type": "string" }, "message": { "type": "string", "maxLength": 20000 } } }
// teams_post_decision_card
{ "type": "object", "required": ["team_id", "channel_id", "work_item_id", "title"], "properties": {
  "team_id": { "type": "string" }, "channel_id": { "type": "string" },
  "work_item_id": { "type": "string", "format": "uuid" },
  "title": { "type": "string", "maxLength": 150 }, "message": { "type": "string", "maxLength": 2900 } } }
```

Message HTML: escape user text before wrapping in `<p>`; Graph accepts HTML
and will render injected markup otherwise.

**Payload rule.** Add a `payloadDenial` rule like Slack's: `team_id` and
`channel_id` required for sends, no default channel. An org default may be
read from `orgs.meta.ops_teams_channel` (mirror of `ops_slack_channel`), never
guessed.

**Allowlist.** Default grant: Operations, Executive. Opt-in: Emma, Customer.
Denied: none.

**Errors.** 403 with `Forbidden`/`InsufficientPrivileges` on channel
messages usually means admin consent is missing → `apiError` "Teams admin
consent for ChannelMessage.Read.All is required; ask your Microsoft 365
admin" (not `revoked`). 401 → `revoked`.

**Rate limits.** Graph throttles per app per tenant and returns 429 with
`Retry-After`. Channel message POST is limited per channel per second.
`RATE_LIMIT_MICROSOFT_TEAMS_CAPACITY=10`, `_REFILL=1`.

**Tests.** Id validators (team GUID, channel `19:…@thread.tacv2`, message
id); HTML escaping; Adaptive Card builder (approve/reject actions carry
`workItemId`, not `orgId` in clear for an external surface); payload denial
for missing channel; risk map; not-connected; sign-in prefix `teams` →
`microsoft-teams`.

---

### 3.5 Pipedrive

**Purpose.** Sarah and Growth manage pipeline in Pipedrive orgs: find and
move deals, create persons and deals, log notes and activities.

**Auth.** Nango `pipedrive` ✔ OAuth2. The token response includes
`api_domain` (company-specific base URL); read it from the connection
(`connection_config` / raw credentials), fallback
`https://api.pipedrive.com`. Scopes: `deals:full`, `contacts:full`,
`activities:full`, `search:read`.

**Tools.**

| Chat tool | Action | Risk | Approval | Endpoint |
|---|---|---|---|---|
| `pipedrive_list_deals` | `list_deals` | read | no | `GET /api/v2/deals?status=open&stage_id=&owner_id=&limit=` (v1: `GET /v1/deals`) |
| `pipedrive_search` | `search` | read | no | `GET /api/v2/itemSearch?term=&item_types=deal,person,organization` |
| `pipedrive_get_deal` | `get_deal` | read | no | `GET /api/v2/deals/{id}` + `GET /v1/deals/{id}/activities` |
| `pipedrive_list_stages` | `list_stages` | read | no | `GET /api/v2/stages?pipeline_id=` |
| `pipedrive_create_person` | `create_person` | draft | no | `POST /api/v2/persons` |
| `pipedrive_create_deal` | `create_deal` | draft | no | `POST /api/v2/deals` |
| `pipedrive_update_deal` | `update_deal` | draft | no | `PATCH /api/v2/deals/{id}` |
| `pipedrive_add_note` | `add_note` | draft | no | `POST /v1/notes` |
| `pipedrive_create_activity` | `create_activity` | draft | no | `POST /api/v2/activities` |

Verify the v2 paths against Pipedrive's current reference at build time; v2
is replacing v1 endpoint by endpoint, and notes were v1-only when last
checked. Keep the version per endpoint in one constant map.

```json
// pipedrive_list_deals
{ "type": "object", "properties": {
  "status": { "enum": ["open","won","lost","all_not_deleted"], "default": "open" },
  "stage_id": { "type": "integer", "minimum": 1 },
  "stale_days": { "type": "integer", "minimum": 1, "maximum": 365, "description": "Only deals with no update in N days (filtered client-side on update_time)" },
  "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 25 } } }
// pipedrive_search
{ "type": "object", "required": ["term"], "properties": {
  "term": { "type": "string", "minLength": 2, "maxLength": 100 },
  "types": { "type": "array", "items": { "enum": ["deal","person","organization"] } } } }
// pipedrive_get_deal
{ "type": "object", "required": ["deal_id"], "properties": { "deal_id": { "type": "integer", "minimum": 1 } } }
// pipedrive_create_person
{ "type": "object", "required": ["name"], "properties": {
  "name": { "type": "string", "maxLength": 200 },
  "email": { "type": "string", "format": "email" },
  "phone": { "type": "string", "maxLength": 30 },
  "org_name": { "type": "string", "maxLength": 200 } } }
// pipedrive_create_deal
{ "type": "object", "required": ["title"], "properties": {
  "title": { "type": "string", "maxLength": 255 },
  "value": { "type": "number", "minimum": 0 },
  "currency": { "type": "string", "pattern": "^[A-Z]{3}$" },
  "person_id": { "type": "integer" }, "org_id_pd": { "type": "integer", "description": "Pipedrive organization id (not the Darex org)" },
  "stage_id": { "type": "integer" }, "expected_close_date": { "type": "string", "format": "date" } } }
// pipedrive_update_deal
{ "type": "object", "required": ["deal_id"], "properties": {
  "deal_id": { "type": "integer", "minimum": 1 },
  "stage_id": { "type": "integer" }, "value": { "type": "number", "minimum": 0 },
  "status": { "enum": ["open","won","lost"] }, "lost_reason": { "type": "string", "maxLength": 500 },
  "expected_close_date": { "type": "string", "format": "date" } } }
// pipedrive_add_note
{ "type": "object", "required": ["content"], "properties": {
  "content": { "type": "string", "maxLength": 10000 },
  "deal_id": { "type": "integer" }, "person_id": { "type": "integer" } } }
// pipedrive_create_activity
{ "type": "object", "required": ["subject", "type"], "properties": {
  "subject": { "type": "string", "maxLength": 255 },
  "type": { "enum": ["call","meeting","task","deadline","email","lunch"] },
  "due_date": { "type": "string", "format": "date" }, "due_time": { "type": "string", "pattern": "^\\d{2}:\\d{2}$" },
  "deal_id": { "type": "integer" }, "person_id": { "type": "integer" } } }
```

Note the field name `org_id_pd`: the bridge strips `org_id` from every
schema, so a provider field literally named `org_id` would be silently
dropped.

**Dedupe.** `create_person` searches by email first and returns the
existing person with "already exists" rather than creating a duplicate.
Pipedrive has no idempotency header; `create_deal` checks for a deal with the
same title and person created in the last 10 minutes.

**Allowlist.** Default grant: Sarah, Growth. Opt-in: Operations (dedup work).
Denied: customer persona already blocks `create_deal`/`update_deal` by
action name; also add `pipedrive` to `PERSONA_DENIED_TOOLS.marketing`? No:
marketing may read pipeline attribution. Leave tool-level open; action
denials cover writes.

**Errors.** 401 → `revoked`; 402 (plan lacks feature) → `apiError`; 404 deal
→ `apiError`.

**Rate limits.** Pipedrive uses token-based daily budgets per company plus a
short burst limit, returning 429 with `x-ratelimit-*` headers.
`RATE_LIMIT_PIPEDRIVE_CAPACITY=20`, `_REFILL=2`.

**Tests.** `api_domain` resolution (from connection, fallback); stale-days
filter; person dedupe path; `org_id_pd` mapping; risk map; customer persona
denied `create_deal`; not-connected.

---

### 3.6 Calendly

**Purpose.** See who booked, send booking links, cancel bookings; new bookings
become leads or showings through webhook-in.

**Auth.** Nango `calendly` ✔ OAuth2. Resolve the user URI once per call via
`GET https://api.calendly.com/users/me` (cache 60 s with the token).

**Tools.**

| Chat tool | Action | Risk | Approval | Endpoint |
|---|---|---|---|---|
| `calendly_list_events` | `list_events` | read | no | `GET /scheduled_events?user={uri}&min_start_time=&max_start_time=&status=active&count=` |
| `calendly_get_invitees` | `get_invitees` | read | no | `GET /scheduled_events/{uuid}/invitees` |
| `calendly_list_event_types` | `list_event_types` | read | no | `GET /event_types?user={uri}&active=true` |
| `calendly_create_link` | `create_link` | draft | no | `POST /scheduling_links` `{max_event_count:1, owner:<event_type_uri>, owner_type:"EventType"}` |
| `calendly_cancel_event` | `cancel_event` | delete | **yes** | `POST /scheduled_events/{uuid}/cancellation` `{reason}` |

`create_link` is `draft` because it only produces a URL; sending it to a lead
happens through `gmail_send`/`whatsapp_send`, which park.

```json
// calendly_list_events
{ "type": "object", "properties": {
  "from": { "type": "string", "format": "date-time" }, "to": { "type": "string", "format": "date-time" },
  "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 20 } } }
// calendly_get_invitees / calendly_cancel_event
{ "type": "object", "required": ["event_uuid"], "properties": {
  "event_uuid": { "type": "string", "pattern": "^[A-Za-z0-9-]{8,64}$" },
  "reason": { "type": "string", "maxLength": 500 } } }
// calendly_create_link
{ "type": "object", "required": ["event_type"], "properties": {
  "event_type": { "type": "string", "description": "Event type name or uuid from calendly_list_event_types" } } }
```

**Inbound.** On connect, register `POST /webhook_subscriptions` for
`invitee.created` / `invitee.canceled` pointing at a webhook-in endpoint with
`source='calendly'` (Calendly signs with `Calendly-Webhook-Signature`;
the generic route gets a `calendly` verifier). Webhook subscriptions need a
paid Calendly plan; on 403 show "Calendly plan does not allow webhooks" in
the catalog card, tools still work.

**Allowlist.** Default grant: Sarah, Emma. Opt-in: Operations, Customer.
Denied: `cancel_event` contains no `delete` substring, so **add `cancel` to
`PERSONA_DENIED_ACTIONS` for growth and marketing**; customer/support may
cancel with approval.

**Errors.** 401 → `revoked`; 404 → `apiError`; 403 on cancellation of an
event owned by another user → `apiError`.

**Rate limits.** `RATE_LIMIT_CALENDLY_CAPACITY=10`, `_REFILL=1`.

**Tests.** Event-type resolution by name (exact, case-insensitive, ambiguous
→ error listing options); uuid extraction from a full URI; time window
defaults (now → +7 days); risk map (`cancel_event` → delete/confirm);
not-connected; webhook signature verifier.

---

### 3.7 Zoom

**Purpose.** Schedule meetings, list upcoming meetings, pull recordings and
transcripts so employees can summarise calls.

**Auth.** Nango `zoom` ✔ OAuth2 (user-level app). Scopes (granular names
vary by app type; confirm at registration): meeting read/write, recording
read, user read.

**Tools.**

| Chat tool | Action | Risk | Approval | Endpoint |
|---|---|---|---|---|
| `zoom_list_meetings` | `list_meetings` | read | no | `GET https://api.zoom.us/v2/users/me/meetings?type=upcoming&page_size=` |
| `zoom_get_meeting` | `get_meeting` | read | no | `GET /v2/meetings/{meetingId}` |
| `zoom_create_meeting` | `create_meeting` | send | **yes** | `POST /v2/users/me/meetings` (with `settings.registrants_email_notification` when invitees are given) |
| `zoom_update_meeting` | `update_meeting` | send | **yes** | `PATCH /v2/meetings/{meetingId}` |
| `zoom_delete_meeting` | `delete_meeting` | delete | **yes** | `DELETE /v2/meetings/{meetingId}?schedule_for_reminder=true` |
| `zoom_list_recordings` | `list_recordings` | read | no | `GET /v2/users/me/recordings?from=&to=` |
| `zoom_get_transcript` | `get_transcript` | read | no | Pick `recording_files[]` with `file_type=TRANSCRIPT` from `GET /v2/meetings/{meetingId}/recordings`, download `download_url` with the bearer token, parse VTT → text |

`create_meeting` is `send` (matches `calendar_create_event`): invitees get
an email or the link is shared outward. A meeting with no invitees could be
`draft`, but one class per action keeps approval predictable.

```json
// zoom_list_meetings
{ "type": "object", "properties": { "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 20 } } }
// zoom_get_meeting / zoom_delete_meeting / zoom_get_transcript
{ "type": "object", "required": ["meeting_id"], "properties": {
  "meeting_id": { "type": "string", "pattern": "^[0-9]{9,12}$" } } }
// zoom_create_meeting
{ "type": "object", "required": ["topic", "start_time", "duration_minutes"], "properties": {
  "topic": { "type": "string", "maxLength": 200 },
  "start_time": { "type": "string", "format": "date-time" },
  "duration_minutes": { "type": "integer", "minimum": 5, "maximum": 600 },
  "timezone": { "type": "string", "description": "IANA zone; defaults to the org timezone" },
  "agenda": { "type": "string", "maxLength": 2000 },
  "invitees": { "type": "array", "items": { "type": "string", "format": "email" }, "maxItems": 50 } } }
// zoom_update_meeting
{ "type": "object", "required": ["meeting_id"], "properties": {
  "meeting_id": { "type": "string", "pattern": "^[0-9]{9,12}$" },
  "topic": { "type": "string", "maxLength": 200 }, "start_time": { "type": "string", "format": "date-time" },
  "duration_minutes": { "type": "integer", "minimum": 5, "maximum": 600 } } }
// zoom_list_recordings
{ "type": "object", "properties": {
  "from": { "type": "string", "format": "date" }, "to": { "type": "string", "format": "date" } } }
```

Transcript download: the `download_url` host must be a `zoom.us` subdomain
(check before sending the bearer token, so a tampered response cannot leak the
token to another host). Cap transcript text at 60,000 chars and return
`truncated: true` when cut.

**Allowlist.** Default grant: Sarah, Executive (read tools effectively; sends
still park). Opt-in: Operations, Research (transcripts). Denied: none at tool
level; `delete_meeting` already denied by persona for most roles.

**Errors.** 404 meeting → `apiError`; 124 invalid token → `revoked`; 3001
"meeting does not exist" → `apiError`; recording without transcript →
`apiError` "No transcript for this recording (cloud recording transcripts
must be enabled in Zoom settings)".

**Rate limits.** Zoom rate limits by API category (light/medium/heavy) and
account plan, with daily caps on some. `RATE_LIMIT_ZOOM_CAPACITY=10`,
`_REFILL=1`.

**Tests.** VTT parser (cue timing removed, speaker names kept, dedupe of
repeated lines); download host check; timezone default from org; meeting id
validator; risk map; not-connected.

---

### 3.8 Xero

**Purpose.** Finance reads receivables, contacts, bank summary and creates
draft invoices for Xero orgs; sending an invoice parks.

**Auth.** Nango `xero` ✔ OAuth2. Scopes: `accounting.transactions`,
`accounting.contacts`, `accounting.reports.read`, `offline_access`. Tenant:
`GET https://api.xero.com/connections` returns `tenantId`s; store the chosen
tenant in Nango connection metadata at connect time (admin picks when there
are several). Every call sends `xero-tenant-id`.

**Tools.**

| Chat tool | Action | Risk | Approval | Endpoint |
|---|---|---|---|---|
| `xero_list_invoices` | `list_invoices` | read | no | `GET /api.xro/2.0/Invoices?Statuses=AUTHORISED&where=Type=="ACCREC"&page=` |
| `xero_get_invoice` | `get_invoice` | read | no | `GET /api.xro/2.0/Invoices/{InvoiceID}` |
| `xero_list_contacts` | `list_contacts` | read | no | `GET /api.xro/2.0/Contacts?searchTerm=` |
| `xero_aged_receivables` | `aged_receivables` | read | no | `GET /api.xro/2.0/Reports/AgedReceivablesByContact?contactId=` (per contact) or summarise from overdue invoices |
| `xero_bank_summary` | `bank_summary` | read | no | `GET /api.xro/2.0/Reports/BankSummary?fromDate=&toDate=` |
| `xero_create_draft_invoice` | `create_draft_invoice` | draft | no | `PUT /api.xro/2.0/Invoices` with `Status:"DRAFT"` |
| `xero_email_invoice` | `send_invoice` | send | **yes** | `POST /api.xro/2.0/Invoices/{InvoiceID}/Email` (invoice must be AUTHORISED) |
| `xero_create_contact` | `create_contact` | draft | no | `PUT /api.xro/2.0/Contacts` |

Approving an invoice (DRAFT → AUTHORISED) posts it to the ledger; it is not
in Wave 1. Recording payments (`PUT /Payments`) is `pay` and deferred to
Wave 2.

```json
// xero_list_invoices
{ "type": "object", "properties": {
  "status": { "enum": ["DRAFT","SUBMITTED","AUTHORISED","PAID","VOIDED"], "default": "AUTHORISED" },
  "overdue_only": { "type": "boolean", "default": false },
  "min_days_overdue": { "type": "integer", "minimum": 0, "maximum": 365 },
  "contact_name": { "type": "string", "maxLength": 200 },
  "page": { "type": "integer", "minimum": 1, "default": 1 } } }
// xero_get_invoice / xero_email_invoice
{ "type": "object", "required": ["invoice_id"], "properties": {
  "invoice_id": { "type": "string", "pattern": "^[0-9a-fA-F-]{36}$" } } }
// xero_list_contacts
{ "type": "object", "properties": { "search": { "type": "string", "maxLength": 100 } } }
// xero_bank_summary
{ "type": "object", "properties": { "from": { "type": "string", "format": "date" }, "to": { "type": "string", "format": "date" } } }
// xero_create_draft_invoice
{ "type": "object", "required": ["contact_id", "line_items"], "properties": {
  "contact_id": { "type": "string", "pattern": "^[0-9a-fA-F-]{36}$" },
  "line_items": { "type": "array", "minItems": 1, "maxItems": 50, "items": { "type": "object",
    "required": ["description", "quantity", "unit_amount"], "properties": {
      "description": { "type": "string", "maxLength": 4000 },
      "quantity": { "type": "number", "exclusiveMinimum": 0 },
      "unit_amount": { "type": "number", "minimum": 0 },
      "account_code": { "type": "string", "maxLength": 10 },
      "tax_type": { "type": "string", "maxLength": 50 } } } },
  "due_date": { "type": "string", "format": "date" },
  "reference": { "type": "string", "maxLength": 255 },
  "currency": { "type": "string", "pattern": "^[A-Z]{3}$" } } }
// xero_create_contact
{ "type": "object", "required": ["name"], "properties": {
  "name": { "type": "string", "maxLength": 255 }, "email": { "type": "string", "format": "email" } } }
```

`where` clauses are built from validated fields only (enum status, ISO
dates); never interpolate free text into `where`. Contact search uses the
`searchTerm` parameter, not `where`.

**Idempotency.** Xero supports an `Idempotency-Key` header on POST/PUT/PATCH;
send `ctx.idempotencyKey` when present.

**Allowlist.** Default grant: Finance. Opt-in: Executive (read). Denied: add
`xero` to `PERSONA_DENIED_TOOLS` for growth and marketing (matches stripe).

**Errors.** 401 → `revoked`; 403 `AuthorizationUnsuccessful` (tenant
disconnected) → `revoked` with detail; 400 validation → `apiError` with
Xero's `Elements[].ValidationErrors` messages; missing tenant id →
`apiError` "Reconnect Xero and pick an organisation".

**Rate limits.** Xero documents 60 calls/minute and 5,000/day per tenant,
5 concurrent calls, plus an app-wide minute limit; 429 carries
`Retry-After` and `X-Rate-Limit-Problem`. `RATE_LIMIT_XERO_CAPACITY=5`,
`_REFILL=1`.

**Tests.** `where` builder (no free text, correct date syntax
`DateTime(yyyy,mm,dd)`); overdue filter; line-item validation; tenant header
always present; idempotency header passthrough; risk map (`send_invoice` →
send/confirm); growth/marketing persona denied; not-connected.

---

### 3.9 Freshdesk

**Purpose.** Customer and Emma work Freshdesk tickets: list/search, read with
conversation, reply (parks), private notes, status/priority changes.

**Auth.** Nango `freshdesk` ✔ (API key, Basic with key as username and `X`
as password) plus `domain` in connection config (`<name>.freshdesk.com`).
Needs `resolveNangoCredentials` (§3.0.1). Host must end in `.freshdesk.com`.

**Tools.**

| Chat tool | Action | Risk | Approval | Endpoint |
|---|---|---|---|---|
| `freshdesk_list_tickets` | `list_tickets` | read | no | `GET /api/v2/tickets?filter=new_and_my_open&order_by=updated_at&per_page=` or `GET /api/v2/search/tickets?query="..."` |
| `freshdesk_get_ticket` | `get_ticket` | read | no | `GET /api/v2/tickets/{id}?include=conversations,requester` |
| `freshdesk_reply` | `reply_ticket` | send | **yes** | `POST /api/v2/tickets/{id}/reply` `{body}` |
| `freshdesk_add_note` | `add_note` | draft | no | `POST /api/v2/tickets/{id}/notes` `{body, private:true}` |
| `freshdesk_update_ticket` | `update_ticket` | draft | no | `PUT /api/v2/tickets/{id}` `{status, priority, responder_id, tags}` |
| `freshdesk_create_ticket` | `create_ticket` | draft | no | `POST /api/v2/tickets` (internal/outbound ticket, no email unless `send_email` → not exposed) |

`add_note` is forced `private: true`; a public note emails the requester and
would be a send.

```json
// freshdesk_list_tickets
{ "type": "object", "properties": {
  "status": { "enum": ["open","pending","resolved","closed"] },
  "priority": { "enum": ["low","medium","high","urgent"] },
  "updated_since_hours": { "type": "integer", "minimum": 1, "maximum": 720 },
  "limit": { "type": "integer", "minimum": 1, "maximum": 30, "default": 20 } } }
// freshdesk_get_ticket
{ "type": "object", "required": ["ticket_id"], "properties": { "ticket_id": { "type": "integer", "minimum": 1 } } }
// freshdesk_reply / freshdesk_add_note
{ "type": "object", "required": ["ticket_id", "body"], "properties": {
  "ticket_id": { "type": "integer", "minimum": 1 }, "body": { "type": "string", "maxLength": 20000 } } }
// freshdesk_update_ticket
{ "type": "object", "required": ["ticket_id"], "properties": {
  "ticket_id": { "type": "integer", "minimum": 1 },
  "status": { "enum": ["open","pending","resolved","closed"] },
  "priority": { "enum": ["low","medium","high","urgent"] },
  "tags": { "type": "array", "items": { "type": "string", "maxLength": 50 }, "maxItems": 20 } } }
// freshdesk_create_ticket
{ "type": "object", "required": ["subject", "description", "email"], "properties": {
  "subject": { "type": "string", "maxLength": 255 }, "description": { "type": "string", "maxLength": 20000 },
  "email": { "type": "string", "format": "email" },
  "priority": { "enum": ["low","medium","high","urgent"], "default": "medium" } } }
```

Map enum words to Freshdesk numbers in one table (status open=2, pending=3,
resolved=4, closed=5; priority low=1 … urgent=4). Search queries are built
from enums and integers only; Freshdesk's query language is quoted, so never
pass free text into it.

**Allowlist.** Default grant: Customer. Opt-in: Emma (persona text says Emma
does not work Zendesk/Intercom tickets; keep Freshdesk consistent and leave it
opt-in). Denied: add `freshdesk` to growth and marketing (matches zendesk).

**Approval extras.** `freshdesk` into `SEND_TOOLS`; `\bfreshdesk-reply\b`
into `isSendRisk`.

**Errors.** 401 → `revoked`; 403 (agent lacks permission) → `apiError`; 404
→ `apiError`; 429 → `apiError` with `Retry-After`.

**Rate limits.** Per-plan per-minute limits (roughly 100 to 700/min) with
`X-Ratelimit-Total/Remaining` headers. `RATE_LIMIT_FRESHDESK_CAPACITY=20`,
`_REFILL=1`.

**Tests.** Domain validator (suffix, no path, no port); enum mapping both
ways; search query builder; note forced private; HTML → text for
conversations; risk map; growth persona denied; not-connected for an API-key
connection (exercises `resolveNangoCredentials`).

---

### 3.10 Jira (Cloud)

**Purpose.** Operations, Executive and Research query and update work in
Jira: JQL search, read issues, create issues, transition, comment.

**Auth.** Nango `jira` ✔ OAuth2 (Atlassian 3LO). Scopes: `read:jira-work`,
`write:jira-work`, `read:jira-user`, `offline_access`. Cloud id from
`GET https://api.atlassian.com/oauth/token/accessible-resources` at connect,
stored in connection metadata (admin picks a site if several). Base:
`https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3`. One Atlassian OAuth
app can serve Jira and Confluence (§3.11).

**Tools.**

| Chat tool | Action | Risk | Approval | Endpoint |
|---|---|---|---|---|
| `jira_search` | `search_issues` | read | no | `POST /search/jql` `{jql, maxResults, fields}` (the older `/search` is being retired; confirm at build) |
| `jira_get_issue` | `get_issue` | read | no | `GET /issue/{key}?fields=summary,status,assignee,priority,description,comment` |
| `jira_list_projects` | `list_projects` | read | no | `GET /project/search?maxResults=50` |
| `jira_create_issue` | `create_issue` | draft | no | `POST /issue` |
| `jira_update_issue` | `update_issue` | draft | no | `PUT /issue/{key}` (summary, priority, labels, assignee) |
| `jira_transition_issue` | `transition_issue` | draft | no | `GET /issue/{key}/transitions` then `POST /issue/{key}/transitions` |
| `jira_add_comment` | `add_comment` | draft | no | `POST /issue/{key}/comment` (ADF body) |

Comments and issues are internal to the team (`draft`), consistent with
`github_create_issue`? Note: `github_create_issue` is `send` today. Decide one
rule: Jira/Linear/Asana are internal trackers (draft); GitHub issues on public
repos are public (send). For Jira Service Management, a comment with
`public: true` emails the customer; Wave 1 always sends
`properties: [{ key: 'sd.public.comment', value: { internal: true } }]` for
JSM projects so comments stay internal.

```json
// jira_search
{ "type": "object", "properties": {
  "jql": { "type": "string", "maxLength": 1000, "description": "JQL; if omitted, built from the fields below" },
  "project": { "type": "string", "pattern": "^[A-Z][A-Z0-9_]{1,9}$" },
  "status": { "type": "string", "maxLength": 50 },
  "assignee_me": { "type": "boolean" },
  "limit": { "type": "integer", "minimum": 1, "maximum": 50, "default": 20 } } }
// jira_get_issue
{ "type": "object", "required": ["key"], "properties": { "key": { "type": "string", "pattern": "^[A-Z][A-Z0-9_]{1,9}-[0-9]{1,7}$" } } }
// jira_create_issue
{ "type": "object", "required": ["project", "summary"], "properties": {
  "project": { "type": "string", "pattern": "^[A-Z][A-Z0-9_]{1,9}$" },
  "summary": { "type": "string", "maxLength": 255 },
  "description": { "type": "string", "maxLength": 20000 },
  "issue_type": { "type": "string", "default": "Task", "maxLength": 50 },
  "priority": { "type": "string", "maxLength": 20 },
  "labels": { "type": "array", "items": { "type": "string", "pattern": "^[^\\s]{1,50}$" }, "maxItems": 10 } } }
// jira_update_issue
{ "type": "object", "required": ["key"], "properties": {
  "key": { "type": "string" }, "summary": { "type": "string", "maxLength": 255 },
  "priority": { "type": "string", "maxLength": 20 }, "labels": { "type": "array", "items": { "type": "string" } },
  "assignee_email": { "type": "string", "format": "email" } } }
// jira_transition_issue
{ "type": "object", "required": ["key", "to_status"], "properties": {
  "key": { "type": "string" }, "to_status": { "type": "string", "maxLength": 50 } } }
// jira_add_comment
{ "type": "object", "required": ["key", "body"], "properties": {
  "key": { "type": "string" }, "body": { "type": "string", "maxLength": 20000 } } }
```

JQL from the model is allowed (it is read-only and scoped by the user's Jira
permissions) but length-capped. When structured fields are used, build JQL
with quoted values and escape `"` and `\`.

Plain text → ADF: wrap paragraphs in `{type:'doc',version:1,content:[{type:'paragraph',content:[{type:'text',text}]}]}`.
Transition by status name: fetch transitions, match `to.name`
case-insensitively, error with the available names when no match.

**Allowlist.** Default grant: Operations. Opt-in: Executive, Research
(reads), custom engineering employees. Denied: none.

**Errors.** 401 → `revoked`; 403 → `apiError` (no project permission); 404 →
`apiError`; 400 → `apiError` with `errorMessages` and `errors` joined.

**Rate limits.** Jira Cloud uses cost-based limits and returns 429 with
`Retry-After`. `RATE_LIMIT_JIRA_CAPACITY=10`, `_REFILL=1`.

**Tests.** Issue-key and project-key validators; JQL builder escaping;
ADF builder; transition matching; JSM internal-comment property; cloud id
required; risk map; not-connected.

---

### 3.11 Confluence

**Purpose.** Research, Executive and Emma answer from the wiki and write
summaries back.

**Auth.** Same Atlassian app as Jira; Nango `confluence` ✔. Scopes:
`read:confluence-content.all`, `search:confluence`,
`write:confluence-content` (classic) or the granular v2 equivalents
(`read:page:confluence`, `write:page:confluence`), `offline_access`. Base:
`https://api.atlassian.com/ex/confluence/{cloudId}/wiki`.

**Tools.**

| Chat tool | Action | Risk | Approval | Endpoint |
|---|---|---|---|---|
| `confluence_search` | `search` | read | no | `GET /rest/api/search?cql=type=page AND text ~ "<q>"&limit=` |
| `confluence_read_page` | `read_page` | read | no | `GET /api/v2/pages/{id}?body-format=storage` → strip to text |
| `confluence_list_spaces` | `list_spaces` | read | no | `GET /api/v2/spaces?limit=50` |
| `confluence_create_page` | `create_page` | draft | no | `POST /api/v2/pages` `{spaceId, status:'current', title, parentId?, body:{representation:'storage', value}}` |
| `confluence_append_page` | `append_page` | draft | no | `GET` page (version) then `PUT /api/v2/pages/{id}` with `version.number + 1` and appended body |

```json
// confluence_search
{ "type": "object", "required": ["query"], "properties": {
  "query": { "type": "string", "minLength": 2, "maxLength": 200 },
  "space_key": { "type": "string", "pattern": "^[A-Za-z0-9~]{1,255}$" },
  "limit": { "type": "integer", "minimum": 1, "maximum": 25, "default": 10 } } }
// confluence_read_page
{ "type": "object", "required": ["page_id"], "properties": { "page_id": { "type": "string", "pattern": "^[0-9]{1,20}$" } } }
// confluence_create_page
{ "type": "object", "required": ["space_id", "title", "content"], "properties": {
  "space_id": { "type": "string", "pattern": "^[0-9]{1,20}$" },
  "parent_id": { "type": "string", "pattern": "^[0-9]{1,20}$" },
  "title": { "type": "string", "maxLength": 255 },
  "content": { "type": "string", "maxLength": 50000, "description": "Plain text or simple markdown; converted to storage format" } } }
// confluence_append_page
{ "type": "object", "required": ["page_id", "content"], "properties": {
  "page_id": { "type": "string", "pattern": "^[0-9]{1,20}$" }, "content": { "type": "string", "maxLength": 50000 } } }
```

CQL injection: the `text ~` value is quoted and `"`/`\` escaped. Markdown →
storage format: paragraphs, headings, lists, code blocks only; all text
HTML-escaped (storage format is XHTML; unescaped text is markup injection).

**Allowlist.** Default grant: Research. Opt-in: Executive, Emma, Customer
(policy lookups). Denied: none.

**Errors.** 409 version conflict on append → retry once with fresh version,
then `apiError`; 404 → `apiError`; 401 → `revoked`.

**Rate limits.** Same Atlassian cost-based model.
`RATE_LIMIT_CONFLUENCE_CAPACITY=10`, `_REFILL=1`.

**Tests.** CQL escaping; storage-format builder escaping (`<script>`,
`&`, `]]>`); version bump on append; 409 retry path; HTML → text for reads;
risk map; not-connected.

---

### 3.12 Asana

**Purpose.** Operations and Executive manage tasks: my tasks, project tasks,
create, complete, comment.

**Auth.** Nango `asana` ✔ OAuth2. Base `https://app.asana.com/api/1.0`.
Default workspace: first of `GET /workspaces` unless the admin set one in
connection metadata.

**Tools.**

| Chat tool | Action | Risk | Approval | Endpoint |
|---|---|---|---|---|
| `asana_list_my_tasks` | `list_my_tasks` | read | no | `GET /tasks?assignee=me&workspace={ws}&completed_since=now&opt_fields=name,due_on,projects.name,permalink_url` |
| `asana_list_project_tasks` | `list_project_tasks` | read | no | `GET /projects/{gid}/tasks?completed_since=now&opt_fields=...` |
| `asana_list_projects` | `list_projects` | read | no | `GET /projects?workspace={ws}&archived=false` |
| `asana_get_task` | `get_task` | read | no | `GET /tasks/{gid}` + `GET /tasks/{gid}/stories` (comments only) |
| `asana_create_task` | `create_task` | draft | no | `POST /tasks` `{data:{name, notes, due_on, projects:[gid], assignee}}` |
| `asana_update_task` | `update_task` | draft | no | `PUT /tasks/{gid}` `{data:{completed, due_on, assignee, name}}` |
| `asana_add_comment` | `add_comment` | draft | no | `POST /tasks/{gid}/stories` `{data:{text}}` |

```json
// asana_list_my_tasks
{ "type": "object", "properties": {
  "due_within_days": { "type": "integer", "minimum": 0, "maximum": 90 },
  "overdue_only": { "type": "boolean", "default": false },
  "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 25 } } }
// asana_list_project_tasks
{ "type": "object", "required": ["project"], "properties": {
  "project": { "type": "string", "description": "Project gid or exact name from asana_list_projects" },
  "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 25 } } }
// asana_get_task
{ "type": "object", "required": ["task_gid"], "properties": { "task_gid": { "type": "string", "pattern": "^[0-9]{1,20}$" } } }
// asana_create_task
{ "type": "object", "required": ["name"], "properties": {
  "name": { "type": "string", "maxLength": 500 }, "notes": { "type": "string", "maxLength": 10000 },
  "project": { "type": "string" }, "due_on": { "type": "string", "format": "date" },
  "assignee_email": { "type": "string", "format": "email" } } }
// asana_update_task
{ "type": "object", "required": ["task_gid"], "properties": {
  "task_gid": { "type": "string", "pattern": "^[0-9]{1,20}$" },
  "completed": { "type": "boolean" }, "due_on": { "type": "string", "format": "date" },
  "name": { "type": "string", "maxLength": 500 }, "assignee_email": { "type": "string", "format": "email" } } }
// asana_add_comment
{ "type": "object", "required": ["task_gid", "text"], "properties": {
  "task_gid": { "type": "string", "pattern": "^[0-9]{1,20}$" }, "text": { "type": "string", "maxLength": 10000 } } }
```

Project name → gid: exact case-insensitive match; ambiguous → `apiError`
listing candidates. Asana returns a `next_page.offset`; return it as
`nextCursor`.

**Allowlist.** Default grant: Operations. Opt-in: Executive, Marcus (campaign
tasks). Denied: none.

**Errors.** 401 → `revoked`; 402 (premium-only feature, e.g. search) →
`apiError`; 403/404 → `apiError`.

**Rate limits.** Asana documents 150 requests/minute on free and 1,500 on
paid workspaces, plus concurrency and cost limits; 429 with `Retry-After`.
`RATE_LIMIT_ASANA_CAPACITY=10`, `_REFILL=2`.

**Tests.** Overdue/due-window filtering on `due_on`; project name resolution;
gid validator; `opt_fields` constant; risk map; not-connected.

---

### 3.13 Linear

**Purpose.** Operations and Research track engineering issues in Linear.

**Auth.** Nango `linear` ✔ OAuth2, scopes `read`, `write`, `issues:create`,
`comments:create`. Single GraphQL endpoint `POST https://api.linear.app/graphql`.

**Tools.**

| Chat tool | Action | Risk | Approval | GraphQL |
|---|---|---|---|---|
| `linear_list_issues` | `list_issues` | read | no | `issues(filter:{team:{key:{eq}}, state:{type:{in}}, assignee:{isMe:{eq:true}}, priority:{lte}}, first:N)` |
| `linear_get_issue` | `get_issue` | read | no | `issue(id:"ENG-123")` with comments |
| `linear_list_teams` | `list_teams` | read | no | `teams { nodes { id key name } }` |
| `linear_create_issue` | `create_issue` | draft | no | `issueCreate(input:{teamId,title,description,priority,assigneeId})` |
| `linear_update_issue` | `update_issue` | draft | no | `issueUpdate(id, input:{stateId, priority, assigneeId})` |
| `linear_add_comment` | `add_comment` | draft | no | `commentCreate(input:{issueId, body})` |

All queries are **fixed documents with variables**; the model never supplies
GraphQL text.

```json
// linear_list_issues
{ "type": "object", "properties": {
  "team_key": { "type": "string", "pattern": "^[A-Z][A-Z0-9]{0,6}$" },
  "state": { "enum": ["backlog","unstarted","started","completed","canceled","triage"] },
  "mine": { "type": "boolean", "default": false },
  "urgent_only": { "type": "boolean", "default": false },
  "limit": { "type": "integer", "minimum": 1, "maximum": 50, "default": 20 } } }
// linear_get_issue
{ "type": "object", "required": ["identifier"], "properties": { "identifier": { "type": "string", "pattern": "^[A-Z][A-Z0-9]{0,6}-[0-9]{1,7}$" } } }
// linear_create_issue
{ "type": "object", "required": ["team_key", "title"], "properties": {
  "team_key": { "type": "string" }, "title": { "type": "string", "maxLength": 255 },
  "description": { "type": "string", "maxLength": 20000 },
  "priority": { "type": "integer", "minimum": 0, "maximum": 4 } } }
// linear_update_issue
{ "type": "object", "required": ["identifier"], "properties": {
  "identifier": { "type": "string" }, "state_name": { "type": "string", "maxLength": 50 },
  "priority": { "type": "integer", "minimum": 0, "maximum": 4 } } }
// linear_add_comment
{ "type": "object", "required": ["identifier", "body"], "properties": {
  "identifier": { "type": "string" }, "body": { "type": "string", "maxLength": 20000 } } }
```

GraphQL errors arrive with HTTP 200 and an `errors` array: treat any
`errors` entry as failure (`extensions.code === 'AUTHENTICATION_ERROR'` →
`revoked`, `RATELIMITED` → rate-limited `apiError`).

**Allowlist.** Default grant: Operations. Opt-in: Research, Executive.
Denied: none.

**Rate limits.** Linear limits requests per hour per user/app and query
complexity; headers `X-RateLimit-Requests-Remaining`. Keep `first` ≤ 50 to
stay under complexity caps. `RATE_LIMIT_LINEAR_CAPACITY=10`, `_REFILL=1`.

**Tests.** 200-with-errors handling; identifier validator; state name →
stateId resolution per team; fixed documents (snapshot); risk map;
not-connected.

---

### 3.14 Airtable

**Purpose.** Operations, Sarah and Marcus use an Airtable base as a system of
record (listings, leads, inventory).

**Auth.** Nango `airtable` ✔ OAuth2, scopes `data.records:read`,
`data.records:write`, `schema.bases:read`. Base
`https://api.airtable.com/v0`.

**Tools.**

| Chat tool | Action | Risk | Approval | Endpoint |
|---|---|---|---|---|
| `airtable_list_bases` | `list_bases` | read | no | `GET /meta/bases` |
| `airtable_list_tables` | `list_tables` | read | no | `GET /meta/bases/{baseId}/tables` |
| `airtable_query` | `query_records` | read | no | `GET /{baseId}/{tableIdOrName}?filterByFormula=&maxRecords=&sort[0][field]=` |
| `airtable_create_record` | `create_record` | draft | no | `POST /{baseId}/{table}` `{records:[{fields}], typecast:true}` |
| `airtable_update_record` | `update_record` | draft | no | `PATCH /{baseId}/{table}` `{records:[{id, fields}]}` |

No delete in Wave 1.

```json
// airtable_list_tables
{ "type": "object", "required": ["base_id"], "properties": { "base_id": { "type": "string", "pattern": "^app[A-Za-z0-9]{14}$" } } }
// airtable_query
{ "type": "object", "required": ["base_id", "table"], "properties": {
  "base_id": { "type": "string", "pattern": "^app[A-Za-z0-9]{14}$" },
  "table": { "type": "string", "maxLength": 100 },
  "filters": { "type": "array", "maxItems": 5, "items": { "type": "object", "required": ["field","op","value"], "properties": {
    "field": { "type": "string", "maxLength": 100 },
    "op": { "enum": ["=","!=",">","<",">=","<=","contains"] },
    "value": { "type": ["string","number","boolean"] } } } },
  "sort_field": { "type": "string" }, "sort_desc": { "type": "boolean" },
  "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 25 } } }
// airtable_create_record
{ "type": "object", "required": ["base_id", "table", "fields"], "properties": {
  "base_id": { "type": "string" }, "table": { "type": "string" },
  "fields": { "type": "object", "maxProperties": 50 } } }
// airtable_update_record
{ "type": "object", "required": ["base_id", "table", "record_id", "fields"], "properties": {
  "base_id": { "type": "string" }, "table": { "type": "string" },
  "record_id": { "type": "string", "pattern": "^rec[A-Za-z0-9]{14}$" },
  "fields": { "type": "object", "maxProperties": 50 } } }
```

`filterByFormula` is built by the module from the structured `filters`
(field names wrapped in `{}` with `}` rejected; string values double-quoted
with `"` and `\` escaped; `contains` → `FIND(LOWER(v), LOWER({f}))`), never
taken raw from the model. Field names in `fields` are checked against the
table schema from `list_tables` (cached 5 min) to give a clear error instead
of Airtable's `UNKNOWN_FIELD_NAME`.

**Allowlist.** Default grant: Operations. Opt-in: Sarah, Marcus, Customer.
Denied: none.

**Rate limits.** Airtable allows 5 requests/second per base and returns 429
with a required 30-second back-off. `RATE_LIMIT_AIRTABLE_CAPACITY=5`,
`_REFILL=5`. On 429 return `retryAfterSec: 30`.

**Tests.** Formula builder (escaping, injection attempts like
`"), TRUE()` stay quoted); id validators; schema field check; risk map;
not-connected.

---

### 3.15 OneDrive and SharePoint files

**Purpose.** Drive parity for Microsoft orgs: search, read text, upload,
create folders, share.

**Auth.** Nango `one-drive` ✔ / `sharepoint-online` ✔ (alias with
`microsoft`, as `microsoft-outlook` does). Scopes `Files.ReadWrite.All`,
`Sites.Read.All`, `offline_access`. Graph base `https://graph.microsoft.com/v1.0`.

**Provider key.** `microsoft-files` (prefixes `onedrive`, `sharepoint`).

**Tools.**

| Chat tool | Action | Risk | Approval | Endpoint |
|---|---|---|---|---|
| `onedrive_search` | `search` | read | no | `GET /me/drive/root/search(q='{q}')?$top=` ; SharePoint: `POST /search/query` with `entityTypes:["driveItem"]` |
| `onedrive_list` | `list_folder` | read | no | `GET /me/drive/root/children` or `/me/drive/items/{id}/children`; sites: `/sites/{site-id}/drive/items/{id}/children` |
| `onedrive_get_text` | `get_text` | read | no | `GET /me/drive/items/{id}` then `/content` for text types, `/content?format=pdf` is not text, so Office files use `GET /items/{id}/content` + local extraction for docx/xlsx/pptx/pdf with the same extractor as `drive_get_text` |
| `onedrive_upload` | `upload_file` | draft | no | `PUT /me/drive/items/{parent-id}:/{filename}:/content` (≤ 4 MB; larger needs an upload session, out of scope) |
| `onedrive_create_folder` | `create_folder` | draft | no | `POST /me/drive/items/{parent-id}/children` `{name, folder:{}, "@microsoft.graph.conflictBehavior":"rename"}` |
| `onedrive_share` | `share_link` | publish | **yes** | `POST /me/drive/items/{id}/createLink` `{type:'view'|'edit', scope:'organization'|'anonymous'}` |
| `sharepoint_list_sites` | `list_sites` | read | no | `GET /sites?search={q}` |

```json
// onedrive_search
{ "type": "object", "required": ["query"], "properties": {
  "query": { "type": "string", "minLength": 2, "maxLength": 200 },
  "site_id": { "type": "string", "maxLength": 200 },
  "limit": { "type": "integer", "minimum": 1, "maximum": 50, "default": 20 } } }
// onedrive_list
{ "type": "object", "properties": { "folder_id": { "type": "string", "pattern": "^[A-Za-z0-9!._-]{1,200}$" }, "site_id": { "type": "string" } } }
// onedrive_get_text
{ "type": "object", "required": ["item_id"], "properties": { "item_id": { "type": "string", "pattern": "^[A-Za-z0-9!._-]{1,200}$" } } }
// onedrive_upload
{ "type": "object", "required": ["filename", "content"], "properties": {
  "folder_id": { "type": "string" }, "filename": { "type": "string", "pattern": "^[^\\\\/:*?\"<>|#%]{1,200}$" },
  "content": { "type": "string", "maxLength": 1000000, "description": "Text content; binary uploads are not supported in Wave 1" } } }
// onedrive_create_folder
{ "type": "object", "required": ["name"], "properties": { "parent_id": { "type": "string" }, "name": { "type": "string", "maxLength": 200 } } }
// onedrive_share
{ "type": "object", "required": ["item_id", "scope"], "properties": {
  "item_id": { "type": "string" }, "scope": { "enum": ["organization","anonymous"] },
  "type": { "enum": ["view","edit"], "default": "view" } } }
```

The search `q` is inside a quoted OData function argument: escape `'` as
`''` and URL-encode. Filenames reject path separators so an upload cannot
escape the target folder.

**Allowlist.** Default grant: Research, Executive. Opt-in: Operations,
Customer. Denied: none. `share_link` with `anonymous` scope: add a
`payloadDenial` rule requiring explicit `scope` (no default), mirroring Slack's
channel rule.

**Errors.** 401 → `revoked`; 403 `accessDenied` → `apiError`; 404 →
`apiError`; 413 (too large) → `apiError` "Files over 4 MB need an upload
session, not supported yet".

**Rate limits.** Graph/SharePoint throttling returns 429 or 503 with
`Retry-After`. `RATE_LIMIT_MICROSOFT_FILES_CAPACITY=10`, `_REFILL=2`.

**Tests.** OData escaping; filename validator; item id validator; extractor
reuse for docx/xlsx/pdf (fixture files); share scope required; risk map
(`share_link` → publish/confirm); not-connected.

---

### 3.16 Dropbox

**Purpose.** Same jobs as OneDrive for Dropbox orgs.

**Auth.** Nango `dropbox` ✔ OAuth2 (offline access). Scopes
`files.metadata.read`, `files.content.read`, `files.content.write`,
`sharing.write`. RPC endpoints on `https://api.dropboxapi.com/2`, content on
`https://content.dropboxapi.com/2`.

**Tools.**

| Chat tool | Action | Risk | Approval | Endpoint |
|---|---|---|---|---|
| `dropbox_search` | `search` | read | no | `POST /files/search_v2` `{query, options:{max_results}}` |
| `dropbox_list` | `list_folder` | read | no | `POST /files/list_folder` `{path}` (+ `/list_folder/continue`) |
| `dropbox_get_text` | `get_text` | read | no | `POST content/files/download` with `Dropbox-API-Arg: {"path":...}` → extractor |
| `dropbox_upload` | `upload_file` | draft | no | `POST content/files/upload` with `Dropbox-API-Arg: {"path":..., "mode":"add", "autorename":true}` |
| `dropbox_create_folder` | `create_folder` | draft | no | `POST /files/create_folder_v2` `{path, autorename:true}` |
| `dropbox_share` | `share_link` | publish | **yes** | `POST /sharing/create_shared_link_with_settings` `{path, settings:{requested_visibility:'public'|'team_only'}}` |

```json
// dropbox_search
{ "type": "object", "required": ["query"], "properties": {
  "query": { "type": "string", "minLength": 2, "maxLength": 200 },
  "limit": { "type": "integer", "minimum": 1, "maximum": 50, "default": 20 } } }
// dropbox_list / dropbox_get_text / dropbox_create_folder
{ "type": "object", "properties": { "path": { "type": "string", "pattern": "^(/[^/\\u0000-\\u001f]{1,255})*$|^$", "maxLength": 1000 } } }
// dropbox_upload
{ "type": "object", "required": ["path", "content"], "properties": {
  "path": { "type": "string", "pattern": "^(/[^/\\u0000-\\u001f]{1,255})+$" },
  "content": { "type": "string", "maxLength": 1000000 } } }
// dropbox_share
{ "type": "object", "required": ["path", "visibility"], "properties": {
  "path": { "type": "string" }, "visibility": { "enum": ["public","team_only"] } } }
```

Reject `..` segments in paths. `Dropbox-API-Arg` must be ASCII-safe JSON
(escape non-ASCII as `\uXXXX`, per Dropbox's HTTP header rules).

**Allowlist.** Default grant: Research. Opt-in: Operations, Executive.
Denied: none.

**Errors.** 401 `expired_access_token` → `revoked`; 409 `path/not_found` →
`apiError`; 409 `shared_link_already_exists` → return the existing link from
the error metadata as success.

**Rate limits.** Dropbox returns 429 with `Retry-After`.
`RATE_LIMIT_DROPBOX_CAPACITY=10`, `_REFILL=2`.

**Tests.** Path validator (`..`, control chars); header JSON ASCII escaping;
existing-link handling; extractor reuse; risk map; not-connected.

---

### 3.17 Mailchimp

**Purpose.** Marcus and Growth read campaign performance, manage audience
members, draft campaigns; sending a campaign parks.

**Auth.** Nango `mailchimp` ✔ OAuth2. The data-centre prefix (`us21` etc.)
comes from `GET https://login.mailchimp.com/oauth2/metadata` (`dc`,
`api_endpoint`); store in connection metadata at connect. Base
`https://{dc}.api.mailchimp.com/3.0`. Validate `dc` against `^[a-z]{2}[0-9]{1,3}$`.

**Tools.**

| Chat tool | Action | Risk | Approval | Endpoint |
|---|---|---|---|---|
| `mailchimp_list_audiences` | `list_audiences` | read | no | `GET /lists?fields=lists.id,lists.name,lists.stats` |
| `mailchimp_list_campaigns` | `list_campaigns` | read | no | `GET /campaigns?status=sent&sort_field=send_time&sort_dir=DESC&count=` |
| `mailchimp_campaign_report` | `campaign_report` | read | no | `GET /reports/{campaign_id}` |
| `mailchimp_upsert_member` | `upsert_member` | draft | no | `PUT /lists/{list_id}/members/{md5(lowercase email)}` `{email_address, status_if_new, merge_fields, tags}` |
| `mailchimp_draft_campaign` | `draft_campaign` | draft | no | `POST /campaigns` then `PUT /campaigns/{id}/content` `{html}` |
| `mailchimp_send_campaign` | `send_campaign` | send | **yes** | `POST /campaigns/{id}/actions/send` (after `GET /campaigns/{id}/send-checklist` is ready) |

`upsert_member` with `status_if_new: 'subscribed'` can enrol a person into a
welcome automation and email them. Wave 1 forces `status_if_new: 'pending'`
(double opt-in confirmation sent by Mailchimp, compliant) **or**
`'transactional'`; anything that subscribes directly is `send`. Simpler rule
adopted: the tool only accepts `pending` and `transactional`, so it stays
`draft`.

```json
// mailchimp_list_campaigns
{ "type": "object", "properties": { "limit": { "type": "integer", "minimum": 1, "maximum": 50, "default": 10 } } }
// mailchimp_campaign_report
{ "type": "object", "required": ["campaign_id"], "properties": { "campaign_id": { "type": "string", "pattern": "^[a-f0-9]{10}$" } } }
// mailchimp_upsert_member
{ "type": "object", "required": ["list_id", "email"], "properties": {
  "list_id": { "type": "string", "pattern": "^[a-f0-9]{10}$" },
  "email": { "type": "string", "format": "email" },
  "first_name": { "type": "string", "maxLength": 100 }, "last_name": { "type": "string", "maxLength": 100 },
  "status_if_new": { "enum": ["pending","transactional"], "default": "pending" },
  "tags": { "type": "array", "items": { "type": "string", "maxLength": 100 }, "maxItems": 10 } } }
// mailchimp_draft_campaign
{ "type": "object", "required": ["list_id", "subject", "from_name", "reply_to", "body"], "properties": {
  "list_id": { "type": "string", "pattern": "^[a-f0-9]{10}$" },
  "subject": { "type": "string", "maxLength": 150 }, "preview_text": { "type": "string", "maxLength": 150 },
  "from_name": { "type": "string", "maxLength": 100 }, "reply_to": { "type": "string", "format": "email" },
  "body": { "type": "string", "maxLength": 100000, "description": "Plain text or simple markdown; converted to escaped HTML" } } }
// mailchimp_send_campaign
{ "type": "object", "required": ["campaign_id"], "properties": { "campaign_id": { "type": "string", "pattern": "^[a-f0-9]{10}$" } } }
```

Approval card for `send_campaign` must show the audience name and member
count (fetch `GET /lists/{id}` during summarise) so the approver sees the
blast radius. Bulk sends are where a mistake is most expensive.

**Allowlist.** Default grant: Marcus. Opt-in: Growth. Denied: add
`mailchimp` to customer, operations and finance (`03` Appendix B).

**Approval extras.** `mailchimp` in `SEND_TOOLS`; `\bmailchimp-send\b` in
`isSendRisk`. Quiet hours apply.

**Errors.** 401 → `revoked`; 400 "Member Exists"/"Forgotten Email Not
Subscribed" → `apiError` with Mailchimp's `detail`; send-checklist not ready →
`apiError` listing the checklist items.

**Rate limits.** Mailchimp caps simultaneous connections per account (10)
and times out long calls. `RATE_LIMIT_MAILCHIMP_CAPACITY=10`, `_REFILL=2`.

**Tests.** Subscriber hash (md5 of lowercased trimmed email); dc validator;
status enum enforced; HTML escaping in body conversion; send-checklist gating;
risk map; persona denials; not-connected.

---

### 3.18 Typeform

**Purpose.** Growth, Sarah and Emma read form responses (leads, feedback);
new responses arrive as webhook-in events and can create inquiries/leads.

**Auth.** Nango `typeform` ✔ OAuth2, scopes `forms:read`, `responses:read`,
`webhooks:write`, `offline`. Base `https://api.typeform.com`.

**Tools.**

| Chat tool | Action | Risk | Approval | Endpoint |
|---|---|---|---|---|
| `typeform_list_forms` | `list_forms` | read | no | `GET /forms?page_size=50` |
| `typeform_list_responses` | `list_responses` | read | no | `GET /forms/{form_id}/responses?since=&page_size=&completed=true` |
| `typeform_summarise_responses` | `summarise_responses` | read | no | Same endpoint, paged up to 500 responses, aggregated per question (counts for choices, averages for ratings/NPS, sampled text) |

Webhook registration on connect (per form the admin selects):
`PUT /forms/{form_id}/webhooks/darex` `{url, enabled:true, secret, verify_ssl:true}`.
Typeform signs with `Typeform-Signature: sha256=<base64 HMAC-SHA256>`; add a
`typeform` verifier to the webhook-in route.

```json
// typeform_list_responses
{ "type": "object", "required": ["form"], "properties": {
  "form": { "type": "string", "description": "Form id or exact title from typeform_list_forms" },
  "since_hours": { "type": "integer", "minimum": 1, "maximum": 2160, "default": 24 },
  "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 25 } } }
// typeform_summarise_responses
{ "type": "object", "required": ["form"], "properties": {
  "form": { "type": "string" }, "since_days": { "type": "integer", "minimum": 1, "maximum": 365, "default": 30 } } }
```

Responses are returned as `{submittedAt, answers:[{question, answer}]}`
with question titles joined from the form definition; text answers fenced
as untrusted.

**Allowlist.** Default grant: Growth, Marcus. Opt-in: Sarah, Emma, Customer.
Denied: finance.

**Rate limits.** Typeform's Create/Responses APIs allow about 2 requests per
second per account. `RATE_LIMIT_TYPEFORM_CAPACITY=4`, `_REFILL=2`.

**Tests.** Answer flattening for each answer type (choice, choices, text,
email, number, boolean, date, rating, opinion scale, phone); summary
aggregation; signature verifier (base64, `sha256=` prefix); risk map;
not-connected.

---

### 3.19 WooCommerce

**Purpose.** Customer and Operations answer "where is my order", update order
status, add order notes.

**Auth.** Basic with consumer key/secret over HTTPS, plus `store_url` in
connection config. Nango `woocommerce` (unverified); fallback BYOK in
`channels.meta` (`channel_type='woocommerce'`). Uses
`resolveNangoCredentials`. `store_url` must be `https://`, public, no path
other than an optional WordPress subdirectory; validated at connect and call.

**Tools.**

| Chat tool | Action | Risk | Approval | Endpoint |
|---|---|---|---|---|
| `woo_list_orders` | `list_orders` | read | no | `GET {store}/wp-json/wc/v3/orders?status=&search=&after=&per_page=` |
| `woo_get_order` | `get_order` | read | no | `GET /wp-json/wc/v3/orders/{id}` + `GET /orders/{id}/notes` |
| `woo_search_products` | `search_products` | read | no | `GET /wp-json/wc/v3/products?search=&per_page=` |
| `woo_add_order_note` | `add_order_note` | draft | no | `POST /wp-json/wc/v3/orders/{id}/notes` `{note, customer_note:false}` |
| `woo_notify_customer` | `send_order_note` | send | **yes** | Same with `customer_note:true` (WooCommerce emails the customer) |
| `woo_update_order_status` | `update_order_status` | send | **yes** | `PUT /wp-json/wc/v3/orders/{id}` `{status}`; status changes trigger customer emails (completed, refunded, cancelled), so `send` |

Refunds (`POST /orders/{id}/refunds`) are `pay` and deferred to Wave 2 with
Shopify writes. `cancelled` status is allowed only through
`update_order_status` and treated as `send` (parks); add `cancel` handling to
persona denials as for Calendly.

```json
// woo_list_orders
{ "type": "object", "properties": {
  "status": { "enum": ["pending","processing","on-hold","completed","cancelled","refunded","failed"] },
  "search": { "type": "string", "maxLength": 100, "description": "Customer name, email, or order number" },
  "since_days": { "type": "integer", "minimum": 1, "maximum": 365 },
  "limit": { "type": "integer", "minimum": 1, "maximum": 50, "default": 20 } } }
// woo_get_order
{ "type": "object", "required": ["order_id"], "properties": { "order_id": { "type": "integer", "minimum": 1 } } }
// woo_search_products
{ "type": "object", "required": ["search"], "properties": { "search": { "type": "string", "minLength": 2, "maxLength": 100 } } }
// woo_add_order_note / woo_notify_customer
{ "type": "object", "required": ["order_id", "note"], "properties": {
  "order_id": { "type": "integer", "minimum": 1 }, "note": { "type": "string", "maxLength": 5000 } } }
// woo_update_order_status
{ "type": "object", "required": ["order_id", "status"], "properties": {
  "order_id": { "type": "integer", "minimum": 1 },
  "status": { "enum": ["processing","on-hold","completed","cancelled"] } } }
```

**Allowlist.** Default grant: Customer. Opt-in: Operations, Emma (read
only via a narrower grant is not possible today; Emma's persona text says no
order processing, so keep opt-in). Denied: add `woocommerce` to growth and
marketing (matches shopify).

**Approval extras.** `woocommerce` in `SEND_TOOLS`; `\bwoo-notify\b|
\bwoo-update-order-status\b` in `isSendRisk`.

**Errors.** 401 `woocommerce_rest_cannot_view` → `revoked`; 404
`woocommerce_rest_shop_order_invalid_id` → `apiError`; HTML response instead
of JSON (security plugin, wrong URL, permalinks off) → `apiError` "The store
did not return JSON; check the store URL and that pretty permalinks are on".

**Rate limits.** Self-hosted; limits depend on the host.
`RATE_LIMIT_WOOCOMMERCE_CAPACITY=10`, `_REFILL=1` to be gentle on small hosts.

**Tests.** Store URL validator (https only, no private hosts, no query
strings); HTML-response detection; status enum; `customer_note` true only in
the send action; risk map; growth persona denied; not-connected through
API-key credentials.

---

### 3.20 Telegram Bot

**Purpose.** Emma and Customer read and answer customers on Telegram,
WhatsApp-style. Inbound messages land in `messages` like WhatsApp and
Instagram.

**Auth.** BYOK bot token from BotFather, stored encrypted in `channels.meta`
(`channel_type='telegram'`), like the WhatsApp Cloud API path. Token format
validated `^[0-9]{6,12}:[A-Za-z0-9_-]{30,50}$`; verified at connect with
`GET https://api.telegram.org/bot<token>/getMe`. Because it is a channel,
`mergeRuntimeAllowlist` adds `telegram` to the turn allowlist when connected
(same as Instagram).

**Inbound.** On connect, `setWebhook` `{url:
https://<host>/api/webhooks/telegram/<channelId>, secret_token,
allowed_updates:['message']}`. New route
`apps/dashboard/app/api/webhooks/telegram/[channelId]/route.ts` checks
`X-Telegram-Bot-Api-Secret-Token` with `timingSafeEqual`, persists message +
conversation (`messages.channel_key='telegram'`, `conversations.contact_id =
chat id`), returns 200, then fire-and-forget the agent (AGENTS.md rule 2).
Could also ride the generic webhook-in route with a `telegram` verifier; a
dedicated route is clearer because it writes `messages`.

**Tools.**

| Chat tool | Action | Risk | Approval | Source / endpoint |
|---|---|---|---|---|
| `telegram_list_messages` | `list_messages` | read | no | `messages` where `channel_key='telegram'` (RLS), optional `chat_id` |
| `telegram_send` | `send_message` | send | **yes** | `POST https://api.telegram.org/bot<token>/sendMessage` `{chat_id, text, reply_parameters?}` |

```json
// telegram_list_messages
{ "type": "object", "properties": {
  "chat_id": { "type": "string", "pattern": "^-?[0-9]{1,20}$" },
  "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 20 } } }
// telegram_send
{ "type": "object", "required": ["chat_id", "message"], "properties": {
  "chat_id": { "type": "string", "pattern": "^-?[0-9]{1,20}$" },
  "message": { "type": "string", "maxLength": 4096 },
  "reply_to_message_id": { "type": "integer", "minimum": 1 } } }
```

Send rules (mirroring `instagram.ts`): refuse a `chat_id` that has never
messaged this bot (no row in `conversations` for it), because Telegram bots
cannot start conversations and an arbitrary id is a misdirected send. Send as
plain text (no `parse_mode`) so model text cannot inject markup. Write the
outbound message back to `messages` (the Instagram and WhatsApp chat sends
do not today; do it here and note the gap for the others).

**Allowlist.** Channel-driven plus default grant: Emma, Customer. Denied: add
`telegram` to finance (out of scope). Operations: `send_message` does not
match `send_email`/`send_channel`; add `send_external`-style naming? Keep
`send_message` and add `telegram` to `PERSONA_DENIED_TOOLS.operations` only if
the operations spec forbids customer messaging (it forbids external sends
today via `send_external`; recommend naming the action `send_external_message`
so the existing denial applies without a new rule).

**Approval extras.** `telegram` in `SEND_TOOLS`; `\btelegram-send\b` in
`isSendRisk`. Quiet hours and critic apply.

**Errors.** Telegram returns `{ok:false, error_code, description}`: 401 →
`revoked`; 403 "bot was blocked by the user" → `apiError` (do not retry); 400
"chat not found" → `apiError`; 429 with `parameters.retry_after` →
rate-limited `apiError`.

**Rate limits.** Telegram allows about 30 messages/second per bot overall,
about 1/second per chat, and 20/minute per group.
`RATE_LIMIT_TELEGRAM_CAPACITY=5`, `_REFILL=1`.

**Tests.** Token and chat id validators; secret-token header check; unknown
chat refused; plain-text send body (no `parse_mode`); `ok:false` mapping;
outbound persisted; risk map; not-connected when no channel row.

---

## 4. Cross-cutting test matrix

| Test | Where | Covers |
|---|---|---|
| Risk + confirm per action | `<provider>.test.ts` via `resolveCallRisk` | Approval parks exactly the right actions |
| Tool → action wiring | `<provider>.test.ts` over `TOOLS` | Chat names resolve; no orphan names |
| Bridge parity | one new `tool-definitions-parity.test.ts` (until §3.0.3 removes the duplicate) | `mcp-bridge.ts` and `tool-definitions.ts` list the same names, tools, actions |
| Honest not-connected | `<provider>.test.ts` with `NANGO_SECRET_KEY` unset | Never fabricates data |
| Revoked vs never-configured | `shared` tests for `resolveNangoCredentials` | Correct reconnect wording |
| Persona denials | `role-capability.test.ts` additions | Each spec's denied personas |
| Payload denials | `executor-gate.test.ts` additions | Teams channel required, share scope required, pay amount |
| Inbound send classification | `inbound-hitl.test.ts` additions | New send tools park on inbound runs |
| Dashboard confirm classes | dashboard `confirm-classes` tests | Webhook replies that claim a send are paused |
| Connector sign-in mapping | shared-types test for `providerKeyForTool` | `teams_send` → `/connectors?connect=microsoft-teams` |
| Chat coverage completeness | `scripts/chat-coverage.test.ts` (existing) | Every new tool has a row |
| Webhook signatures | dashboard route tests | Calendly, Typeform, Telegram, generic HMAC/token |
| SSRF | `safe-url.test.ts` additions | IMAP/SMTP, WooCommerce, remote MCP, Zoom download host |
| DSR | `dsr/tables.test.ts` | New tenant tables reachable by delete/export |

---

## 5. Definition of done (per integration)

- [ ] Absence re-verified; Nango key verified on the pinned Nango.
- [ ] Module with explicit risk map, validators, honest errors; no host from
      payload; `fetchWithTimeout` only.
- [ ] Registered in `tools/index.ts`; chat tools in `tool-definitions.ts`
      (and `mcp-bridge.ts` until deduplicated).
- [ ] Intent regex, inbound send classification, dashboard confirm class.
- [ ] Sign-in id + prefixes, catalog item (`catalog_only` until live), registry
      meta, Nango alias, ping spec.
- [ ] Roster grant + additive migration + persona denials + employee spec doc.
- [ ] Unit tests listed in §1.9, registered in `package.json`; workflows and
      dashboard typecheck and tests pass.
- [ ] `chat-coverage.md` regenerated; new rows 🟡.
- [ ] Rate-limit env added to `deploy/env.production.example`.
- [ ] Credentials runbook row; OAuth app marked 🔴 until a human registers it.
- [ ] Live `/ask-ai` proof (read, draft, approved send, revoked, persona
      denial) → rows 🟢, `catalog_only` → `live`.
- [ ] `BUILD_STATE.md` entry and `integrations-connectors.md` tracker row in
      the same commit as the code.
