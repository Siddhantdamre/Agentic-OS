-------------------------------------------------------------------------------
-- ingestion_jobs.payload — the text an embed job will embed, per job.
-- The text used to ride in knowledge_sources.metadata.pendingText, shared by
-- every job for the same source: two jobs queued for one conversation each
-- overwrote it, and both embedded whichever text was written last (MEM-B03).
-- Cleared when the job finishes. Readers fall back to the metadata copy for
-- jobs queued before this migration.
-- Idempotent.
-- File: infra/db/migrations/208_ingestion_job_payload.sql
-------------------------------------------------------------------------------

ALTER TABLE ingestion_jobs ADD COLUMN IF NOT EXISTS payload JSONB;
