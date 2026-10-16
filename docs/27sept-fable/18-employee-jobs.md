# 18 · Employee jobs — what each employee does when the product works

> ### 📊 Master Audit Completion Status
>
> | Status | Count | Percentage |
> |---|:---:|:---:|
> | 🟢 **Done (Verified)** | 20 | 3.3% |
> | 🟡 **Pending / In Progress** | 42 | 7.0% |
> | 🔴 **Not Done (Open)** | 538 | 89.5% |
> | ⛔ **Blocked (Human/Infra)** | 1 | 0.2% |
> | **Total Findings** | **601** | **100.0%** |

Audit date 2026-09-27. File `03` is the bug list. This file is the job each employee must be able to finish from `/ask-ai` and, where noted, on a schedule with nobody watching. Every external action goes through `17-one-turn-contract.md` §2. Picking an employee never widens its allowlist.

Seed cards are `DEFAULT_EMPLOYEE_ROSTER` in `apps/dashboard/lib/employee-provision.ts:104-187`. Core-read tools (`web_search`, `web_extract`, `cognee_search`, read-only `database_query`, `metrics`) are added by the turn contract §3. Sandbox, terminal, and `cognee_remember` are not.

**Roster key** lives in persona JSON (`rosterKey`), never inferred from the employee's name (EMP-B09). Routing uses phrase patterns, not bare `drive` / `lead` / `sheets` / `returns` (EMP-B04).

**Delegation** is a tool, `delegate_to_employee({employeeId, task, contextRefs[]})`, not a paragraph. It creates a work item assigned to the target, copies the cited tool results, and the target's reply is posted back on the same thread (EMP-G07, ASK-G06). The target still uses its own allowlist.

**Shared done rule.** For each proving prompt: the named employee is who the routing line shows, the tools listed are the only ones called, a write returns `pending_approval` with a one-line summary of the real arguments, and a reload shows the same result. Empty connectors return `not_connected` with the connect URL, never invented rows.

---

## 1. Emma — Customer Support (front line)

| | |
|---|---|
| Card | `gmail`, `whatsapp`, `google-calendar`, `customer-ops` (`employee-provision.ts:137`) |
| Does | FAQ from memory and connected inbox, triage, draft replies, propose calendar times |
| Does not | Refunds, Stripe, Zendesk/Intercom, CRM writes, ads. Those are a delegation to Customer |
| Confirm | Any `send` (email, WhatsApp). Drafts are not sends |
| Background | None. Inbound WhatsApp/widget for contacts assigned to Support stick to Emma (EMP-G08) |
| Memory | Reads org + conversation tier. Writes only FAQ facts the user explicitly asked to remember, via `cognee_remember` if that tool is on the card — it is not, by default. Teaching memory is a user action on `/brain`, not a silent embed of every customer message (`19`) |

**Proving prompts**

| Ask | Must happen |
|---|---|
| "What's our refund policy?" | Answer from Brain/Cognee with a citation, or "I don't have that saved." No web invention. |
| "Draft a reply to the latest customer email about a late order" | `gmail` search (`q=` once TOOL-G01 lands; until then `fetch_latest` and say it is the latest N, not "the" email). Draft only. |
| "Text them that we're looking into it" | `pending_approval` summary names the recipient and the body. Nothing sent before Approve. |
| "Refund order 1042" | Delegation offer to Customer. Emma's tools do not include `stripe`. |
| "Book a 30-min call Thursday" | `check_availability` then `pending_approval` for `create_event` with the real slot. |

**Broken today.** Persona can be inferred as `sales` if the name/role string matches "lead" (EMP-B09). Channel webhook picks the oldest active employee, not Emma (EMP-G08).

---

## 2. Customer — Customer Resolution

| | |
|---|---|
| Card | `gmail`, `whatsapp`, `google-calendar`, `stripe`, `hubspot`, `zendesk`, `intercom`, `customer-ops`, `database_query` (`:109`) |
| Does | Look up the customer across CRM, tickets, and Stripe; draft the reply; open and close loops; refund **inside policy** only after approval |
| Does not | Prospect (Growth/Sarah), reconcile sheets (Operations), create invoices (Finance) |
| Confirm | `send`, `pay` (refund, charge). `stripe` on the card does not mean unattended refunds |
| Background | OpenLoopMonitor 15m, CustomerRecovery (child of work items), ConversationalInsight 24h. All sends through the gate. Critic on every outbound (EMP-S04). Per-customer daily cap (EMP-S05). Quiet hours (EMP-S06) |
| Add to card | `shopify` so an address fix (CE-06) is reachable (EMP-G04). Until then the employee says Shopify is not on this card |

**Proving prompts**

