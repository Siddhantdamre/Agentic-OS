-------------------------------------------------------------------------------
-- Backfill a seeded Executive AI employee per org that lacks role Executive.
-- Idempotent: re-run skips orgs that already have an Executive row.
-- Allowlist is narrow (no stripe / ads / send) — matches DEFAULT_EMPLOYEE_ROSTER.
-------------------------------------------------------------------------------

INSERT INTO ai_employees (org_id, name, role, persona, tool_allowlist, graph_id, status)
SELECT
  o.id,
  'Executive',
  'Executive',
  jsonb_build_object(
    'text',
    'Cross-domain coordinator. Deliver the daily brief from real work items, summarize org status, and hand specialist work to the right employee. Never invent sources. Never send, pay, or run ads.',
    'rosterKey',
    'executive',
    'confirmClasses',
    '[]'::jsonb
  ),
  ARRAY['web_search', 'database_query', 'cognee', 'daily_brief']::text[],
  'default-executive',
  'active'
FROM orgs o
WHERE NOT EXISTS (
  SELECT 1
    FROM ai_employees e
   WHERE e.org_id = o.id
     AND e.role = 'Executive'
);
