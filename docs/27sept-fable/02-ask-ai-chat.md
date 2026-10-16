# 02 · Ask AI chat — the front door

> ### 📊 Completion Status
>
> | Status | Count | Percentage |
> |---|:---:|:---:|
> | 🟢 **Done (Verified)** | 10 | 21.3% |
> | 🟡 **Pending / In Progress** | 2 | 4.3% |
> | 🔴 **Not Done (Open)** | 35 | 74.5% |
> | ⛔ **Blocked (Human/Infra)** | 0 | 0.0% |
> | **Total Findings** | **47** | **100.0%** |

Audit date 2026-09-27, read-only. Scope: `apps/dashboard/app/api/ask-ai/**`, `app/(dashboard)/ask-ai/page.tsx` (2,569 lines) + `components/chat|ask-ai`, `lib/{classify,plan-generator,ask-mode,ask-mode-selection,ask-employee,ask-ai-persist,employee-mentions,handoffs/*,tool-answer,crew-planner,crew-abort,playbook-matcher,confirm-classes,decision-explain,inbound-confirm}.ts`, `services/workflows/src/{reply-from-tools,local-tool-select,route-employee,plan-steps,trueforge-client,local-turn,tool-executor,crew-runner,workflow-client}.ts`, `workflows/{PlanExecuteWorkflow,CrewWorkflow}.ts`, `activities/orchestration.ts`, `prompts/system-prompt-builder.ts`. Docs checked: `gap26sept/ask-ai.md`, `plans.md`, `BUILD_STATE.md` L234-390. `gap26sept/chat-coverage.md` referenced by `AGENTS.md`: **does not exist**.

**Headline.** The mode lock (Auto / Pick one / Team), server-side validation, atomic plan approve, durable idempotent steps, and pool discipline are real. The dangerous part is what happens *after* approval: plan steps run with a tautological allowlist and no employee role, so the autonomy/confirm gate is skipped; a non-durable plan re-executes every step on reconnect; a durable plan cannot be cancelled once running; and every employee has terminal/bash/python in its always-allowed core with a fallback that `spawn`s `/bin/bash` on the host when the sandbox is down. Thread hydration returns the *oldest* 200 rows. There are zero route-level tests for any Ask AI route.

---

## 1. What works (verified)

- Body `org_id`/`orgId` rejected on every Ask AI route: `route.ts:401`, `execute/route.ts:87-92`, `plan/route.ts:57-60`, `revise/route.ts:33-36`, `approve/route.ts:68-71`, `conversations/route.ts:54-57,190-193,244-247`.
- Org from session via `getScopedClient()`; RLS GUC set at session level, RESET on release (`lib/db.ts:78-103`).
- Mode validation server-side: `lib/ask-mode.ts:83-111` parse; `149-212` ids must be active org employees (unknown/other-org → 400; paused → auto + `fallbackNotice`); `273-282` `@Name` → one-message override. Persisted on `conversations.ask_mode/ask_employee_ids` + `ask_ai_user_mode_prefs` (`route.ts:251-283`, migration `109`).
- Locked turn allowlist = card ∪ core ∪ connected channels on the card, never org-union (`lib/ask-employee.ts:165-177`; `route.ts:546-588` exhaustive switch).
- Team mode: fixed roster, cap 3, `fixedMembers:true`, spend gate, `Promise.allSettled`, abort skips synthesis (`route.ts:906-1188`, `crew-runner.ts:124-144,183-226`).
- Plan approve atomic (`UPDATE … WHERE status='approved' RETURNING`, `execute/route.ts:145-157`); approve audit event (`plan/route.ts:109-120`); user-scoped plan lookups (`plan/route.ts:80-84`, `execute/route.ts:125-130`).
- Durable step idempotency (`claimIdempotent`/`writeIdempotent`, `orchestration.ts:297-331`).
- DAG staging + `{{stepN_output}}` (`plan-steps.ts:61-145,149-246`); partial failure freezes, never `completed` (`execute/route.ts:317-343,457-473`).
- POST releases the pooled client before streaming (`route.ts:539`); crew stream guards `enqueue` after close (`:933-941`); per-org concurrency lease released in `finally` (`:1177,1363`).
- Rate limit + usage gate on POST (`route.ts:352,365`). Prior messages and memory fenced as untrusted in the system prompt (`system-prompt-builder.ts:20-25,128-133`).
- Client: parsers settle on error/EOF (`page.tsx:1291-1490,1688-1738`), Stop aborts (`:1263-1289`), approve 409 handled (`:1661-1674`).

