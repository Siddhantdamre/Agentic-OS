# 05 — Ask AI chat: end-to-end gap audit (2026-10-09)

Scope: the whole Ask AI chat as it runs today, from the NEW-FRONTEND chat UI to
the provider call and back. Code was read on `main` at `c8ad0ab1`. Where a doc
and the code disagree, the code wins and the doc row is called out.

Sources read: `AGENTS.md`, top of `BUILD_STATE.md`,
`docs/new-109-pg-plan/gap26sept/{ask-ai,chat-coverage,00-workspace-connectivity,plans,crew-workflows}.md`,
`gap26sept/employees/*`, and the code listed under each section.

Status legend used in the tables: 🟢 works and is verified in code, 🟡 works
with a material gap, 🔴 broken or missing. Priority: P0 (security, data loss,
silent wrong action), P1 (core promise broken for normal use), P2 (quality,
cost, polish). Effort: S (< 1 day), M (1–3 days), L (> 3 days).

---

## 0. Executive summary

The server-side Ask AI pipeline (`apps/dashboard/app/api/ask-ai/route.ts`) is
much more complete than the September audit suggests: mode resolution,
`@Name` overrides, locked allowlists, hand-off offers, crews, plans, approval
resume, audit rows and a Redis limiter are all in code. The problems are at
the seams:

1. **The chat most users see does not go through Ask AI at all.** `/home`
   opens in the `chat` view, which renders `TrueForgeChat`
   (`NEW-FRONTEND/src/components/home/home-screen.tsx:96`), a TrueForge UI
   pointed at `/api/trueforge/*`. That route
   (`apps/dashboard/app/api/trueforge/[...path]/route.ts:16-127`) is a raw
   pass-through proxy to the TrueForge sidecar. It skips classification, the
   employee mode selector, usage caps, rate limits, conversation persistence,
   audit and approval RBAC, and it forwards any path for any signed-in user,
   and for an invalid session it still forwards the request without tenant
   headers. The real Ask AI client (`HomeChat` + `lib/state/chat.ts`) only
   appears in the "Dashboard Overview" view. **P0.**
2. **A send approved in chat does not send.** The in-process engine pauses a
   confirm-class tool for approval (`local-turn.ts:357-391`); after the user
   clicks Allow the tool runs through `executeAutonomousToolAction`, and the
   gate parks every confirm-class call again as `confirm_class`
   (`tool-gate.ts:348`) because the chat path never passes
   `approvedPendingActionId`. The model then reports "Waiting for approval",
   and the email sits in the Actions queue needing a second approval. The same
   happens to plan steps (`activities/orchestration.ts:329-340`), and the
   durable plan then reports `completed` even though the send is only parked.
   **P0/P1.**
3. **Turns with no routed employee have no tools.** When Auto routing returns
   nobody (emergency words such as "fire", "leaking", "smoke"; no active
   employees), the turn runs as `employeeRole: 'Primary Business Assistant'`
   (`route.ts:1310`). The gate resolves identity by role
   (`tool-executor.ts` `pickEmployeeForRole`), finds no match and denies every
   call with `missing_employee` (`tool-gate.ts:204-206`), including web search
   and SQL. **P1.**
4. **All allowed tools are sent to the model every turn.** The schema cap is
   160 (`local-tool-select.ts:12`) and the catalog has 154 tools, so nothing is
   narrowed by intent; an employee with a broad card sends every schema on
   every model call. **P1 cost, P2 quality.**
5. **The client drops most of what the server sends.** The `routing` event
   (why this employee answered, fallback notices, `@Name` overrides) is
   ignored by `applyAskEvent` (`lib/api/ask-ai.ts:141-181`); a reload loses
   tool lists, routing, errors and pending approval cards
   (`restoreThread`, `ask-ai.ts:286-304`); there is no Stop button and no
   abort for a chat turn (`chat.ts:112-155`); attachments and the microphone
   in the chat bar are mock-only (`components/ui/chat-bar.tsx:26-80`).
6. **Approvals are fragile.** In-process paused sessions live in a process
   `Map` with a 30-minute TTL (`local-turn.ts:79-106`); after a restart, on
   another replica, or after 30 minutes, Allow falls through to the HTTP
   sidecar with a session id it never issued and fails. A new message sent
   while a sidecar session has a pending approval deletes the session
   (`trueforge-client.ts:638-647`), silently discarding the approval. Crew
   turns never surface approvals at all (`route.ts:954-1254`).

Counts in this file: 14 areas, 126 findings (94 broken, 32 missing; 7 P0, 55 P1,
the rest P2), each with a fix, files, priority and effort, plus 24 failure
scenarios (§15) and 20 live checks (§17).

---

## 1. Request lifecycle (as built)

### 1.1 Sequence for `POST /api/ask-ai`

| # | Step | Code | Pool slot held? | Latency budget |
|---|------|------|-----------------|----------------|
| 1 | Session → `getScopedClient()` (cookie, user, epoch, org status) | `route.ts:379-382`, `lib/db.ts:164-221` | yes (dashboard pool, max 10) | 5–20 ms |
| 2 | Usage cap (`assertUsageAllowed`) | `route.ts:384-395` | yes | DB read |
| 3 | Rate limit (Redis fixed window 8 rps per user, else in-memory) | `route.ts:397-401`, `lib/rate-limit.ts:139-153` | yes | up to 1.5 s Redis socket timeout |
| 4 | Org name, user email, connected `channels` | `route.ts:406-424` | yes | 3 queries |
| 5 | Parse body, reject `org_id`, require `prompt` | `route.ts:426-443` | yes | — |
| 6 | Resolve or create the conversation, load mode, user prefs, last 12 messages (2 000 chars each), insert the user message | `route.ts:445-473` | yes | 5 queries |
| 7 | Load `ai_employees` | `route.ts:475-526` | yes | 1 query |
| 8 | Resolve mode (body > conversation > last choice > auto), validate ids, apply `@Name` | `route.ts:528-550`, `lib/ask-mode.ts:214-305` | yes | pure |
| 9 | Persist mode + audit a change | `route.ts:552-568` | yes | 3 queries |
| 10 | **Release** the pool client | `route.ts:571` | no | — |
| 11 | Pick employee + allowlist for the turn | `route.ts:573-620` | no | pure |
| 12 | Locked hand-off check → NDJSON hand-off answer | `route.ts:622-650` | no | pure |
| 13 | Classify (`classifyRequest`) | `route.ts:657`, `lib/classify.ts:118-170` | no | 0 ms (heuristic) to 20 s (LLM) |
| 14 | Load promoted playbooks | `route.ts:658` | short checkout | 1 query |
| 15a | Plan path (explicit `/plan`, "create a plan", or playbook match): generate, stamp employees, insert `agent_plans`, start a waiting Temporal workflow when durable, return JSON | `route.ts:676-785` | short checkouts | up to 60 s planner |
| 15b | Team mode → crew stream | `route.ts:789-806` | no | 2 × turn |
| 15c | Auto + heuristic crew hint → crew stream | `route.ts:808-826` | no | 2 × turn |
| 15d | Default → single agent stream | `route.ts:828-842` | no | turn |
| 16 | Concurrency lease (in-process, 3 per org) | `route.ts:974-975`, `:1272-1275` | no | — |
| 17 | Memory retrieval (SQL tiers + Cognee + Hindsight, 6 s cap) | `route.ts:1294-1301`, `memory/retrieve.ts:731-760` | workflows pool | ≤ 6 s |
| 18 | Agent turn: in-process engine, model candidates in order, then HTTP sidecar | `trueforge-client.ts:576-699`, `local-turn.ts:958-1003` | workflows pool per tool | 120 s per candidate |
| 19 | Langfuse trace, persist assistant message, memory write-back workflow | `route.ts:1336-1389` | short checkout | — |
| 20 | `approval` event if paused, then `done` | `route.ts:1394-1428` | — | — |

### 1.2 What works

- The pool client is released before every slow step (`route.ts:571`); plan
  inserts and assistant persistence use short-lived checkouts
  (`route.ts:105-112`, `lib/ask-ai-persist.ts:5-18`). This honours AGENTS.md
  rule 3 on the main path.
- `org_id` in the body is refused (`route.ts:433-436`); org comes from the
  session only.
- History is bounded (12 messages × 2 000 chars, `route.ts:455-467`).
- A failed context load is surfaced as a `warning` event, not hidden
  (`route.ts:1287-1293`).

### 1.3 Broken

| ID | Finding | Evidence | Impact | Fix | Pri | Eff |
|----|---------|----------|--------|-----|-----|-----|
| LC-B01 | The user message is inserted (step 6) before mode validation (step 8). A 400 from `resolveAskMode` ("single mode requires exactly 1 employeeId", unknown id) leaves a user message with no reply in the thread, and the client shows only the error. | `route.ts:468` then `:546-549` | Dangling prompts in history; the next turn's 12-message window contains an unanswered question the model may try to answer. | Move `insertAskAiMessage` after `resolveAskMode` succeeds, or delete it on the 400 path. | P2 | S |
| LC-B02 | If `resolveConversationId` throws, `conversationId` keeps the raw client value (`route.ts:445`), `contextLoadFailed` is set, and the turn still persists the assistant reply to that id (`route.ts:1361-1376`). The id was never ownership-checked, so a reply can be written into another user's Ask AI thread in the same org. | `route.ts:445-473`, `:1361` | Cross-user write inside an org (RLS only scopes by org). | On any failure in step 6 set `conversationId = ''` and skip persistence, or re-run `findOwnedAskAiConversation` before every write. | P1 | S |
| LC-B03 | Classification (step 13) runs on every non-hand-off turn, but its result only matters when a playbook matches or a plan was explicitly requested (`route.ts:671`). For prompts ≥ 150 chars or with mixed simple/complex words it makes a blocking LLM call with a 20 s timeout (`classify.ts:106`, `:143-147`) before the stream opens. | `route.ts:657-671` | Up to 20 s of dead air, with no event sent, on long prompts; paid tokens for a result that is then ignored. | Run `matchPlaybook` + `matchOrgPromotedPlaybook` first (pure); call the LLM classifier only when neither matched **and** the answer could change the path. Better: open the NDJSON stream first and send `routing` + a `status: classifying` event. | P1 | S |
| LC-B04 | Nothing is streamed until step 16. Steps 1–15 (up to ~26 s with the classifier and Redis timeout) produce no bytes, so proxies with idle timeouts and the UI spinner have no signal. | `route.ts:365-842` | Perceived hangs; possible proxy 504s on slow classify. | Return the `ReadableStream` immediately after auth and emit `routing`, `status` events as each phase finishes. | P1 | M |
| LC-B05 | The NDJSON responses set only `Content-Type` (`route.ts:951`, `:1253`, `:1449`). `execute` sets `Cache-Control: no-transform` and `X-Accel-Buffering: no` (`execute/route.ts:36-43`); chat does not. Behind nginx or a compressing proxy the chat stream can be buffered until the turn ends. | as cited | No token streaming in production behind Caddy/nginx with buffering or gzip. | Reuse `sseHeaders()` minus the content type for all NDJSON responses (`route.ts`, `approve/route.ts:241`). | P1 | S |
| LC-B06 | `streamSimpleAnswer`'s `send()` is not guarded (`route.ts:1281-1283`). After the client disconnects, `controller.enqueue` throws inside `onChunk`, inside the agent loop; the catch then calls `send('error')`, which throws again, and `controller.close()` in `finally` throws a third time. The crew path has a guard (`route.ts:981-989`); the simple path and `approve` (`approve/route.ts:163-165`) do not. | as cited | Unhandled rejections in `start()`; the disconnect becomes an error log storm instead of a clean abort. The lease is released first, so no slot leak. | Copy the `streamOpen` guard from `streamCrewAnswer` into `streamSimpleAnswer`, `streamHandoffAnswer` and `approve`. | P2 | S |
| LC-B07 | On user abort the assistant reply is never persisted (`route.ts:1333`). The user message was already stored, so the thread shows an unanswered question, and any tool that ran (draft created, CRM row updated) leaves no trace in the conversation. | `route.ts:1333` | History and reality diverge after Stop or a closed tab. | Persist a partial assistant message with `{ aborted: true, executedSteps }` on abort. | P2 | S |

### 1.4 Missing

| ID | Gap | Fix | Pri | Eff |
|----|-----|-----|-----|-----|
| LC-M01 | No request id tying the NDJSON stream, Langfuse trace, `tool_invocations` rows and the persisted message together. | Mint `turnId` at step 1, send it in the first event, pass it as `workflowId`/trace id and store it on the message `tool_calls`. | P2 | S |
| LC-M02 | No per-phase timing in the `done` event (classify ms, memory ms, model TTFB, tools ms). | Add a `timings` object; the UI already has space under each answer. | P2 | S |
| LC-M03 | No idempotency on `POST /api/ask-ai`: a client retry (network blip after the server accepted) runs the whole turn twice. | Accept an `Idempotency-Key` header (client message id) and dedupe on `(conversation_id, client_message_id)`. | P2 | M |

---

## 2. The two chat front doors

### 2.1 What the user actually sees

