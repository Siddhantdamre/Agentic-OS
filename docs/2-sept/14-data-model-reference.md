# 14 — Data Model Reference

Complete tenant data model as of migration `021`. Every table listed here
exists in `infra/db/migrations/`. Where a column encodes a product rule, the
rule is stated — the schema *is* the specification for most of Darex's
guarantees.

## 0. Conventions that hold everywhere

- **Primary keys** are `UUID DEFAULT uuid_generate_v4()`, except registry
  tables keyed by a stable string (`packs.id`, `connector_defs.key`).
- **Tenant column** is `org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE`.
- **RLS** on every tenant table, both `ENABLE` *and* `FORCE ROW LEVEL SECURITY`,
  with the policy:
  ```sql
  USING      (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID)
  ```
  `FORCE` matters: without it the table owner bypasses the policy. `WITH CHECK`
  matters: without it a tenant can *write* rows into another tenant.
- **Timestamps** are `TIMESTAMPTZ NOT NULL DEFAULT NOW()`, with an
  `update_updated_at_column()` trigger on `updated_at`.
- **Extensible fields** are `JSONB NOT NULL DEFAULT '{}'::jsonb` — never
  nullable JSON, so application code never branches on null-vs-empty.
- **Grants** go to `darex_app`, the non-superuser role every application
  connects as.

---

## 1. Identity and tenancy

### `orgs`
The tenant root. `meta JSONB` added in `018` carries org-level configuration
(timezone, quiet hours overrides, branding).

### `users`
Members of an org. `password_hash` added in `004`. Two policies:
`users_org_isolation` for org-scoped listing, and `users_self_select` so a user
can read their own row during session bootstrap before an org context exists.

### `org_invites`, `password_reset_tokens`
Invitation and recovery flows (`009_auth_tenancy`). Tokens are single-use and
expiring.

### `org_onboarding`
Per-org onboarding state — which steps are complete, which pack was chosen.
Onboarding is data, not a hardcoded wizard, so a pack can extend it.

### `human_roles` (`019`)
The human side of the permission model, distinct from AI employee roles.

---

## 2. The AI workforce

### `ai_employees` (`001`, extended `011`)

| Column | Meaning |
|---|---|
| `name` | Identity users refer to ("ask Sarah…") |
| `role` | Job description; shapes routing and the system prompt |
| `persona JSONB` | Tone, constraints, refusal rules |
| `tool_allowlist TEXT[]` | **Enforced** authorisation, not prompt guidance |
| `graph_id` | The agent graph this employee runs |
| `status` | `provisioning` \| `active` \| `paused` |

`tool_allowlist` being a first-class array column rather than prompt text is
the single most important design choice in the workforce model: a jailbroken
prompt cannot grant itself a tool that is not in this array.

### `agent_plans` (`007`)

| Column | Meaning |
|---|---|
| `thread_id` | Default `'ask-ai'`; ties a plan to its conversation |
| `summary` | Human-readable description of the whole plan |
| `steps JSONB` | Ordered step objects: `{id, description, tool, action, payload, enabled}` |
| `status` | `pending` → approved/rejected → executing → done/failed |
| `current_step` | Resume point; makes partial execution observable |
| `draft JSONB` | The proposed artifact (an email body, a message) before send |
| `reasoning JSONB` | Why the planner chose these steps |
| `feedback TEXT` | The human's revision instruction, fed to `/api/ask-ai/revise` |

The presence of `draft` and `feedback` is what makes the confirm gate a
*conversation* rather than a yes/no: the user can edit the artifact and ask for
a revision without regenerating the whole plan.

### `work_items` and `work_events` (`012`)

`work_items` is the human-in-the-loop queue.

| Column | Meaning |
|---|---|
| `type` | Default `'conversation'`; the class of work |
| `status` | `open` and its terminal states |
| `assignee_employee_id` | Which AI employee owns it (`ON DELETE SET NULL` — deleting an employee never deletes work) |
| `conversation_id` | Source thread |
| `channel` | Where it came from |
| `entity_refs JSONB[]` | Which entities this work touches |
| `priority`, `due_at` | Triage inputs |
| `temporal_workflow_id` | The durable execution handling it — the join between the DB and Temporal |

