# 08 · Billing & metering, plans, packs & skills, onboarding, settings, connectors

> ### 📊 Completion Status
>
> | Status | Count | Percentage |
> |---|:---:|:---:|
> | 🟢 **Done (Verified)** | 1 | 1.4% |
> | 🟡 **Pending / In Progress** | 3 | 4.1% |
> | 🔴 **Not Done (Open)** | 69 | 94.5% |
> | ⛔ **Blocked (Human/Infra)** | 0 | 0.0% |
> | **Total Findings** | **73** | **100.0%** |

Audit date 2026-09-27, read-only. Scope: `apps/dashboard/app/api/billing/**` (`_lib.ts` ~2,200 lines), `(dashboard)/billing`, `lib/{usage-gate,org-cost}.ts`, `wf/{usage-gate,cost/**,tools/billing}.ts`, migrations `017/104/116/120`, `api/packs/**`, `api/skills/**`, `wf/packs/**`, `wf/skills/**`, `api/onboarding/**`, `lib/{onboarding-cold-start,employee-provision,onboarding-observation-query}.ts`, `(onboarding)/**`, `api/settings/**`, `api/integrations/**`, `api/nango/**`, `lib/{nango-client,nango-server,oauth-providers,connector-registry,integrations-catalog}.ts`, `services/connectors/**`. Docs: `gap26sept/{billing,packs,skills,onboarding,settings,autonomy,integrations-connectors,connectors}.md`, `saas-conversion/04-billing-plans.md`, `new-109-pg-plan/payment/payment-pans.md`.

**Headline.** Stripe and Razorpay checkout / portal / webhooks / dunning are real and signed. But: usage caps only trip when someone opens `/billing` (no scheduled meter refresh); LLM cost is traced only from dashboard routes, so webhook / Temporal / sweep spend is unmetered; **`orgs.plan` gates nothing** (free = enterprise); Stripe seat add-on and portal plan changes desync `billing_subscriptions`; pack `upgrade` clobbers the default roster; skill PATCH strips pack tools from employees; BYOK tokens stored plaintext; connector connect/disconnect has **no RBAC**; the intended pricing model (Scale tier, credits/DWC, annual, INR/USD) is unimplemented.

---

## 1. Billing reality

### 1.1 Plan catalog — code vs intended

| Dimension | Code | Intended (`payment-pans.md`) |
|---|---|---|
| Plan keys | `free / starter / growth / enterprise` (`017:21-24`, `_lib.ts:47`) | Free Pilot 14-day, Starter $99, Growth $299, **Scale $799**, Enterprise $2,499+ (`:127-133,152-198`) |
| Prices | env `DAREX_PLAN_*_AMOUNT_CENTS`, `null` when unset (`_lib.ts:209-222`); `.env.example:141-146` blank | Fixed USD + INR, annual discount |
| Currency | one `DAREX_PLAN_CURRENCY`; `catalogPlans()` defaults `usd` regardless of provider (`_lib.ts:194-207,485-493`) | USD/Stripe, INR/Razorpay |
| **Per-plan limits** | **None.** `orgs.plan` read only for display (`billing/route.ts:45`, `admin/page.tsx:278`) | 1/3/all employees, credits per tier, 3/10/25 seats |
| Annual | not found | yes |
| Trial | no `trial_period_days` (`_lib.ts:1661-1679,1734-1741`) | 14-day |
| Credits (DWC) | not found | 1 DWC = 1 action / 1k tokens (`:215-228`) |
| Seats add-on | `DAREX_STRIPE_PRICE_ADDON_SEAT` line item (`_lib.ts:1674-1679`); Razorpay `quantity` | $15/seat |
| Tax / GST | not found | — |

### 1.2 Meters

| Kind (`017:150-158`) | Source | Computed | Period |
|---|---|---|---|
| `llm_tokens` (usd) | Langfuse traces `userId=orgId` (`org-cost.ts:223-266,312-318`) | `refreshOrgMeters` (`_lib.ts:1123`) | rolling 7 d |
| `whatsapp_conversations` | `COUNT(conversations)` on whatsapp channel (`_lib.ts:1089-1100`) | same | rolling 7 d |
| `seats` | `COUNT(users)` (`_lib.ts:1102-1106`) | same | snapshot |
| `successful_actions` / `disconnected_actions` | Langfuse tag classification (`org-cost.ts:136-158`) | same | 7 d |
| `embeddings` | in CHECK, **never written** | — | — |
| `org_model_spend` (`029:28`) | `recordModelSpend` (`wf/cost/track.ts:33`) | **no callers** | dead |