- `/chat` redirects to `/home` (`NEW-FRONTEND/src/app/(app)/chat/page.tsx`).
- `/home` renders `HomeScreen`. Its default view is `chat` unless in a test or
  forced state (`home-screen.tsx:31-33`). The chat view mounts
  `TrueForgeChat` with `agentName="darex-ai"` (`home-screen.tsx:96-101`).
- `TrueForgeChat` is the vendor `@truefoundry/trueforge-ui` thread with
  `baseUrl: "/api/trueforge"` (`components/chat/trueforge-chat.tsx:10-13`).
  NEW-FRONTEND rewrites `/api/trueforge/:path*` to the dashboard
  (`NEW-FRONTEND/next.config.ts:35`).
- The real Ask AI client, `HomeChat` (`components/home/home-chat.tsx`), with
  the mode picker, plan cards, approvals, history, votes and hand-offs, is
  only rendered in the "Dashboard Overview" view (`home-screen.tsx:122`), and
  it opens answers in a small overlay (`AssistantOverlay`).
- The Actions command bar also sends through Ask AI
  (`components/actions/command-bar.tsx:9`, `send as askAi`).

### 2.2 Broken

| ID | Finding | Evidence | Impact | Fix | Pri | Eff |
|----|---------|----------|--------|-----|-----|-----|
| FD-B01 | `/api/trueforge/[...path]` forwards **any** path and method to the sidecar (`route.ts:20-23`, `:129-134`). A signed-in user can call TrueForge's own APIs (list or read sessions, delete sessions, `api/internal/*`). TrueForge sessions are keyed by `darex:<org>:<key>` external ids, not by caller, so another tenant's sessions are reachable if their ids are listed or guessed. | `apps/dashboard/app/api/trueforge/[...path]/route.ts:16-127` | Cross-tenant read/delete of agent sessions and transcripts. | Replace the catch-all with an allowlist of the exact paths the UI needs (create session for *this* org's external id, post turn, stream). Validate that every session id in the path belongs to `darex:<session org>:`. Better: retire the proxy (FD-B04). | P0 | M |
| FD-B02 | When `getScopedClient()` throws (expired epoch, disabled user, suspended org) the error is swallowed (`route.ts:70-72`) and the request is still forwarded, with the **client's own headers** copied verbatim (`route.ts:74-79`) and no tenant headers. Middleware only checks that a session cookie parses (`middleware.ts:46-58`), not the DB epoch. | as cited | Signed-out or disabled users keep using the agent; client-supplied `x-org-id` / `x-tfg-mcp-headers` reach TrueForge unfiltered (the bridge rejects unsigned headers only when `MCP_BRIDGE_SECRET` is set). | Return 401 when `getScopedClient` fails; strip every `x-org-id`, `x-user-id`, `x-tfg-*`, `x-employee-*` header from the incoming request before forwarding. | P0 | S |
| FD-B03 | The proxy path skips: usage cap, Ask AI rate limit and concurrency lease, mode selector, hand-offs, classify/plan, `messages` persistence, Langfuse metering at the route, `crew.dispatch`/`tool.approve` audit rows, and the approver RBAC in `approve/route.ts:108-138`. Approvals in the TrueForge UI go straight to the sidecar. | proxy route vs. `ask-ai/route.ts` | The default chat is outside every control built for Ask AI; spend is still metered per turn only if the sidecar reports usage. | Make `/home` chat use `HomeChat`/`lib/state/chat.ts` (or a full-page version of it), and keep `TrueForgeChat` only behind a feature flag. | P0 | M |
| FD-B04 | Employee choice in the proxy comes from a client header or query (`x-employee-role`, `employee_id`, `route.ts:37-38`), defaulting to the Executive. This is a second, unvalidated mode selector that ignores the per-conversation mode stored by Ask AI. | `route.ts:37-64` | Two different "who answers" answers for the same user. | Same as FD-B03. | P1 | S |

### 2.3 Missing

| ID | Gap | Fix | Pri | Eff |
|----|-----|-----|-----|-----|
| FD-M01 | No full-page Ask AI. `HomeChat` answers in an overlay with no sidebar of conversations, no plan pane, no tool trace. | Build `/home` chat view on `useChat()`; reuse `AssistantOverlay` message rendering. | P1 | M |
| FD-M02 | No contract test that `/home` talks to `/api/ask-ai`. | Add a Playwright test: send "hi" from `/home`, assert one `POST /api/ask-ai` and zero `/api/trueforge/*` requests. | P1 | S |

---

## 3. Classification and plan triggering

Code: `apps/dashboard/lib/classify.ts`, `route.ts:652-671`,
`lib/playbook-matcher.ts`, `lib/insight-engine.ts` (`matchOrgPromotedPlaybook`).

### 3.1 How it works

1. A daily-brief regex short-circuits to simple (`classify.ts:124`).
2. Heuristics: `COMPLEX_HINTS` and `SIMPLE_HINTS` regexes (`classify.ts:18-46`).
   Simple-only → simple at 0.9.
3. A shipped playbook match at or above the threshold → complex with that
   playbook (`classify.ts:133-141`).
4. Complex-only and shorter than 150 chars → complex at 0.85
   (`classify.ts:143-145`).
5. Otherwise an LLM call through LiteLLM, 300 tokens, 20 s timeout
   (`classify.ts:82-113`), then a heuristic fallback.
6. The route then only builds a plan when the user asked for one
   (`body.mode === 'plan'`, a `/plan` or `plan:` prefix, or "create/generate/
   draft/make a plan/playbook") **or** a playbook matched (`route.ts:652-671`).
   A complex classification without a playbook streams through the agent.

### 3.2 What works

- Greetings never become plans or crews (`classify.ts:40`, `route-employee.ts:436`).
- The LLM classifier can only name a known playbook id (`classify.ts:58-59`).
- A planner failure degrades to a streamed answer with the reason traced
  (`route.ts:765-784`).

### 3.3 Broken

| ID | Finding | Evidence | Impact | Fix | Pri | Eff |
|----|---------|----------|--------|-----|-----|-----|
| CL-B01 | The classifier's `complex` verdict is unused unless a playbook matched (`route.ts:671`), so the LLM call in step 5 is paid for nothing on most turns (LC-B03). | `route.ts:657-671` | Cost and latency. | Skip `classifyWithAgent` unless it could return a playbook: pass `playbookOnly: true` and return early when no playbook keywords exist. | P1 | S |
| CL-B02 | `"draft a plan"` triggers the plan path through the explicit regex (`route.ts:655`), but so does any sentence containing "make a plan" in passing ("we need to make a plan for Q4, what are the risks?"). That question becomes an approval card with tool steps. | `route.ts:655` | Questions turn into plans. | Require the phrase at the start, or require a tool-shaped verb after it; keep `/plan` and the UI toggle as the reliable trigger. | P2 | S |
| CL-B03 | `parseClassifierJson` falls back to `content.includes(id)` for playbook ids (`classify.ts:69`). A model reply that mentions a playbook name while answering SIMPLE still attaches that playbook when the type match is COMPLEX elsewhere in the text. | `classify.ts:67-79` | Rare false playbook plans. | Only accept `playbook` from the parsed JSON object. | P2 | S |

### 3.4 Missing

| ID | Gap | Fix | Pri | Eff |
|----|-----|-----|-----|-----|
| CL-M01 | No "Plan first" toggle in the UI. The server supports `body.mode === 'plan'` (`ask-mode.ts:93-94`), but the client always sends the employee mode in `mode` (`chat.ts:124`), so the explicit plan request is only reachable by typing `/plan`. The `mode` field is overloaded for two meanings. | Add `planFirst: boolean` to the body; keep `mode` for the employee mode. Add a toggle next to the mode picker. | P1 | S |
| CL-M02 | No risk-based plan forcing. A prompt that will obviously send to many recipients ("email all 300 leads") streams through the agent and relies on per-call approvals. | When the classifier or planner sees a bulk send/pay intent, force the plan path so the user reviews one card. | P2 | M |

---

## 4. Routing and the employee mode selector

Code: `lib/ask-mode.ts`, `lib/ask-employee.ts`, `lib/employee-mentions.ts`,
`lib/handoffs/*`, `services/workflows/src/route-employee.ts`,
`lib/crew-planner.ts`, UI `components/home/ask-mode-picker.tsx`.

### 4.1 How it works

- **Auto:** `routeAskEmployee` scores the message against keyword weights per
  roster key and picks the best active employee (`route-employee.ts:413-492`).
  Emergency words go to a dispatch employee or nobody; greetings and
  "who are you" go to support; below 0.5 confidence the turn goes to support,
  else the Executive, else nobody (`route-employee.ts:476-490`). The allowlist
  is that employee's card plus core reads plus connected channels on the card
  (`ask-employee.ts:160-173`). If nobody is routed, the turn uses the org
  union of all cards (`route.ts:607-612`).
- **Auto crew:** after routing, `heuristicCrewPlan` looks for two or more
  domain keyword groups (`crew-planner.ts:271-326`); if found, the turn is a
  crew with **org-union** allowlists (`route.ts:808-826`, `lockedAllowlists:
  false`).
- **Pick one:** body `mode: 'single'` with exactly one UUID; validated against
  the session org roster; paused/archived falls back to Auto with a notice
  (`ask-mode.ts:149-212`).
- **Team:** 1–3 UUIDs, fixed members, each with a locked allowlist
  (`route.ts:789-806`).
- **@Name:** overrides the mode for one message only, active employees only
  (`ask-mode.ts:264-283`).
- **Persistence:** the chosen mode is stored per conversation and as the
  user's last choice (`route.ts:254-315`), audited only on change.
- **Hand-off:** in Pick one / Team, when every locked employee's role matches
  a hand-off rule for the message, the server answers with a hand-off offer
  instead of running the turn (`route.ts:622-650`, `lib/handoffs/types.ts:55-74`).

### 4.2 What works

- Picking never widens: locked turns use `allowlistForLockedEmployeeTurn`
  (`ask-employee.ts:154-173`), and the gate re-checks the DB card
  (`tool-gate.ts:242-251`).
- Server-side validation rejects unknown ids and ids from other orgs
  (`ask-mode.ts:190-203`).
- `@Name` respects paused status (`ask-mode.ts:276`).
- Mode changes and crew dispatches are audited (`route.ts:282-306`, `:1086-1101`).

### 4.3 Broken

| ID | Finding | Evidence | Impact | Fix | Pri | Eff |
|----|---------|----------|--------|-----|-----|-----|
| RT-B01 | **No-employee turns cannot use any tool.** When Auto returns null, the agent input gets `employeeRole: 'Primary Business Assistant'` and no `employeeId` (`route.ts:1308-1310`). The gate loads the employee by role (`tool-executor.ts` `loadGateEmployee` → `pickEmployeeForRole`); "primary business assistant" matches no role, roster key or persona family, so every call is denied `missing_employee` (`tool-gate.ts:200-206`) — including `web_search` and `database_query`, because identity is checked before the core-read rule. | as cited; `route-employee.ts:419-427` (emergency), `:432-434` (no active employees) | "Our pipeline is leaking deals, find out why" (matches `leaking`) or any org whose employees are all paused gets a model that cannot call anything. | When Auto finds nobody, fall back to the Executive row or the first active employee (as plans already do, `ask-mode.ts:360-370`), and pass `employeeId` explicitly. If the org has no active employee, answer with a clear "no active employee" message. | P1 | S |
| RT-B02 | `EMERGENCY_RE` (`route-employee.ts:77-86`) matches ordinary business words: `fire` ("fire off an email"), `leaking`, `smoke` ("smoke test"), `sparks`, `flood` ("flood of tickets"). In Ask AI these route to dispatch/human, which falls into RT-B01. | `route-employee.ts:77-86`, `:419-425` | Normal requests lose their tools. | Apply the emergency rule only on inbound customer channels (webhooks), not in Ask AI; or require two signals (emergency word plus property/tenant context). | P1 | S |
| RT-B03 | **Auto crew widens permissions.** The heuristic crew path passes `orgTools` and `lockedAllowlists: false` (`route.ts:815-820`), so each specialist gets `allowlistForEmployeeTurn(card, orgUnion, …)` (`ask-employee.ts:139-152`): every tool any employee has. AGENTS.md §4a says "picking an employee never widens its allowlist"; Auto crews do. The gate's card check (`tool-gate.ts:244`) still blocks off-card calls, so the effect is wasted schemas and model confusion rather than an escalation — but the model is offered tools it will be refused. | as cited | Refused tool calls, longer prompts, wrong expectations in replies. | Use `lockedAllowlists: true` for Auto crews too. | P1 | S |
| RT-B04 | **Auto crew fires on common two-domain words.** `heuristicCrewPlan` spawns a crew when two domain groups match (`crew-planner.ts:285-306`). "Email the lead about tomorrow's meeting" matches the support group (`meeting`) and the sales group (`email`, `lead`), so a single-employee request becomes a two-specialist crew plus a manager synthesis: three model loops instead of one. | `crew-planner.ts:52-60`, `:295` | 3× cost and latency for ordinary asks; the routed employee from step 11 is discarded. | Only spawn an Auto crew when the routed employee's card cannot cover both domains, or when the prompt explicitly asks for multiple people; otherwise keep the routed solo. Add tests for the ten most common phrasings. | P1 | M |
| RT-B05 | Low-confidence Auto goes to Customer Support (`route-employee.ts:486-489`). Generic asks such as "write a strategy memo in Google Docs" or "summarize my business" land on Emma, whose card usually lacks Docs/Slides/Sheets, so the turn has the wrong tools. | `route-employee.ts:476-490` | Wrong employee for open-ended work, which is the most common chat ask. | Fall back to the Executive (cross-domain, broad read card) for low confidence in Ask AI; keep support for inbound channels. | P1 | S |
| RT-B06 | The mode picker lists every employee, including paused ones (`ask-mode-picker.tsx:23`). Picking a paused one silently falls back to Auto on the server (`ask-mode.ts:204-207`); the notice is sent in `routing.fallbackNotice`, which the client ignores (RT-B07). | as cited | The user thinks they are talking to the chosen employee. | Filter options to active employees and show paused ones disabled with a tooltip. | P2 | S |
| RT-B07 | **The client ignores the `routing` event.** `applyAskEvent` has no `routing` case (`lib/api/ask-ai.ts:141-181`). Auto's reason ("Routed to Sarah: keyword match"), `overriddenByMention` and `fallbackNotice` never reach the screen. Only `employeeName · employeeRole` from `done` is shown as "handled by" (`ask-ai.ts:115-120`), and the crew path sends `employeeName: 'Crew'` with the routing reason as the role (`route.ts:1227-1228`). | as cited | "Auto (router picks and shows why)" from AGENTS.md §4a is not met in the UI. | Handle `routing` in `applyAskEvent`: store `routing` on the message and render a chip "Auto → Sarah · keyword match", a notice for fallbacks, and "@Name override" when set. | P1 | S |
| RT-B08 | Selecting "Pick one" sends `mode: 'single', employeeIds: []` until an employee is chosen (`ask-mode-picker.tsx:30`, `chat.ts:102-106`), which the server rejects with 400 "single mode requires exactly 1 employeeId" (`ask-mode.ts:170-173`); the user message is still stored (LC-B01). | as cited | First message after switching modes fails. | Client: do not switch to single/team until at least one employee is chosen, or send `auto` while the selection is empty. | P2 | S |
| RT-B09 | Session instructions are frozen per conversation on the HTTP sidecar path. `getOrCreateTrueForgeSession` keys the session by `conversationId` (`trueforge-client.ts:456-461`) and sets `instructions: buildSystemPrompt(input)` only at creation (`:485`). Later turns routed to a different employee, or with `@Name`, keep the first employee's persona; only the tool header changes per turn. | as cited | Wrong persona and hand-off rules after the first turn when the sidecar path is used (no local model key, or all local candidates failed). | Include the employee id in the external id (`darex:<org>:<conversation>:<employee>`), or send the persona as a per-turn system message. | P1 | S |
| RT-B10 | Identity at the gate is by role, not id, on the in-process path: `DarexLocalToolSet.callTool` passes `employeeRole` but not `employeeId` (`local-turn.ts:568-575`). Two employees with the same role (two custom "Sales" employees, a duplicate seeded row) resolve to the first active one (`tool-executor.ts` `pickEmployeeForRole`), so the gate checks the wrong card and logs the wrong employee. | as cited | Wrong card enforced; wrong per-employee metrics and approval attribution. | Add `employeeId` to `DarexLocalToolSet` and pass it on every call; the dashboard already has it (`route.ts:1308`). | P1 | S |

### 4.4 Missing

| ID | Gap | Fix | Pri | Eff |
|----|-----|-----|-----|-----|
| RT-M01 | No `@` autocomplete in the chat bar; users must know exact names. | Popover on `@` listing active employees; insert the canonical name. | P2 | S |
| RT-M02 | No per-message "answered by" badge persisted. On reload the employee is gone because `restoreThread` drops `tool_calls.routing` (`ask-ai.ts:286-292`). | Return `routing` in GET messages and map it in `restoreThread`. | P2 | S |
| RT-M03 | Hand-off "Hand to" switches the mode but does not resend the request (`chat.ts:401-406`). | Offer "Hand to X and ask again" that sets the mode and re-sends the last prompt. | P2 | S |
| RT-M04 | No hand-off suggestion in Auto. If Auto routes to the wrong employee, nothing offers a switch. | When a locked-style hand-off rule matches the routed employee, emit a non-blocking `handoff` suggestion with the answer. | P2 | M |
| RT-M05 | Team mode has no per-member task split: every member gets the full prompt (`ask-mode.ts:336-341`). | Run `planCrew` constrained to the selected members to split tasks (membership stays fixed). | P2 | M |

---

## 5. Planning, plan cards and execution

Code: `lib/plan-generator.ts`, `route.ts:676-785`, `api/ask-ai/plan/route.ts`,
`api/ask-ai/execute/route.ts`, `api/ask-ai/revise/route.ts`,
`services/workflows/src/workflows/PlanExecuteWorkflow.ts`,
`activities/orchestration.ts:293-355`, `plan-step-actor.ts`, UI
`components/home/plan-card.tsx`, `lib/state/chat.ts:157-320`.

### 5.1 How it works

- The planner is one LiteLLM JSON call (1 200 tokens, 60 s timeout) that must
  use the provider keys in `VALID_TOOLS` (`plan-generator.ts:23-33`,
  `:158-210`). Steps are capped at 12 (`:124`), deduplicated, normalised.
- Steps are stamped with the routed or chosen employee
  (`route.ts:685-696`, `ask-mode.ts:360-409`).
- Plans whose steps include send/pay/sign/publish/delete start a Temporal
  `PlanExecuteWorkflow` that waits up to 24 h for approval
  (`route.ts:722-729`, `PlanExecuteWorkflow.ts:121-135`).
- Approve (`PATCH plan`) checks RBAC (pay, refunds), audits, signals
  Temporal; execute (`GET execute`) atomically flips `approved → running`,
  then either polls the workflow's progress query (durable) or runs stages
  in-process with SSE (`execute/route.ts:147-269`, `:271-646`).
- Each step runs as its stamped employee through the gate
  (`execute/route.ts:471-496`).

### 5.2 What works

- Atomic execute lock; 409 on a second click (`execute/route.ts:147-159`), and
  the client also guards double clicks (`chat.ts:170-173`).
- Cancel is checked between stages with an org-scoped client
  (`execute/route.ts:395-409`); the durable workflow honours `rejected`
  between stages (`PlanExecuteWorkflow.ts:156-170`).
- Mid-plan failure marks `completed_with_errors` and records a freeze log
  (`execute/route.ts:567-584`).
- Step edit, enable/disable and draft revise are wired from the chat card
  (`chat.ts:247-299`).

### 5.3 Broken

| ID | Finding | Evidence | Impact | Fix | Pri | Eff |
|----|---------|----------|--------|-----|-----|-----|
| PL-B01 | **Approved plan sends are parked, and the plan reports success.** `executePlanStepActivity` calls `executeAutonomousToolAction` without `approvedPendingActionId` (`activities/orchestration.ts:329-340`); the in-process SSE path does the same (`execute/route.ts:484-495`). For any confirm-class step the gate parks the call (`tool-gate.ts:346-348`) and returns `status: 'pending_approval'`. Neither executor treats that as an error or a wait, so the step shows "done" and the plan ends `completed` (`PlanExecuteWorkflow.ts:208-215`, `execute/route.ts:591-605`). | as cited | The user approved the plan, sees "Completed", but the email/charge/signature waits in Actions for a second approval. This is the core promise of plan-confirm-execute. | Treat PlanCard approval as the human approval: on plan approve, create one `agent_pending_actions` row per confirm-class step already in `approved` state (with approver, payload hash) and pass its id as `approvedPendingActionId` on execution, so the gate's approved path runs (`tool-gate.ts:213-221`, `:307-322`). Until then, map `pending_approval` to a distinct step state `waiting_approval` and a plan status `waiting_approval`, never `completed`. | P0 | M |
| PL-B02 | `VALID_TOOLS` covers 38 provider keys plus core (`plan-generator.ts:23-33`). Plans cannot include Instagram, `operations` (work items, reconcile, rent reminders), `re`/`rera` (listings, inquiries, showings), `metrics`, `cognee`, `growth`, `customer-ops`, `daily_brief`, `billing`, `connectors`; steps naming them are silently dropped by `sanitizeSteps` (`:127`). | as cited; tool list in `chat-coverage.md` | "Create a work item and email the owner" plans only the email. | Derive `VALID_TOOLS` and the action list from `TOOLS` in `services/workflows/src/tool-definitions.ts` (one source of truth) and filter by the stamped employee's card. | P1 | S |
| PL-B03 | The planner prompt hard-codes an action list (`plan-generator.ts:176`) that has drifted: it offers `google-tasks: tasks_create`, which has no chat tool (only `tasks_list` exists in `chat-coverage.md`), and omits new actions (`read_email`, `reply_email`, `draft_reply`, Outlook read/reply, Slack threads, Instagram). A step with an unknown action is refused at execute time as "not a registered tool action" (`tool-gate.ts:259-261`). | as cited | Plans that look fine fail at step N after earlier steps already ran. | Generate the action list from `TOOLS`; validate `(tool, action)` against `resolveCallRisk` in `sanitizeSteps` so bad steps never reach the card. | P1 | S |
| PL-B04 | The planner only sees connected **channels** (`route.ts:683`, `connectedPlannerTools`), not the stamped employee's card. A plan can include a step the employee cannot run; execution then fails `not_in_allowlist` mid-plan. | `plan-generator.ts:113-118`, `:164` | Partial plans with freeze logs for something knowable at plan time. | Pass the employee's effective allowlist to `generatePlan` and filter steps by it; show "needs X's card" on any dropped step. | P1 | S |
| PL-B05 | `CORE_PLAN_TOOLS` includes `sandbox` and `file_ops` (`plan-generator.ts:15-21`), but both are `NEVER_CORE` at the gate (`tool-gate.ts:31-34`). For employees without them on the card those steps always fail. | as cited | Same as PL-B04. | Remove them from `CORE_PLAN_TOOLS`; add only when on the card. | P2 | S |
| PL-B06 | **Client disconnect leaves the plan `running` and the in-flight step unrecorded.** On abort the loop returns without updating the plan (`execute/route.ts:381-394`, `:519-521`). `raceAbort` rejects the race but does not stop the tool call (`execute/route.ts:50-68`), so the provider call can still succeed; its result is never written to `steps`. Re-opening the plan resumes from `current_step` (`:433-441`) and runs that step again. | as cited | Duplicate CRM records, duplicate drafts, duplicate non-confirm writes (sends are durable and go through Temporal, so they are not affected). | Pass an `AbortSignal` into `executeAutonomousToolAction` (the executor already supports one internally, `tool-executor.ts` `executeWithTimeout`), and on abort await the in-flight calls with a short grace period and persist their outcomes before returning. Mark the plan `interrupted` (new status) instead of leaving `running`. | P1 | M |
| PL-B07 | The durable SSE path polls for at most 600 × 400 ms = 240 s (`execute/route.ts:235-253`) and then closes the stream with no terminal event. The client then shows "The run ended unexpectedly" and marks the plan `completed_with_errors` locally (`chat.ts:196-199`) while the workflow may still be running or waiting. | as cited | Long plans look failed in the UI. | Send a `still_running` event and let the client reconnect (the `running` branch already supports re-attach); never infer a final status client-side — re-read `GET plan`. | P1 | S |
| PL-B08 | `PATCH plan` approve uses `UPDATE … SET status='approved'` without a status predicate (`plan/route.ts:164-167`) after an earlier read (`:108-127`). A cancel that lands between the read and the update is overwritten to `approved`. Cancel has the same pattern (`:228-231`). | as cited | Cancelled plans can be resurrected by a slow approve. | `WHERE id=$1 AND org_id=$2 AND status='pending' RETURNING id`; 409 when no row. | P1 | S |
| PL-B09 | If the Temporal signal fails on cancel, the plan is reverted to `pending` (`plan/route.ts:252-264`), even if it was `approved` or `running`. For non-durable plans with no workflow the signal may fail every time Temporal is down, so **cancel is impossible while Temporal is down**. | as cited | Stop does not stop; status regresses. | Only signal when the plan is durable or a workflow exists; on signal failure keep `cancelled` in the DB (the SSE loop and workflow both read it) and report a warning. | P1 | S |
| PL-B10 | `revise` holds the pooled client across the LLM call (`revise/route.ts:19-21`, `:65`, released in `finally` at `:94`). A 60 s planner call pins one of the 10 dashboard slots. | as cited | Pool starvation under concurrent revisions (AGENTS.md rule 3). | Release after the read, call the LLM, re-acquire for the update with a `WHERE status IN (...)` predicate. | P1 | S |
| PL-B11 | `revise` accepts `completed` and `completed_with_errors` plans and moves them back to `pending` (`revise/route.ts:53`, `:73-78`). Steps keep `status: 'completed'` and `current_step`, so a re-approved plan replays cached results and runs nothing, while the UI shows it ran. It also accepts `failed`, a status the FSM never writes. | as cited | Confusing "re-run" that does not re-run. | Allow revise only on `pending`/`approved`; offer "Duplicate as new plan" for finished ones. | P2 | S |
| PL-B12 | `revise` rewrites only the draft text, never the steps' payloads. The step that sends the email still carries the old body unless the planner used `{{draft}}`-style wiring, which it does not. | `revise/route.ts:61-78`, `plan-generator.ts:173` | The revised draft is not what gets sent. | After revising, re-render step payload fields that held the draft (store a `draftField` pointer on the step at plan time). | P1 | M |
| PL-B13 | Deleting a conversation deletes its plans, including `running` ones (`conversations/route.ts:276-280`). The SSE loop then updates a missing row and the durable workflow keeps going. | as cited | Orphaned executions with no record. | Refuse delete while a plan is `running`/`approved`, or cancel first and soft-delete. | P2 | S |
| PL-B14 | The approve RBAC check for refunds is a regex over `tool action` (`plan/route.ts:152-156`); `isPayTool` covers pay. A plan step `stripe.create_refund` matches, but a renamed provider action would not. | as cited | Fragile RBAC. | Use `resolveCallRisk(tool, action)` and a `refund` risk flag from the tool definition. | P2 | S |
| PL-B15 | `restoreThread` restores only `pending`/`approved` plans (`ask-ai.ts:293-302`). A `running` plan disappears after a reload; the user cannot reattach or stop it from chat. | as cited | Lost control of running plans. | Restore `running` plans with a "Reattach" action that calls `execute` (server already supports re-attach, `execute/route.ts:160-169`). | P1 | S |

### 5.4 Missing

| ID | Gap | Fix | Pri | Eff |
|----|-----|-----|-----|-----|
| PL-M01 | No compensation/undo for executed steps (freeze log only). | Add inverse actions per tool (`hubspot.create_contact` → archive, `calendar.create_event` → delete) and an "Undo completed steps" button. | P2 | L |
| PL-M02 | No plan diff before approve (who receives what, which record changes). | Render recipients/amounts/record ids per step from the payload with a risk badge. | P2 | M |
| PL-M03 | No startup sweep for plans stuck in `running` after a dashboard restart (the in-memory `activePlanExecutions` set is lost). | Periodic sweep: `running` with `updated_at < now() - 15 min` and no workflow → `interrupted`. | P2 | S |
| PL-M04 | Plans cannot be produced by the agent mid-conversation ("make that a plan"). | Give the agent a `plan_propose` tool that writes an `agent_plans` row and returns the card. | P2 | M |

---

## 6. Approvals inside a chat turn

Code: `local-turn.ts:357-391`, `:883-898`, `:929-941`, `:1032-1136`;
`trueforge-client.ts:486-496`, `:636-680`, `:989-1065`;
`api/ask-ai/approve/route.ts`; `tool-gate.ts:307-363`; UI
`chat.ts:322-356`, `components/home/assistant-overlay.tsx`.

### 6.1 How it works

Two independent approval layers exist:

1. **Engine approval** (TrueForge): the in-process tool set marks confirm-class
   tools and, unless `REQUIRE_TOOL_APPROVAL=false`, every write as
   approval-required (`local-turn.ts:357-391`, `:617-632`). The sidecar uses
   `require_approval_for_tools: ['@destructive']` (or `@write` too)
   (`trueforge-client.ts:490-493`). The turn pauses; the route sends an
   `approval` event with `sessionId` and call ids (`route.ts:1394-1400`). The
   client posts decisions to `/api/ask-ai/approve`, which audits and resumes
   (`approve/route.ts:140-175`).
2. **Gate approval** (Darex): every confirm-class call, every call below the
   skill tier minimum, rollout `escalate`, and autonomy `approval_required`
   is parked into `agent_pending_actions` (`tool-gate.ts:346-362`), decided
   later on Actions / `api/decisions`, and re-entered with
   `approvedPendingActionId`.

### 6.2 Broken

| ID | Finding | Evidence | Impact | Fix | Pri | Eff |
|----|---------|----------|--------|-----|-----|-----|
| AP-B01 | **Double approval for every send/pay/sign/publish/delete/execute.** After the user allows the call in chat, the resumed tool runs `executeAutonomousToolAction` without an approved pending-action id (`local-turn.ts:568-575`, bridge `mcp-bridge.ts:1778-1785`), and the gate parks it again (`tool-gate.ts:348`). The model receives `pending_approval` and says "Waiting for approval". | as cited | "Send this email" from chat never sends from chat; it needs a second approval in Actions. Write approvals (`REQUIRE_TOOL_APPROVAL` default) also cover drafts, so a draft asks once in chat and then runs. | Unify on the gate: make the in-process `toolCallInfo` report `is_approval_required: false` for anything the gate will park, and surface the gate's `pending_approval` result to the chat as an approval card bound to `pendingActionId` (Approve → `/api/decisions` path, which re-enters with `approvedPendingActionId` and then resumes the turn). Alternatively, when the chat approval is granted, write an `agent_pending_actions` row in `approved` state and pass its id on the resumed call. One human click per action. | P0 | M |
| AP-B02 | **The approver RBAC uses client-supplied tool names.** `approve/route.ts` decides pay/refund RBAC from `d.tool`/`d.action` in the body (`:116-137`). The client never sends them (`chat.ts:337-341` sends only `threadId`, `toolCallId`, `decision`), so the pay and refund checks always see `undefined` and pass. A member allowed to approve actions can therefore approve a pay call in chat. | as cited | Pay RBAC bypass on the engine layer (the gate still parks pay calls, AP-B01, so today the second approval in Actions is what actually enforces it). | Resolve the tool for each `toolCallId` server-side from the paused session (local: `activeLocalOrchestrators.get(sessionId).callIdToName`; sidecar: session state), and ignore client `tool`/`action`. | P0 | S |
| AP-B03 | **The resume allowlist is the union of all providers.** `RESUME_TOOL_ALLOWLIST` is `VALID_TOOLS` plus code/sql/file tools (`approve/route.ts:19-29`). The comment says it matches the simple path; it does not: the simple path uses the employee's locked allowlist. On the sidecar path this header replaces the turn's narrow list for the rest of the resumed turn. The gate still enforces the employee card when the role header is present, but see AP-B04. | as cited | Wider tool exposure after approval. | Store the original turn's allowlist and employee id with the paused session (dashboard-side table keyed by `sessionId`, scoped to org and user) and reuse it on resume. | P1 | S |
| AP-B04 | **Resumed sidecar turns lose the employee identity.** `resumeTrueForgeTurn` builds tenant headers with only org, user and allowlist (`trueforge-client.ts:1011-1015`); no `employeeRole`. The bridge keeps a stale role from an earlier turn on the same MCP session (`mcp-bridge.ts:2028`), or falls back to the **model-supplied** `args.employee_role` (`mcp-bridge.ts:1783-1784`; several tool schemas expose `employee_role`, e.g. `mcp-bridge.ts:336`, `:345`, `:380`). The gate then loads whichever employee that role names (`tool-gate.ts:200-203`). | as cited | The model can choose which employee's card is applied (e.g. claim `Finance` to reach Stripe) on resumed or role-less turns. | Never read `employee_role` from model args at the bridge; require a signed role or employee id, deny otherwise. Pass the stored employee id on resume (AP-B03). Reset `ctx.employeeRole` per request instead of carrying it over. | P0 | S |
| AP-B05 | **Paused in-process sessions are process-local and expire after 30 min.** `activeLocalOrchestrators` is a module `Map`, capped at 500, cleaned every 5 min for entries older than 30 min (`local-turn.ts:79-106`). After a deploy, a crash, on another replica, or after 30 minutes, `resumeLocalTurn` returns null (`:1036-1037`) and `resumeTrueForgeTurn` posts to the sidecar with a session id the sidecar never issued (`trueforge-client.ts:1022-1046`), which fails. The client shows "Could not resume after your decision." | as cited | Approval cards die silently; users approve and nothing happens. | Persist paused-turn state (messages, pending call ids, allowlist, employee) in Postgres and rebuild the orchestrator on resume; or route approvals through the gate (AP-B01) so no in-memory session is needed. At minimum, return a clear "this approval expired, ask again" error and mark the card expired. | P1 | M |
| AP-B06 | **A new message deletes a pending sidecar approval.** If the sidecar session has pending approvals, the next user message gets 422 and the code deletes the session and recreates it (`trueforge-client.ts:638-647`). The pending tool call and its card are gone without telling the user. | as cited | Silent loss of an action the user may still want to approve. | Before sending, check for pending approvals in that conversation and either block with "approve or deny the pending action first" or auto-deny with a visible note. | P1 | S |
| AP-B07 | **Crew turns never surface approvals.** Specialist and manager turns run through `runAutonomousAgentDirect` (`crew-runner.ts:163`, `:186-193`, `:234`), and their `approvals`/`sessionId` are dropped; `streamCrewAnswer` never sends an `approval` event (`route.ts:954-1254`). Any specialist write that needs approval stalls; with in-process turns the paused orchestrator sits in memory until it expires. | as cited | Team mode cannot perform any approval-gated action. | Collect approvals from every spawn and emit one `approval` event per paused specialist with its session id; resume per specialist, then re-run synthesis. Or rely on gate parking (AP-B01) so crews never pause in-engine. | P1 | M |
| AP-B08 | The UI applies one decision to all approvals in a batch (`chat.ts:340`); there is no per-item allow/deny, no view of the arguments (recipient, amount, body), and no edit-before-allow. | `chat.ts:322-356` | Users approve blind. | Show each paused call's tool, summary and key args (the gate's `buildActionSummary` already produces one); per-item buttons; "edit and allow" mapped to `modified_payload` on the gate path. | P1 | M |
| AP-B09 | `approve` has no usage-cap, rate-limit or concurrency lease (`approve/route.ts:52-241`), unlike `POST /api/ask-ai`. A resumed turn can run a full agent loop past a hard cap. | as cited | Spend past the cap. | Call `assertUsageAllowed`, `denyAskAiIfLimitedAsync` and `tryAcquireConcurrency` as in the main route. | P1 | S |
| AP-B10 | `approve` does not check that the session belongs to this user. Any member who can approve actions and learns another user's `sessionId` (it is in that user's network log and stored nowhere else) can resume their turn. The org check exists (`local-turn.ts:1038-1041`). | as cited | Low-likelihood cross-user action inside an org. | Store `(sessionId, orgId, userId, conversationId)` when the approval event is emitted and require a match on resume. | P2 | S |
| AP-B11 | The resumed answer is persisted as a new assistant message (`approve/route.ts:186-201`), but no record of the decision is added to the conversation (only `audit_events`). On reload, the thread shows the original "waiting" answer and then the continuation with nothing in between. | as cited | Confusing history. | Persist a system message "Allowed gmail_send (by Asha, 10:42)" before the continuation. | P2 | S |