`work_events` is the append-only history of what happened to a work item,
indexed by `(org_id, kind)`.

---

## 3. Conversations and channels

### `channels` (`001`, `005`, `018`)
One row per connected channel per org. `005` adds a unique constraint on
`(org_id, type)` so an org cannot accidentally hold two WhatsApp channels with
divergent state.

### `conversations`
Threads, with `employee_id` (owning AI employee) and `status`. Indexed on
`(org_id)`, `(employee_id)`, `(status)`.

### `messages` (`001`, `006`, `018`)
`chatwoot_msg_id` was widened to `TEXT` in `006` because provider ids are not
integers. `018` adds `channel_key` plus `idx_messages_org_channel_key` — the
deduplication key for inbound delivery.

### `channel_logs` (`003`)
Raw channel-level delivery log, separate from `messages`, so a provider
retry storm never pollutes the conversation view.

### `chatwoot_inbox_map`
Maps a Chatwoot inbox to an org — tenant resolution for inbound webhooks.

### `widget_embed_tokens` (`018`)
The public web widget's site keys. Tenant is derived from a **hash of the site
key**, never from a body `org_id`. This table is why the widget is safe to
embed on a customer's public site.

---

## 4. Memory (`013_memory_rag`)

Four memory tiers plus a relation table. All five share the same column
contract: `kind`, `title`, `body`, `embedding vector(1536)`, `source`,
`source_ref`, `content_hash`, `metadata`, `expires_at`, and a **generated
`body_tsv` tsvector**.

| Table | Scope key | Retrieved when |
|---|---|---|
| `org_memory` | org | Every turn — SOPs, brand, FAQ, area books, policy |
| `employee_memory` | `employee_id` | That employee's turns — learned patterns |
| `entity_memory` | `(entity_type, entity_id)` | The entity is in scope — confirmed facts |
| `conversation_memory` | `conversation_id` | Same thread, and similar threads |
| `memory_edges` | `from_id`/`to_id`/`rel` | Multi-hop expansion |

### Index strategy — this is a hybrid store, deliberately

Every memory tier carries **both**:

```sql
CREATE INDEX ... USING gin (body_tsv);                         -- lexical
CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;                                 -- semantic
```

Plus a scope btree (`(org_id, entity_type, entity_id)` etc.) for **lock-first
retrieval**: when the query names an entity, the entity's rows are fetched
deterministically before any similarity search runs.

The partial HNSW index (`WHERE embedding IS NOT NULL`) is what lets memory work
*before* the embed worker has caught up — rows are searchable lexically the
moment they land, and become semantically searchable when embedded.

### Idempotent ingest

```sql
CREATE UNIQUE INDEX ... ON <tier> (org_id, source, source_ref, content_hash);
```

Re-ingesting unchanged content is a no-op, and re-embedding is skipped. This is
the mechanism that makes scheduled re-crawls cheap.

### `memory_edges`

Typed relations between memory rows: `inquired_about`, `shown`, `owns`,
`employs`, `cites`. `from_id`/`to_id` are polymorphic UUIDs with `from_kind`/
`to_kind` naming the tier — deliberately **no foreign key**, so a relation can
span tiers. `weight REAL` supports ranked traversal. Unique on
`(org_id, from_id, to_id, rel)`.

This is a graph inside Postgres, on purpose. The comment in the migration is
explicit: "Apache AGE later if needed". Graph hops stay inside RLS, which a
separate graph database would not.

### `knowledge_sources` and `ingestion_jobs`

`knowledge_sources`: `connector` (drive, notion, upload, pack, crawl), `path`,
`content_hash`, `last_synced`, `status` (`pending`/`syncing`/`ready`/`error`/
`disabled`). Unique on `(org_id, connector, path)`.

