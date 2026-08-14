# 03 — End-to-end: Ask AI

Primary product path. All steps shown as sequence diagrams below. Files:

| Layer | Path |
|-------|------|
| UI | `apps/dashboard/app/(dashboard)/ask-ai/page.tsx` |
| Classify | `apps/dashboard/lib/classify.ts` |
| Plan | `apps/dashboard/lib/plan-generator.ts` |
| LiteLLM | `apps/dashboard/lib/litellm-client.ts` |
| POST entry | `apps/dashboard/app/api/ask-ai/route.ts` |
| Plan CRUD | `apps/dashboard/app/api/ask-ai/plan/route.ts` |
| Revise draft | `apps/dashboard/app/api/ask-ai/revise/route.ts` |
| Execute SSE | `apps/dashboard/app/api/ask-ai/execute/route.ts` |
| Agent | `services/workflows/src/atomic-agent-client.ts` |
| Tools | `services/workflows/src/tool-executor.ts` |

Chat UI components: `PlanCard`, `DraftPanel`, `ExecutionStrip`,
`ActionPermissionCard`, `ReasoningStrip`, `FormattedMarkdownResponse`.

Thread state: canonical history is the `messages` table for the Ask AI
conversation (`GET /api/ask-ai`). `localStorage` is a cache. Plans persist in
`agent_plans` and reload on refresh.

## Complete Ask AI flow diagram

```mermaid
flowchart TD
  Start["User types question<br/>in Ask AI input"] --> Send["Click Send"]
  Send --> PostReq["POST /api/ask-ai<br/>(session auth)"]
  PostReq --> SessionKey["Session key<br/>askai-{userId}-{YYYYMMDD}"]
  SessionKey --> Classify["classifyRequest<br/>(LiteLLM heuristic)"]
  
  Classify -->|simple| Simple["SIMPLE path"]
  Classify -->|complex| Complex["COMPLEX path"]
  Classify -->|error/timeout| DefaultSimple["Bias to SIMPLE"]
  
  Simple --> StreamOpen["Open NDJSON stream"]
  StreamOpen --> DirAgent["runAutonomousAgentDirect"]
  DirAgent --> AA["POST atomic-agent<br/>:8787 stream=true"]
  AA --> MCPLoop["MCP loop<br/>(max 3 auto-turns)"]
  MCPLoop --> Exec["executeAutonomousToolAction"]
  Exec --> ToolResult["tool result"]
  ToolResult -->|done| StreamDone["SSE done"]
  ToolResult -->|continue| MCPLoop
  StreamDone --> Persist["INSERT messages"]
  Persist --> Display1["Display on page<br/>+ update localStorage"]
  
  Complex --> GenPlan["generatePlan<br/>(LiteLLM JSON)"]
  GenPlan -->|success| PlanJSON["{ steps[], draft?, summary }"]
  GenPlan -->|fail| FallbackAgent["Fallback direct agent<br/>(JSON)"]
  PlanJSON --> SavePlan["INSERT agent_plans<br/>(status=pending)"]
  SavePlan --> ShowCard["PlanCard UI<br/>+ DraftPanel"]
  ShowCard --> HumanAction{Human Action?}
  
  HumanAction -->|Approve| Approve["PATCH /api/ask-ai/plan<br/>{ action: approve }"]
  HumanAction -->|Revise draft| Revise["POST /api/ask-ai/revise<br/>(LiteLLM only)"]
  HumanAction -->|Toggle step| Toggle["PATCH /api/ask-ai/plan<br/>{ stepId, enabled }"]
  HumanAction -->|Cancel| Cancel["PATCH /api/ask-ai/plan<br/>{ action: cancel }"]
  HumanAction -->|Reject| Reject["PATCH /api/ask-ai/plan<br/>{ action: cancel }"]
  
  Revise --> ShowCard
  Toggle --> ShowCard
  Reject --> End1["Plan cancelled"]
  
  Approve --> Execute["GET SSE /api/ask-ai/execute?planId="]
  Execute --> Wire["wireDependencies()<br/>+ stageSteps()"]
  Wire --> Parallel["Run steps in parallel<br/>(independent)"]
  Parallel --> PerStep["Per step:<br/>executeAutonomousToolAction"]
  PerStep --> Events["Events:<br/>step_start, step_done<br/>step_error"]
  Events -->|success| UpdatePlan["Update agent_plans<br/>current_step + result"]
  Events -->|error| StepErr["Step failed<br/>log error"]
  UpdatePlan --> AllDone{All steps<br/>done?}
  StepErr --> AllDone
  AllDone -->|yes| ExecDone["execution_done"]
  ExecDone --> Persist2["Save execution result"]
  Persist2 --> Display2["Display results<br/>+ mark complete"]
  
  FallbackAgent --> Persist
  Display1 --> End2["Done"]
  Display2 --> End2
  End1 --> End2
```

