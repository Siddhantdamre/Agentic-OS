-------------------------------------------------------------------------------
-- Mark orgs that have completed initial AI-employee roster seeding so an
-- intentionally emptied roster is never auto-reseeded on GET /api/employees.
-------------------------------------------------------------------------------

ALTER TABLE orgs
  ADD COLUMN IF NOT EXISTS employees_seeded BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill: any org that already has employees has been seeded.
UPDATE orgs
   SET employees_seeded = TRUE
 WHERE employees_seeded = FALSE
   AND EXISTS (SELECT 1 FROM ai_employees e WHERE e.org_id = orgs.id);