### 1.3 Where meters increment vs where caps are enforced

| Path | Traced to Langfuse | `assertUsageAllowed` |
|---|---|---|
| Ask AI | ✅ | ✅ (`ask-ai/route.ts:352`, `execute:87`) |
| `/api/agent/run`, `/crew` | ✅ | **❌** |
| Tool executor | n/a | ✅ (`tool-executor.ts:231-245`) |
| WhatsApp / Chatwoot / IG / SMS webhooks → Temporal | **❌** (`local-turn.ts:245`) | **❌** |
| Periodic sweeps, memory writeback, embed | ❌ | only tool steps |
| **Meter refresh trigger** | `GET /api/billing` (`billing/route.ts:53`), `GET /api/billing/meters` (`:24`) — **no cron/Temporal** | |

Cap semantics: `usageBlocked = llm.overHard || whatsapp.overHard` (`_lib.ts:1280`); gate reads latest `billing_meters` row (`wf/usage-gate.ts:147-182`), **fails open** on DB error (`:199-206`); soft caps set a flag only, no alert.

### 1.4 PSP flows

| Flow | Stripe | Razorpay |
|---|---|---|
| Checkout | Session, customer first (`_lib.ts:1637-1691`) | Subscription + `short_url`, `total_count:120` (`:1709-1753`) |
| Portal | hosted (`:1693-1707`) | in-app payload (`portal/route.ts:175-191`) |
| Change / proration | `create_prorations` (`:1871-1882`) | `schedule_change_at:'now'`, no proration (`:1901-1923`) |
| Cancel | period end / immediate (`:1767-1806`) | `cancel_at_cycle_end` (`:1807-1824`) |
| Signature | HMAC `t.body` 300 s timing-safe (`:564-582`) | HMAC body (`:584-588`) |
| Dedupe | `billing_claim_webhook_event` (`017:274-291`); 5xx releases claim (`webhooks/billing:99-111`) | same; fallback id `${event}:${entityId}` (`:26-37`) |
| Events | checkout.completed, sub.updated/deleted, invoice.paid/failed/finalized (`:640-657`) | activated/authenticated/charged/pending/halted/cancelled, payment.failed (`:668-685`) |
| Refunds / disputes | **ignored** | ignored |
| Dunning | `applyDunningState` (`:1365-1485`): grace 7 d → `past_due` → `suspended` + plan free; **evaluated only inside a webhook handler** (`:1405`), no sweep | mirrored |
| RBAC | owner/admin/billing for mutations (`:144-172`); GET open to all | same |

## 2. Connector provider table (summary)

Connection id always `${orgId}_${provider}` (`nango-server.ts:232-234`); `accountId:'primary'` hardcoded; `upsertOrgConnector` never writes `account_id` (`connector-registry.ts:486-515`) despite `098` — **multi-account is schema-only**. Health check is manual POST only (`[provider]/ping`); no background sweep touches `health_status`. Nango webhook is log-only (`webhooks/nango/route.ts:14-16,52-66`) so revocations never demote a channel. Scopes stored are the static catalog list, never granted scopes (`integrations/route.ts:301`). `NEXT_PUBLIC_NANGO_PUBLIC_KEY` required for the popup; `oauthConfigured=false` + reason rendered (`connectors/page.tsx:54-55,190`). No client IDs are committed — all human-pasted in Nango UI.