## Sequence diagram: Step 1-2 (Send + Classify)

```mermaid
sequenceDiagram
  participant User as User Browser
  participant Page as ask-ai page
  participant API as POST /api/ask-ai
  participant Classify as classifyRequest
  participant LLM as LiteLLM :4000

  User->>Page: Type prompt + Send
  Page->>API: POST /api/ask-ai<br/>{ prompt, context }
  API->>API: getScopedClient()
  API->>API: sessionKey = askai-{userId}-{YYYYMMDD}
  API->>Classify: classify(prompt)
  Classify->>Classify: heuristic hints<br/>(COMPLEX_HINTS / SIMPLE_HINTS)
  Classify->>LLM: chatCompletion<br/>max_tokens: 300<br/>reasoning: disabled
  LLM-->>Classify: { type: SIMPLE }<br/>or { type: COMPLEX }
  alt type = SIMPLE
    Classify-->>API: SIMPLE
  else type = COMPLEX
    Classify-->>API: COMPLEX
  else error/timeout
    Classify-->>API: SIMPLE (bias)
  end
  API->>API: route based on type
```

## Sequence diagram: Step 3a (Simple streaming)

```mermaid
sequenceDiagram
  participant Page as ask-ai page
  participant Stream as GET NDJSON /api/ask-ai
  participant Direct as runAutonomousAgentDirect
  participant AA as atomic-agent :8787
  participant MCP as MCP Bridge :8790
  participant Exec as Tool Executor
  participant DB as Postgres

  Page->>Stream: open connection
  Stream->>Direct: start()
  Direct->>Direct: buildGroundedUserMessage()<br/>(org facts in USER message)
  Direct->>AA: POST /v1/chat/completions<br/>stream=true<br/>session_id
  AA->>AA: inference (up to 3 turns)
  AA->>MCP: tool_progress: {name, args}
  MCP->>Exec: executeAutonomousToolAction
  Exec->>DB: check RLS + allowlist
  alt allowed
    Exec->>DB: real query
    DB-->>Exec: result
  else not allowed
    Exec-->>MCP: error: not_allowed
  end
  Exec-->>MCP: result JSON
  MCP-->>AA: SSE tool result
  AA->>AA: isDone?
  alt no
    AA->>MCP: next tool_progress
  else yes
    AA-->>Stream: SSE final text
  end
  Stream-->>Page: NDJSON event
  Page->>Page: append to chat<br/>+ update UI
  AA -->|done| Stream: SSE done
  Stream->>DB: INSERT messages
  DB-->>Stream: ok
  Stream-->>Page: stream close
```

## Sequence diagram: Step 3b (Complex plan generation)

