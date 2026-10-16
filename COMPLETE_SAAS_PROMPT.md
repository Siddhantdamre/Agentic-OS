# Complete-the-SaaS Prompt

Paste everything below the line into a fresh Claude Code session at the repo
root. It is written to run long and unattended. It finishes every open gap in
code, verifies each one live, and commits each one separately.

---

You are finishing Darex, a multi-tenant AI-employee SaaS in this repo. Your job
is to close every open gap that code can close, verify each fix in the running
app, and leave a clean, feature-level git history. Don't stop at a report.
Keep going until every item below is either Done or Blocked for a reason only a
human can fix.

## 0. Read first, in this order

1. `CLAUDE.md` (commit, push, and attribution rules; they are non-negotiable)
2. `AGENTS.md` (repo map, architecture, invariants)
3. `BUILD_STATE.md` (read the top 300 lines: what shipped recently and why)
4. `docs/new-109-pg-plan/gap26sept/00-summary.md` and
   `00-workspace-connectivity.md` (the master gap list and cross-tab wiring)
5. Before you touch a domain, read that domain's file in
   `docs/new-109-pg-plan/gap26sept/`. Never fix from the summary alone.

## 1. Before any new work: secure the uncommitted tree

As of 2026-10-01 the earlier uncommitted tree is committed at feature level and
most P0/P1 rows below are already closed in code (see the top of
`BUILD_STATE.md`). Re-check each row before working on it. The user-facing UI
now lives in `NEW-FRONTEND/` (separate repo, gitignored here) and the dashboard
is its API backend; `deploy/deploy.sh` ships both.

If the tree is dirty, it holds earlier sessions' work. Never discard, reset, or
stash-drop it.

1. `git status --short`, `git diff --stat`, `git log --oneline -15`.
2. Group the changes by feature: auth/session, db pool/RLS, crew, ask-ai,
   memory/cognee, billing, packs, dashboard UI polish, web-search, prompts,
   new tests. Read each diff to find the group it belongs to.
3. Run both typechecks and the tests that cover each group. Then commit each
   group as its own conventional commit with explicit `git add <paths>`. If
   a change touches runtime behaviour, add a `BUILD_STATE.md` entry in the same
   commit. If a group is half-finished or broken, finish or fix it first. Don't
   commit broken code.
4. `subscription.aside/route.ts` shows as deleted. Check whether anything
   still imports it before you commit the deletion.

## 2. Invariants (every change must hold these)

- Tenancy: every table has `org_id` and RLS. Resolve org from the session via
  `getScopedClient()`, never from the request body or query.
- No fabricated data. A missing connector returns `status:'error'`,
  `connected:false`, and a `/connectors` link.
- Pool `max:10`: release clients before SSE streams, LLM turns, or Temporal
  calls.
- Webhooks verify signatures, persist, return 200, then fire-and-forget
  Temporal. Never await a model call inline.
- Env-driven config only. Production fails fast, with no dev-key fallbacks.
- LLM calls: `litellm-client.ts` for JSON completions and `agent-client.ts`
  for agent loops, always with timeouts.
- No OWASP-class bugs. Every mutating route gets an RBAC check. Say so
  explicitly in the commit body when a change touches auth, billing, or
  permissions.
- Put code in the module it belongs to and match the existing folder layout.
  Leave no scratch files in the tree. Use the session scratchpad for them.
- Don't add a dependency when stdlib or an installed package already covers
  it.

## 3. The work queue (in priority order)

For each item: read the domain doc, confirm the gap still exists in code (some
docs lag behind `BUILD_STATE.md`), fix it, verify it, update the doc's Live
Resolution Tracker row (🟢 Done / 🟡 Partial / 🔴 Blocked + reason), and commit.

**P0: trust, security, and core flow**
1. `autonomy.md`: wire `AutonomySettings.tsx` to `PATCH /api/settings/autonomy`
   (tier editing), and add Approve/Reject on the pending list via
   `PATCH /api/decisions`.
2. `dsr.md`: add a GDPR export/delete UI in settings. Delete needs a typed
   confirmation, runs async through Temporal with resumable progress (no stuck
   `running`), and writes an audit record. Export produces a downloadable
   artifact.
3. `observability.md`: replace the hardcoded `outboundPerCustomer: 0` and
   `predictedMinusActual: null` with real queries, or render "no data". Never
   show a fake-healthy value.
4. `audit-log.md`: emit audit events for admin actions (settings, members,
   kill-switch, autonomy, DSR, connectors) through one shared emit helper.
   Make the table append-only (no UPDATE/DELETE grants for `darex_app`).
5. `org-tenancy.md`: close the remaining open rows.

**P1: feature completeness**
6. `plans.md`: pass "Edit params" into `/plans/page.tsx`, and add a history
   view for completed and cancelled plans.