**Rule encoded here:** a `disabled` source must not be retrieved. Disabling is
how a customer removes a source from the brain's answers without deleting its
history.

`ingestion_jobs`: `state` (`queued`/`running`/`succeeded`/`failed`/`cancelled`),
`cursor` for resumable paging, `error`. The migration comment states the rule:
**never run on the WhatsApp request thread**, and **`error` must not store
secrets**.

### What the migration deliberately omits

> "Deliberately omitted: KYC / PAN / Aadhaar columns. Do not embed KYC. Do not
> store government ID numbers on these tables."

The Indian brokerage vertical handles identity documents. The schema refuses to
be the place they live. This is a compliance decision expressed as an absence.

### The embedding-dimension contract

`vector(1536)` must equal env `EMBEDDING_DIM`. Mixing dimensions in one column
is unrecoverable without a re-embed. Changing the model requires a migration
plus a re-embed job — never an in-place `ALTER` with rows present. No model
name is hardcoded in the schema.

---

## 5. Connectors (`014_connector_registry`, `021`)

### `connector_defs` — the registry (global, not tenant-scoped)

| Column | Purpose |
|---|---|
| `key` | Primary key, e.g. `gmail`, `zoho-crm` |
| `nango_key` | The broker's integration id |
| `category`, `icon`, `description` | Catalogue presentation |
| `auth_mode` | `oauth` \| BYOK variants |
| `risk_class` | Default risk for this connector's actions |
| `confirm_policy` | When a human confirm is required |
| `vertical_tags TEXT[]` | Which packs surface it |
| `mcp_tools TEXT[]` | Tools exposed over MCP for this connector |
| `extra_connect_fields`, `extra_test_fields JSONB` | BYOK form definitions, data-driven |
| `executor_status` | `live` and its alternatives — is the executor implemented? |
| `testable BOOLEAN` | Whether "Test connection" is meaningful |
| `scopes TEXT[]` | Required OAuth scopes — the source of scope-drift detection |
| `env_vars JSONB` | What operations must configure |
| `webhook_events TEXT[]` | Events this connector can push |

The connector catalogue is **data**, so adding a connector to the UI does not
require a dashboard deploy, and `executor_status` prevents the UI from
advertising a connector whose executor does not exist.

### `org_connectors`
Per-org connection state, keyed by `connector_key`. **`status: 'connected'` is
only ever written from a real broker connection** — never from a seed file,
never inferred from a UI click.

### `org_sql_connections` (`021`)
Customer-owned SQL databases the brain may query. This is how Darex answers
questions about data that lives in the customer's own system of record without
ingesting it.

### `sync_cursors`
Per `(org_id, connector_key)` incremental sync position, so a re-sync resumes
rather than refetching.

### `idempotency_keys`
Org-scoped, with `expires_at` and an expiry index. This is the mechanism that
stops a Temporal retry from sending the same email twice.

---

## 6. Packs (`015_packs`)

### `packs` — the catalogue
`id TEXT` primary key, `version`, `extends` (pack inheritance — a vertical pack
extends `core-b2b`), `markets TEXT[]`, `live BOOLEAN`, `manifest JSONB`.

Policies are `packs_read_all` / `packs_write_all` — the catalogue is global,
not tenant data.

### `org_packs` — installations
`status` is constrained by a `CHECK`:
`pending | installing | installed | failed | uninstalling | disabled | uninstalled`.
`is_primary` marks the vertical pack when several are installed. Unique on
`(org_id, pack_id)`. `installed_at` / `uninstalled_at` give the install history.

An explicit `installing` and `uninstalling` state means a partially applied
pack is visible rather than looking installed-but-broken.

### `pack_entity_schemas`
The entity types a pack registers, global like the pack catalogue.

---

## 7. Vertical tables

### Real estate (`015`)
- `re_listings` — with `idx_re_listings_filters` and `idx_re_listings_locality`
  for the filter-first search path.
