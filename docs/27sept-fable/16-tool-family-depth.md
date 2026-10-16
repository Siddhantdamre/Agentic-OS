# 16 · Tool-family capability depth — implemented vs enterprise-expected

> ### 📊 Completion Status
>
> | Status | Count | Percentage |
> |---|:---:|:---:|
> | 🟢 **Done (Verified)** | 0 | 0.0% |
> | 🟡 **Pending / In Progress** | 0 | 0.0% |
> | 🔴 **Not Done (Open)** | 13 | 100.0% |
> | ⛔ **Blocked (Human/Infra)** | 0 | 0.0% |
> | **Total Findings** | **13** | **100.0%** |

Audit date 2026-09-27, read-only. Completes the catalog that [Audit tool families depth](44b0240f-cf9d-4000-a76b-d91a06f148e7) started before the usage-limit abort. Cross-cutting executor holes (confirm skip, no zod, no abort, no Idempotency-Key, prefix allowlist) live in `04`. This file is **per-family missing actions** so enhancement sprints have a checklist. Action names from each module's `ACTIONS` const.

**Headline.** Almost every connector is a thin slice: list/get + one write. Enterprise users of Gmail, Calendar, HubSpot, Slack, WhatsApp, Stripe, and Shopify will hit a wall in the first week. No module has zod payload schemas. Only Meta Ads paginates. Cross-cutting defaults that bite: Slack `#general` (`slack.ts:14`), Stripe `$50` / Razorpay `₹500` (`stripe.ts:161`, `razorpay.ts:34`), WhatsApp platform `META_ACCESS_TOKEN` fallback (`whatsapp.ts:71`), Gmail 401 → `[]` success (RT-B05).

Legend: **impl** = in `ACTIONS`. **missing** = expected by an enterprise admin of that product. Risk from `riskFor()`.

---

## 1. Google Workspace

| Module | Implemented | Missing (enterprise) | Honesty / tests |
|---|---|---|---|
| **gmail** | `fetch_latest_emails`, `triage_emails`, `extract_otp`, `extract_attachment`, `draft_email`, `send_email` | **search `q=`**, threads, reply-in-thread, labels, schedule send, signatures, vacation, delegates, batch modify | 401→`[]` (RT-B05); OTP into model (RT-S13); CRLF injection (RT-S06). Tests: `gmail.test.ts` |
| **google-calendar** | `list_events`, `check_availability`, `create_event`, `update_event` | delete, recurring / exceptions, rooms, working hours, conference data, timezone-aware free/busy across many calendars, attachments | no delete. Tests: `google-calendar.test.ts` |
| **google-drive** | `drive_search`, `drive_list`, `drive_get_text`, `drive_upload`, `drive_share`, `drive_create_folder` | move, comments, export (PDF/DOCX), revisions, permissions list/revoke, shared drives, watch | 401→empty (RT-B05). Tests: `google-drive.test.ts` |
| **google-docs** | `docs_create`, `docs_read`, `docs_append` | templates, suggestions, headings/structure, replace, comments | tests in `google-docs-sheets.test.ts` |
| **google-sheets** | `sheets_create`, `sheets_read`, `sheets_append_row` | batch ranges, formulas, named ranges, filter views, append-with-schema, charts | same test file |
| **google-slides** | create / add / update / delete / get | from-outline, speaker notes, theme, images | none |
| **google-forms** | `forms_get`, `forms_get_responses` | create, add questions, publish, watch | none |
| **google-chat** | `chat_list_spaces`, `chat_send_message` | threads, cards, members, DMs | none |
| **google-meet** | `meet_create_space`, `meet_get_space` | recordings, transcripts, participants, recordings download | none |
| **google-contacts** | `contacts_list` | search, create, update, groups, otherContacts | none |
| **google-tasks** | `tasks_list`, `tasks_create` | complete, lists, due recurrence | none |
| **google-cloud** | `cloud_list_projects` | anything else | none |

## 2. Marketing / ads / local

| Module | Implemented | Missing | Notes |
|---|---|---|---|
| **google-analytics** | `analytics_report` | properties list, realtime, funnels, named presets | WEB-G16 |
| **google-search-console** | sites, query (7d, dim query, 25) | inspect URL, sitemaps, country/device presets | WEB-G14 |
| **google-business-profile** | `business_list_locations` | reviews list/reply, posts, Q&A, insights, hours | WEB-G15 |
| **google-ads** | `fetch_campaign_metrics` | mutate campaigns/budgets, keywords, negatives | catalog_only vs executor (BIZ-G19); ⛔ token |
| **meta-ads** | `fetch_campaign_metrics` | create/pause ads, creatives, audiences | **only paginated tool** |

