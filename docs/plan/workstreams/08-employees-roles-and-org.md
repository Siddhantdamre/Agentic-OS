# Workstream 08 — Employees, roles, and org

Darex’s product is **AI employees**, not a single chatbot. New
employee = config. Never hardcode a role into shared infra.

Linked from [../05-workstream-index.md](../05-workstream-index.md).
Documentation only.

---

## 1. Current reality

Sources: `docs/current-working/09-dashboard-pages.md`,
`07-e2e-agent-runtime.md`, `08-tools-catalog.md`, BUILD_STATE
allowlist fix 2026-08-13.

- GET `/api/employees` auto-seeds Sarah / Emma / Marcus.
  `AutonomousActionConsole` → `POST /api/agent/run`.
- Allowlist = union of **all** active employees + connected
  channels + core tools. Do not regress to LIMIT 1.
- WhatsApp uses the first active employee. No router, critic,
  @employee, Research/Finance, or skill-version UI.
- `users.role` exists; not product RBAC.

---

## 2. Target

Sources: `docs/future-scope/08-agent-workforce.md`, `03`, `13`.

- Core roster v2 adds Research and Finance (confirm `pay`).
- `route(work_item) -> { employeeId, confidence, reason }`.
- Multi-agent = Temporal of multiple loops. Default solo + memory.
  Never 8 agents per “hi”.
- Critic LiteLLM JSON before send/publish/sign.
- Human takeover disables auto. Promote confirmed plans to skills.

---

## 3. Gaps

**Audit 2026-08-14:** E1–E6 **done** (org-union @employee).

Seed + allowlist union **done**. Router, critic, Research/Finance,
@mention, pack YAML, auditor role **missing**.

---

## 4. Work items

### E1 — Do not regress allowlist union

- **Where:** `tool-executor.ts`; `ask-ai/execute/route.ts`.
- **DoD:** Org with Sarah (gmail-only) + connected Sheets still
  runs `sheets_create`. Never-connected HubSpot stays gated.

### E2 — Router

- **Where:** `services/workflows/src/route-employee.ts`; O2 calls it.
- **DoD:** Emergency keyword → human/dispatch, not ISA. “Ask
  Marcus to …” locks Marcus.

### E3 — Critic gate

- **Where:** activity `criticCheck`; S2 webhook path.
- **DoD:** Known-bad fair-housing draft blocked in tests.

### E4 — Research + Finance seeds

- **Where:** employees seed; later pack YAML.
- **DoD:** New org can disable Finance. Allowlists distinct.

### E5 — Ask AI @employee + auto

- **Where:** `ask-ai/page.tsx`; POST `/api/ask-ai`.
- **Open question:** mention-lock vs org-union allowlist — see
  [../execution/02-risks-and-open-questions.md](../execution/02-risks-and-open-questions.md).

### E6 — Human roles

- **What:** owner / admin / member / auditor. Auditor cannot `pay`.
- **DoD:** Auditor cannot POST `/api/agent/tools` for razorpay.

---

## 5. End-to-end connections

Runtime executes as the routed employee. Orchestration calls the
router. Memory scopes `employee_memory`. Packs seed YAML.

---

## 6. Non-goals

CrewAI/AutoGen/Letta as runtime. Hardcoding “Listing agent” in
the worker. Unbounded multi-agent.

---

## 7. Verification

Allowlist regression. Router goldens. Critic known-bad draft.
Two-org employee isolation. Honest notConnected regardless of
persona.

Related: [01-runtime-and-agent-loop.md](./01-runtime-and-agent-loop.md),
[13-vertical-packs.md](./13-vertical-packs.md).