| Ask | Must happen |
|---|---|
| "What's the status of Acme's ticket?" | HubSpot or Zendesk read. Empty → `not_connected` or "no ticket", not a made-up status. |
| "Refund $20 to jane@acme.com" | `pending_approval` with amount and customer. Member role is 403 (SEC-R01). No default amount if the user did not name one (RT-B06). |
| "Who haven't we replied to?" | `customer-ops` open loops from the DB. |
| "Change the shipping address on order 55" | Shopify `update_order_address` only after the card includes `shopify`; otherwise delegation/not on card. Approval required. |
| "Chase the three open loops" | Plan with one step per loop, each a send approval, idempotent per `(workItemId, day)`. |

**Background done when.** Kill switch on ⇒ OpenLoopMonitor writes shadow ledger rows and sends zero messages. A guest or customer is not emailed twice for the same loop on the same day.

---

## 3. Operations

| | |
|---|---|
| Card | `hubspot`, `database_query`, `google-calendar`, `google-sheets`, `slack`, `gmail`, `operations`, `re` (`:116`) |
| Does | Reconcile records, dedup **report**, calendar deadlock audit, meeting prep for the owner, work-item SLA, real-estate listing reads |
| Does not | Send customer email (persona denial must win even though `gmail` is on the card — EMP-S07). Invent listings. Merge CRM records without approval |
| Confirm | Slack posts, Gmail sends (denied by persona — the denial returns `persona_denied`, it does not fall through to send), calendar guest pings, CRM owner reassignment, listing writes |
| Background | MorningCheck, StuckWork, RepFollowUpSla, WorkloadBalancer, MeetingPrep 24h, SystemReconciliation. New orgs start all of them (`kickPeriodicSweeps` → `startSweepsForOrg`, EMP-B16) |

**Proving prompts**

| Ask | Must happen |
|---|---|
| "Which meetings tomorrow have unconfirmed guests?" | Calendar read. The fix is a plan, not an immediate email. |
| "Dedup HubSpot contacts" | A report of pairs. Merge is `pending_approval` and calls the HubSpot merge API, not only local `entities` (EMP-G06). |
| "What's stuck?" | Work items past SLA from the DB. |
| "Any listing under 80L in Andheri?" | `re.listings_search` over the org sheet. Zero rows → "none", never a fabricated flat. |
| "Ping the guests who haven't confirmed" | `pending_approval` per guest. Next day's sweep does not ping them again (EMP-B08). |

**Background done when.** WorkloadBalancer does not reassign CRM owners at stage 0 (EMP-S02). `outage-buffer` holds a failed send and retries through the gate (EMP-G05), or it is deleted so nobody thinks it does.

---

## 4. Growth

| | |
|---|---|
| Card | `hubspot`, `web_search`, `web_extract`, `apollo`, `gmail`, `slack`, `growth` (`:123`) |
| Does | ICP and buying-signal research, draft outreach, dormant-lead lists, pipeline attribution from `growth` tools |
| Does not | Invent pipeline dollars. Scrape LinkedIn. Create a HubSpot contact without approval |
| Confirm | `send` (outreach email, Slack), CRM create/update |
| Background | GrowthWatcher 4h, MarketScout 24h, MeetingDossier 30m, ReplySorter 20m, **DormantLeadRevival** (registered, never started — EMP-G02) |

**Proving prompts**

| Ask | Must happen |
|---|---|
| "Who looks like our best customers?" | Apollo search if connected, else `not_connected`. No invented people. |
| "Any buying signals for Acme this week?" | Shared search provider (`14`), results with URLs. Provider failure is `provider_unavailable`, not "no signals". |
| "Draft a note to the VP of Acme" | Gmail draft. Send is approval. |
| "Revive dormant leads" | `growth.list_dormant_leads` from the DB. The revival send is a plan of approvals. |
| "Push this lead into HubSpot" | `pending_approval` with the fields that will be written. Dedup check runs after create, and a duplicate becomes a decision, not a second contact. |

**Background done when.** MarketScout's HubSpot create is an approval or a stage-3 action, never a raw `executeProvider` at stage 0 (EMP-S02). DormantLeadRevival runs on the same registry as the other four.

---

## 5. Sarah — Sales & Lead Gen

| | |
|---|---|
| Card | `gmail`, `whatsapp`, `hubspot`, `salesforce`, `zoho-crm`, `apollo`, `linkedin`, `google-calendar`, `re` (`:130`) |
| Does | Qualify, match an inquiry to a listing, draft outreach, read deals |
| Does not | People-search LinkedIn. `search_people` hits typeahead of the token's own network (`14` §8.2). Until a partner API exists, that action is off the card and people-search goes to Apollo |
| Confirm | Send, CRM create, showing book |
| Background | None until a sales loop is specified. Do not pretend MarketScout is Sarah's |
| Connect UI | Salesforce, Zoho, Apollo, LinkedIn have executors and **no catalog row** (TOOL-G10). The employee says `not_connected` and the connect URL only when the catalog row exists. Until then the prompt must not offer those tools |

