-------------------------------------------------------------------------------
-- Employees + least-privilege app role — Migration 011
-- Caller: infra/db/migrate.js. 009/010 exist; no 011 yet.
-- graph_id had no default. GRANT CONNECT so DB_USER=darex_app works.
-- No tenant rows fabricated. User asked to complete darex_app path.
-------------------------------------------------------------------------------

ALTER TABLE ai_employees
  ALTER COLUMN graph_id SET DEFAULT '';

UPDATE ai_employees SET graph_id = '' WHERE graph_id IS NULL;

GRANT CONNECT ON DATABASE darex TO darex_app;
GRANT USAGE ON SCHEMA public TO darex_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO darex_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO darex_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO darex_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO darex_app;
