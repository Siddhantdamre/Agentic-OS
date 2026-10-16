# DSR (Data Subject Request) Audit

## Status: mostly done (P0 closed — UI, typed confirm, async Temporal delete with
resumable progress, downloadable export artifact, history API + audit rows)

This covers `apps/dashboard/app/api/dsr/*`, Settings → Privacy & GDPR,
`services/workflows` `DsrDeleteWorkflow` / `DsrExportWorkflow`, and migration
`107_dsr_progress_artifact.sql`.

---

## Tracker

| Gap | Status | Notes |
|-----|--------|-------|
| Settings Privacy/GDPR UI (export + delete) | **Done** | `settings/page.tsx` Privacy tab + `DsrPrivacyPanel` |
| Typed confirmation on delete | **Done** | Body `confirm` must match org slug or exact name (`dsr-confirm.ts`) |
| Async delete via Temporal + resumable progress | **Done** | `DsrDeleteWorkflow` + `progress.doneTables`; direct fallback if Temporal down; failed after retries (not stuck `running`) |
| Stale `running` delete reaper | **Done** | `runDsrDelete` stamps `progress.heartbeatAt` on every save; `DsrReaperWorkflow` (15 min) calls `dsr_requests_reap_stale` (migration 203, default 30 min, `DAREX_DSR_STALE_MINUTES`) and marks silent delete jobs `failed` so the operator can retry. Migration not applied live; not run against Temporal. |
| Audit record on delete/export | **Done** | Inline `audit_events` insert in workflow runners (`dsr.delete` / `dsr.export`). Shared emit helper remains owned by the audit agent |
| Downloadable export artifact | **Done** | JSON under `DSR_ARTIFACT_DIR/{orgId}/{id}.json`; `GET /api/dsr/:id/download` |
| `GET /api/dsr` history | **Done** | Lists last 50 jobs with progress + downloadPath |
| Honest `include_files` | **Done** | Export sets `include_files=false`; payload notes metadata-only knowledge_sources |
| Post-delete zero-row verification | **Done** | `tablesWithRemainingRows` sweep after the delete loop; leftover rows (in-flight writes) re-open those tables and throw so the Temporal retry finishes them instead of marking `completed` |
| Legal-hold / retention override | **Blocked** | No legal-hold product surface yet |
| Live UI check on :3002 | **Partial** | Not verified live in this worktree (shared port policy); unit/typecheck covered |

---

## What works (file:line evidence)

1. **Org scoping** — routes reject body `org_id`/`orgId`; resolve via `getScopedClient()`.
2. **RBAC** — delete owner-only (`canDeleteDsr`); export/history/download owner+admin (`canExportDsr`).
3. **Typed delete confirm** — `matchesDsrDeleteConfirm` before insert.
4. **Async delete** — insert `pending`, release pool, `enqueueDsrDelete` → Temporal or direct resumable runner.
5. **Progress cursor** — `dsr_requests.progress.doneTables` updated after each table.
6. **Export artifact** — written to disk; download gated by session org + RBAC; path traversal rejected.
7. **Audit** — success paths write `dsr.delete` / `dsr.export` into `audit_events`.

---

## Remaining (non-P0)

- Legal hold gate (Blocked / product).
- Optional: hide Delete button for non-owners in UI (API already 403s).
