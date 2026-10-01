# Marcus — Marketing & Analytics

> Per-employee chat capability spec. Status legend: 🟡 code exists, not proved live · 🔴 missing / wrong / silent. No 🟢 until a live `/ask-ai` pass.

## Job

Marcus owns campaign performance, ad conversions, customer feedback signals, and market trends. Seeded allowlist: Meta Ads, Google Ads, Gmail, Google Analytics, Search Console, Business Profile. Reads ads/analytics connectors; never widens permissions beyond allowlist ∪ core ∪ connected channels after role denials. Does not own payments, refunds, or CRM deal writes.

| Field | Value | Evidence |
|---|---|---|
| Name | Marcus | `apps/dashboard/lib/employee-provision.ts` |
| Role | Marketing & Analytics | `employee-provision.ts` |
| Persona (seed text) | Data-driven marketing strategist monitoring campaign performance, ad conversions, customer feedback, and market trends. | `employee-provision.ts` |
| Seed allowlist | `meta-ads`, `google-ads`, `gmail`, `google-analytics`, `google-search-console`, `google-business-profile` | `employee-provision.ts`; backfill `113_marketing_finance_employee_tools.sql` |
| Roster key (inferred) | `ops` (no dedicated `marketing` key; marketing/analytics/marcus blob → ops) | `services/workflows/src/route-employee.ts` |
| Router prefer | ads/ROAS/campaign keywords prefer Marcus/marketing | `route-employee.ts` |

## Role-capability / EmployeePersona

`EmployeePersona` includes `'marketing' | 'finance'` (`services/workflows/src/tools/role-capability.ts`).

`normalizeEmployeePersona` maps role/name containing `marketing`, `analytics`, or `marcus` → **`marketing`** (marcus is **not** growth). Marketing denies pay tools (`stripe`, `razorpay`, …) and actions `delete` / `refund` / `create_charge` / `charge` / `payout`.

| Fact | Status | Notes |
|---|---|---|
| Seeded role `Marketing & Analytics` → marketing | 🟡 | Unit: `role-capability.test.ts` |
| `marcus` is not growth | 🟡 | Same test; growth still matches `Growth` / `sdr` only |
| Selection never widens allowlist | invariant | `mergeRuntimeAllowlist` then `filterAllowlistForPersona` |

## Persona in system prompt

`buildUnifiedSystemPrompt` injects an additive Marketing & Analytics block for Marcus (`system-prompt-builder.ts`). Hand-off rules live in `apps/dashboard/lib/handoffs/marketing-finance.ts` (`export const rules`).

## Memory scope

| Behaviour | Evidence | Status |
|---|---|---|
| Org-scoped retrieve; optional `employeeId` | `retrieve.ts` | 🟡 |
| Marketing persona budget 1600; drop conversation-tier citations | `PERSONA_TOKEN_BUDGET`, `filterCitationsForPersona` | 🟡 |
| Empty index → honest "no stored memory" | `EMPTY_MEMORY_BLOCK` | 🟡 |

## Allowlist vs provision

| Layer | What Marcus gets |
|---|---|
| Seed | meta-ads, google-ads, gmail, google-analytics, google-search-console, google-business-profile |
| Runtime merge | + always-allowed core + org **connected** channels |
| Role denial | Applied after merge when persona = marketing |

## Capabilities

| Capability | Example chat message | Tool(s) | Simple or plan | Approval? | Status | Evidence |
|---|---|---|---|---|---|---|
| Google Ads metrics | "Pull Google Ads performance for the last 7 days" | `google-ads` / `google_ads_metrics` | simple/complex | no (read) | 🟡 executor returns notConnected naming `GOOGLE_ADS_DEVELOPER_TOKEN` when missing — never fake metrics | `tools/google-ads.ts` |
| Meta Ads metrics | "Show Meta Ads ROAS / spend last week" | `meta-ads` | simple/complex | no | 🟡 code; OAuth human-only | `tools/meta-ads.ts` |
| Google Analytics (GA4) | "Run a GA4 report for property X" | `google-analytics` / `analytics_report` | complex preferred | no | 🟡 on seed allowlist | provision + defs |
| Search Console | "List Search Console sites" | `google-search-console` | complex preferred | no | 🟡 on seed allowlist | provision + defs |
| Business Profile | "List Google Business Profile locations" | `google-business-profile` | complex preferred | no | 🟡 on seed allowlist | provision + defs |
| Gmail | "Draft a reply to this ad-lead email" | `gmail` | complex for send | **yes** for send | 🟡 | provision |

## Hand-offs

| Request | Hand off to | Why | Status |
|---|---|---|---|
| Payment link / charge / invoice | Finance | Marketing does not send payment links | 🟡 `handoffs/marketing-finance.ts` |
| CRM reconciliation / dedup | Operations | Not Marketing's job | 🟡 same |
| Refund / return | Customer | Refunds belong to Customer | 🟡 router + Finance rule |

## Human-only blockers

| Blocker | Affects |
|---|---|
| Meta OAuth client ID/secret in Nango UI | Meta Ads live connect |
| Google OAuth + `GOOGLE_ADS_DEVELOPER_TOKEN` | Google Ads (notConnected until token) |
| Google OAuth for GA / Search Console / Business Profile | Those reads |

## Live Resolution Tracker

| # | Gap | Priority | Status | Evidence |
|---|---|---|---|---|
| 1 | Seed role `Marketing & Analytics` → marketing persona (not growth / not null) | P1 | 🟡 | `role-capability.ts` + unit tests |
| 2 | GA / Search Console / Business Profile on seed allowlist | P1 | 🟡 | provision + migration 113 |
| 3 | Google Ads catalog_only without developer token | P0 | 🔴 Blocked (human) | executor names `GOOGLE_ADS_DEVELOPER_TOKEN` |
| 4 | Meta Ads OAuth client IDs | P0 | 🔴 Blocked (human) | catalog operatorHint |
| 5 | No live `/ask-ai` proof for any row | P0 | 🔴 | — |
| 6 | Crew cap 3 | P1 | 🟡 | code caps at 3: `MAX_CREW_SPAWN = 3` (`packages/shared-types/src/crew.ts`, `crew-contract.ts`), `ASK_TEAM_MAX = 3` (`ask-mode.ts`); live crew proof pending |
| 7 | Additive Marketing system-prompt block + handoff rules file | P1 | 🟡 | `system-prompt-builder.ts`, `handoffs/marketing-finance.ts` |