- `re_inquiries` — indexed by `(org_id, listing_id)` and `(org_id, status)`.
- `re_showings` — indexed by `(org_id, starts_at)` for the scheduling window.
- `rera_cache` — global cache of RERA registry lookups with `expires_at`.
  Global because the registry is public data, not tenant data.

### Property management
- `pm_leases`, `pm_charges` — indexed by `(org_id, status)`, the trigger source
  for `RentReminderWorkflow` (`pm.charge.due`).

---

## 8. Governance and audit (`016_audit_events`)

`audit_events` is the most information-dense table in the schema:

| Column | Why it exists |
|---|---|
| `kind` | Event class |
| `actor_type` | human \| employee \| component |
| `actor_user_id`, `actor_employee_id`, `actor_component` | Who or what acted |
| `work_item_id`, `plan_id` | What the action belonged to |
| `confirm_id`, `approver_user_id` | **Who approved it** — the accountability join |
| `tool`, `action`, `risk_class` | Exactly what was attempted |
| `model`, `prompt_hash` | Which model and prompt version produced it |
| `langfuse_trace_id` | Join to the full trace |
| `result_status` | Outcome, default `ok` |

Indexed by `(org_id, created_at DESC)`, `(org_id, kind)`, `(org_id,
approver_user_id)`, `(org_id, langfuse_trace_id)`.

`prompt_hash` plus `model` means a regression can be traced to the exact prompt
version that produced a bad action, months later. `approver_user_id` means the
question "who authorised this?" always has an answer.

### `dsr_requests`
Data-subject requests, with `(org_id, status)` indexed. Backed by the
`/api/dsr/export` and `/api/dsr/delete` routes.

---

## 9. Billing (`017_billing`)

### `billing_subscriptions`
Provider-agnostic: `provider`, `provider_customer_id`,
`provider_subscription_id`, `plan_key`, `status`, `seats`, period bounds,
`cancel_at_period_end`. Stripe and Razorpay both fit, which matters for an
India-first product.

### `billing_meters`
`period_start`/`period_end`, `meter_kind` (CHECK-constrained), `quantity`,
`unit`, **`soft_limit`**, **`hard_limit`**, `source`, `truncated`.

Soft and hard limits in the meter table mean budget enforcement is a data
question, not a code path someone forgot to add. `truncated` records that a
meter stopped counting — honest metering rather than a silently capped number.

### `billing_invoices`, `billing_webhook_events`
Invoice state and idempotent provider webhook processing.

---

## 10. Insight and learning (`020_insight_learning`)

### `ask_ai_feedback`
`vote` CHECK-constrained to `'up' | 'down'`, joined to `conversation_id`,
`plan_id`, `message_id`. This is the seed of the learning loop: explicit human
judgement attached to a specific plan.

### `org_playbook_promotions`
**The "always do this" table.** A user takes a plan that worked and promotes it
into a named, reusable playbook.

| Constraint | Rule it enforces |
|---|---|
| `playbook_id LIKE 'org.%'` | Org-authored playbooks can never collide with or impersonate a platform/pack playbook |
| `UNIQUE (org_id, playbook_id)` | One definition per name per org |
| `name` length 3–80 | A playbook must be nameable by a human |
| `named_by_user_id ... ON DELETE RESTRICT` | You cannot delete the user who authored a live playbook — provenance is preserved |

This table is the foundation of customer-authored procedures. The generalisation
step (turning concrete step payloads into parameterised ones) is the part still
to build.

---

## 11. Schema-level rules to keep

1. Every new tenant table ships `ENABLE` + `FORCE` RLS and a `USING` +
   `WITH CHECK` policy **in the same migration**.
2. Grants to `darex_app` in the same migration; applications never connect as
   the owner.
3. Idempotency keys as unique indexes, not application-level checks.
4. State machines as `CHECK` constraints, so an impossible state cannot be
   written by any code path.
5. Provenance columns (`source`, `source_ref`, `content_hash`) on anything the
   brain will later cite.
6. Sensitive data classes are excluded by absence, and the absence is
   documented in the migration.