### 6.3 Missing

| ID | Gap | Fix | Pri | Eff |
|----|-----|-----|-----|-----|
| AP-M01 | Pending gate approvals created by chat turns are not linked back to the conversation. Approving one in Actions does not post the result into the chat. | Store `conversationId` in the parked payload; on approve/execute in `/api/decisions`, append the outcome to that conversation and publish a realtime event. | P1 | M |
| AP-M02 | No approval expiry shown in chat. | Show "expires in N min" from the stored pause time. | P2 | S |

---

## 7. Streaming protocol

Code: `route.ts:882-1450`, `approve/route.ts:160-241`,
`execute/route.ts:216-268`, `:271-646`; client
`NEW-FRONTEND/src/lib/api/ask-ai.ts:40-181`, `:232-259`; `chat.ts:112-155`.

### 7.1 Events in use

| Event | Producer | Client handling |
|-------|----------|-----------------|
| `routing` | all NDJSON paths (`route.ts:903`, `:992`, `:1286`) | **ignored** (no case in `applyAskEvent`) |
| `warning` | context load failed, crew skips (`route.ts:1288`, `:1010`, `:1020`) | shown as transient `status`, then cleared by `done` (`ask-ai.ts:145-146`, `:170`) |
| `chunk` | model deltas (`route.ts:1327`), crew answer (`:1180`) | appended |
| `tool` | tool progress (`route.ts:1328`) | label + status line |
| `subagent` | dynamic subagents, crew members | list on the message |
| `approval` | paused turn (`route.ts:1395`) | approval card |
| `done` | end of turn | final text replaces the streamed text |
| `error` | thrown errors | error banner |
| `execution_*`, `step_*` (SSE) | plan execute | plan card |

