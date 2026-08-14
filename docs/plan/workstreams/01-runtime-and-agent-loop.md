# Workstream 01 — Runtime and agent loop

The employee loop stays **atomic-agent v0.1.72 → MCP bridge
`mcp.darex.*` → `executeAutonomousToolAction`**. LiteLLM stays the
JSON brain for classify/plan/revise/embed. Do not merge those paths.

Linked from [../05-workstream-index.md](../05-workstream-index.md).
Documentation only.

---

## 1. Current reality

Sources: `docs/current-working/07-e2e-agent-runtime.md`,
`03-e2e-ask-ai.md`, `08-tools-catalog.md`, `16-updates-2026-08-13.md`,
`AGENTS.md` (tool count there is stale: 49 vs 62).

- Ask AI **simple** always uses `runAutonomousAgentDirect` (no
  Temporal). Org facts go in the user message because atomic-agent
  drops `system`. Session key `askai-{userId}-{YYYYMMDD}`.
- Ask AI **complex execute** calls `executeAutonomousToolAction`
  per step and **skips** atomic-agent. Independent steps run in
  parallel via `stageSteps`.
- Inbound / `/api/agent/run` / `/api/agent/stream` try Temporal
  `AutonomousAgentWorkflow` first (max 3 durable turns, `isDone`,
  `priorToolResults`, `idempotency_keys`), then direct fallback.
- MCP bridge on `:8790`, server name `darex`, 62 tools, `GET /health`.
- Allowlist = caller list **or** union of active employees +
  connected channels + always-allowed core tools. Matching is
  case-insensitive and treats `_` / `-` as equal.
- 11 `SKILL.md` playbooks under
  `infra/docker/atomic-agent/custom-skills/` are COPY’d into
  `starter-skills`. Rebuild the image after edits.
- Sandbox: `infra/docker/sandbox/` (unprivileged uid 10001,
  python/node/bash, no outbound network). `SANDBOX_API_URL` wired.
  Context is in the working tree; untracked vs commit `99b5f04`.
- Memory fabric inside atomic-agent (profile/notes) is **on**.
  Embeddings/lessons/procedures are **off**. That is **not** Darex
  org RAG.

---

## 2. Target

Sources: `docs/future-scope/00` layer 3–4, `02` §5–7, `08` §5 and
§12, `10` intro, `14` §2, `15` §3.

- One employee loop forever. Multi-agent is **Temporal orchestration
  of multiple loops**, not CrewAI/LangGraph/Letta.
- Skills are real SOPs: core playbooks mounted (already in tree) +
  vertical playbooks + org-uploaded SOPs promoted after review.
- `retrieveMemory` prefix on **every** path, including Ask AI
  simple and webhook turns. atomic-agent scratch stays working
  memory only.
- `executeAutonomousToolAction` remains the single gateway. Split
  the file into provider modules; add risk/confirm metadata.
- Semantic `metrics.query` for models; raw `database_query` admin-only.
- Computer-use / Playwright only in Phase 17, confirm every write.

---

## 3. Gaps

**Audit 2026-08-14:** R1/R2/R3/R4/R5/R6 **done**. Inbound parent
`retrieveMemoryActivity` calls `retrieveMemory`. Browser-runner **deferred**.

| Item | Status |
|------|--------|
| Dual-loop hang class (classify via atomic-agent) | **closed** — LiteLLM path |
| Skills COPY in Dockerfile | **done** in working tree; rebuild + commit |
| Sandbox image context | **partial** — land on default branch |
| `retrieveMemory` in `buildGroundedUserMessage` | **missing** (workstream 03) |
| Specialist router / critic | **missing** (workstream 08) |
| Provider-module split of `tool-executor.ts` | **missing** (workstream 04) |
| Semantic metrics tool | **missing** (workstream 05 / 10) |
| Browser-runner | **missing** (Phase 17) |
| Hermes / LangGraph | **gone** — do not revive |

---

## 4. Work items

### R1 — Land skills and sandbox on the default branch

- **What:** Commit `infra/docker/sandbox/` and confirm
  `infra/docker/atomic-agent/Dockerfile` COPY of `custom-skills/`.
  Rebuild `atomic-agent` and `sandbox` images.