| Provider group | Catalog | Auth | Connect path | BYOK | Executor | Ping spec |
|---|---|---|---|---|---|---|
| whatsapp | `:73` | byok | Graph-verified route | yes, **plaintext** (`whatsapp/route.ts:35`) | ✅ | route |
| gmail, google-calendar, drive/docs/sheets/slides/forms, chat/meet/contacts/tasks, GA/GSC/GBP/cloud | `:99-567` | oauth | Nango popup + `nango-token` | no | ✅ | `providers.ts:79-94` |
| google-ads | `:140` | oauth | same + `customerId` | no | ✅ file exists but catalog says `executorStatus:'catalog_only'` — contradiction | `:88` |
| meta-ads, hubspot, stripe (org tool), notion, slack, shopify, zendesk, intercom, github | `:161-326` | oauth | same | no | ✅ | `:95-107` |
| razorpay (org tool) | `:344` | api_key | pinged route | yes, **plaintext** (`razorpay/route.ts:41-43`) | ✅ | route |
| quickbooks, microsoft-outlook, microsoft-calendar | `:570-611` | oauth | same | no | ✅ | **none** |
| **salesforce, zoho-crm, apollo, linkedin, twilio, maps, docusign, leegality** | **not in catalog** | — | **no UI path** | — | ✅ executors exist and are in roster allowlists (`employee-provision.ts:130,208`) | none |

## 3. Bugs

