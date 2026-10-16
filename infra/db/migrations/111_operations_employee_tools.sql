-------------------------------------------------------------------------------
-- Backfill Operations employee tool allowlist with chat ops tools + showings.
-- Additive only: never deletes org-added tools. Idempotent.
-------------------------------------------------------------------------------

UPDATE ai_employees
   SET tool_allowlist = (
         SELECT ARRAY(
           SELECT DISTINCT t
             FROM unnest(
               COALESCE(tool_allowlist, '{}'::text[])
               || ARRAY['operations', 're']::text[]
             ) AS t
            ORDER BY t
         )
       ),
       updated_at = NOW()
 WHERE role = 'Operations'
   AND (
     NOT (COALESCE(tool_allowlist, '{}'::text[]) @> ARRAY['operations']::text[])
     OR NOT (COALESCE(tool_allowlist, '{}'::text[]) @> ARRAY['re']::text[])
   );