### 7.2 Broken

| ID | Finding | Evidence | Impact | Fix | Pri | Eff |
|----|---------|----------|--------|-----|-----|-----|
| ST-B01 | **Model failover duplicates streamed text.** `runLocalTurn` tries each model candidate in turn (`local-turn.ts:973-999`). Candidate 1 streams chunks to the client via `onChunk` (`:842-846`), then fails (rate limit, 5xx); candidate 2 starts from scratch and streams a second answer into the same message. No reset event exists. | as cited | Garbled replies ("Here is… Here is…") whenever a provider fails mid-stream. The final `done` replaces the text, so it heals at the end, but only if `done` arrives. | Emit `{type:'reset', reason:'model_failover'}` before each retry and have `applyAskEvent` clear `text`; or buffer chunks until the candidate's first tool call/answer is confirmed. | P1 | S |
| ST-B02 | **Local-then-sidecar fallback can re-run the turn.** `runTrueForgeTurnUnmetered` treats an empty local result (no reply, no tools) as failure and runs the whole turn again on the sidecar (`trueforge-client.ts:582-588`). Read-only work and streamed chunks are repeated; side-effect protection exists only when a non-read tool was dispatched (`local-turn.ts:989-994`). | as cited | Double latency and cost on empty answers; duplicate chunks. | Treat an empty local answer as a final answer with a clear message; only fall through when no candidate could start. | P2 | S |
| ST-B03 | `done.answer` replaces the streamed text (`ask-ai.ts:166`). `replyForTurn` may substitute a tool-grounded reply for a placeholder (`trueforge-client.ts:1088-1091`), so the text visibly jumps at the end of the stream. | as cited | Jarring UI; users copy text mid-stream that then changes. | Send `final_replace: true` only when the server actually substituted the reply; otherwise keep the streamed text. | P2 | S |
| ST-B04 | Subagent text deltas are dropped (`local-turn.ts:842-846`, root only) and subagent tool calls are only labels. During a long subagent run the UI shows a spinner with no text. | as cited | Long silent periods. | Stream subagent deltas tagged with `threadId` into the subagent row (collapsed by default). | P2 | M |
| ST-B05 | The `warning` event is overwritten by the next `tool` status and cleared by `done` (`ask-ai.ts:145-150`, `:170`). The "history could not be loaded" notice is effectively invisible. | as cited | Users are not told the reply lacks context. | Store warnings in a `notices` array on the message and render them persistently. | P2 | S |
| ST-B06 | No heartbeat. A 60–120 s tool call (sandbox, large Drive read) produces no bytes; proxies with 60 s idle timeouts drop the stream. | `route.ts:1302-1331` | Mid-turn disconnects that then abort the agent (the signal is bound, `trueforge-client.ts:612`). | Send `{type:'ping'}` every 15 s while the turn is running. | P1 | S |
| ST-B07 | The NDJSON line parser drops any line that fails `JSON.parse` (`ask-ai.ts:10-20`) without logging. A very long chunk split across reads is reassembled correctly, but a server bug that writes a non-JSON line is invisible. | as cited | Silent loss of events. | Count dropped lines and log once per turn in development. | P2 | S |