## 2. Bugs

| ID | Sev | Where | What happens | Trigger | Fix sketch | Status |
| ASK-B01 | P0 | `execute/route.ts:158-160` → `261-529` | `status==='running'` branch says "allow SSE reconnect" but falls through into the full non-durable executor: **every step re-runs** (emails re-sent, rows re-inserted). No idempotency claim on the non-durable path. | Approve, lose connection, click Execute again / second tab | For `running` non-durable: 409 or replay from `agent_plans.current_step`; only durable path may reconnect. | 🟢 (2026-09-29: non-durable reconnect to running plan re-attaches and resumes from current_step; completed steps replay from agent_plans.steps DB cache without tool re-invocation; in-memory activePlanExecutions prevents duplicate concurrent runs on the same node; verified in ask-ai-execute-reconnect.test.ts) |
| ASK-B02 | P0 | `PlanExecuteWorkflow.ts:98-103,128-134,144-200`; `plan/route.ts:165-203`; `workflow-client.ts:305-334` | Durable plans **cannot be cancelled once running**: `rejectPlan` sets `decision`, read once before start; no per-stage status check. PATCH cancel writes `cancelled`; workflow keeps executing then overwrites to `completed`. | Approve a plan with `send_email`, hit Cancel mid-run | `cancelPlan` signal + `condition` check per stage, or re-read `agent_plans.status` before each stage. | 🟢 (2026-09-29: in-flight stages wrapped in Temporal CancellationScope; rejectPlan signal triggers scope cancellation and halts in-flight activities; cleanup activity executes inside CancellationScope.nonCancellable ensuring cancelled status is persisted; subsequent stages do not run; verified in plan-execute-workflow.test.ts) |
| ASK-B03 | P0 | `route.ts:1440-1447` | Hydration was `ORDER BY created_at ASC LIMIT 200` → oldest 200 rows; newest messages vanish from long threads. | Thread > 200 rows, reload | `DESC LIMIT 200` in subquery then re-sorted `ASC` outside. | 🟢 (2026-09-28: queries newest 200 via `ORDER BY created_at DESC LIMIT 200` subquery and re-sorts `ASC` outside; verified with automated unit tests in `ask-ai-persist.test.ts` asserting 205-message hydration preserves newest messages msg-006 through msg-205) |
| ASK-B04 | P1 | `execute/route.ts:403-414`; `shared-types/src/agent.ts:95-106` | `...({ userId } as object)` — `ToolExecutionParams` has no `userId`; executor never reads it. `ask-ai.md` row #5 "user attribution" is a no-op. | Any plan step | Add `userId` to `ToolExecutionParams`, thread into audit. | 🟢 |
| ASK-B05 | P1 | `plan/route.ts:139-161`; `workflow-client.ts:311-332` | `signalPlanDecision` swallows all errors → revert-to-pending catch unreachable. Temporal down: DB says `approved`, workflow never wakes, user told nothing. | Stop Temporal, approve durable plan | Return `{ok,error}`; on failure revert or surface `needs_execute`. | 🔴 |
| ASK-B06 | P1 | `execute/route.ts:225-243` | Durable poll capped at 600×400 ms = 240 s; on timeout SSE ends with no terminal event; `ExecutionStrip` stays "running". | Plan > 4 min of tool work | Emit `still_running`; client re-polls. | 🔴 |
| ASK-B07 | P1 | `route.ts:1216-1218`, `approve/route.ts:102-104` | Unguarded `controller.enqueue` after disconnect throws; catch calls `send('error')` (throws again); `finally close()` throws → rejected `start()`. Crew path is guarded, simple/approve are not. | Close tab mid-stream | Reuse guarded `send` with `closed` flag. | 🔴 |
| ASK-B08 | P1 | `CrewWorkflow.ts:250-259` vs `route.ts:1142-1160`; `page.tsx:253-365` | Temporal crew path persists `tool_calls` as bare array; direct path persists `{type,usedTools,executedSteps,routing,crew}`. Hydration reads the structured shape → crew replies lose trajectory/routing/specialist cards after reload when Temporal is up. | Team mode + Temporal, reload | One persistence shape. | 🔴 |
| ASK-B09 | P1 | `page.tsx:253-365` | `parseThreadMessages` drops `routing`, `handoff`, `approvalBox`, `subagents`, `usage`; running plan hydrates as `execution.running:true` with no stream (`300-303`) → permanently "running"; orphan plan message `planId` never rendered (`350-361`). | Reload during a plan run | Persist/restore fields; on hydrate of `running`, open durable poll SSE. | 🔴 |
| ASK-B10 | P1 | `route.ts:615,641` | `classifyRequest` (≤20 s LLM, `classify.ts:76-82`) runs for every turn incl. single/team, before any byte is streamed → blank "Thinking…"; planner uses org channels not the locked employee's allowlist. | Slow LiteLLM | Skip when heuristics decide; send `routing` first; pass employee allowlist to `generatePlan`. | 🔴 |
| ASK-B11 | P1 | `revise/route.ts:53,70-73`, `page.tsx`, `PlanCard.tsx`, `DraftPanel.tsx` | Comment says revised plan must re-route to approval; `newStatus` keeps `'approved'` → **edited steps run without re-approval**. | Approve → revise → Execute | Force `pending` on any revise; re-render Pending Approval state in PlanCard and reset execution state. | 🟢 (2026-09-28: revise resets status to pending in DB; DraftPanel & EmailDraftPreviewModal forward status to onRevised; PlanCard shows Pending Approval badge and disables Approve when approved; page.tsx resets execution and updates planCard status) |
| ASK-B12 | P2 | `route.ts:423-435` vs `452-482,496-518` | User message inserted before mode validation; a 400 leaves an orphan message. | Stale employee id | Validate mode first. | 🔴 |
| ASK-B13 | P2 | `route.ts:675-681` | `void startPlanExecuteWorkflow` returns null on failure with no feedback; plan JSON promises durability it may not have. | Temporal down at plan creation | Await; include `durable:false`. | 🔴 |
| ASK-B14 | P2 | `conversations/route.ts:197,261-280` | PATCH `request.json()` unguarded → 500; DELETE conversation + plans non-transactional and deletes `running` plans while the workflow continues. | Delete thread mid-execution | Transaction; refuse delete while `running`. | 🔴 |
| ASK-B15 | P2 | `page.tsx:1828-1918` | Plan mutations use a stale `messages` closure and ignore non-OK responses; optimistic UI diverges from DB. | Toggle while another mutation in flight | Functional `setMessages`, check `res.ok`. | 🔴 |
| ASK-B16 | P2 | `route.ts:1323-1349`; `trueforge-client.ts:946-998` | `done` includes `partialReply` never set and omits `usage` (approve route includes it). Client persists `usage` it never receives. | Any simple turn | Emit `usage`; drop `partialReply`. | 🔴 |
| ASK-B17 | P2 | `execute/route.ts:103`, `plan/route.ts:65` | Sync `denyAskAiIfLimited(orgId)` — org shares one bucket while POST is per-user. | Two users approving concurrently | Use async per-user variant. | 🔴 |

