-------------------------------------------------------------------------------
-- Customer employee tool allowlist backfill
-- Adds zendesk, intercom, and customer-ops to Customer Resolution; customer-ops
-- to Customer Support. Idempotent: never removes tools an org already added.
-- File: infra/db/migrations/110_customer_employee_tools.sql
-------------------------------------------------------------------------------

UPDATE ai_employees e
   SET tool_allowlist = (
         SELECT ARRAY(
           SELECT DISTINCT t
             FROM unnest(
               COALESCE(e.tool_allowlist, '{}'::text[])
               || ARRAY['zendesk', 'intercom', 'customer-ops']::text[]
             ) AS t
            ORDER BY t
         )
       ),
       updated_at = NOW()
 WHERE e.role = 'Customer Resolution'
   AND e.archived_at IS NULL
   AND (
     NOT (COALESCE(e.tool_allowlist, '{}'::text[]) @> ARRAY['zendesk']::text[])
     OR NOT (COALESCE(e.tool_allowlist, '{}'::text[]) @> ARRAY['intercom']::text[])
     OR NOT (COALESCE(e.tool_allowlist, '{}'::text[]) @> ARRAY['customer-ops']::text[])
   );

UPDATE ai_employees e
   SET tool_allowlist = (
         SELECT ARRAY(
           SELECT DISTINCT t
             FROM unnest(
               COALESCE(e.tool_allowlist, '{}'::text[])
               || ARRAY['customer-ops']::text[]
             ) AS t
            ORDER BY t
         )
       ),
       updated_at = NOW()
 WHERE e.role = 'Customer Support'
   AND e.archived_at IS NULL
   AND NOT (COALESCE(e.tool_allowlist, '{}'::text[]) @> ARRAY['customer-ops']::text[]);