## 3. CRM / enrichment

| Module | Implemented | Missing | Notes |
|---|---|---|---|
| **hubspot** | create/update/search/list contacts, list/create/update deals, `sync_deal_schedule`, `reassign_owner` | companies, tickets, notes, tasks, sequences, associations, custom properties, merge, owners, pipelines/stages as first-class, search deals | honesty OK. Test: `hubspot-sync-deal-schedule.test.ts` |
| **salesforce** | list/create contact, create lead, list/create/update deal | SOSL, accounts, tasks, notes, custom objects, Bulk, composite | **no connect UI** (RT-E01) |
| **zoho** | same slice as Salesforce | same | no connect UI |
| **apollo** | `search_people`, `enrich_company` | org search, filters, paging, sequences | no catalog; enrich = PII (WEB-S09). Test: honesty |
| **linkedin** | `search_people`, `company_signals` | **names lie** (typeahead / admin ACL) | WEB-B14 / S07. Test: honesty |

## 4. Messaging / comms

| Module | Implemented | Missing | Notes |
|---|---|---|---|
| **slack** | `send_channel_message`, `read_channel`, `post_decision_card` | search.messages, threads, reactions, files, schedule, create/invite channel, blocks, users.lookup | default `#general`; net err → notConnected (RT-B25) |
| **whatsapp** | `send_whatsapp_message` | templates, 24h window, media, buttons/lists, flows, catalog, opt-out/STOP, mark read | CH-G01; platform token fallback (RT-S10) |
| **twilio** | `send_sms`, `list_messages` | voice, verify, messaging service, status callback | no catalog |
| **microsoft-outlook** | `list_messages`, `draft_email`, `send_email` | search, folders, reply-all, calendar overlay | no ping spec |
| **microsoft-calendar** | `list_events`, `check_availability`, `create_event` | Teams, rooms, recurring | no ping |
| **intercom** | fetch / reply / create conversation | search, tags, notes, assignments | — |
| **zendesk** | fetch / create / update ticket | macros, CSAT, SLA, side conversations, search | — |

## 5. Commerce / payments / sign

| Module | Implemented | Missing | Notes |
|---|---|---|---|
| **stripe** | payment_link, customer get/create, refund, charge | invoices, subscriptions, disputes, payouts, tax, payment_intent confirm, webhook reconcile, metadata | amount default 5000 (RT-B06); clientSecret to model (RT-S14). Test: `stripe.test.ts` |
| **razorpay** | `create_payment_link` | refunds, subscriptions, invoices, customers, settlements | amount default 50000; plaintext BYOK |
| **shopify** | fetch products/orders, `update_order_address` | fulfill, refund, inventory, discounts, customers, draft orders | Test: `shopify.test.ts` |
| **quickbooks** | list/create customer, list invoices | create invoice, bills, payments, reports, tax | no catalog |
| **docusign** | list / create / send envelope | download, void, templates, embedded sign, webhook | no catalog |
| **leegality** | list / create / send document | status, download, stamp | no catalog |
| **billing** (org) | `usage` | catalog, checkout, seat — those stay HTTP | queries `plan_key` (BIZ-B14) |

## 6. Docs / code / maps / memory / runtime

| Module | Implemented | Missing | Notes |
|---|---|---|---|
| **notion** | create page, append, `search_workspace_docs` | database query/filter, blocks, comments, permissions | — |
| **github** | `fetch_user_repos`, `create_repo`, `create_issue` | search code/issues, PRs, reviews, actions, checks, projects | — |
| **maps** | geocode, reverse | places, details, distance, directions | shared platform key (WEB-B13) |
| **cognee** | search, remember | forget, dataset delete, ACL | MEM-S03/S04 |
| **database_query** | `query` | schema inspect, EXPLAIN, read-only role | RT-B01 |
| **sandbox** | execute / terminal / python / bash | none should be core | ASK-S01; host fallback RT-B02 |
| **file-ops** | read_file, write_file | list, delete, mkdir | `orgId\|\|'default'` (RT-S15) |
| **rera** | `lookup` | multi-state portals, refresh stale | honesty strong |
| **re / mls** | listings/inquiry/showing/charges | MLS live | mls always notConnected |
| **growth / customer-ops / operations / daily_brief / metrics** | list/read slices | mutations belong in TAB-G* | — |

---

## 7. Registry drift (defs vs catalog vs allowlist vs MCP)