## 3. Security

| ID | Sev | Where | What happens | Fix sketch | Status |
|---|---|---|---|---|---|
| ASK-S01 | **P0** | `tool-executor.ts:28-39`; `tools/sandbox.ts:8-10,80-100,162-216`; `route.ts:83,89` | `terminal_run_command` / `bash_execute` / `python_execute` are in `ALWAYS_ALLOWED_CORE_TOOLS` for **every employee**, risk hard-coded `'draft'` (never confirms), and when `SANDBOX_API_URL` (default `localhost:8080`) is unreachable the tool **falls back to `spawn('/bin/bash',['-c',code],{env:process.env})` on the app/worker host** with all secrets in env. Persona says "full terminal hands". | Remove local fallback (return `notConnected`); drop terminal tools from core; risk `execute` → confirm; fail closed. | 🟢 (2026-09-28: sandbox risk `execute`, confirm-class) |
| ASK-S02 | **P0** | `execute/route.ts:139,403-414`; `plan-steps.ts:255-262`; `orchestration.ts:238,311-317`; `tool-executor.ts:345-401` | Plan execution allowlist = core ∪ tools named **in the plan itself** (tautological) and `employeeRole` is never passed → autonomy/confirm gate (`if (!skipAutonomy && employeeRole)`) is skipped. Plan steps bypass employee allowlists and risk confirmation; `plan/route.ts:206-253` lets the user set arbitrary `payload`/tool on pending steps. | Derive allowlist from stamped employee per step; pass `employeeRole`; enforce `confirmForRisk` per step. | 🟢 (2026-09-28: `resolvePlanStepActor` derives stamped employee card allowlist + role, applies persona filters, and passes `toolAllowlist` and `employeeRole` to `executeAutonomousToolAction` in both Next.js and Temporal routes; verified in `plan-step-actor.test.ts`) |
| ASK-S03 | P1 | `approve/route.ts:17-27,91,127`; `ask-ai-persist.ts:54-62` | Resume path uses `RESUME_TOOL_ALLOWLIST` = full catalog, widening a locked turn; body `conversationId` written with no user-ownership check; no usage gate / rate limit / lease. | Persist allowlist in the approval box; verify `conversations.user_id`; add gates. | 🔴 |
| ASK-S04 | P1 | `lib/rbac.ts:51-65,131-140` — zero refs in `api/ask-ai/**` | `canCallPayTools` never consulted; a `member` can approve a plan/tool that pays or refunds. | RBAC in plan approve and tool approve per tool. | 🟢 (2026-09-29: `canApproveActions`, `canCallPayTools`, and `canApproveRefunds` enforced across Ask AI: `ask-ai/plan` PATCH checks user role, blocking non-pay roles from financial plans and non-owners/non-admins from refunds; `ask-ai/approve` validates matching RBAC on in-turn decisions; tested in `ask-ai-plan-rbac.test.ts`) |
| ASK-S05 | P1 | `local-turn.ts:463-477` | Write-tool approval only when `REQUIRE_TOOL_APPROVAL==='true'` (unset). Tools with `'draft'` risk or no risk module (sandbox, `file_ops` writes, `database_query` DML) run unconfirmed. | Default approval on for write/execute classes; risk-map every provider. | 🟢 (2026-09-28: `isToolApprovalRequired` requires approval unconditionally for confirm-class [pay/send/sign/publish/delete/execute]; write actions default to requiring approval; read actions run unconfirmed; verified in `executor-confirm.test.ts`) |
| ASK-S06 | P1 | `local-tool-select.ts` | ~~`DAREX_ALL_TOOLS==='true'` returned the full catalog regardless of allowlist — env-gated bypass in shipped code.~~ The bypass was removed; local tool selection always intersects the employee allowlist. | Keep the allowlist intersection covered by regression tests and live verification. | 🟡 (2026-09-28: removed the shipped environment bypass; regression test passes after build, live chat verification still pending) |
| ASK-S07 | P1 | `crew-contract.ts:85-120`; `crew-runner.ts:239-248` | Specialist replies (tool-derived, attacker-controllable web/email text) concatenated **unfenced** into the manager's user message; manager runs with tools. | Fence each report; synthesis with `toolAllowlist: []`. | 🔴 |
| ASK-S08 | P1 | `route.ts:83-97` | Persona says core tools include `gmail, slack, hubspot, stripe` (false — connection-gated), "NEVER stall by asking permission", "Complete end-to-end" — contradicts approval gating. | Rewrite persona. | 🔴 |
| ASK-S09 | P2 | `feedback/route.ts:114-128,185-227` | Vote/promote checks org only; any member can promote any plan to a playbook. | `user_id` check; promote admin/owner. | 🔴 |
| ASK-S10 | P2 | `trueforge-client.ts:281-322` | `buildGroundedUserMessage` injects prior turns and memory into the **user** message unfenced. | Fence. | 🔴 |