### 7.3 Missing

| ID | Gap | Fix | Pri | Eff |
|----|-----|-----|-----|-----|
| ST-M01 | No resumable stream. A dropped connection loses the turn's output even though the server finishes it and persists the reply. | Emit `turnId`; on reconnect poll `GET /api/ask-ai?conversationId=` for a message with that `turnId`, or keep a short Redis event log per turn for replay. | P2 | M |
| ST-M02 | No structured "step timeline" (tool → args summary → result summary) streamed; only labels. | Add `tool_result` events with the summary the gate already builds; render a collapsible trace. | P2 | M |

---

## 8. Tool selection: how 154 tools reach the model

Code: `services/workflows/src/tool-definitions.ts` (154 `ToolDef`s),
`local-tool-select.ts`, `skills/catalog.ts:136-190`, `tool-gate.ts:18-34`,
`lib/ask-employee.ts:13-173`, `trueforge-client.ts:50-82`, `:350-375`,
`mcp-bridge.ts:1710-1790`.

### 8.1 How narrowing actually works today

1. **Dashboard allowlist (per turn).** Locked/auto-with-employee:
   `CORE_TOOLS ∪ card ∪ connected channels that appear on the card`, then
   persona deny filter (`ask-employee.ts:154-173`, `:81-97`). Auto with no
   employee: org union of every card (`route.ts:607-612`). Keys are
   normalised to dashes (`ask-employee.ts:54-56`).
2. **In-process schema.** `selectToolsForLocalTurn` keeps catalog tools whose
   name or provider is in the allowlist or the core list
   (`local-tool-select.ts:81-90`, `skills/catalog.ts:172-190`). Only past
   `MAX_SCHEMA_TOOLS = 160` does it rank by intent (`local-tool-select.ts:12`,
   `:91-104`). The catalog has 154 entries, so **the cap never applies**: the
   model gets every allowed tool schema on every call.
3. **Sidecar schema.** The bridge registers all 154 tools for every session
   (`mcp-bridge.ts:1716-1735`) and `enable_tools: ['@all']`
   (`trueforge-client.ts:489`); the allowlist only refuses at call time.
4. **Execution.** The gate checks the DB card and core reads again and narrows
   by the caller list (`tool-gate.ts:242-251`).
5. **Per-turn call budget.** `LOCAL_TURN_MAX_TOOL_CALLS = 25` (env
   `DAREX_LOCAL_MAX_TOOL_CALLS`); after the cap the model gets refusals, and
   after cap + 3 the turn is aborted (`local-turn.ts:438-442`, `:552-564`).
   Identical read calls in one turn are served from a cache
   (`local-turn.ts:547-550`, `:604-606`). The sidecar path has no Darex-side
   call cap.

### 8.2 Broken

| ID | Finding | Evidence | Impact | Fix | Pri | Eff |
|----|---------|----------|--------|-----|-----|-----|
| TS-B01 | **No intent narrowing.** With the cap above the catalog size, a broad card (Executive, org-union auto) sends ~100–154 tool schemas on every model call in the loop. At 150–300 tokens per schema that is roughly 20–45k input tokens per call before history, multiplied by the number of loop iterations. | `local-tool-select.ts:12`, `:88-90` | Dominant share of chat cost; slower first token; weaker tool choice with many near-duplicates (`gmail_fetch` vs `gmail_triage` vs `gmail_read_email`). | Two-stage selection: (a) always include core + tools whose provider matches `intentPriorityKeys` + tools used earlier in this conversation; (b) add a `discover_tools(query)` meta-tool that returns more schemas on demand. Target ≤ 30 schemas per call. Set `MAX_SCHEMA_TOOLS` from env with default 40. | P1 | M |
| TS-B02 | **Sidecar sessions expose all 154 tools** regardless of allowlist (`mcp-bridge.ts:1716`). The model plans with tools it will be refused. | as cited | Refusal loops; wasted tokens. | Filter `registerTool` by the session's signed allowlist, or return a filtered `tools/list` per request. | P1 | M |
| TS-B03 | **Allowlist header truncation.** `compactAllowlistHeaderJson` keeps at most 100 entries and 4 000 chars, dropping the tail with a server log only (`trueforge-client.ts:55-82`). Cards that list MCP tool names (rather than provider keys) plus core can exceed 100; the dropped tools are then refused by the bridge's narrowing on the sidecar path. | as cited | Tools silently unavailable for large cards. | Send provider keys only (collapse MCP names to providers before packing), and fail loudly (event to the client) if anything is still dropped. | P1 | S |
| TS-B04 | **The persona promises tools the employee may not have.** `buildPersona` tells the model "Core tools always available: database_query, web_search, web_extract, file_ops, google_slides, google_docs, google_sheets, terminal_run_command, python_execute, code_execution, gmail, slack, hubspot, stripe" (`route.ts:86`) and gives detailed instructions for Slides/Docs/Sheets/terminal (`:92-99`). Most of these are `NEVER_CORE` or connector tools (`tool-gate.ts:31-34`). | as cited | The model calls tools that are not in its schema, or tells the user it will build a deck it cannot build. | Generate the "tools you have" sentence from the actual allowlist for the turn; drop tool-specific instructions for tools not present. | P1 | S |
| TS-B05 | **The persona tells the model never to ask permission** ("NEVER ask 'Would you like me to proceed?'", "Complete the entire task … without stopping halfway", `route.ts:100`). Combined with engine approvals this produces multi-step turns that pause mid-way, and it discourages clarifying questions (recipient, amount) that the gate explicitly requires ("Ask the user for the exact amount", `tool-gate.ts:137`). | as cited | Fabricated recipients/amounts get refused; worse answers. | Replace with: "Ask one short question when a required detail (recipient, amount, date, channel) is missing; otherwise proceed." | P1 | S |
| TS-B06 | **Large object results are not truncated.** For object payloads over 20 000 chars the code only adds `_truncated: true` and keeps the whole object (`local-turn.ts:585-598`). | `local-turn.ts:590-591` | Very large tool results (CRM lists, Drive text) go to the model in full, inflating every subsequent call in the loop. | Serialize, then cut to a byte budget with a structured preview (first N items, keys), and tell the model how to page. | P1 | S |
| TS-B07 | Tool errors from providers are passed through as text; there is no classification into `not_connected`, `auth_expired`, `rate_limited`, `invalid_args`, `provider_error` in the chat event stream. The UI cannot show a "Connect Gmail" button from a tool event; it depends on the model writing the link. | `local-turn.ts:577-614` | Inconsistent connect prompts. | Emit `tool_error` events with the gate/provider reason and `setupUrl` when present; render a connect button. | P2 | S |
| TS-B08 | `executeAutonomousToolAction` from the in-process tool set omits `actorUserId`, `employeeId`, `source`, `workflowId`, `conversationId` (`local-turn.ts:568-575`); `DarexLocalToolSet` stores `userId` and never uses it (`:478`, `:494`). The bridge path also omits `actorUserId` (`mcp-bridge.ts:1778-1785`). | as cited | `tool_invocations` and ledger rows have no human actor for chat calls; quiet-hours logic treats chat sends as unattended (`tool-gate.ts:318`); per-user OAuth cannot be resolved. | Pass `actorUserId: userId, employeeId, source: 'chat', workflowId: turnId, conversationId`. | P1 | S |

### 8.3 Missing

| ID | Gap | Fix | Pri | Eff |
|----|-----|-----|-----|-----|
| TS-M01 | No per-tool usage stats feeding selection (tools this org actually uses first). | Rank by `tool_invocations` counts per org/employee over 30 days. | P2 | M |
| TS-M02 | No visible "tools available to this employee" panel in chat. | Popover from the routing chip listing the turn's allowlist and which connectors are signed in. | P2 | S |
| TS-M03 | No sidecar-side call cap equal to the local 25. | Count calls per turn at the bridge using a signed turn id; refuse past the cap. | P2 | S |

---

## 9. Memory and context

Code: `route.ts:450-467`, `:1294-1301`, `:1380-1388`;
`trueforge-client.ts:386-430`; `memory/retrieve.ts:520-760`;
`local-turn.ts:649-663`, `:704`.

### 9.1 How it works

- History: last 12 messages, 2 000 chars each, from `messages`
  (`route.ts:455-467`), rendered as a "RECENT CONVERSATION HISTORY" block
  inside the user message (`trueforge-client.ts:405-411`).
- Retrieval: `retrieveMemory` runs SQL tiers (org/employee/entity/
  conversation, pgvector when an embedding is available), Cognee and
  Hindsight in parallel with a 6 s overall cap (`retrieve.ts:520-611`,
  `:731-760`; `DEFAULT_TIMEOUT_MS` at `:39`). Citations are formatted into
  the user message (`trueforge-client.ts:421-423`).
- Write-back: `startMemoryWriteBackWorkflow` after each successful turn with
  the tool results (`route.ts:1380-1388`).
- Compaction: TrueForge `contextCompaction` on the in-process thread
  (`local-turn.ts:704`); each turn is a fresh thread, so compaction only acts
  inside one long turn.

### 9.2 Broken

| ID | Finding | Evidence | Impact | Fix | Pri | Eff |
|----|---------|----------|--------|-----|-----|-----|
| MC-B01 | **Duplicate history on the sidecar path.** Sidecar sessions persist their own transcript per conversation (`trueforge-client.ts:456-463`), and every turn also injects the last 12 messages as text (`:405-411`). The model sees each prior exchange twice. | as cited | Token bloat; the "do not answer earlier messages again" instruction (`:426`) exists because of this. | On the sidecar path, send only the new message (the session has history); on the local path, keep the injected history. | P1 | S |
| MC-B02 | **History stores raw text only.** `messages.content` holds the final answer; tool results live only in `tool_calls` JSON, which is not loaded (`route.ts:455-467`). A follow-up such as "reply to the second email" has no message ids from the previous turn's `gmail_fetch`, so the model must re-fetch or guess. | as cited | Follow-ups fail or re-run reads. | Add a compact "facts from the previous turn" block: ids, titles and links extracted from the last turn's `executedSteps` (cap ~1 500 chars). | P1 | M |
| MC-B03 | **Crew turns have no history.** Specialists and manager are built without `priorMessages` and with `conversationId: undefined` (`route.ts:1037-1074`, `crew-runner.ts:186-193`, `:234-238`). | as cited | Team mode forgets everything said before in the thread. | Pass `priorMessages` to the manager and a short summary to each specialist. | P1 | S |
| MC-B04 | `retrieveMemory` is called twice for in-process turns that fail over: once by the route (`route.ts:1294`) and passed in, but `executeLocalTurn` re-runs it when `opts.retrievedMemory` is absent; crew specialists do not get the prefetched memory and each fetch their own (up to 6 s each, in parallel). | `local-turn.ts:649-661` | Extra latency in crews. | Prefetch once per crew and pass `retrievedMemory` to every member. | P2 | S |
| MC-B05 | Memory write-back runs only when `result.success && answer` (`route.ts:1380`); `mapTurnToResult` sets `success: true` even for refusals and errors handled inside the turn (`agent-client.ts:59-60`), so failed turns can still be written to memory as facts. | as cited | Noise or wrong "facts" in org memory. | Skip write-back when every tool call errored or the reply is a refusal/side-effect stop. | P2 | S |
| MC-B06 | The 12-message window counts assistant plan cards and hand-off notices as messages; three plan revisions push real context out. | `route.ts:455-461` | Context loss in plan-heavy threads. | Window by tokens, not count, and skip system-ish rows. | P2 | S |