| ID | Sev | Where | What happens | Fix sketch | Status |
|---|---|---|---|---|---|
| BIZ-B01 | **P0** | `_lib.ts:1074`, `billing/route.ts:53`, `meters/route.ts:24`; `wf/usage-gate.ts:147-182` | Meters refreshed only when a user opens `/billing`; worker gate reads stale rows → hard caps never trip for an org nobody looks at. | Temporal cron `refreshOrgMeters` per org + refresh on webhook ingress. | 🔴 |
| BIZ-B02 | **P0** | `local-turn.ts:245`; `langfuse-trace.ts:208` only from ask-ai/agent routes | Webhook, crew, sweep, writeback LLM cost never traced with `userId=orgId`; `org_model_spend` 0 callers. Only the chat surface is metered. | Record spend at LiteLLM boundary for every call; gate reads that table. | 🔴 |
| BIZ-B03 | **P0** | `_lib.ts:1986,2020,1674-1679` | Seat add-on: checkout sends base qty 1 + addon qty seats-1; `checkout.session.completed` reads `data.quantity` (does not exist) → fallback; `sub.updated` reads `items.data[0].quantity` = 1. **Purchased seats collapse to 1**, invites then blocked. | Sum quantities across items by price id. | 🔴 |
| BIZ-B04 | P1 | `_lib.ts:2012,1983` | Plan from `metadata.darex_plan`; portal plan switch keeps stale metadata → wrong `plan_key`. | Resolve from `price.id`. | 🔴 |
| BIZ-B05 | P1 | `checkout/route.ts:78-90` | "Modify in place" only checks same provider → Stripe + Razorpay double subscription. | Block when any provider active. | 🔴 |
| BIZ-B06 | P1 | `_lib.ts:937-939` | Cancel on one provider sets `plan='free'` even if other provider active. | Recompute across rows. | 🔴 |
| BIZ-B07 | P1 | `_lib.ts:1405-1429` | Dunning grace expiry evaluated only on another past_due webhook; Stripe Smart Retries stop → org `past_due` on paid plan forever. | Daily sweep. | 🔴 |
| BIZ-B08 | P1 | `_lib.ts:1562-1625`, `settings/route.ts:211-231` | `checkSeatAvailability` counts `users` only — pending invites uncounted, no lock → seat cap bypassable; memberships (097) not counted. | Count users + open invites; `FOR UPDATE`. | 🔴 |
| BIZ-B09 | P1 | `skills/[id]/route.ts:63-65` | `syncEmployeeAllowlist` strips every tool owned by *any* skill and re-adds only assigned skills' tools → PATCHing one skill removes `gmail`, `whatsapp`, `hubspot`. | Remove only the changed skill's tools. | 🔴 |
| BIZ-B10 | P1 | `install-pack.ts:55-72`; `employee-provision.ts:127-153` vs `manifests.ts:10-28` | `core-b2b` install skips default roster by name; `action=upgrade` treats `pack_id IS NULL` as upgradable and **overwrites role/persona/allowlist** (Marcus: Marketing → "Ops / analyst"). | Upgrade only `pack_id = packId`. | 🔴 |
| BIZ-B11 | P1 | `install-pack.ts:14,249,359` | `installed_version` always constant `'1.0.0'`; upgrade is a no-diff reapply. | Persist `manifest.version`. | 🔴 |
| BIZ-B12 | P1 | `manifests.ts:100` vs `packs/re-brokerage-in/pack.yaml:7` (`live:false`) vs `015:409` (`true`); `pack-recommendations.ts:24` | Three sources disagree on whether `real-estate-brokerage` is live. | Single source; generate TS from YAML. | 🔴 |
| BIZ-B13 | P1 | `settings/autonomy/route.ts:119-122` vs `023:280-282` | PATCH accepts `reversible|irreversible`; a `visible` rule is silently downgraded when the UI echoes it. | Accept `visible`. | 🔴 |
| BIZ-B14 | P2 | `wf/tools/billing.ts:68-70` | Queries `plan_key FROM orgs`; column is `plan`. Error swallowed → null in chat. | Fix column. | 🔴 |
| BIZ-B15 | P2 | `webhooks/billing/route.ts:26-37` | Razorpay fallback event id identical for every monthly `subscription.charged` → month 2+ dropped as duplicate if header absent. | Include `payment.entity.id`. | 🔴 |
| BIZ-B16 | P2 | `_lib.ts:485-493` | Razorpay INR plans render as USD (`billing/page.tsx:404`). | Per-provider currency. | 🔴 |
| BIZ-B17 | P2 | `_lib.ts:1076-1078`, `017:163` | Rolling 7-day window → one new meter row per kind per day, never pruned; not cycle-aligned; UTC. | Cycle-aligned; prune. | 🔴 |
| BIZ-B18 | P2 | `_lib.ts:1123-1130`; `org-cost.ts:231-266` | `GET /api/billing` fans out to Langfuse (≤20 pages) and writes 5 rows on every page load. | Cache / cron. | 🔴 |
| BIZ-B19 | P2 | `017:166` | Only `idx_billing_meters_org_id`; gate `DISTINCT ON … ORDER BY period_end DESC` scans. | Index `(org_id, meter_kind, period_end DESC)`. | 🔴 |
| BIZ-B20 | P2 | `_lib.ts:1349` | Warning references `093_billing_packs_gaps.sql`; file is `104_*`. | Fix. | 🔴 |
| BIZ-B21 | P2 | `install-pack.ts:410-444`; `packs/route.ts:232` | Uninstall never checks installed, no transaction, no cascade to `extends`, leaves SOP `org_memory`. | Guard + cascade. | 🔴 |
| BIZ-B22 | P2 | `packs/[id]/config/route.ts:35-37` | Config arbitrary JSON, no schema/size cap; UI via `window.prompt`. | JSON schema per pack. | 🔴 |
| BIZ-B23 | P2 | `onboarding/backfill/route.ts:50-65` | Backfill inline in request holding a pool client; two POSTs → two `running` jobs. | Temporal; unique partial index. | 🔴 |
| BIZ-B24 | P2 | `onboarding/settings/route.ts:59-62` | Timezone validated by length only; `isValidIanaTimezone` unused. | Call validator. | 🔴 |
| BIZ-B25 | P2 | `auth/[[...path]]:321` vs `:368` | SuperTokens signup path forces invitees to `member`; fallback honours `invite.role`. | Use `invite.role` in both. | 🔴 |
| BIZ-B26 | P2 | `org/create/route.ts:97-101` | `channels[]` unvalidated against catalog; `teamSize` unbounded. | Validate. | 🔴 |
| BIZ-B27 | P2 | `integrations/route.ts:104-125` | Nango unreachable → `[]` → every provider shows "create it in Nango UI". | Distinguish unreachable vs empty. | 🔴 |

## 4. Security / RBAC

