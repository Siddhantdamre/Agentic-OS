-- 099_org_skills.sql
-- Tenant skill enablement + employee skill assignments.
-- Catalog lives in @darex/workflows skills/catalog (code); skill_id is free text.
-- Idempotent / IF NOT EXISTS only.

CREATE TABLE IF NOT EXISTS org_skills (
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  custom_prompt_overlay TEXT,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, skill_id)
);

CREATE TABLE IF NOT EXISTS employee_skills (
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES ai_employees(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, employee_id, skill_id)
);

CREATE INDEX IF NOT EXISTS idx_org_skills_lookup ON org_skills (org_id, enabled);
CREATE INDEX IF NOT EXISTS idx_employee_skills_lookup ON employee_skills (org_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_skills_skill ON employee_skills (org_id, skill_id);

ALTER TABLE org_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_skills FORCE ROW LEVEL SECURITY;
ALTER TABLE employee_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_skills FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_skills_org_isolation ON org_skills;
CREATE POLICY org_skills_org_isolation ON org_skills
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

DROP POLICY IF EXISTS employee_skills_org_isolation ON employee_skills;
CREATE POLICY employee_skills_org_isolation ON employee_skills
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON org_skills TO darex_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON employee_skills TO darex_app;