- **Where:** `infra/docker/sandbox/`, `infra/docker/atomic-agent/`,
  `infra/docker-compose.yml`.
- **Depends on:** nothing.
- **DoD:** `code_execution` python `6*7` still works after a clean
  `pnpm infra:up`. A gmail-playbook change is visible only after
  image rebuild (documented). Git tracks the sandbox context.

### R2 — Extend `buildGroundedUserMessage` with retrieved facts

- **What:** After workstream 03 ships `retrieveMemory`, inject a
  capped cited-facts block into the user message on Ask AI simple,
  `/api/agent/run`, and Temporal `runAgentTurnActivity`. Empty index
  → “no stored memory”; never invent.
- **Where:** `services/workflows/src/atomic-agent-client.ts`;
  callers in `apps/dashboard/app/api/ask-ai/route.ts` and
  `services/workflows/src/activities/index.ts`.
- **Depends on:** M1–M3 in workstream 03.
- **DoD:** Returning WhatsApp number retrieves name + last issue
  (future-scope `10` §7). Disconnected Sheets/MLS still honest.

### R3 — Per work-item session keys for inbound

- **What:** Inbound Temporal turns use `darex:{orgId}:{workItemId}`
  (or conversation id until work items exist). Stop any shared
  `darex:{org}:chat` leftover. Keep Ask AI daily per-user keys.
- **Where:** `atomic-agent-client.ts` `buildSessionId`;
  `apps/dashboard/lib/inbound-agent.ts`.
- **Depends on:** workstream 02 work-item id (conversation id interim).
- **DoD:** Two concurrent inbound threads do not share WAL. Poisoned
  session cannot last beyond the work item.

### R4 — Verify skill playbooks change behavior

- **What:** Golden prompt that the gmail-playbook (or
  nango-integrations-playbook) should steer. Run connected +
  disconnected. Document rebuild requirement.
- **Where:** `infra/scripts/` or Promptfoo YAML (workstream 10).
- **Depends on:** R1, eval-runner stub.
- **DoD:** One playbook-on vs playbook-off difference recorded in
  `BUILD_STATE.md`. No fabricated Gmail data.

### R5 — Risk metadata on the executor gateway (start)

- **What:** Each tool export `{ actions, risk, confirm }`. MCP
  bridge and plan execute read risk class. Do not yet block webhook
  sends (that is workstream 07 / 02) but the metadata must exist.
- **Where:** `services/workflows/src/tool-executor.ts` then
  `src/tools/*.ts` as the file is split (workstream 04).
- **Depends on:** none to start; split can follow.
- **DoD:** `gmail.send` / `razorpay_create_payment_link` /
  `web_search` have classes `send` / `pay` / `read`. Exhaustive
  switch on the risk union.

### R6 — Do not add a second runtime

- **What:** Standing reject. If a PR adds LangGraph, Mastra, Letta,
  CrewAI, or a second MCP server, it fails review.
- **Where:** this file + [../04-principles-and-constraints.md](../04-principles-and-constraints.md).
- **DoD:** future-scope `15` §14 still matches the repo.

---

## 5. End-to-end connections

- **Ask AI simple** streams this loop; must gain memory prefix (03)
  and citations UI (09).
- **Ask AI execute** bypasses the loop; still uses the same
  executor and allowlist (04, 08).
- **WhatsApp / Chatwoot** use Temporal then this loop (02, 06).
- **Employees** pass persona + allowlist into `/api/agent/run` (08).
- **Langfuse** traces each turn (10).

---

## 6. Non-goals

- Replacing atomic-agent or LiteLLM.
- Fine-tuning a custom model.
- Computer-use as default muscle (Phase 17 only).
- Letting the model `INSERT` memory via raw SQL.

---

## 7. Verification

- Existing: Temporal E2E `mcp.darex.database_query`; Ask AI ~6s
  simple / ~13s complex; sandbox 6*7; honest GitHub notConnected.
- New: R1 clean compose; R2 two-org vector + returning contact;
  R4 playbook eval; R5 risk enum compile.
- Never: fake tool success, fake inventory, embeddings on the
  webhook thread.

Related: [02-orchestration-and-workflows.md](./02-orchestration-and-workflows.md),
[03-memory-rag-brain.md](./03-memory-rag-brain.md).