| ID | Sev | Where | Issue |
|---|---|---|---|
| BIZ-S01 | **P0** | `integrations/whatsapp/route.ts:35`, `integrations/razorpay/route.ts:41-43` | Meta token and Razorpay secret **plaintext** in `channels.meta`; no encryption anywhere (`rg encrypt|pgp_sym|kms` → 0 in this path). |
| BIZ-S02 | **P0** | `integrations/route.ts:228-232`, `nango-token:64-66`, `whatsapp:6`, `razorpay:14`, `integrations/test:44`, `[provider]/ping:12` | **No RBAC** on connect / disconnect / BYOK / `update_config` / test / ping — any `member` or `auditor` can revoke the org's Gmail or paste their own Razorpay keys. |
| BIZ-S03 | P1 | `integrations/route.ts:460-475` | `update_config` writes `channels.meta` with no audit and no RBAC. |
| BIZ-S05 | P1 | `settings/suppressions/route.ts:106-116` | Fallback `UPDATE org_preferences … rules || {"dismissed":true}` by client-supplied `id`; no audit. |
| BIZ-S06 | P1 | `settings/members/[id]/route.ts:42` | Hard delete `users`; no session revocation (platform has `revoke-sessions`, settings does not). |
| BIZ-S07 | P1 | `onboarding/observation/route.ts:12` | GET has write side effects, any role. |
| BIZ-S08 | P2 | `auth/[[...path]]:283-403` | No email verification at signup. |
| BIZ-S09 | P2 | `webhooks/billing:61` | No body-size cap / per-IP limit. |
| BIZ-S10 | P2 | `webhooks/nango:43-50` | Unresolvable ids acked 200 silently. |
| BIZ-S11 | P2 | `integrations/route.ts:301`, `nango-token:147` | Requested scopes persisted, not granted → least-privilege unauditable. |

| ID | Sev | Where | Issue | Status |
|---|---|---|---|---|
| BIZ-S01 | **P0** | `integrations/whatsapp/route.ts:35`, `integrations/razorpay/route.ts:41-43` | Meta token and Razorpay secret **plaintext** in `channels.meta`; no encryption anywhere (`rg encrypt|pgp_sym|kms` → 0 in this path). (2026-09-28: verified still real, unchanged — same as `RT-S04`. This needs a KMS/encryption-key **product decision** [which KMS, key rotation, envelope vs. column encryption] before code can close it; not something to fix as a pure app-code change.) | 🟢 2026-10-05: WhatsApp token and Razorpay key secret sealed (AES-256-GCM, `CHANNEL_SECRETS_KEY`); backfill `infra/scripts/seal-*.js` |
| BIZ-S02 | **P0** | `integrations/route.ts:228-232`, `nango-token:64-66`, `whatsapp:6`, `razorpay:14`, `integrations/test:44`, `[provider]/ping:12` | **No RBAC** on connect / disconnect / BYOK / `update_config` / test / ping — any `member` or `auditor` can revoke the org's Gmail or paste their own Razorpay keys. | 🔴 |
| BIZ-S03 | P1 | `integrations/route.ts:460-475` | `update_config` writes `channels.meta` with no audit and no RBAC. | 🔴 |
| BIZ-S04 | P1 | `billing/route.ts:44`, `meters/route.ts:20` | Any role reads invoices, customer ids, subscription ids, billing audit. | 🔴 |
| BIZ-S05 | P1 | `settings/suppressions/route.ts:106-116` | Fallback `UPDATE org_preferences … rules || {"dismissed":true}` by client-supplied `id`; no audit. | 🔴 |
| BIZ-S06 | P1 | `settings/members/[id]/route.ts:42` | Hard delete `users`; no session revocation (platform has `revoke-sessions`, settings does not). | 🔴 |
| BIZ-S07 | P1 | `onboarding/observation/route.ts:12` | GET has write side effects, any role. | 🔴 |
| BIZ-S08 | P2 | `auth/[[...path]]:283-403` | No email verification at signup. | 🔴 |
| BIZ-S09 | P2 | `webhooks/billing:61` | No body-size cap / per-IP limit. | 🔴 |
| BIZ-S10 | P2 | `webhooks/nango:43-50` | Unresolvable ids acked 200 silently. | 🔴 |
| BIZ-S11 | P2 | `integrations/route.ts:301`, `nango-token:147` | Requested scopes persisted, not granted → least-privilege unauditable. | 🔴 |

## 5. Functional gaps

