# Status: what Darex has vs what Grok Bot does

Compared 2026-09-30.

**How to read this.** Darex facts come from `AGENTS.md`, `BUILD_STATE.md` and the
`gap26sept/` trackers (about 240 green, 23 yellow, 8 red rows). I did not re-run
Darex for this comparison, so those are the repo's own claims. Grok Bot facts come
from xAI's docs and reviews (see [09-sources.md](09-sources.md)); I have not run it
either. Treat every "better" below as a judgement from documents, not a benchmark.

## One-line difference

- **Grok Bot** is a horizontal, per-user **computer-use agent**: a Bot gets a cloud
  PC and clicks through any website as you.
- **Darex** is a multi-tenant **business-brain SaaS**: AI employees with role
  allowlists, shared org memory and real connector calls, with approval gates and
  row-level security.

Grok Bot wins on *reach* (any app, no API). Darex wins on *control and company
knowledge*.

## Side by side

| Area | Grok Bot | Darex (repo state) | Edge |
|---|---|---|---|
| Core idea | Named Bots on their own cloud computer | Named AI employees behind one Ask AI chat | Different bets |
| How it acts | Connectors, else computer use (clicks a real browser) | 62 real tool executors (connectors, SQL, web) via MCP bridge; missing connector returns an honest `connected:false` | Grok for API-less apps; Darex for reliability |
| Apps with no API | Yes, main selling point | No computer-use path | **Grok Bot** |
| Roles | 8 starter roles, user-defined Bots | Roster: Executive, Customer Support, Sales/Lead Gen, Marketing, Research, Finance, Growth, Customer, Operations, custom | Tie; Darex has deeper per-role engines |
| Front door | Chat per Bot, group chats of 2 to 6 | One Ask AI chat with Auto / Pick one / Team modes (Team cap 3, in progress) | Grok is more mature UX; Darex is one place |
| Multi-agent | Bots message each other, pass ownership | Crew workflow: manager plus up to 3 parallel specialists, synthesis | Grok (freer); Darex (bounded, safer) |
| Planning | Bot just does the task | Complex asks become a plan card: approve, edit params, then staged parallel execution, cancel, durable Temporal for send/pay/sign | **Darex** |
| Approvals | Prompt-stated boundaries plus Auto Review model; approvals cover proposed actions only | Autonomy tiers, approve/reject, per-employee tool allowlist, plan confirm before risky steps | **Darex** |
| Memory | Per-Bot preferences and summaries | Shared org "brain": hybrid vector search, revisions, re-embed, cascade invalidation | **Darex** |
| Learn a workflow | "Watch me once" screen recording (10 min) | Playbooks promoted from successful plans; no screen-recording path | Grok for ease |
| Schedules / triggers | Routines, up to 50 per Bot; Slack/GitHub events | Periodic sweeps, Temporal workflows, webhook triggers | Tie |
| Inbound channels | Chat with you; acts in your inbox | WhatsApp, Chatwoot, Gmail/IG/SMS inbound and outbound, widget; inbound always solo | **Darex** for customer-facing |
| Multi-tenant isolation | Shared computer per account; Bots are not security boundaries | `org_id` on every table, RLS, scoped clients, never trust body org | **Darex** |
| Audit | Enterprise only, "coming soon" for per-action view | Audit table with list UI, append-only grants, login-denied rows | **Darex** (migration apply pending) |
| Credentials | Shared browser logins across all Bots | Nango OAuth; tokens not given to the model | **Darex** |
| Compliance | None claimed | GDPR export/delete built, UI still open (P0) | **Darex**, unfinished |
| Vertical packs | None | Real-estate pack (listings, showings, rent reminders) and pack installer | **Darex** |
| Ecosystem and distribution | Cursor and SuperGrok user bases | Pre-launch | **Grok Bot** |
| Client apps | Desktop plus iOS | Web dashboard | Grok |
| Proven at scale | Beta, no published reliability data | Live sweeps still finding routing/token bugs | Neither |
| Price | Bundled: Cursor from $20, Ultra $200, Teams $120/seat | Plans defined in `docs/new-109-pg-plan/payment/`; usage cap not enforced yet | Unclear |

## Scorecard: % better, area by area

**These percentages are my judgement, not measurements.** Each row splits 100%
between the two products for that area (higher is better for that product).
Neither product was benchmarked; Darex numbers rest on the repo's own trackers.

### Capability and reach

| Area | Darex | Grok Bot | Better |
|---|---|---|---|
| Reach into apps with no API | (5%) | (95%) | Grok Bot |
| Acting through real connectors, honest failures | (75%) | (25%) | Darex |
| Role depth and employee engines | (65%) | (35%) | Darex |
| Multi-agent coordination | (45%) | (55%) | Grok Bot, freer; Darex is bounded and safer |
| Learning a workflow from you | (25%) | (75%) | Grok Bot |
| Schedules and event triggers | (50%) | (50%) | Tie |
| **Group average** | **(44%)** | **(56%)** | **Grok Bot** |

