# 18 — Q2: @employee mention vs org-union allowlist

Date: **Thursday 13 August 2026**. Branch: `future-scope`. Workstream **WS-16 / E5**.

Closes open question [Q2](../plan/execution/02-risks-and-open-questions.md) before
shipping `@employee` mention parsing (`apps/dashboard/lib/employee-mentions.ts`).
This is a product decision, not a guess in the plan file.

---

## Decision

**Keep the org-union allowlist.** An `@Sarah` / “Ask Marcus to …” lock chooses
the **employee** (persona, memory scope, routed worker). It does **not** shrink
the tool set to that employee’s `tool_allowlist`.

Runtime allowlist remains:

1. always-allowed core tools
2. union of **all active** employee allowlists
3. connected channels

E1 stands: Sarah (gmail-only) + connected Sheets still runs `sheets_create`.
Never-connected HubSpot stays gated. Mention-lock must not regress that union.

---

## Why

- E1 already shipped the union after a LIMIT-1 bug. Mention-lock-as-allowlist
  would reintroduce “Sheets connected but Sarah cannot touch them.”
- Isolation that matters is still **honest `notConnected`** plus the org union,
  not prompt-level persona. A listing coordinator without WhatsApp in any
  active allowlist (and without a connected WhatsApp channel) still cannot send.
- Ask AI “auto” and `@employee` then share one tool policy; only the voice
  and memory scope change.

---

## What mention parsing does

`parseEmployeeMentions` returns `{ mode: 'auto' | 'mention', locked, remainder }`.
Callers pass `locked` into `route(work_item)` as a preferred employee. They
must **not** pass only that employee’s allowlist into `executeAutonomousToolAction`.

Pack YAML employees (WS-21) and Ask AI @mention UX chrome (WS-19) are out of
scope here.

---

## Verify

- Org with Sarah (gmail) + Emma + connected Sheets: `@Sarah create a sheet`
  still executes `sheets_create` when Sheets is connected.
- HubSpot never connected: still `connected: false`.
- Auditor still cannot POST pay tools (E6); that gate is RBAC, not allowlist.