| ID | Sev | Gap | Evidence | Status |
|---|---|---|---|---|
| BIZ-G01 | **P0** | `orgs.plan` gates nothing: free orgs get 9 employees, crews, all tools, same caps as enterprise | `employee-provision.ts:104-187` seeded for every org | 🔴 |
| BIZ-G02 | **P0** | No credit/DWC ledger; intended pricing unimplementable on current meters | `payment-pans.md:215-228` vs `017:150-158` | 🔴 |
| BIZ-G03 | P1 | No Scale tier, annual price ids, INR/USD dual catalog | `BILLING_PLAN_TYPES` 3 keys | 🔴 |
| BIZ-G04 | P1 | No trial initiated by Darex | `_lib.ts:1661-1679` | 🔴 |
| BIZ-G05 | P1 | Refunds, disputes, `invoice.upcoming`, `trial_will_end`, `payment_method.*` ignored | `_lib.ts:640-657` | 🔴 |
| BIZ-G06 | P1 | Soft-cap alerts computed, never dispatched | `_lib.ts:1054-1062` | 🔴 |
| BIZ-G07 | P1 | Removing members never reduces PSP quantity; no seats used-vs-purchased reconciliation | `members/[id]:42` | 🔴 |
| BIZ-G08 | P1 | **Skills runtime is not wired**: `org_skills.enabled`, `custom_prompt_overlay`, `config` written by API, **never read by the worker** | `rg org_skills|custom_prompt_overlay` outside `api/skills` → 0 | 🔴 |
| BIZ-G09 | P1 | Pack manifests: TS hand-mirrors YAML; no parser/schema; `entitySchemas:[]`; `workflows[]` never scheduled on install | `manifests.ts:1-5,68-71,89-92`; `install-pack.ts:174-276` | 🔴 |
| BIZ-G10 | P1 | `InstallPackWorkflow` registered, no caller; dashboard installs synchronously | `workflows/index.ts:21`; `org/create:39` | 🔴 |
| BIZ-G11 | P1 | Onboarding resumability: `wizard_step` written only at create and settings PATCH (wrong step) | `org/create:104-118`; `onboarding/settings:75` | 🔴 |
| BIZ-G12 | P1 | Stranger→first-value: 4-page wizard → roster+packs → channels `pending` → **no guided OAuth step**; first reply needs a connected channel; no demo/sandbox data | `(onboarding)/*`, `org/create:97-101` | 🔴 |
| BIZ-G13 | P1 | Notification prefs and quiet hours: not found (`rg quiet_hours|notification_pref` → 0); `business_hours` not consumed by outbound | `org_onboarding.business_hours` | 🔴 |
| BIZ-G14 | P1 | Multi-account per provider schema-only | `nango-server.ts:232` | 🔴 |
| BIZ-G15 | P1 | Proactive connection health: manual only; Nango webhook does nothing; no re-auth email | `[provider]/ping`, `webhooks/nango:14-16` | 🔴 |
| BIZ-G16 | P2 | Marketplace: hardcoded TS map; uninstall pauses employees only | `manifests.ts:55`, `install-pack.ts:430-437` | 🔴 |
| BIZ-G17 | P2 | Autonomy: no create-rule form, confidence/reversibility editing | `autonomy.md:11` | 🔴 |
| BIZ-G18 | P2 | Settings audit gaps (suppressions DELETE, `update_config`) | S03/S05 | 🔴 |
| BIZ-G19 | P2 | `google-ads` `catalog_only` while executor + ping exist | `integrations-catalog.ts:140-157` | 🔴 |
| BIZ-G20 | P2 | 8 executors with no catalog entry appear in roster allowlists | `employee-provision.ts:130,208` | 🔴 |

## 6. Enterprise readiness

