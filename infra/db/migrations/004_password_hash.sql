---------------------------------------------------------------------------
-- Darex Migration 004 — Password Hash for Postgres auth fallback
-- Adds password_hash to users so the Postgres fallback verifies credentials
-- instead of auto-provisioning on any password.
---------------------------------------------------------------------------

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