| Drift | Examples | Finding |
|---|---|---|
| Executor + roster, **no catalog / connect UI** | salesforce, zoho, apollo, linkedin, twilio, maps, docusign, leegality, quickbooks | RT-E01, BIZ-G20 |
| Catalog `catalog_only` but executor live | google-ads | BIZ-G19 |
| MCP name / module action mismatch risk | `file_ops` risk from `auto_execute` (RT-B23) | — |
| Allowlist prefix match | allow `stripe` → `stripe_create_charge` (RT-S18) | — |
| Core widens every card | web_search, web_extract, cognee, sandbox | ASK-S01, WEB §9 |
| `TOOLS` duplicated in mcp-bridge vs `TOOL_MODULES` | add a module in one place, forget the other | RT drift in `04` |
| Two Slack/Gmail UIs | `/connectors` and `/integrations` | BIZ dead-code |

---

## 8. Cross-cutting (do not re-fix per module)

| Gap | Every module today | Target |
|---|---|---|
| Payload schema | none (zod 0) | `def.schema.safeParse` (RT-B06) |
| Pagination | Meta Ads only | `{items,nextCursor,truncated}` (RT-G05) |
| Idempotency-Key | 0 write tools | from `sideEffectKey` (RT-B10) |
| AbortSignal | ~85 raw fetches | ctx.signal (RT-B04) |
| 401/403 | often `[]` + executed | `revoked` / `apiError` |
| 429 | unparsed | Retry-After + breaker |
| Multi-account | schema-only (`accountId:'primary'`) | BIZ-G14 |
| Act-as-user | org connector only | per-user Nango when the human is in the loop |
| Audit args | console | `tool_invocations` (RT-G06) |
| Tests | gmail, calendar, drive, docs/sheets, stripe, shopify, hubspot-sync, honesty waves, RE match/charges; **~40 modules untested** | one honesty + one happy-path per family |

---

## 9. Numbered findings (family-level; executor P0s stay in `04`)

| ID | Sev | Issue | Fix packet | Status |
|---|---|---|---|---|
| TOOL-G01 | **P0** | Gmail has no `q=` search — inbox find is last-N | with SRCH-G01 / WEB-B17 | 🟢 2026-10-05: `gmail_fetch` takes `query` (Gmail search syntax) |
| TOOL-G02 | P1 | Calendar cannot delete or do recurring/rooms | Workspace depth sprint | 🔴 |
| TOOL-G03 | P1 | HubSpot no companies/notes/tasks/pipelines | CRM depth | 🔴 |
| TOOL-G04 | P1 | Slack no search/threads | with WEB-G13 | 🔴 |
| TOOL-G05 | P1 | WhatsApp no templates/media/STOP | CH-G01 | 🔴 |
| TOOL-G06 | P1 | Stripe no invoices/subscriptions/disputes | Finance depth | 🔴 |
| TOOL-G07 | P1 | Shopify no fulfill/refund/inventory | Customer depth (EMP-G04) | 🔴 |
| TOOL-G08 | P2 | Notion no database query | Research internal | 🔴 |
| TOOL-G09 | P2 | GitHub no PR/search | — | 🔴 |
| TOOL-G10 | P1 | Salesforce/Zoho/Apollo/LinkedIn/Twilio/Maps/DocuSign/QB — no connect UI | RT-E01 | 🔴 |
| TOOL-B01 | P1 | Hardcoded money/channel defaults in stripe/razorpay/slack | RT-B06 | 🔴 |
| TOOL-S01 | P1 | Platform WhatsApp/Maps/Apollo-visitor keys used for tenants | RT-S10, WEB-S08 | 🔴 |
| TOOL-S02 | P1 | Gmail OTP + Stripe clientSecret in model context | RT-S13, S14 | 🔴 |

---

## 10. Enhancement waves (after Wave 1 executor lock-down)

Do not widen allowlists until confirm + RBAC + abort + idempotency land (`12` Wave 1.4 / 1.6 / 1.8).

1. **Find**: Gmail `q=`, Slack search, HubSpot companies, conversation/work-item search (`15`).
2. **Workspace complete**: Calendar delete/recurring, Drive export/permissions, Sheets batch, Docs structure.
3. **CRM complete**: HubSpot notes/tasks/pipelines; Salesforce/Zoho connect UI or drop from Sarah.
4. **Comms complete**: WhatsApp templates/STOP/media; Slack threads; Outlook search.
5. **Money complete**: Stripe invoices/subscriptions; Razorpay refunds; Shopify fulfill/refund; drop monetary defaults.
6. **Sign / SMS**: DocuSign download + catalog; Twilio without platform fallback.