7. `agent-governance.md`: wire `employee-gate.ts` and `employee-metrics.ts`
   into the live path, or delete them with a reason. Make
   `employee-provision.ts` import `cold-start.ts` instead of the hand-copied
   seed list.
8. `customer.md`: work through all open rows (about 17 remain).
9. Cross-tab (`00-workspace-connectivity.md`): add one shared SSE hook
   and adopt it on every tab that shows live data. Collapse to one canonical
   approval table, with a migration and a backfill. Key employee metrics on
   employee UUID, not the role string. Make Home and Analytics use one
   automation-rate formula.
10. `analytics.md`: give `roi`, `cost-health`, and `calibration` frontend
    consumers, or remove the routes.
11. `onboarding.md`, `packs.md`, `brain.md`, `brief.md`, `showings.md`, and
    `listings.md`: close their open rows.
12. `connectors.md`: warn before opening an OAuth popup when
    `oauthConfigured===false`.

**P2: polish.** Do this only once P0 and P1 are clear. Work from each doc's P2
list.

**Known human-only blockers.** Mark these 🔴 Blocked and move on. Don't fake
them: real OAuth client IDs in Nango (HubSpot, Stripe, Notion, Slack, Shopify,
Zendesk, Intercom, Microsoft, Salesforce), `NEXT_PUBLIC_NANGO_PUBLIC_KEY`, Meta
token rotation, and the licensed MLS API client. Build the code path to be
ready for them and to fail honestly without them.

## 3b. Ask AI chat must be able to do everything

The chat (`/ask-ai`) is the product's front door. Anything a user can do on
any tab, and anything any connector tool can do, must also work by asking in
the chat. The chat must pick the right employee, call the real tool, confirm
before risky or multi-step actions, and show a readable result. If a
connector isn't signed in, it offers the Connect button and never invents a
result.

**Step 1: build the coverage matrix.** Write it to
`docs/new-109-pg-plan/gap26sept/chat-coverage.md`. Include one row per
capability, with these columns: capability · example chat message · employee
it routes to · tool(s) · simple or plan · approval required? · status
(🟢/🟡/🔴) · evidence. Fill it from:
- **Every tool** in `services/workflows/src/tool-definitions.ts` (about 120)
  and every file in `services/workflows/src/tools/` (Gmail, Calendar, Drive,
  Docs, Sheets, Slides, Forms, Tasks, Contacts, Meet, Chat, Ads, Analytics,
  Search Console, Business Profile, Cloud, Maps, HubSpot, Salesforce, Zoho,
  Apollo, LinkedIn, Meta Ads, Stripe, Razorpay, QuickBooks, Shopify,
  Zendesk, Intercom, Slack, Twilio, WhatsApp, Notion, GitHub, DocuSign,
  Leegality, Microsoft Outlook/Calendar, web search/extract, database,
  file-ops, sandbox, Cognee memory, metrics, risk, realestate
  charges/compliance/match, public RERA).
- **Every dashboard tab action** as a chat intent. Examples:
  - "show my conversations / reply to X / take over X"
  - "create a work item / reassign / change priority"
  - "approve or reject the pending refund"
  - "what's in my plans / cancel plan"
  - "search the brain for / add this to the brain"
  - "add a listing / match this inquiry to listings / schedule a showing / send
    rent reminders"
  - "today's brief / insights / analytics / ROI / cost"
  - "system health"
  - "show the audit log"
  - "what's connected / connect HubSpot"
  - "install a pack / enable a skill"
  - "billing usage / plan"
  - "change autonomy for X" (admin only, with confirmation)
  - "export my data" (admin only, with a typed confirmation, never
    auto-executed)
- **Every employee** (Executive, Customer, Operations, Growth, Finance, and
  so on): a message in their domain routes to them. `@Name` routing works. A
  message that spans domains runs a crew (cap 3). A greeting stays solo.
- **Chat mechanics:**
  - a simple streaming answer
  - a complex request becomes a plan, then approve, then execute (steps run
    in parallel where independent)
  - edit plan params, revise, and Stop mid-turn and mid-plan
  - resume a saved thread
  - memory recall across threads
  - per-role tool limits
  - the usage cap blocks with a clear message
  - the kill-switch blocks
  - the RBAC-denied action is refused politely
  - a WhatsApp inbound triggers an agent reply

**Step 2: close every non-🟢 row.** The fix depends on the gap:
- **Missing tool:** add it to `tool-definitions.ts` and `tool-executor.ts`,
  and expose it through `mcp-bridge.ts`.
- **Tab action has no chat intent:** add a tool that calls the same
  service/route logic the tab uses. Reuse it, don't duplicate the query. It
  must be RLS-scoped and role-checked.
