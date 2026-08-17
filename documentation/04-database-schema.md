# 04 — Database Schema

## Databases

The single Postgres instance (`pgvector/pgvector:pg16`, container `darex-postgres`) hosts multiple databases created by `infra/db/init/00_create_databases.sql` on first boot:

| Database | Owner service |
|---|---|
| `darex` | Primary app DB (all business tables) |
| `nango` | Nango (OAuth tokens/connections) |
| `langfuse` | Langfuse (trace metadata) |
| `litellm` | LiteLLM |
| `supertokens` | SuperTokens (identity) |
| `temporal_visibility` | Temporal (visibility store) |
| (5 more created implicitly by services) | — |

On `darex`, `00_create_databases.sql` enables `uuid-ossp`, `pgcrypto`, `vector` (pgvector), sets `row_security = on` at DB level, and creates the least-privilege `darex_app` role (password `darex_app_dev_secret`) with schema grants. Note: the app currently connects as `darex` (superuser-ish), not `darex_app`.

## Migrations (`infra/db/migrations/`)

Run in order (a migration runner applies them; applied migrations are tracked). All core tables are `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`, so re-running is safe.

| # | File | Change |
|---|---|---|
| 001 | `001_core_schema.sql` | `orgs`, `users`, `ai_employees`, `channels`, `conversations`, `messages`, `org_onboarding`, `idempotency_keys` + RLS policies + `update_updated_at_column()` trigger helper |
| 002 | `002_rls_test.sql` | `test_rls_isolation()` stored function (creates 2 orgs, asserts each sees only its own row) |
| 003 | `003_channel_logs.sql` | `channel_logs` audit table + RLS + index |
| 004 | `004_password_hash.sql` | adds `users.password_hash` (Postgres auth fallback) |
| 005 | `005_channels_unique_org_type.sql` | unique index `(org_id, channel_type)` on `channels` (dedupes first) |
| 006 | `006_messages_chatwoot_msg_id_text.sql` | `messages.chatwoot_msg_id` `integer` → `text` (Meta IDs are like `wamid.1786359347590`) |

## Core tables (database `darex`)

### `orgs`
- `id uuid PK default uuid_generate_v4()`, `name text`, `slug text UNIQUE`, `plan text default 'free'`, `status text default 'provisioning'` (active), timestamps.
- **No RLS** (orgs is the tenant root; not filtered by org).

### `users`
- `id uuid PK`, `org_id uuid FK orgs ON DELETE CASCADE`, `supertokens_id text UNIQUE`, `email text`, `role text default 'agent'` (owner/agent), `password_hash text` (nullable — only set for Postgres-fallback users), timestamps.
- **RLS FORCED**: policy `org_id = current_setting('app.current_org_id')::uuid`.
- Session cookie `darex_session` stores the **users.id PK**.

### `ai_employees`
- `id uuid PK`, `org_id uuid FK`, `name text`, `role text` (sales/support/marketing), `persona jsonb default {}`, `tool_allowlist text[] default {}`, `graph_id text` (legacy field), `status text default 'provisioning'` (active), timestamps.
- **RLS FORCED**.

### `channels`
- `id uuid PK`, `org_id uuid FK`, `channel_type text` (whatsapp/gmail/google-calendar/hubspot/razorpay/meta-ads/google-ads/…), `nango_connection_id text`, `chatwoot_inbox_id integer`, `status text default 'disconnected'` (active/connected), `meta jsonb default {}` (**stores `phone_number_id`, `meta_access_token`, `whatsapp_business_account_id`, `webhook_secret`**, `name`), `connected_at`, timestamps.
- **RLS FORCED**. Unique index `(org_id, channel_type)` (migration 005) — used by `ON CONFLICT` upserts.

### `conversations`
- `id uuid PK`, `org_id uuid FK`, `employee_id uuid FK ai_employees`, `channel_id uuid FK channels`, `chatwoot_conv_id integer UNIQUE`, `temporal_workflow_id text`, `status text default 'open'` (open/resolved), `contact_id text`, `summary text`, `metadata jsonb default {}` (stores `sender_name`, arbitrary meta), `started_at`, `resolved_at`, timestamps.
- **RLS FORCED**. Indexes on org_id, employee_id, status.

### `messages`
- `id uuid PK`, `org_id uuid FK`, `conversation_id uuid FK ON DELETE CASCADE`, `role text` (user/assistant/system/human_agent), `content text`, `tool_calls jsonb` (executedSteps from the agent), `chatwoot_msg_id text` (was integer; migration 006), `created_at`.
- **RLS FORCED**. Indexes on org_id, conversation_id.

### `channel_logs`
- `id uuid PK`, `org_id uuid FK`, `channel_type text`, `event_type text` (`inbound_message`, `outbound_message`, `connect`, `disconnect`, `proxy_call`, `webhook`, `sync`, `AGENT_EXECUTION`, `inbound`…), `status text` (success/error/pending), `status_code integer default 200`, `message text`, `payload jsonb default {}`, `response jsonb default {}`, `created_at`.
- **RLS FORCED**. Indexes on org_id, channel_type, created_at.
- **⚠️ Contract:** this table has **no** `channel_id` and **no** `log_type` column. When inserting, use the exact columns above. (`channel_type` holds the channel type string, `event_type` the event kind; the second insert value in some callers is `event_type`, not `log_type`.) Any code inserting `channel_id`/`log_type` breaks.

### `org_onboarding`
- `id uuid PK`, `org_id uuid UNIQUE FK`, `wizard_step text default 'name'`, `business_name text`, `team_size integer`, `business_type text`, `channels_selected text[] default {}`, provisioning timestamps.
- **RLS FORCED**.

### `idempotency_keys`
- `key text PK`, `org_id uuid FK`, `result jsonb`, `created_at`, `expires_at default +24h`.
- **RLS FORCED**.

## RLS model

Every tenant table is `ENABLE ROW LEVEL SECURITY` **and** `FORCE ROW LEVEL SECURITY`, with one policy each:
`USING (org_id = current_setting('app.current_org_id', true)::uuid)`.

- The app must call `SELECT set_config('app.current_org_id', $1, true)` on every connection before querying tenant data. This is done by `getScopedClient()` in the dashboard and by activities/tool-executor in the worker.
- RLS is verified by the `test_rls_isolation()` function (migration 002) and by the Phase 3 check (creates rows, reads them back under the org's RLS context).
- No `INSERT WITH CHECK` policies are defined on tenant tables — with FORCE RLS, inserts are permitted as long as the session passes the USING policy's `org_id` comparison. (Keep this in mind if you add policies.)

## Data notes (from last audit)

- Row counts at audit time: **37 orgs, 34 users, 52 channels, 21 conversations, 34 messages, 3 ai_employees** (many are check-script artifacts).
- Check scripts create fresh users/orgs per run (`check_<ts>@example.com`, `e2e_<ts>@example.com`) and clean their webhook test conversations; org rows accumulate.

## How to inspect

```bash
docker exec -it darex-postgres psql -U darex -d darex
# List tables
\dt
# Test RLS isolation
SELECT test_rls_isolation();
```