```mermaid
sequenceDiagram
  participant Page as ask-ai page
  participant API as POST /api/ask-ai
  participant PlanGen as generatePlan
  participant LLM as LiteLLM :4000
  participant Sanitize as sanitizeSteps
  participant DB as Postgres

  API->>PlanGen: generatePlan(prompt, orgId, connectedTools)
  PlanGen->>LLM: chatCompletion (JSON mode)<br/>{ reasoning, steps[], draft?, summary }
  LLM-->>PlanGen: JSON response
  alt JSON parse ok
    PlanGen->>Sanitize: sanitizeSteps(steps)
    Sanitize->>Sanitize: filter to VALID_TOOLS
    Sanitize->>Sanitize: max 12 steps
    Sanitize-->>PlanGen: cleaned steps
  else parse error
    PlanGen-->>API: error + fallback to direct
  end
  PlanGen->>DB: INSERT agent_plans<br/>{ steps, draft, status='pending', ... }
  DB-->>PlanGen: plan_id
  PlanGen-->>API: { plan_id, steps, draft }
  API-->>Page: JSON (not stream)
  Page->>Page: render PlanCard<br/>+ DraftPanel
  Page-->>User: "Plan ready for approval"
```

## Sequence diagram: Step 4 (Human plan editing)

```mermaid
sequenceDiagram
  participant User as User
  participant UI as PlanCard UI
  participant API as PATCH /api/ask-ai/plan
  participant DB as Postgres

  loop while editing
    User->>UI: toggle step / edit notes
    UI->>API: PATCH<br/>{ planId, stepId, enabled }<br/>or { action: revise }
    API->>DB: UPDATE agent_plans<br/>status still pending
    DB-->>API: ok
    API-->>UI: updated plan
    UI->>UI: re-render
  end
  
  User->>UI: Click Approve
  UI->>API: PATCH<br/>{ planId, action: approve }
  API->>DB: UPDATE agent_plans<br/>status = approved<br/>approved_at = now()
  DB-->>API: ok
  API-->>UI: { status: approved }
  UI-->>User: "Ready to execute"
  
  alt user clicks Execute
    User->>UI: Click Execute
  else user cancels
    User->>UI: Click Cancel
    UI->>API: PATCH { action: cancel }
    API->>DB: status = cancelled
  end
```

## Sequence diagram: Step 5 (Plan execution)

```mermaid
sequenceDiagram
  participant Page as ask-ai page
  participant Exec as GET SSE /api/ask-ai/execute
  participant Wire as wireDependencies
  participant Stage as stageSteps
  participant ToolExec as executeAutonomousToolAction
  participant Nango as Nango Vault
  participant Provider as Provider API
  participant DB as Postgres

  Page->>Exec: GET ?planId=<id>
  Exec->>DB: SELECT * FROM agent_plans WHERE id=? AND status=approved
  DB-->>Exec: plan + steps
  Exec->>Wire: analyze step dependencies
  Wire-->>Exec: dependency graph
  Exec->>Stage: create parallel batches
  Stage-->>Exec: batch[] (independent steps)
  
  Exec-->>Page: SSE execution_start
  
  par batch 1 (parallel)
    Page->>ToolExec: step 1
    ToolExec->>Nango: fetch token (Gmail)
    Nango-->>ToolExec: token
    ToolExec->>Provider: HTTP call
    Provider-->>ToolExec: result
  and batch 2 (parallel)
    Page->>ToolExec: step 2
    ToolExec->>DB: query
    DB-->>ToolExec: result
  and batch 3 (parallel)
    Page->>ToolExec: step 3
  end
  
  ToolExec-->>Exec: step_done { step, result }
  Exec->>DB: UPDATE agent_plans<br/>current_step + results
  Exec-->>Page: SSE step_done
  Page->>Page: display result
  
  Exec->>Exec: all steps done?
  Exec-->>Page: SSE execution_done
  Exec->>DB: UPDATE agent_plans<br/>status = completed<br/>completed_at
  DB-->>Exec: ok
  Page->>Page: mark complete<br/>save to localStorage
```

---

## Step 1 — User sends a prompt

`sendRequest()` POSTs `/api/ask-ai` with the prompt. Session cookie supplies
org. Route **does not** take `org_id` from the body.

Session key for atomic-agent: `askai-{userId}-{YYYYMMDD}` so a poisoned session
cannot last more than a day.

---

## Step 2 — Classify (`classifyRequest`)