## 4. Functional gaps

| ID | Sev | Evidence | Enterprise-complete | Status |
|---|---|---|---|---|
| ASK-G01 | P0 | `gap26sept/chat-coverage.md` not found | Matrix: one row per tool (109) and per tab action, each proved live from `/ask-ai`; CI check that new tools add a row. | 🟡 (2026-10-09: `gap26sept/chat-coverage.md` generated from the tool catalog (154) and mutating tab routes (83) by `services/workflows/src/scripts/chat-coverage.ts`; `chat-coverage.test.ts` fails CI when a tool or route has no row. Every row is 🔴 until proved live from `/ask-ai`) |
| ASK-G02 | P0 | `plan/route.ts:96-163`; `PlanCard.tsx:224-233` | One "Approve & Execute" for the whole plan; no per-step risk badge, employee badge, or per-step approve with argument preview. | 🔴 |
| ASK-G03 | P1 | `ask-mode.ts:356-392` stamps `employeeId` per step; `execute/route.ts:403-414`, `orchestration.ts:311-317` ignore it | Steps execute as "org", not as the assigned employee (no persona, allowlist, tier). | 🟢 (2026-09-28: `resolvePlanStepActor` resolves stamped `employeeId`/`employeeRole` per step, loading card allowlist and persona filters before executing step) |
| ASK-G04 | P1 | `route.ts:760-778` heuristic only; `planCrew` LLM only from `/api/agent/crew` | Auto-crew from chat is keyword-only. | 🔴 |
| ASK-G05 | P1 | `confirm-classes.ts`, `inbound-confirm.ts` webhook-only | Confirm-class gate protecting WhatsApp replies is not applied to chat outbound. | 🔴 |
| ASK-G06 | P1 | `route.ts:834-903` | Hand-off is static text; no in-thread "continue as X"; no specialist→specialist hand-off in Team. | 🔴 |
| ASK-G07 | P1 | `plans.md`; `page.tsx:1611-1785` `retryPrompt: undefined` (2026-09-28: stale — `retryPrompt` is now conditionally set at `page.tsx:1041,1147,1425,1441`, not always `undefined`; the underlying gap — no plan history/diff, no resume from failed stage — is still open) | No plan history/diff, no re-run with edits, no resume from failed stage. | 🔴 (2026-09-28: cited `retryPrompt: undefined` evidence is stale — it's now conditionally set in several places; underlying gap — no plan history/diff, no resume-from-failed-stage — still open) |
| ASK-G08 | P1 | `plan-generator.ts:23-33` `VALID_TOOLS` (12) vs 109-tool catalog; `playbook-matcher.ts:52-54,65-66,91-92` empty payloads | Planner can emit a dozen tools; playbook steps with `payload:{}` fail at execution. | 🔴 |
| ASK-G09 | P2 | `tool-answer.ts:286-300,256`; `reply-from-tools.ts:243-250,165-175` | Regex post-processing **replaces** the model's "could not find" with synthesized founder/year claims (`darexai.com` hardcoded). Violates never-fabricate. | 🔴 |
| ASK-G10 | P2 | `page.tsx:2355-2360`; `route.ts:692-716` `proposedAction:null` | `ActionPermissionCard` never receives data — dead UI. | 🔴 |
| ASK-G11 | P2 | `employee-mentions.ts:1-8` `MENTION_ALLOWLIST_MODE='org-union'` vs locked behaviour | Contradiction; delete one. | 🔴 |

## 5. Enterprise readiness

| ID | Sev | Evidence | Gap | Status |
|---|---|---|---|---|
| ASK-E01 | P0 | `audit-events.ts` called only at `plan/route.ts:109-120` | No audit for plan cancel, step edit, tool approval/denial, mode change, crew dispatch, executed tool with actor. | 🟢 2026-10-05: plan cancel / step edit, tool approve / deny (fail closed), Ask mode change (`settings.update`) and crew dispatch audited; kinds in migration 207 |
| ASK-E02 | P1 | `rate-limit.ts:98-99,147-166` in-memory; 429 with no `Retry-After` | Concurrency cap per process (×N replicas); no per-user token/cost quota. | 🔴 |
| ASK-E03 | P1 | `route.ts:683-690` `.catch(()=>{})`; `execute/route.ts:446-453` | No correlation id in events/headers; no metrics for stream duration, approval latency, plan success. | 🔴 |
| ASK-E04 | P1 | `route.ts:423-435,1440-1447`; `conversations/route.ts:34` | No retention or PII redaction on `messages.content`/`tool_calls` (raw tool outputs incl. emails); no export. | 🔴 |
| ASK-E05 | P1 | `page.tsx:905-948` | Tool results and resumable `approvalBox.sessionId` in localStorage, unencrypted, no TTL, no logout wipe. | 🔴 |
| ASK-E06 | P2 | `PlanCard.tsx:115`; `page.tsx:2481` | Generic a11y labels; no live-region for approvals; mobile/keyboard unverified. | 🔴 |
| ASK-E07 | P2 | everywhere | Hardcoded English. | 🔴 |
| ASK-E08 | P2 | `route.ts:1234-1263` 120 s; `tool-executor.ts:22` 15 s; `execute/route.ts:225-243` 240 s | Timeouts constants; no retry on HTTP path. | 🔴 |
| ASK-E09 | P2 | — | Zero route tests for approve / execute / plan edit. | 🔴 |

## 6. Dead / duplicate

- `AskMode`/`AskRouting` duplicated: `ask-mode.ts:16-23` vs `ask-mode-selection.ts:20-27`.
- `ask-employee.ts:14-24` `CORE_TOOLS` mirror of `tool-executor.ts:28-39` (drifted: missing `billing`, `billing_usage`).
- `tool-answer.ts` vs `reply-from-tools.ts`: `decodeEntities`, `pullContentBlocks`, `unwrapToolText`, `usefulText`, `parsePayload`, `asHits`, `isPlaceholderReply`, `namedFounders` duplicated.
- Unused: `ask-mode.ts:395-401` `rosterForLockedTeam`; `decision-explain.ts` (from ask-ai); `crew-planner.ts:422-429` `planCrew`/`parseEmployeeAllowlist` (from ask-ai); `plan/route.ts:145-161` revert block; `route.ts:68-100` `orgId` param; `page.tsx:1948-1991` `'simulated'` status; `route.ts:1323-1349` `partialReply`.
- `route.ts:197-222` comment says "Migration 107" (actual 109).

## 7. Test coverage map

| Path | Status |
|---|---|
| `api/ask-ai/route.ts`, `execute`, `plan`, `approve`, `revise`, `feedback`, `conversations` | **uncovered** |
| `(dashboard)/ask-ai/page.tsx` | uncovered |
| `components/chat/*` | partial (presentation only) |
| `lib/ask-ai-persist.ts`, `employee-mentions.ts`, `classify.ts`, `plan-generator.ts`, `playbook-matcher.ts`, `decision-explain.ts` | uncovered |
| `lib/ask-mode.ts`, `ask-mode-selection.ts`, `handoffs/*`, `crew-planner.ts`, `crew-abort` lease, `tool-answer.ts` | covered |
| `lib/ask-employee.ts` | partial |
| `wf/reply-from-tools.ts`, `local-tool-select.ts`, `route-employee.ts`, `prompts/system-prompt-builder.ts` | covered |
| `wf/plan-steps.ts`, `PlanExecuteWorkflow.ts`, `tools/sandbox.ts` local fallback | **uncovered** |
| `wf/crew-runner.ts` | partial |

Doc-claim verification: `ask-ai.md` row #5 (user attribution) **false** (ASK-B04); row #7 (double-execute guard) **partial** (ASK-B01); `BUILD_STATE.md:380` "employee role passed into tool execution" holds for in-process chat only, not plans (ASK-S02); `BUILD_STATE.md:369` "plans scoped to owning user" holds except `approve` and `feedback` (ASK-S03, S09).

## 8. Fix order for this domain

1. **ASK-S01** — remove bash fallback, drop terminal tools from core, confirm class `execute`.
2. **ASK-S02 + ASK-G03** — plan steps run as their stamped employee with that employee's allowlist and confirm gate.
3. **ASK-B01 + ASK-B02 + ASK-B11** — plan lifecycle integrity: no re-execution on reconnect, cancellable durable plans, revise → pending.
4. **ASK-S04 + ASK-S03 + ASK-S05** — RBAC on pay tools at approve; resume path keeps the locked allowlist; approval default-on for write classes.
5. **ASK-B03 + ASK-B08 + ASK-B09** — hydration correctness (newest rows, one persistence shape, restore running plans).
6. **ASK-E01** — audit helper on every Ask AI mutation.
7. **ASK-G01** — generate `chat-coverage.md` from the tool catalog + tab-action list, all cells 🔴 until a test + live probe turns them green.
8. **ASK-G02 / G08** — per-step approval with argument preview; planner over the real allowlist.
9. **ASK-S07 / S10 / S08** — fence everything model-visible; rewrite persona.
10. Route-level tests for approve/execute/plan (ASK-E09) before any of the above is called done.