### Control and trust

| Area | Darex | Grok Bot | Better |
|---|---|---|---|
| Plan, approve, edit, cancel before risky steps | (80%) | (20%) | Darex |
| Company memory and shared knowledge | (80%) | (20%) | Darex |
| Tenant isolation and security model | (85%) | (15%) | Darex |
| Credential handling | (80%) | (20%) | Darex |
| Audit trail and compliance work | (75%) | (25%) | Darex |
| Customer-facing channels (WhatsApp, Gmail, SMS) | (85%) | (15%) | Darex |
| **Group average** | **(81%)** | **(19%)** | **Darex** |

### Product and market

| Area | Darex | Grok Bot | Better |
|---|---|---|---|
| Chat UX and collaboration | (40%) | (60%) | Grok Bot |
| Vertical packs (real estate) | (95%) | (5%) | Darex |
| Ecosystem and distribution | (10%) | (90%) | Grok Bot |
| Client apps (desktop, iOS) | (25%) | (75%) | Grok Bot |
| Proven in real use | (40%) | (60%) | Grok Bot, beta but live; Darex still finding bugs in sweeps |
| Price and packaging | (50%) | (50%) | Unknown, no fair comparison yet |
| **Group average** | **(43%)** | **(57%)** | **Grok Bot** |

### Overall

| Lens | Darex | Grok Bot |
|---|---|---|
| All 18 areas, equal weight | **(56%)** | **(44%)** |
| A company running customer-facing, multi-user work | **(70%)** | **(30%)** |
| One person who wants a personal assistant today | **(30%)** | **(70%)** |

The two lens rows are a judgement call about which groups matter most for that
buyer (control and trust for a company, reach and polish for a solo user), not a
computed weighting.

**Reading it:** Darex is clearly better at control and trust. Grok Bot is better
at reach, polish and distribution. Darex's product-and-market score is low mostly
because it is pre-launch, not because the design is weak.

## Which is better, and when

**Pick Grok Bot when**
- The work lives in a website or legacy tool with no API or MCP.
- One person wants a personal assistant that does chores overnight.
- You want zero setup and an existing Cursor or SuperGrok subscription.
- Output is a draft or review list and mistakes are reversible.

**Pick Darex when**
- A company needs many employees or customers sharing one memory and one set of rules.
- Actions touch customers, money or contracts and need plan approval and an audit trail.
- You need tenant isolation, per-role tool limits and honest "not connected" answers.
- You serve a vertical (real estate today) with two-way messaging channels.

**Overall:** neither is simply better. For a *business platform* Darex is the
stronger design: governance, memory and isolation are what Grok Bot's own reviewers
call its weakest points. For *raw capability today* Grok Bot is ahead on reach and
polish.

## Where Darex is behind (from the repo's own open rows)

- **No computer-use fallback.** Anything without a connector is out of reach.
- **Connector coverage is thin in practice.** Only Google, Meta and GitHub have real
  OAuth client IDs; HubSpot, Stripe, Notion, Slack, Shopify, Zendesk, Intercom need
  registration, and `NEXT_PUBLIC_NANGO_PUBLIC_KEY` unset blocks every connect. These
  are human blockers.
- **Usage cap computed but not enforced** in the tool path (billing P0).
- **Auth has no rate limiting, lockout or MFA at the route level** per the Sept 26
  audit (a TOTP path and denied-login auditing have since been added).
- **GDPR delete/export has no frontend UI** (P0), though the backend is built.
- **Realtime fails hard** when Redis is down; only 2 of 22 tabs use the shared event stream.
- **Stub metrics** had been rendering fake-healthy (partly fixed).
- **No independent proof of reliability yet;** the latest live sweep found routing,
  blank-reply and token-budget bugs, several now fixed on `main`.

## Where Grok Bot is behind

- Shared credentials and shared computer across all Bots; no role isolation.
- No dry run, no confidence thresholds, no knowledge-base grounding.
- Actions logged as the human user; per-action audit view unfinished.
- No compliance certifications; retention follows Cursor's terms.
- Cannot bypass CAPTCHAs, 2FA or payments; needs you at the screen.
- Beta, invite-tier access, launch-day sign-in failures.

## Ideas worth borrowing (not commitments)

1. **A read-only browser fallback** for tools with no connector, gated behind the
   existing approval plan card. Biggest capability gap.
2. **Watch-me-once capture** feeding the existing playbook promotion loop.
3. **Group-chat handoff view** for Team mode, since Darex already has crews.
4. Keep the differentiators loud: shared brain, per-employee allowlists, RLS, plan
   approval and an audit trail.

## Confidence

| Claim | Confidence |
|---|---|
| Grok Bot feature list | Medium-high (xAI docs) |
| Grok Bot pricing and Team Bots | Low-medium (reviews disagree, docs unreadable) |
| Darex feature state | Medium (repo trackers, not re-verified live today) |
| "Which is better" verdicts | Judgement, not measured |