1. Cheap heuristics (`COMPLEX_HINTS` / `SIMPLE_HINTS`).
2. LiteLLM `chatCompletion` with `max_tokens: 300`, `reasoning: { enabled: false }`.
3. Expect `{"type":"SIMPLE"}` or `{"type":"COMPLEX"}`.
4. On timeout / garbage / uncertainty → **bias to simple**.

Complex means: tools, record changes, inbox triage, drafts, scheduling, CRM,
analytics over data, anything that should be approved first.

---

## Step 3a — Simple → stream

Route opens an NDJSON stream and calls `runAutonomousAgentDirect`:

1. POST `ATOMIC_AGENT_URL/v1/chat/completions` with `stream: true`.
2. Org facts in the **user** message (`buildGroundedUserMessage`) because
   atomic-agent drops the OpenAI `system` role.
3. atomic-agent may call MCP tools on `:8790`.
4. Chunks + `tool` events go to the page until the turn ends.

Verified live: DB count question answered in ~6–7s; unconnected GitHub returns
an honest “not connected via Nango” reply (no `org_id` hunting loop).

---

## Step 3b — Complex → plan

`generatePlan(prompt, orgId, connectedTools)`:

- LiteLLM JSON: `reasoning`, `steps[]` (`tool`, `action`, `payload`, `description`),
  optional `draft`, `summary`.
- `sanitizeSteps` keeps only tools in `VALID_TOOLS` (gmail, calendars, drive,
  docs, sheets, github, whatsapp, hubspot, ads, slack, notion, stripe, shopify,
  zendesk, intercom, razorpay, google-analytics, google-chat, google-meet,
  google-search-console, google-business-profile, google-cloud, database_query,
  web_search, web_extract, file_ops, sandbox). Max 12 steps.
- Insert `agent_plans` row `status='pending'`.
- Response is JSON (not a stream). UI shows `PlanCard` + `DraftPanel`.

If plan generation fails, the route falls back to a **direct agent JSON** run
so the user still gets an answer.

---

## Step 4 — Human edits the plan

| Action | API |
|--------|-----|
| Toggle a step | `PATCH /api/ask-ai/plan` while pending |
| Approve | `PATCH` `{ action: 'approve' }` |
| Cancel | `PATCH` `{ action: 'cancel' }` |
| Revise draft copy | `POST /api/ask-ai/revise` → `reviseDraft()` |

---

## Step 5 — Execute (SSE)

`GET /api/ask-ai/execute?planId=`

1. Load approved plan. Reject if not approved.
2. `wireDependencies()` then `stageSteps()` — independent steps run **in parallel**.
3. Each step: `executeAutonomousToolAction` with `toolAllowlist` = plan tools +
   always-allowed core tools.
4. Events: `execution_start`, `step_start`, `step_done`, `step_error`,
   `execution_done`.
5. `agent_plans` updated mid-stream (`current_step`, step results).
6. Langfuse traces: `PlanExecution-<tool>` + `PlanExecutionSummary`.

This path **does not** call atomic-agent. The plan is the program.

Verified live (2026-08-11): complex prompt → plan with gmail `draft_email` →
approve → execute stream in ~13s. Draft itself 403’d until Gmail was
re-connected with `gmail.compose`.

---

## What works

- Simple streaming Q&A with real tools. SSE `done` is applied on the page.
- Complex plan persist / refresh-safe / approve / cancel / toggle / extra
  instructions (notes, not a fake tool) / revise.
- Execute 409s already-completed plans and finishes after SSE disconnect.
- Home `/ask-ai?q=` works. History hydrates from `messages`.
- Honest `notConnected` when OAuth is missing (`setupUrl`).
- Daily session rotation (no unbounded poisoned WAL).

## What does not (on this path)

- Classifier can still mis-tag; fallback prefers simple (user may not see a
  plan when they expected one).
- No multi-user shared Ask AI thread.
- Google Chat/Meet/Analytics/etc. are in `VALID_TOOLS` and have executors; they
  still need a live Nango token.