**Proving prompts**

| Ask | Must happen |
|---|---|
| "Find a director of ops at a 50-person logistics company in Pune" | Apollo if connected. LinkedIn tool is not called. |
| "What deals are in proposal?" | HubSpot list/search. |
| "Someone asked about a 2BHK in Baner" | `re` inquiry match against org listings. No match → say so. |
| "Email them the two matching flats" | Draft, then `pending_approval`. Body contains only listings the tool returned. |
| "Book a showing Saturday 11:00" | `pending_approval` for the booking. Calendar event includes the listing id. |

---

## 6. Marcus — Marketing & Analytics

| | |
|---|---|
| Card | `meta-ads`, `google-ads`, `gmail`, `google-analytics`, `google-search-console`, `google-business-profile` (`:144-151`) |
| Does | Read campaign, search, and listing metrics; draft a summary |
| Does not | Mutate budgets, create ads, or send mail without approval. Persona denies charge/payout |
| Confirm | `send`, any future ads mutate |
| Background | None. Do not invent a campaign workflow |
| Gap | No `web_search` on the card. Competitor questions delegate to Research (`14` §9, WEB-G17). Google Ads stays ⛔ until `GOOGLE_ADS_DEVELOPER_TOKEN` exists |

**Proving prompts**

| Ask | Must happen |
|---|---|
| "How did non-brand search do in the last 7 days?" | GSC query. Say the row limit. No invented clicks. |
| "Which Meta campaigns spent the most?" | Meta metrics, with the cursor if truncated. |
| "Reply to our latest Google review" | Not possible until GBP reviews exist (TOOL depth, `16`). Say so. Do not draft a reply to a review you did not fetch. |
| "What are competitors bidding on?" | Delegation to Research. Marcus does not call `web_search` unless it is added to **this** card on purpose. |
| "Pause the underperforming ad" | `pending_approval` if the mutate action exists; otherwise "I can read metrics, I cannot pause ads yet." |

---

## 7. Research

| | |
|---|---|
| Card | `web_search`, `web_extract`, `google-drive`, `notion` (`:162`). Persona JSON already has `rosterKey: 'research'` |
| Does | Search, extract, cite. `research_run` once `14` §8 lands: search → pick → extract → claims mapped to sources |
| Does not | Send, pay, CRM write, invent a founder or a year (ASK-G09 / WEB-B11). The post-processor that rewrites "could not find" is deleted |
| Confirm | None on reads. `cognee_remember` is not on the card |
| Background | Optional `web_monitor` later (`14` WEB-G10). Not in the first cut |
| Answer shape | Numbered claims, each with a source id, domain, and `fetchedAt`. Provider down → `provider_unavailable`, and the sentence is "search failed", not "nobody founded this" |

**Proving prompts**

| Ask | Must happen |
|---|---|
| "Who founded Stripe, and when?" | Citations to fetched URLs. If search fails, say it failed. |
| "Summarise the Q3 strategy doc" | Drive search then extract. Missing file → not found. |
| "What's in the wiki about refunds?" | Notion search. |
| "Email the founder" | Delegation to Growth or Sarah. Research does not send. |
| "Remember that our ICP is 20–200 person B2B" | Hand the user to Brain, or `pending` a memory write. Do not silently store. |

Routing: founder/company questions already target Research. "Who is in charge at Acme" must not hand off to Finance (EMP-B07).

---

## 8. Executive

| | |
|---|---|
| Card | `web_search`, `database_query`, `cognee`, `daily_brief` (`:173`). Persona JSON has `rosterKey: 'executive'` |
| Does | Daily brief from real work items, org status, delegate specialist work |
| Does not | Send, pay, run ads, or run a 20s research crawl. Deep research delegates to Research |
| Confirm | Delegation that will send or pay is the target's confirm, not a free pass |
| Background | OwnerBriefing is **not** in `PERIODIC_SWEEPS`; it starts from the owner-WhatsApp webhook. Put it on the registry or document that it is webhook-only and test that path |
| Bug | `normalizeEmployeePersona('Executive')` returns null, so persona denials do not run (file `03` table). Fix the normaliser so `executive` denies send/pay/ads |

**Proving prompts**

