-------------------------------------------------------------------------------
-- DSR — resumable progress + downloadable export artifact path
-- progress tracks per-table delete cursor so a timed-out/retried job never
-- stays stuck in status='running' without a resume point.
-- artifact_path is an org-scoped relative path under DSR_ARTIFACT_DIR.
-- File: infra/db/migrations/107_dsr_progress_artifact.sql
-------------------------------------------------------------------------------

ALTER TABLE dsr_requests
  ADD COLUMN IF NOT EXISTS progress JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE dsr_requests
  ADD COLUMN IF NOT EXISTS artifact_path TEXT;

COMMENT ON COLUMN dsr_requests.progress IS
  'Resumable job cursor: { doneTables: string[], deleted: object, currentTable?: string }. Empty when idle.';
COMMENT ON COLUMN dsr_requests.artifact_path IS
  'Relative path under DSR_ARTIFACT_DIR for kind=export downloads. Null until the artifact is written.';