### 9.3 Missing

| ID | Gap | Fix | Pri | Eff |
|----|-----|-----|-----|-----|
| MC-M01 | No rolling summary for long threads (`gap26sept/ask-ai.md` "missing" #3 still open). | Summarise messages older than the window into `conversations.summary_long` on write-back; inject it. | P2 | M |
| MC-M02 | No "remember this" from chat UI (the `cognee_memory_remember` tool exists but is NEVER_CORE, `tool-gate.ts:33`). | Add a message action "Save to Brain" that calls `POST /api/brain` with the message. | P2 | S |
| MC-M03 | No per-user memory scope (user preferences vs org facts). | Add a `user` tier keyed by `user_id` in retrieval and write-back. | P2 | M |

---

## 10. Conversation persistence and history

Code: `route.ts:114-199`, `:1452-1571`; `api/ask-ai/conversations/route.ts`;
`lib/ask-ai-persist.ts`; client `chat.ts:408-507`, `ask-ai.ts:261-304`.

### 10.1 What works

- Per-user threads (`contact_id = 'ask-ai:<userId>'`) with ownership checks on
  open, rename and delete (`conversations/route.ts:206-218`, `:260-270`).
- New chat reuses an empty conversation instead of piling up blanks
  (`conversations/route.ts:88-127`).
- Mode is stored per conversation and seeded from the user's last choice.

### 10.2 Broken

| ID | Finding | Evidence | Impact | Fix | Pri | Eff |
|----|---------|----------|--------|-----|-----|-----|
| CP-B01 | **Reload loses most of a turn.** `restoreThread` maps only `id`, `role`, `content`, `createdAt` (`ask-ai.ts:286-292`). `tool_calls` (tools used, routing, errors, handoff, approvals, subagents, crew) is returned by the server (`route.ts:1551-1557`) but discarded. | as cited | After refresh: no "handled by", no tool list, no error state, no hand-off button, and **pending approval cards disappear**, so the paused action can no longer be approved from chat. | Map `toolCalls` into `ChatMessage` fields; restore `approval` when the session is still resumable (check with a lightweight `GET /api/ask-ai/approve?sessionId=`). | P1 | S |
| CP-B02 | Restored plan cards are appended at the end with `at: now` (`ask-ai.ts:293-302`) instead of next to the message that created them. | as cited | Thread order breaks after reload. | Use the plan's `created_at` and the `planId` in the assistant message's `tool_calls` to place the card. | P2 | S |
| CP-B03 | The user message is truncated client-side to 2 000 chars without notice (`chat.ts:30`, `:69`). | as cited | Long pasted emails/briefs silently cut. | Raise to a server-validated limit (e.g. 16 000), show a counter, and reject (not cut) above it. | P2 | S |
| CP-B04 | The vote endpoint stores the client-side message id (`chat.ts:369-383`, `newId("msg")`), not the persisted `messages.id`. Votes cannot be joined to the stored answer. | as cited, `feedback/route.ts:111-139` | Feedback loop data is unusable for evaluation. | Return the persisted assistant message id in `done` and use it for votes. | P2 | S |
| CP-B05 | `retry` removes the failed pair locally (`chat.ts:359-366`) but both rows stay on the server, so the reloaded thread shows the failure and the retry. | as cited | Duplicated history. | Mark the failed assistant row `superseded` server-side on retry. | P2 | S |
| CP-B06 | Conversation list fetches 100 rows each with a correlated `count(*)` (`conversations/route.ts:20-35`). | as cited | Slow history menu for heavy users. | Keep `message_count` on `conversations` (trigger or write-path increment). | P2 | S |
| CP-B07 | Two users' Ask AI threads are both stored in `conversations`, the same table as customer threads; they are filtered out of `/conversations` only by `metadata.source`. Any query that forgets the filter (analytics automation rate, open counts) counts internal chats as customer conversations. | `route.ts:133-138`; `00-workspace-connectivity.md` §1 | Skewed analytics. | Add a `kind` column (`customer` / `ask_ai`) with an index and use it in every aggregate. | P2 | M |

### 10.3 Missing

| ID | Gap | Fix | Pri | Eff |
|----|-----|-----|-----|-----|
| CP-M01 | No search across Ask AI conversations. | `GET /api/ask-ai/conversations?q=` over `messages.content` (FTS). | P2 | S |
| CP-M02 | No share/export of a conversation. | Export markdown; share read-only link inside the org. | P2 | M |
| CP-M03 | No retention control for Ask AI threads distinct from customer threads (DSR deletes cover both). | Per-org retention setting for `kind = ask_ai`. | P2 | M |

---

## 11. Attachments, files, images and voice

Code: `NEW-FRONTEND/src/components/ui/chat-bar.tsx:20-110`; `chat.ts:68-80`;
`route.ts:437-443`.

| ID | Finding | Evidence | Impact | Fix | Pri | Eff |
|----|---------|----------|--------|-----|-----|-----|
| AT-B01 | **Attach is cosmetic.** The chat bar validates a file type and shows the name (`chat-bar.tsx:43-44`, `:74-80`), but `submit` sends only the text and clears the attachment (`:55-60`); `send(text)` has no file parameter (`chat.ts:68`), and `POST /api/ask-ai` accepts only `prompt` (`route.ts:437`). | as cited | Users attach a PDF, the model never sees it, and answers as if it did not exist — or worse, invents its content. | Hide the attach button until wired. Then: upload to the Brain ingest path (`POST /api/brain` already exists), pass `attachments: [{sourceId, name, mime}]`, extract text (PDF/CSV/DOCX) server-side, inject up to a budget, and index for retrieval. | P1 | M |
| AT-B02 | **The microphone is a mock.** It waits `micListeningMs` and appends a fixed sample string (`chat-bar.tsx:26`, `:61-71`). | as cited | Fake data entered into a real chat in live mode. | Hide in live mode; implement with the Web Speech API (client-only) or a server transcription endpoint. | P1 | S |
| AT-M01 | No image input (screenshots of dashboards, invoices). | Accept images, send to a vision-capable model candidate (Gemini candidates already exist, `local-turn.ts:144-166`), or OCR to text. | P2 | M |
| AT-M02 | No file outputs in chat (CSV export of a SQL result, generated deck link card). Tools return links in text only. | Add an `artifact` event (name, mime, url) and render download cards; `file_ops` writes can produce them. | P2 | M |
| AT-M03 | No voice output. | Optional TTS on answers; low priority. | P2 | M |

---

## 12. Citations and grounding

Code: `trueforge-client.ts:421-423`; `memory/retrieve.ts`;
`prompts/system-prompt-builder.ts:91-92`; `route.ts:97`.

| ID | Finding | Evidence | Impact | Fix | Pri | Eff |
|----|---------|----------|--------|-----|-----|-----|
| CT-B01 | Memory citations are injected into the prompt but never returned to the client. The `done` event has no `citations` field (`route.ts:1402-1428`). | as cited | Users cannot see which Brain document or memory grounded an answer (also `00-workspace-connectivity.md` §4 gap). | Return `retrievedMemory.citations` (id, title, source, score, url) in `done`, and render footnotes; link Brain rows to `/settings/...` knowledge item. | P1 | S |
| CT-B02 | Web citations depend on the model writing links; there is no structured list of URLs fetched by `web_search`/`web_extract`. | `route.ts:97` | Unverifiable research answers. | Collect URLs from web tool results into `sources` on `done`. | P2 | S |
| CT-B03 | No check that links in the answer came from tool results. | — | Hallucinated URLs pass through. | Post-process: flag links not present in any tool result or citation. | P2 | M |

---

## 13. Error handling, timeouts and retries

### 13.1 Timeouts in force

| Layer | Timeout | Where |
|-------|---------|-------|
| Redis rate-limit socket | 1.5 s | `lib/rate-limit.ts:91` |
| Classifier LLM | 20 s | `classify.ts:106` |
| Planner / revise LLM | 60 s | `plan-generator.ts:191`, `:239` |
| LiteLLM client retries | exponential, transient statuses only | `lib/litellm-client.ts:66-116` |
| Memory retrieval | 6 s (Cognee/Hindsight 6 s each inside) | `memory/retrieve.ts:39`, `:537`, `:560` |
| Agent turn per local candidate | `timeoutMs` 120 s from the route | `route.ts:1323`, `local-turn.ts:770-771` |
| Sidecar turn | 120 s from the route, default 180 s | `trueforge-client.ts:126`, `:611` |
| Tool execution | 15 s (`TOOL_EXECUTION_TIMEOUT_MS`) | `tools/shared.ts:18`, `tool-executor.ts` `executeWithTimeout` |
| Crew synthesis | `runWithTimeout` | `crew-runner.ts:37-50`, `:233-260` |
| Durable execute polling | 240 s | `execute/route.ts:235` |

### 13.2 Broken

| ID | Finding | Evidence | Impact | Fix | Pri | Eff |
|----|---------|----------|--------|-----|-----|-----|
| ER-B01 | **Worst-case turn time is unbounded by the route's 120 s.** Each local model candidate gets its own 120 s timer (`local-turn.ts:770-771`) and up to five candidates exist (override, gemini, gemini-lite, groq, openrouter, litellm; `local-turn.ts:119-234`). If each hangs and then throws, the loop moves to the next, and after all fail the sidecar path gets another 120 s (`trueforge-client.ts:611`). That is up to ~12 minutes holding a concurrency lease (3 per org). | as cited | One stuck provider blocks an org's chat for minutes. | Use one deadline for the whole turn (start time + `timeoutMs`), and give each candidate only the remaining budget; cap retries at 2 candidates. | P1 | S |
| ER-B02 | **15 s tool timeout is too short for some tools and silent about it.** Sandbox/Python, Drive text extraction, Slides creation with many slides and web extraction routinely take longer; the model receives "exceeded execution timeout" and may retry, repeating side effects that did commit before the abort reached the provider. | `tools/shared.ts:18` | Partial writes and duplicate retries. | Per-tool timeouts from the tool definition (reads 15 s, generators 60 s, sandbox 120 s); for writes, return "outcome unknown — check before retrying" instead of a plain failure. | P1 | S |
| ER-B03 | Errors are shown with raw internals. `runAutonomousAgentDirect` returns "I encountered an issue while processing your request: <exception message>" (`trueforge-client.ts:1117-1119`); the route's catch persists `❌ <message>` (`route.ts:1432`). Messages like `TrueForge turn creation failed (422): {...}` reach users and the stored history. | as cited | Leaks infrastructure details; unhelpful. | Map known errors to user text (timeout, provider down, usage cap, not connected) and keep the raw text in logs/trace only. | P2 | S |
| ER-B04 | The in-memory concurrency cap (3 per org per process) returns 429 "busy" for the fourth simultaneous chat in an org (`rate-limit-core.ts:86-89`, `:147-167`). In an org with several active users this is reached quickly, and the limit is per process, so it differs per replica. | as cited | Teams get "busy" errors during normal use. | Make the cap per user (e.g. 2) plus a larger per-org cap (e.g. 10), stored in Redis with a TTL lease. | P1 | S |
| ER-B05 | `execute` and `plan`/`revise` still use the synchronous in-memory limiter (`execute/route.ts:106`, `plan/route.ts:90`, `revise/route.ts:23`) while the main route uses Redis. | as cited | Inconsistent limits across replicas. | Use `denyAskAiIfLimitedAsync` everywhere. | P2 | S |
| ER-B06 | `mapTurnToResult` always returns `success: true` (`agent-client.ts:59-60`), even for paused or side-effect-stopped turns; retry decisions downstream (`retryable`) never fire for resumed turns. | as cited | Wrong success metrics and write-backs. | Derive `success` from the turn: false when the side-effect stop or a fatal error occurred. | P2 | S |

### 13.3 Retries

- LLM JSON calls retry on transient statuses with backoff (`litellm-client.ts:66-116`). 🟢
- Agent turns are not retried by the route; failover between model candidates
  is the retry, guarded against side effects (`local-turn.ts:989-994`). 🟢
- Client `retry` re-sends the prompt (`chat.ts:359-366`); there is no guard
  against re-running a turn that already performed writes. 🔴 Fix: when the
  failed turn has executed non-read tools (from `executedSteps`), ask for
  confirmation before retrying. P2, S.

---

## 14. Latency, cost and model selection

### 14.1 Model selection (as built)

- In-process candidates in order: explicit override
  (`DAREX_LOCAL_MODEL_BASE_URL`), Gemini (`GEMINI_CHAT_MODEL`, default
  `gemini-2.5-flash`), a hard-coded Gemini lite fallback, Groq, OpenRouter,
  then LiteLLM; inside Docker LiteLLM is moved first; OpenRouter is moved
  first when `TRUEFORGE_MODEL` starts with `openrouter/`
  (`local-turn.ts:119-234`). A circuit breaker skips providers with recent
  failures (`local-turn.ts:976-979`).
- Sidecar model: `TRUEFORGE_MODEL`, default `openrouter/deepseek-v4-1-flash`
  (`trueforge-client.ts:117`).
- Classifier, planner and revise use LiteLLM's default model via
  `chatCompletion`.

### 14.2 Findings

| ID | Finding | Evidence | Impact | Fix | Pri | Eff |
|----|---------|----------|--------|-----|-----|-----|
| LM-B01 | Model choice is environment-wide; there is no per-org, per-employee or per-task model (cheap for triage, strong for research/plans). | `local-turn.ts:119-234` | Either overpay on simple turns or underperform on hard ones. | Add `model_tier` per employee (fast / balanced / deep) mapped to candidates; route plan generation and research to the deep tier. | P2 | M |
| LM-B02 | Model remapping rules are hard-coded strings (`local-turn.ts:148-150`, `:171-173`, `:186-193`) that silently change configured models (e.g. any `llama-3.3` becomes `qwen/qwen3.8-27b`). | as cited | Operators cannot predict which model runs. | Remove silent rewrites; validate configured names at boot and fail loudly. | P2 | S |
| LM-B03 | Spend is metered (`recordTurnSpend`, `trueforge-client.ts:569`), but the chat never shows tokens, cost or duration per answer, and `done` omits `usage` on the main path (`route.ts:1402-1428`; `approve` does include it, `approve/route.ts:228`). | as cited | No cost visibility (ask-ai.md missing #4 still open). | Add `usage` to `done` and render "1 240 tokens · $0.002 · 3.4 s" under answers for admins. | P2 | S |
| LM-B04 | Prompt size per call: unified system prompt (~11 KB source, `prompts/system-prompt-builder.ts`) + `buildPersona` (~2.5 KB, `route.ts:71-103`) + history (≤ 24 KB) + memory block + all tool schemas (TS-B01). | as cited | High base cost per loop iteration. | Trim persona (TS-B04/TS-B05), narrow tools (TS-B01), cache the static system prompt where the provider supports prompt caching. | P1 | M |
| LM-B05 | Crew turns cost at least 3 loops (2+ specialists + manager), triggered by keyword heuristics in Auto (RT-B04). | `route.ts:808-826` | Cost multiplier on common prompts. | See RT-B04. | P1 | M |

### 14.3 Latency budget, simple turn (typical, from code paths)

| Phase | Typical | Worst |
|-------|---------|-------|
| Auth + 15 DB queries before release | 30–80 ms | pool wait (see §15) |
| Classify | 0 ms (heuristic) | 20 s |
| Playbooks load | 5 ms | — |
| Memory | 200 ms–2 s | 6 s |
| Model TTFB | 0.5–3 s | 120 s × candidates |
| Tools | 0.3–5 s each | 15 s each × up to 25 |
| Persist + trace | 20 ms | — |

---

## 15. Failure scenarios found by reading the code

| # | Scenario | Path | Result today | Fix ref |
|---|----------|------|-------------|---------|
| F01 | User asks "send the proposal to Ravi" in chat and clicks Allow. | local-turn approval → resume → gate `confirm_class` | Email parked in Actions; chat says "waiting for approval". | AP-B01 |
| F02 | User approves a plan with an email step; durable execute runs. | `PlanExecuteWorkflow` → `executePlanStepActivity` → gate | Plan shows Completed; email parked. | PL-B01 |
| F03 | "Our Q3 pipeline is leaking — pull HubSpot deals." | Auto → `EMERGENCY_RE` → dispatch → no employee → role "Primary Business Assistant" | Every tool denied `missing_employee`. | RT-B01, RT-B02 |
| F04 | All employees paused; user asks anything needing a tool. | Auto → `route()` returns human | Every tool denied. | RT-B01 |
| F05 | User approves an action 35 minutes after the card appeared, or after a deploy. | `resumeLocalTurn` → null → sidecar resume with unknown id | "Could not resume". | AP-B05 |
| F06 | User ignores an approval card (sidecar path) and types a new message. | 422 → session deleted and recreated | Pending action discarded silently. | AP-B06 |
| F07 | Team mode with a specialist that needs to send. | crew-runner drops approvals | Stalls; no card. | AP-B07 |
| F08 | Model provider 1 returns 500 after streaming half an answer. | candidate failover | Duplicated text until `done`. | ST-B01 |
| F09 | Four teammates in one org chat at once. | in-memory lease cap 3 | Fourth gets 429. | ER-B04 |
| F10 | User closes the tab while plan step 3 (HubSpot create) is in flight. | `raceAbort` returns early; plan stays `running`; step result not saved | Reopen → step re-run → duplicate contact. | PL-B06 |
| F11 | Plan approve and cancel clicked close together (two tabs). | read-then-update without predicate | Cancelled plan becomes approved. | PL-B08 |
| F12 | Temporal down; user clicks Stop on a non-durable plan. | signal fails → status reverted to `pending` | Stop does not stick. | PL-B09 |
| F13 | Several users revise drafts at once. | `revise` holds a pool client across a 60 s LLM call | Dashboard pool (10) starves; unrelated API calls queue. | PL-B10 |
| F14 | Parallel plan stage of 4 steps + 2 subagents each doing tool calls. | Each gate pass does several sequential `withOrgScopedClient` checkouts (org state, employee, usage, autonomy, ledger, quiet hours, audit) from the workflows pool (`tools/shared.ts:50-57`, max 10, no `connectionTimeoutMillis`) | Pool exhaustion; checkouts wait with no acquire timeout until the 15 s tool timeout or the turn timeout fires; the work behind the timed-out race still holds clients. | §15.1 |
| F15 | Signed-out user's tab keeps the old session cookie and uses the default `/home` chat. | `/api/trueforge` proxy swallows auth failure | Request forwarded to TrueForge without tenant scoping. | FD-B02 |
| F16 | Signed-in user calls `/api/trueforge/api/v1/sessions`. | catch-all proxy | Reaches sidecar session APIs. | FD-B01 |
| F17 | Model passes `employee_role: "Finance"` in a Slack tool call on a role-less resumed sidecar turn. | bridge fallback to args role | Gate applies Finance's card. | AP-B04 |
| F18 | Allowlist of > 100 entries on the sidecar path. | header packing drops the tail | Tools silently unavailable. | TS-B03 |
| F19 | Prompt "make a plan for the offsite, what should we consider?" | explicit plan regex | Approval card instead of an answer. | CL-B02 |
| F20 | Plan step uses `google-tasks.tasks_create` suggested by the planner prompt. | gate: not a registered action | Step fails mid-plan. | PL-B03 |
| F21 | User attaches a contract PDF and asks for a summary. | attachment dropped client-side | Model answers without the file. | AT-B01 |
| F22 | Conversation switched to another employee mid-thread on the sidecar path. | session instructions frozen | Old persona answers. | RT-B09 |
| F23 | User deletes a conversation while its plan runs. | plans deleted | Orphaned execution. | PL-B13 |
| F24 | Approval on a turn whose original allowlist was narrow (sidecar). | resume header = all providers | Wider tool exposure after approval. | AP-B03 |

### 15.1 Pool deadlock and exhaustion analysis

- **Dashboard pool** (`lib/db.ts:50-52`, max 10): the main route holds one
  client for ~15 queries and releases it before slow work (`route.ts:571`).
  Risks: `revise` holds across LLM (PL-B10); `plan PATCH` holds one client
  while it calls `signalPlanDecision` only after releasing (OK,
  `plan/route.ts:198-206`); `execute` acquires a new scoped client for every
  progress update and cancel check (`execute/route.ts:297-329`, `:382-409`),
  sequentially per stage, so a stage of N parallel steps causes N
  `updatePlan` calls after the stage, not concurrently. OK.
- **Workflows pool** (`tools/shared.ts:50-57`, max 10, **loaded inside the
  dashboard process too**, because the dashboard imports
  `@darex/workflows/dist/*`): every tool call runs the gate, which checks out
  a client several times in sequence. With a concurrency lease of 3 turns per
  org, parallel plan stages, and dynamic subagents, 10 clients are easy to
  exhaust across orgs. `pg.Pool` waits forever by default; no
  `connectionTimeoutMillis` is set in either pool. Nested checkouts (a
  function that holds a `withOrgScopedClient` client while calling another
  helper that also checks out) would deadlock at saturation; none was found in
  the gate path read for this audit, but there is no guard.
- **Fix (P1, S):** set `connectionTimeoutMillis` (e.g. 5 s) on both pools and
  turn the timeout into a clear "busy" tool error; collapse the gate's
  sequential checkouts into one client per call (pass the client to the
  employee, usage, autonomy and ledger deps); add a pool-saturation metric to
  `/api/observability`; add an ESLint rule or wrapper that forbids
  `withOrgScopedClient` inside another `withOrgScopedClient` callback.
- Side note found while reading: `tools/shared.ts:45-48` falls back to a
  hard-coded `'darex_app_dev_secret'` DB password, which AGENTS.md rule 5
  forbids in shipped code. P1, S: throw in production when neither variable
  is set.

---

## 16. Fix plan in priority order

| Order | IDs | Theme | Effort |
|-------|-----|-------|--------|
| 1 | FD-B01, FD-B02, FD-B03 | Close the `/api/trueforge` proxy; make `/home` chat use Ask AI | M |
| 2 | AP-B04, AP-B02 | Signed identity only at the bridge; server-side tool resolution for approver RBAC | S |
| 3 | AP-B01, PL-B01 | One approval per action: chat/plan approvals re-enter the gate as approved | M |
| 4 | RT-B01, RT-B02, RT-B05, RT-B10, TS-B08 | Every turn has a real employee id; Ask AI does not use the emergency rule; actor fields on every call | S |
| 5 | LC-B02, PL-B08, PL-B09, PL-B10, PL-B06 | Race and pool fixes in plan/route handlers | S–M |
| 6 | LC-B03, LC-B04, LC-B05, ST-B06, ER-B01 | Stream immediately, heartbeat, no-buffer headers, single turn deadline | S–M |
| 7 | TS-B01, TS-B02, TS-B03, TS-B04, TS-B05, TS-B06 | Tool narrowing and prompt diet | M |
| 8 | AP-B05, AP-B06, AP-B07, AP-B08, AP-B09 | Durable, visible, per-item approvals; crews surface approvals | M |
| 9 | RT-B03, RT-B04, RT-B07, RT-B09 | Auto crew discipline; show routing reason; per-employee sessions | S–M |
| 10 | PL-B02, PL-B03, PL-B04, PL-B12, PL-B15 | Planner uses the real catalog and the employee card; revise updates payloads; reattach running plans | S–M |
| 11 | CP-B01, MC-B01, MC-B02, MC-B03, CT-B01 | Restore full turns; history and citations | S–M |
| 12 | AT-B01, AT-B02 | Attachments real or hidden; mic real or hidden | S–M |
| 13 | ER-B04, ER-B02, LM-B03 | Concurrency per user; per-tool timeouts; usage chips | S |

---

## 17. Verification plan (live, from the chat)

Each fix above is closed only when the matching check passes against a
running stack (`pnpm infra:up`, dashboard, NEW-FRONTEND) with a test org that
has Gmail and HubSpot connected through Nango and three active employees
(Executive, Sales, Customer Support).

| # | Check | Steps | Pass condition |
|---|-------|-------|----------------|
| V01 | Default chat is Ask AI | Open `/home`, send "hi". | Network shows `POST /api/ask-ai`, no `/api/trueforge/*`. |
| V02 | Proxy closed | `curl` `/api/trueforge/api/v1/sessions` with a valid cookie; then with a cookie whose epoch was bumped. | 404/403 for unlisted paths; 401 for the stale cookie. |
| V03 | One-click send | "Email test@<your domain> subject Ping body Hello" → Allow. | Email arrives; no new row in Actions; `tool_invocations` has `actor_user_id`. |
| V04 | Plan send | "/plan email test@… then create a HubSpot contact" → Approve. | Both done; plan `completed`; no parked action. |
| V05 | No-employee fallback | Pause all but Executive; ask "our pipeline is leaking, list open HubSpot deals". | `hubspot_list_deals` runs as Executive. |
| V06 | Routing chip | Ask "refund order 123" in Auto. | Chip shows "Auto → Customer · keyword match". |
| V07 | Pick one + paused | Pick a paused employee. | Option disabled or a visible fallback notice. |
| V08 | Approval expiry | Pause a turn, restart the dashboard, click Allow. | Clear "expired, ask again" or successful resume from persisted state. |
| V09 | Pending + new message | Leave a card pending, send another message. | Blocked with a prompt to decide, or auto-denied with a visible note. |
| V10 | Crew approval | Team mode (Sales + Support): "reply to the latest support email and log a HubSpot note". | Approval card per specialist; both actions complete after Allow. |
| V11 | Failover | Set the first candidate's key to an invalid value. | One clean answer, no duplicated text. |
| V12 | Tool narrowing | Inspect the first model request for "what's on my calendar today?". | ≤ 30 tool schemas. |
| V13 | Disconnect mid-plan | Start a 3-step non-durable plan; close the tab during step 2; reopen. | Plan `interrupted`; step 2 recorded; no duplicate on resume. |
| V14 | Revise updates payload | Revise the draft, approve. | Sent body equals the revised draft. |
| V15 | Reload fidelity | Run a tool turn, reload. | Tools, handled-by, approval (if pending) all restored. |
| V16 | Attachment | Attach a 2-page PDF, ask for a summary. | Summary cites the file; Brain has the source. |
| V17 | Streaming through proxy | Through Caddy in front of NEW-FRONTEND, ask a long question. | First chunk < 3 s; chunks arrive incrementally. |
| V18 | Concurrency | Four users in one org send at once. | All four answered (none 429). |
| V19 | Pool saturation | Load test 20 concurrent tool turns. | No request waits > 5 s for a client; clear busy errors otherwise. |
| V20 | Citations | Ask a question answered from a Brain doc. | `done.citations` present; footnote links open the doc. |

---

## 18. Doc corrections

- `gap26sept/ask-ai.md` "What's broken" #1–#16 describe the code before the
  tracker fixes; the tracker rows 1–10 are accurate. Items #8 (table flicker),
  #10 (usage chips), #11 (stale running sweep), #12 (attachments) remain open
  and are covered above as ST/LM/PL-M03/AT rows.
- `gap26sept/ask-ai.md` "What works" #6 says the approval resume uses
  "strictly locked tool allowlists". It uses the union of all providers
  (AP-B03).
- `AGENTS.md` §2 data flow says `ask-ai/page.tsx` → `POST /api/ask-ai`. In
  NEW-FRONTEND the default chat is `TrueForgeChat` → `/api/trueforge/*`; Ask
  AI is reached through `HomeChat` in the overview view and the Actions
  command bar.
- `local-tool-select.ts:10-11` says the catalog is ~109 tools; it is 154.
- `local-turn.ts:6` says 96 tools; it is 154.

---

## 19. Area scorecard

| Area | Works | Broken | Missing | Overall |
|------|-------|--------|---------|---------|
| Request lifecycle | Pool released before slow work; body org refused; bounded history | 7 (LC-B01..B07) | 3 | 🟡 |
| Front doors | Ask AI client is complete in `HomeChat` | 4 (FD-B01..B04), two P0 | 2 | 🔴 |
| Classification | Heuristics first; greeting safety; planner fallback | 3 | 2 | 🟡 |
| Routing and mode selector | Server-side validation, locked allowlists, `@Name`, audit | 10 | 5 | 🟡 |
| Planning and execution | Atomic lock, cancel checks, freeze log, step edit | 15 | 4 | 🔴 (PL-B01) |
| Approvals | Audit before resume; org check on resume | 11 | 2 | 🔴 (AP-B01, AP-B02, AP-B04) |
| Streaming | Event set covers chunks, tools, subagents, approvals | 7 | 2 | 🟡 |
| Tool selection | Allowlist intersection; 25-call cap; read cache | 8 | 3 | 🟡 |
| Memory and context | Multi-tier retrieval with 6 s cap; write-back | 6 | 3 | 🟡 |
| Persistence and history | Ownership checks; empty-chat reuse; mode per thread | 7 | 3 | 🟡 |
| Attachments and voice | — | 2 (mock UI) | 3 | 🔴 |
| Citations | Prompt-side citations from memory | 3 | — | 🔴 |
| Errors, timeouts, retries | LLM retry with backoff; failover without double side effects | 6 | — | 🟡 |
| Latency, cost, models | Spend metering; provider circuit breaker | 5 | — | 🟡 |

---

## 20. Proposed event schema v2 (NDJSON)

All events carry `turnId` and a monotonically increasing `seq`, so the client
can de-duplicate and a reconnect can resume from the last `seq`.

```ts
type AskEventV2 =
  | { type: 'turn_start'; turnId: string; seq: number; conversationId: string }
  | { type: 'routing'; turnId: string; seq: number; routing: AskRouting }          // rendered as a chip
  | { type: 'phase'; turnId: string; seq: number; phase: 'classify' | 'memory' | 'model' | 'tools'; ms?: number }
  | { type: 'notice'; turnId: string; seq: number; code: string; message: string } // persistent (replaces 'warning')
  | { type: 'reset'; turnId: string; seq: number; reason: 'model_failover' }      // clear streamed text
  | { type: 'chunk'; turnId: string; seq: number; text: string; threadId?: string }
  | { type: 'tool'; turnId: string; seq: number; tool: string; label: string; callId: string }
  | { type: 'tool_result'; turnId: string; seq: number; callId: string; status: 'ok' | 'error' | 'pending_approval';
      summary: string; reason?: string; setupUrl?: string }
  | { type: 'approval'; turnId: string; seq: number; items: Array<{
      approvalId: string;              // gate pending-action id (AP-B01 design)
      tool: string; action: string; summary: string; args: Record<string, unknown>;
      risk: 'send' | 'pay' | 'sign' | 'publish' | 'delete' | 'execute' | 'draft';
      expiresAt: string }> }
  | { type: 'artifact'; turnId: string; seq: number; name: string; mime: string; url: string }
  | { type: 'ping'; turnId: string; seq: number }
  | { type: 'done'; turnId: string; seq: number; messageId: string; answer: string; finalReplace: boolean;
      citations: Citation[]; sources: string[]; usage?: TurnUsage; timings: Record<string, number> }
  | { type: 'error'; turnId: string; seq: number; code: 'timeout' | 'provider_down' | 'usage_cap' | 'busy' | 'internal';
      message: string; retryable: boolean };
```

Client changes (`NEW-FRONTEND/src/lib/api/ask-ai.ts`): handle `routing`,
`notice`, `reset`, `tool_result`, `artifact`, `ping`; store `messageId` from
`done` for votes; drop events with `seq <= lastSeq`.

---

## 21. Proposed approval unification (AP-B01, PL-B01, AP-B05, AP-B07)

Goal: one human click per risky action, durable across restarts, the same for
chat turns, plan steps and crews.

1. **Engine never pauses.** `DarexLocalToolSet.toolCallInfo` returns
   `is_approval_required: false` (`local-turn.ts:617-632`); the sidecar session
   is created with `require_approval_for_tools: []`
   (`trueforge-client.ts:490-493`). The gate is the only approval layer.
2. **Gate parks with context.** `park()` (`tool-gate.ts:278-305`) stores
   `conversationId`, `turnId`, `actorUserId` and the employee id in the pending
   payload. The tool result tells the model: "Parked for approval
   (<pendingActionId>): <summary>. Tell the user it is waiting; do not retry."
3. **Chat shows the card.** The route collects `pending_approval` results from
   `executedSteps` and emits an `approval` event with `approvalId =
   pendingActionId` (event schema §20). Cards survive reloads because they are
   rows in `agent_pending_actions` filtered by `conversationId`.
4. **Allow runs the stored call.** The card's Allow posts to the existing
   decisions path (`PATCH /api/decisions` with RBAC from the stored tool, not
   client input), which executes with `approvedPendingActionId`
   (`tool-gate.ts:213-221`). The result is appended to the conversation as an
   assistant message and pushed over realtime.
5. **Optional continuation.** If the user wants the agent to continue after the
   action ("then reply in Slack that it is done"), the decisions handler starts
   a follow-up turn in the same conversation with the action's result as
   `priorToolResults` (`trueforge-client.ts:413-419`).
6. **Plans.** On plan approve, create one approved pending-action row per
   confirm-class enabled step (payload hash bound), and execute steps with
   those ids. Editing a step after approval invalidates its row.
7. **Crews.** Specialists park like any other turn; the crew answer lists the
   parked items and the card renders them.

Effect: `/api/ask-ai/approve`, `activeLocalOrchestrators` and the sidecar
pending-approval 422 handling become unnecessary for Darex tools; RBAC lives in
one place.

---

## 22. Proposed tool narrowing (TS-B01..B03)

```ts
// services/workflows/src/local-tool-select.ts (sketch)
const MAX_SCHEMA_TOOLS = Number(process.env.DAREX_MAX_SCHEMA_TOOLS || 32);

export function selectToolsForTurn(args: {
  catalog: ToolDef[];
  allowlist: string[];             // the turn's effective allowlist
  role?: string;
  message: string;
  recentTools: string[];           // tools used in the last 3 turns of this conversation
}): ToolDef[] {
  const allowed = filterCatalogByAllowlist(args.catalog, args.allowlist, ALWAYS_ALLOWED_CORE_TOOLS);
  const intent = intentPriorityKeys(args.role, args.message);        // providers named by the message
  const score = (t: ToolDef) =>
    (intent.has(norm(t.tool)) ? 100 : 0) +
    (args.recentTools.includes(t.name) ? 50 : 0) +
    (CORE.has(norm(t.tool)) ? 20 : 0) +
    (t.risk === 'read' ? 5 : 0);
  const ranked = [...allowed].sort((a, b) => score(b) - score(a));
  const picked = ranked.slice(0, MAX_SCHEMA_TOOLS - 1);
  return [...picked, DISCOVER_TOOLS_DEF];                             // meta-tool, see below
}

// discover_tools({ query }) → returns up to 8 more ToolDefs from `allowed`
// (never outside it), which the tool set adds to the thread for the rest of the turn.
```

- Apply the same selection on the bridge by filtering `registerTool`
  per signed allowlist (TS-B02).
- Send provider keys only in the allowlist header (TS-B03).
- Record `schemaCount` and `discoverCalls` per turn in the Langfuse trace so
  the effect is measurable.

---

## 23. Code index (files read for this audit)

| Concern | Files |
|---------|-------|
| Chat route | `apps/dashboard/app/api/ask-ai/route.ts` |
| Plan / execute / revise / approve / feedback / conversations | `apps/dashboard/app/api/ask-ai/{plan,execute,revise,approve,feedback,conversations}/route.ts` |
| Mode, routing, hand-offs | `apps/dashboard/lib/{ask-mode,ask-employee,crew-planner,crew-abort}.ts`, `apps/dashboard/lib/handoffs/*`, `services/workflows/src/route-employee.ts` |
| Classify / plan | `apps/dashboard/lib/{classify,plan-generator,playbook-matcher}.ts` |
| Limits and gates | `apps/dashboard/lib/{rate-limit,rate-limit-core,usage-gate,db}.ts`, `apps/dashboard/middleware.ts` |
| Persistence | `apps/dashboard/lib/ask-ai-persist.ts` |
| Agent runtime | `services/workflows/src/{agent-client,trueforge-client,local-turn,local-tool-select,crew-runner,reply-from-tools}.ts` |
| Tool gate and executor | `services/workflows/src/{tool-gate,tool-executor,plan-step-actor,mcp-bridge}.ts`, `services/workflows/src/tools/shared.ts`, `services/workflows/src/skills/catalog.ts` |
| Plan workflow | `services/workflows/src/workflows/PlanExecuteWorkflow.ts`, `services/workflows/src/activities/orchestration.ts` |
| Memory | `services/workflows/src/memory/retrieve.ts` |
| Proxy | `apps/dashboard/app/api/trueforge/[...path]/route.ts`, `NEW-FRONTEND/next.config.ts` |
| Chat UI | `NEW-FRONTEND/src/components/home/{home-screen,home-chat,ask-mode-picker,assistant-overlay,plan-card}.tsx`, `NEW-FRONTEND/src/components/chat/trueforge-chat.tsx`, `NEW-FRONTEND/src/components/ui/chat-bar.tsx`, `NEW-FRONTEND/src/components/actions/command-bar.tsx`, `NEW-FRONTEND/src/lib/state/chat.ts`, `NEW-FRONTEND/src/lib/api/ask-ai.ts` |

---

## 24. Open questions for the owner

1. Is `TrueForgeChat` on `/home` intentional (a vendor UI trial) or should the
   default chat be Ask AI? Every control in this audit assumes Ask AI.
2. Should chat approvals be the human approval (one click), or must
   confirm-class actions always go through Actions? The code currently does
   both (AP-B01). The design in §21 assumes one click.
3. Is it acceptable for Auto to spawn crews from keywords, given the cost
   multiplier (RT-B04)? The alternative is crews only in Team mode or on an
   explicit "ask the team".
4. Target maximum tool schemas per call (§22): 32 is proposed.
5. Should Ask AI threads move to their own table or a `kind` column
   (CP-B07)? This is a schema change and needs approval per AGENTS.md.
