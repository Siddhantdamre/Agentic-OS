-------------------------------------------------------------------------------
-- Onboarding & cold start — Migration 027
-------------------------------------------------------------------------------

ALTER TABLE org_onboarding
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC',
  ADD COLUMN IF NOT EXISTS business_hours JSONB NOT NULL DEFAULT
    '{"start":"09:00","end":"18:00","days":[1,2,3,4,5]}'::jsonb,
  ADD COLUMN IF NOT EXISTS business_hours_start TEXT NOT NULL DEFAULT '09:00',
  ADD COLUMN IF NOT EXISTS business_hours_end TEXT NOT NULL DEFAULT '18:00',
  ADD COLUMN IF NOT EXISTS decision_recipient_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS decision_recipient_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS first_observation_shown_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_observation_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rollout_announced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS autonomy_confirmed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS org_backfill_jobs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  window_days     INTEGER NOT NULL DEFAULT 30,
  status          TEXT NOT NULL DEFAULT 'pending',
  loops_imported  INTEGER NOT NULL DEFAULT 0,
  won_imported    INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT org_backfill_jobs_window_chk CHECK (window_days > 0 AND window_days <= 30),
  CONSTRAINT org_backfill_jobs_status_chk CHECK (
    status IN ('pending','running','completed','failed')
  )
);

ALTER TABLE org_backfill_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_backfill_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_backfill_jobs_org_isolation ON org_backfill_jobs;
CREATE POLICY org_backfill_jobs_org_isolation ON org_backfill_jobs
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON org_backfill_jobs TO darex_app;

CREATE TABLE IF NOT EXISTS org_first_observations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  headline        TEXT NOT NULL,
  detail          TEXT NOT NULL,
  thread_count    INTEGER NOT NULL DEFAULT 0,
  conversation_ids UUID[] NOT NULL DEFAULT '{}',
  shown_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE org_first_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_first_observations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_first_observations_org_isolation ON org_first_observations;
CREATE POLICY org_first_observations_org_isolation ON org_first_observations
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON org_first_observations TO darex_app;