| Ask | Must happen |
|---|---|
| "Brief me" | `daily_brief` from work items. Empty inbox → "nothing waiting", not a fabricated brief. |
| "Brief me on today's meetings" | Stays on Executive (calendar read via delegation to Operations or a read tool). Does **not** hand off to Sales (EMP-B07). |
| "Refund the customer" | Delegation to Customer. Executive tools do not include Stripe. |
| "How many open work items?" | `database_query` on a read-only role (`17` / RT-B01). `WITH … DELETE` is rejected. |
| "Have the team handle the Acme renewal" | Crew or two delegations, cap 3, each specialist on its own card. |

---

## 9. Finance

| | |
|---|---|
| Card | `stripe`, `razorpay`, `quickbooks`, `billing_usage` (`:185`) |
| Does | Payment links, usage readout, invoice **reads** |
| Does not | Refunds (delegate to Customer — persona says this). Unattended charges. `confirmClasses: ['pay']` is already enforced inside `checkAutonomy` (`autonomy.ts:288-300`) and must remain enforced **even when** the turn contract's confirm step also fires — one approval, not two |
| Confirm | Every pay action, including when the model omits the amount (no ₹500 / $50 default) |
| Background | No reconciliation loop until QuickBooks create-invoice exists (`16`). Do not mark one ✅ |
| Keys | Stripe/Razorpay production keys and QuickBooks catalog are ⛔ human. The employee returns `not_connected`, not a fake link |

**Proving prompts**

| Ask | Must happen |
|---|---|
| "Send a payment link for 15000 INR to billing@acme.com" | `pending_approval` with 15000 and that email. |
| "Charge them 500" | Same, and a `member` gets 403. |
| "How much usage do we have left?" | `billing` reads `orgs.plan`, not `plan_key` (BIZ-B14). |
| "Refund it" | Delegation to Customer. |
| "Create the invoice in QuickBooks" | Only if that action exists; otherwise say the tool can list invoices. |

---

## 10. Custom employees

| Rule | Detail |
|---|---|
| Create | `POST /api/employees` validates name, role, persona ≤ 8 KB, tools against the catalog, and writes an audit row (EMP-B11, EMP-E10) |
| Autonomy | Seed rules for this employee id at create (the call to `seedDefaultAutonomyRules` has no caller today — EMP-S12). Stage stays the org's stage |
| Routing | Auto can select them when persona/tool overlap wins (EMP-B03). Today `inferRosterKey` returns `'other'` and they are invisible |
| Allowlist | The posted list, exact ids, intersected with persona denials. Empty means core-read, not the customer's Stripe tools (EMP-B02) |
| Hand-off | No rule file matches an unknown role, so an unknown locked custom employee currently never hands off. Add a default: if the utterance needs a tool not on the card, offer the roster employee who has it |
| Builder | Schedule, memory scope, and model are EMP-E06 — not required for the first cut, but the API must reject unknown fields instead of ignoring them into a false sense that they were saved |

---

## 11. Governance that applies to every employee

| Control | Working behaviour |
|---|---|
| Kill switch | One flag. Chat, webhook, crew, and every sweep stop at `17` §2 step 2. The flag is not "only open-loop sends" |
| Stage 0 | Shadow ledger only. UI copy says "watching". Advancing stage is an audited owner action, and `canAdvanceStage` checks per-employee approval rate once metrics are keyed by `employee_id` (EMP-G03, EMP-E02) |
| Metrics | `org_employee_metrics_daily` keyed by `employee_id`. Bands from `employee-metrics.ts` run daily and can force `escalate`. `employees/stats` automation rate comes from the ledger, not active/total headcount (EMP-B12) |
| Quiet hours | Org timezone, default 21:00–08:00, overridable. Applies to every send |
| Versioning | Later (EMP-E03). Until then, PATCH persona/tools writes `audit_events` with before/after |
| Archived | Every roster query has `archived_at IS NULL` (EMP-B17). PATCH cannot revive an archived row by omitting the check (EMP-B11) |

---

## 12. Order to make the jobs true

The gate in `17` lands first. Then, in order:

1. Persona module + `rosterKey` + router tests (`router-safety.test.ts`).
2. Emma, Customer, Operations, Executive proving prompts — they use connectors the catalog already has (Gmail, Calendar, HubSpot, Sheets).
3. Growth and Research proving prompts — depend on the search honesty contract in `14` (failures are not empty success).
4. Sarah and Marcus — drop or hide tools with no connect UI; do not demo a tool the user cannot connect.
5. Finance — pay confirm + RBAC, with test keys. Production keys stay ⛔.
6. Custom employee routing and audit.
7. Delegation tool.
8. Per-employee metrics and stage advance.

A job is 🟢 only when its five proving prompts pass against a live org, recorded in `gap26sept/chat-coverage.md` (ASK-G01).