| ID | Feature | Status | Evidence |
|---|---|---|---|
| BIZ-E01 | Per-org SSO (SAML/OIDC) | 🔴 | social OAuth + one global SSO client (`oauth-providers.ts:1`; see SEC-A05) |
| BIZ-E02 | Audit export / retention SLA | 🟡 | `billing_audit_log` capped 25 in UI; no export |
| BIZ-E03 | Invoicing / PO / net-30 | 🔴 | card-only |
| BIZ-E04 | Annual contracts | 🔴 |  |
| BIZ-E05 | Seat pooling across orgs | 🔴 | seats per `users.org_id` |
| BIZ-E06 | Usage alerts / spend limits | 🔴 | hard cap only; `org_cost_ceilings.max_spend_cents_per_day` never fed |
| BIZ-E07 | Cost-center tags / per-employee budgets / chargeback | 🔴 | no employee id in cost attribution |
| BIZ-E08 | Platform overrides (caps, seat cap, flags) | 🟡 | `120`; flags readable, **not consumed by product code** |
| BIZ-E09 | Support access opt-in | 🟢 | `settings/route.ts:344-392` |
| BIZ-E10 | Kill switch / suspension | 🟡 | `116`, dunning, platform route |
| BIZ-E11 | White-label / custom domains | 🔴 | single origin |
| BIZ-E12 | Residency / region-specific PSP | 🔴 |  |
| BIZ-E13 | Tax compliance (GST/VAT invoices, tax ids) | 🔴 |  |
| BIZ-E14 | Procurement docs (DPA, SOC2, questionnaire) | 🔴 | see 11 |
| BIZ-E15 | Secrets at rest for BYOK | 🔴 | S01 |

## 7. Dead / duplicate

- `usage-gate.ts.aside` committed at repo root — stale copy.
- `ONBOARDING.md` (untracked, root) — an AI-assistant onboarding template with "Claude" instructions; **must not be committed** (`CLAUDE.md §1`); unrelated to product onboarding.
- `wf/cost/track.ts:33-90` `recordModelSpend` / `recordIdleSweepPass` — no callers.
- `LIVE_PACK_IDS` triplicated: `manifests.ts:100`, `pack-recommendations.ts:24`, `packs/page.tsx:173`.
- `InstallPackWorkflow` + `installPackActivity` — never started.
- Two connector UIs (`/connectors`, `/integrations`) both in nav.
- `api/packs/install/route.ts`, `packs/listings/route.ts` — re-export aliases.
- `isValidIanaTimezone`, `parseBusinessHour`, `toRolloutWeekViews` — exported, unused.
- `embeddings` meter kind never populated; `ai_employees.pack_id` unattributed for default roster.

## 8. Test coverage

| Area | Present | Missing |
|---|---|---|
| Billing RBAC | `rbac-billing.test.ts` (matrix) | `verifyStripeSignature`, `verifyRazorpaySignature`, `processStripeEvent`, `processRazorpayEvent`, `upsertSubscription`, `applyDunningState`, `checkSeatAvailability`, `refreshOrgMeters`, webhook claim/release — **0 tests** |
| Usage gate | none | hard-cap reasons, override precedence, fail-open |
| Cost budget | `cost/budget.test.ts` (not in script) | `track.ts` |
| Packs | none | install idempotency, extends chain, upgrade clobber (B10), uninstall |
| Skills | `skills/catalog.test.ts` (not in script) | `syncEmployeeAllowlist` (B09) |
| Onboarding | `onboarding-cold-start.test.ts` (pure) | `org/create`, backfill, observation |
| Settings/Autonomy | `AutonomySettings.test.tsx` | autonomy PATCH, suppressions DELETE, members, invite seat path |
| Connectors | `connector-signin`, `ask-oauth-tools`; tool tests gmail/calendar/drive/shopify/stripe | `integrations/route.ts` connect/disconnect, `nango-token` tenant check, `listNangoConfigs`, ping, Nango webhook |

Docs vs code: `billing.md:10` 🟢 "usageBlocked enforced" true only for ask-ai/tool-executor and only after a page view; `integrations-connectors.md:12` 🟢 multi-account is schema-only; `:13` 🟢 proactive health is manual; `packs.md:14` 🟢 upgrade engine has clobber bug; `skills.md:9` 🟢 toggles persisted but not honoured at runtime.

## 9. Fix order for this domain