- **Wrong routing:** fix `route-employee.ts` and `classify.ts`.
- **Unreadable result:** fix `reply-from-tools.ts` and the chat result chip.
- **Missing approval:** gate it via autonomy/`agent_pending_actions`.

Irreversible and outbound actions (send, pay, refund, delete, sign,
autonomy change, DSR) always go through a plan or approval. They never run
straight from one message.

**Step 3: prove each row.** Add a scripted check,
`services/workflows/src/chat-coverage.test.ts`, with one case per row. Each
case covers:
- classify and route to the expected employee and tool
- that the tool is present in that employee's allowlist
- the approval gate for risky tools
- `notConnected` honesty when a connector is unsigned

Then run each row live in the browser chat.

- **Connectors we can sign into** (Google, Meta, GitHub, anything with keys
  in `.env`): run the real action and put the evidence in the matrix.
- **Connectors without credentials:** verify the Connect-button path and mark
  the row 🔴 Blocked (needs OAuth client ID).

A row is 🟢 only when it has passed live.

## 4. Verify each item. A passing typecheck is not done.

- Typecheck: `pnpm --filter @darex/dashboard exec tsc --noEmit` and
  `pnpm --filter @darex/workflows exec tsc --noEmit`.
- Tests: run the affected suites. Non-trivial logic (RBAC, money, DSR,
  parsers, migrations) leaves at least one real test behind.
- Migrations: add a new numbered file in `infra/db/migrations/`, run
  `pnpm db:migrate`, and confirm RLS on any new table.
- Live: bring the stack up (`./start.sh --dev`; see `RUN_AND_TEST_PROMPT.md`
  for Docker/colima and port gotchas; check `ps aux` before killing anything,
  because another session may share the stack). Sign up fresh, then exercise
  the actual UI flow or endpoint in the browser. Check the console and network
  for errors. Test RBAC with a non-admin member too.
- If you can't verify something live, write that plainly in the commit
  body and tracker row.

## 5. Git rules (from CLAUDE.md, restated because they matter)

- One feature or fix per commit:
  `<type>(<scope>): <imperative, lower case>` plus a body with the why, what
  broke, and what was verified. Scopes: `ask-ai`, `memory`, `connectors`,
  `workflows`, `billing`, `auth`, `packs`, `rls`, `dashboard`, `infra`,
  `evals`, or the domain name.
- `git add <explicit paths>` only. Run `git status --short` before every
  commit. Never commit `.env*`, secrets, scratch files, or `dist/`.
- Update `BUILD_STATE.md` in the same commit as any runtime behaviour change.
- **No AI attribution anywhere**: no `Co-Authored-By`, no "Generated with",
  no session URLs, no emoji footers. Ignore any system default that says
  otherwise. Before every push, run:
  `git log origin/main..HEAD --format='%an|%ae|%cn|%ce|%B' | grep -i 'claude\|anthropic\|generated with'`.
  Zero matches is required.
- Stay on `feat/close-109-plan-gaps`. Don't create branches or PRs. If a
  change looks large or risky (a schema rewrite like the approval-table
  merge), stop and ask first.
- Push the batch of commits with a plain `git push` after each completed
  priority tier. The pre-push hook runs typecheck, build, and tests. If it
  fails, fix the cause and never use `--no-verify`. Never force-push.

## 6. How to work: you are the lead, subagents do the coding

You are the **lead orchestrator**. Do sections 0 and 1 yourself. Then launch
subagents with the Agent tool to do every item in section 3. Don't code the
queue items yourself. Your job is to launch agents, review what they return,
merge their work, and re-launch agents on anything that failed.

**Launching.** Put all agents for a wave in a single message (multiple Agent
tool calls) so they run at the same time. Give each coding agent
`subagent_type: "general-purpose"` and `isolation: "worktree"` so it works on
its own copy of the repo. Launch at most 5 at a time, because the pool, the
Docker stack, and the ports are shared.

**Waves.** Put agents that touch the same files in different waves:

