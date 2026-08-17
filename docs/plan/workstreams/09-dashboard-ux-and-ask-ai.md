# Workstream 09 — Dashboard UX and Ask AI

Owner surfaces stay Next.js + the existing cream theme / AppShell.
Packs add **modules**, not a second app.

Linked from [../05-workstream-index.md](../05-workstream-index.md).
Documentation only.

---

## 1. Current reality

Sources: `docs/current-working/03-e2e-ask-ai.md`,
`09-dashboard-pages.md`, `16-updates-2026-08-13.md`.

- Ask AI works: simple stream with SSE `done`; complex PlanCard +
  parallel execute; history from `messages`; Home `?q=`; honest
  chips; `notConnected` CTA.
- Classifier can mis-tag (bias to simple). No shared multi-user
  thread. No citations. No @employee.
- Inbox, employees, integrations, settings, analytics use real
  SQL. Insight is templates. Warm-up is a fake bar.
- No `/brain`, listings, inquiry kanban, map, plans inbox,
  mobile/a11y pass.

---

## 2. Target

Sources: `docs/future-scope/11` §2 and §6, `00` §5, `05` §12,
`13` Phases 9/11/13.

Ask the business with RAG + citations + @employee. Home briefing.
Work-item omnibox. Brain. Pack modules (listings, kanban, map).
Onboarding → pack install with real warm-up. Mobile + a11y.

---

## 3. Gaps

**Audit 2026-08-14:** U1–U5 **done**. U6 **partial** (a11y
components; no recorded 375px pass).

Ask AI core **done**. Citations, @employee, Brain, pack modules,
real warm-up, mobile/a11y **missing**.

---

## 4. Work items

### U1 — Citations on Ask AI

- **Where:** `ask-ai/page.tsx`.
- **Depends on:** M3.
- **DoD:** Memory-backed sentences show a source chip.

### U2 — Plans inbox

- **Where:** `/plans`; list `agent_plans`.
- **DoD:** Approve from this page equals PlanCard.

### U3 — `/brain` chrome

- **Depends on:** M5.
- **DoD:** Disabled source visible as disabled.

### U4 — Pack modules (RE first)

- **Where:** listings / inquiries routes, gated by pack.
- **DoD:** Empty sheet → empty table, not demo listings.

### U5 — Onboarding → pack + real warm-up

- **Where:** `(onboarding)`; InstallPackWorkflow.
- **DoD:** “Real estate — brokerage” installs `core-b2b` +
  `real-estate-brokerage` idempotently.

### U6 — Mobile + a11y (Phase 9)

- **What:** Bottom tabs; `aria-live`; keyboard confirm; non-color
  status.
- **DoD:** Checklist in
  [../execution/01-definition-of-done.md](../execution/01-definition-of-done.md).

---

## 5. End-to-end connections

Ask AI sits on runtime (01) + memory (03). Inbox is channels (06)
+ work items (02). Pack modules are 13. Insight cards (10) on Home.

---

## 6. Non-goals

A second frontend. Consumer listing portal. Rewriting the NDJSON
stream protocol.

---

## 7. Verification

Keep Ask AI ~6s / ~13s. Citations when memory used. Empty pack UI
has zero invented rows. Keyboard-reachable confirm.

Related: [03-memory-rag-brain.md](./03-memory-rag-brain.md),
[13-vertical-packs.md](./13-vertical-packs.md).