1. **BIZ-S02 / S01 / S03** — RBAC (`canManageOrgSettings`) + audit on every connector route; encrypt BYOK at rest.
2. **BIZ-B01 / B02** — Temporal cron `refreshOrgMeters`; spend recorded at the LiteLLM boundary for every path (pairs with RT-G01, OPS-B02); fail-closed gate.
3. **BIZ-B03 / B04 / B05 / B06 / B08** — subscription integrity: seat quantities by price id, plan from price id, one live subscription, seat count incl. invites with lock.
4. **BIZ-G01** — plan entitlements table (`plan_limits`: employees, seats, tools, crews, memory MB, channels) enforced at provision, invite, tool-executor, crew start; free tier actually free.
5. **BIZ-B07 / G06** — dunning + soft-cap sweep with customer email.
6. **BIZ-B09 / B10 / B11 / B12 / G08 / G09** — skills honoured at runtime; pack upgrade scoped to `pack_id`; manifest from YAML with schema; version persisted.
7. **BIZ-G12 / G11** — onboarding: guided OAuth step, per-step persistence, demo data, "first reply" measured.
8. **BIZ-G14 / G15** — multi-account per provider; scheduled ping + Nango webhook → demote + re-auth email.
9. **BIZ-G02 / G03 / G04 / G05** — credits ledger, Scale tier, annual, trials, refunds/disputes.
10. **BIZ-E03 / E06 / E07 / E13** — invoicing/PO, usage alerts, per-employee budgets, tax fields.

## 10. Resolution tracker

`🟡` = typechecked + unit/route-tested, not proven against a live stack. `⛔` = needs a human input (reason given). `🔴` = open.

| ID | Status | Fix / verification |
|---|---|---|
| BIZ-S02 | 🟡 | `lib/connector-rbac.ts` `denyUnlessConnectorManager` (owner/admin) on `POST /api/integrations` (connect/disconnect/update_config), `whatsapp`, `razorpay`, `test`, `webhooks`, `nango-token` POST, `[provider]/ping`. `connector-rbac.test.ts`: auditor disconnect → 403 with zero writes. |
| BIZ-S03 | 🟡 | `update_config` now RBAC-gated and emits `settings.update` audit with the changed keys; WhatsApp/Razorpay BYOK connects emit `connector.connect`. |
| BIZ-S04 | 🟡 | `GET /api/billing` returns invoices, PSP customer/subscription ids and billing audit only to owner/admin/billing (`canManageBilling`); other roles get plan + meters. |
| BIZ-B01 | 🟡 | `BillingSweepWorkflow` (singleton id `billing-sweep`, started at worker boot, every `DAREX_BILLING_SWEEP_MINUTES`=15) runs `refreshAllOrgMetersActivity` → `wf/billing/meter-refresh.ts` writes whatsapp/seats/llm meters for every non-deleted org; llm from `org_model_spend` (OPS-owned writer), monotonic vs the Langfuse row. `wf/usage-gate.ts` now **fails closed** (`gate_unavailable`) on meter read errors; missing table still allows; `DAREX_USAGE_GATE_FAIL_OPEN=true` dev escape. Migration 140. `meter-refresh.test.ts` (10 tests). |
| BIZ-B19 | 🟡 | Migration 140 adds `(org_id, meter_kind, period_end DESC, period_start DESC)` index for the gate lookup. |
| BIZ-B03 | 🟡 | `_stripe-items.ts` `summarizeStripeItems` sums base-plan + seat add-on quantities by price id; `checkout.session.completed` reads the subscription items from Stripe (fallback `metadata.darex_seats`, now written at checkout); `sub.updated/deleted` read `data.items`. Tested: 1 base + 9 add-on → 10 seats. |
| BIZ-B04 | 🟡 | Plan resolved from the price id (Stripe) / `plan_id` (Razorpay `razorpayPlanKeyFromPlanId`) before metadata/notes; stale `darex_plan` metadata no longer wins. Tested. |
| BIZ-B05 | 🟡 | Checkout returns 409 `SUBSCRIPTION_EXISTS_ON_OTHER_PROVIDER` when another provider holds a live/past_due paid subscription (`otherLiveProvider`). Tested. |
| BIZ-B06 | 🟡 | `upsertSubscription` derives `orgs.plan` from every provider row (`resolveOrgPlan`: highest live plan; unchanged while a row is past_due/incomplete; free only when nothing live). Tested. Dunning suspension still sets free directly (single-provider assumption). |
| BIZ-B08 | 🟡 | Seats in use = users ∪ `organization_memberships` + open unexpired invites for non-members; invite path runs check + write in one transaction under `pg_advisory_xact_lock` (`reserveInviteSeat`). Tested: full → 402 + ROLLBACK, free → COMMIT, resend does not consume. |