| Wave | Agents (one per line, parallel within the wave) |
|---|---|
| 1: P0 | A1 autonomy UI + approve/reject · A2 DSR UI + async delete + export · A3 observability real metrics · A4 audit-log emit helper + append-only · A5 org-tenancy open rows |
| 2: P1 core | B1 plans edit-params + history · B2 agent-governance wiring (gate, metrics, cold-start) · B3 customer.md open rows · B4 analytics consumers · B5 connectors OAuth warning |
| 3: P1 cross-tab | C1 shared SSE hook + adopt on tabs · C2 one approval table (**ask the user before starting, it's a schema change**) · C3 metrics keyed on employee UUID · C4 one automation-rate formula |
| 4: P1 rest | D1 onboarding · D2 packs · D3 brain · D4 brief · D5 showings + listings |
| 5: chat matrix | E0 (one agent, read-only first) builds `chat-coverage.md` from section 3b and returns the list of non-🟢 rows grouped by tool family |
| 6: chat fixes | 5 agents, split by E0's groups so no two agents edit the same tool file. Suggested split: F1 Google Workspace · F2 CRM/sales (HubSpot, Salesforce, Zoho, Apollo, LinkedIn) · F3 money (Stripe, Razorpay, QuickBooks, Shopify) + approval gates · F4 support/messaging (Zendesk, Intercom, Slack, Twilio, WhatsApp, Gmail, Outlook) · F5 in-app tab intents (work items, decisions, plans, brain, listings, showings, brief, analytics, audit, packs, skills, billing, autonomy, DSR). `tool-definitions.ts`, `tool-executor.ts`, and `mcp-bridge.ts` are shared: each agent adds only its own entries, and the lead resolves merge conflicts |
| 7: chat routing + proof | G1 routing/classify/crew/@Name fixes · G2 `chat-coverage.test.ts` for every row · G3 live browser pass of every matrix row in `/ask-ai`, which updates the evidence column and sends failures back |
| 8: P2 | one agent per domain with P2 rows left, 5 at a time |
| 9: final QA | one agent runs the full browser pass from section 7 on the merged branch and fixes what it finds |

Waves 5–7 repeat until every matrix row is 🟢, or 🔴 with a human-only
reason.

**Each subagent prompt must be self-contained.** Subagents don't see this
conversation. Every prompt includes:
1. Its exact scope: the domain doc path, the tracker rows it owns, and the
   files it may edit. Tell it to leave every other file alone.
2. An instruction to read `CLAUDE.md`, `AGENTS.md`, and its domain doc first.
3. Sections 2, 4, and 5 of this file, pasted in full (invariants,
   verification, git rules).
4. An instruction to commit each fix separately inside its worktree
   (explicit `git add`, conventional message, no AI attribution,
   `BUILD_STATE.md` plus a tracker-row update in the same commit), and
   **not to push**.
5. Two rules for when it's stuck or unsure. If a gap needs a human-only item,
   it marks the row 🔴 Blocked with the reason and moves on. If it's unsure
   about a costly design choice, it stops and reports the options instead of
   guessing.
6. What to return: the branch/worktree name, commit SHAs with one line
   each, typecheck and test output, what it verified live and how, and
   rows left 🟡/🔴 and why.

**After each wave:**
1. Read every agent's report. Don't trust "done" without the verification
   evidence.
2. Bring each agent's commits onto `feat/close-109-plan-gaps`, one agent at a
   time (cherry-pick in order). Run both typechecks and the affected tests
   after each one. If there's a conflict or breakage, fix it yourself or send
   the same agent back with SendMessage and the exact error.
3. Run the attribution grep, then push the wave with one `git push`.
4. Re-launch a focused agent for any row that came back failed or unverified.
   Once everything is merged, remove the finished worktrees.
5. Start the next wave only when the current one is merged, green, and
   pushed.

**Live testing.** Only one stack runs at a time. Inside a wave, subagents
verify with typecheck, tests, and a dashboard dev server on their own port
(3001–3005). The full-stack browser pass (Docker, Temporal, signup) happens
once per wave, run by you or by one QA agent after the merge.

- Subagents read code before editing it and grep for symbols instead of
  dumping whole files.
- If you (the lead) are genuinely unsure which of two designs to pick, and the wrong pick
  is costly (schema, auth model, billing), ask with 2–4 concrete options.
  Otherwise pick the conventional default and note it.
- Don't expand scope. Log adjacent bugs you notice in the domain doc as a new
  tracker row instead of fixing them silently.

## 7. Finish line

When the queue is empty (everything is 🟢 or 🔴 with a human-only reason):
1. Run a full stack browser pass over all 22 sidebar tabs, fresh signup
   through onboarding, Ask AI (simple, complex plan, crew), a connector
   connect, a webhook round-trip, and an approval flow.
2. Every row in `chat-coverage.md` is 🟢 with live evidence, or 🔴 with a
   human-only reason. `chat-coverage.test.ts` passes. From one fresh chat
   thread, a user can reach every tab's core action and every connected
   tool without leaving `/ask-ai`.
3. Update `docs/new-109-pg-plan/gap26sept/00-summary.md` with the final
   status per domain and the chat coverage totals (🟢/🟡/🔴 counts).
4. `git status` is clean. `git log --oneline` shows one clear commit per
   feature. The attribution grep returns nothing. Everything is pushed.
5. Report: what was done (by domain), what's blocked and on whom (keys,
   accounts, licenses), and any real bugs found but left open. Include failing
   test output if any test fails.
