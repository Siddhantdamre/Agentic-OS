-------------------------------------------------------------------------------
-- Backfill Growth + Sales (Sarah) employee tool allowlists.
-- Additive only: never remove org-added tools.
-------------------------------------------------------------------------------

-- Sarah / Sales & Lead Gen: deals already via hubspot; add CRM enrichment + calendar + RE match
UPDATE ai_employees
   SET tool_allowlist = (
         SELECT ARRAY(
           SELECT DISTINCT unnest(
             COALESCE(tool_allowlist, '{}'::text[])
             || ARRAY[
               'salesforce',
               'zoho-crm',
               'apollo',
               'linkedin',
               'google-calendar',
               're'
             ]::text[]
           )
         )
       ),
       updated_at = NOW()
 WHERE archived_at IS NULL
   AND (
     lower(name) = 'sarah'
     OR lower(role) LIKE '%sales%lead%'
     OR lower(role) LIKE '%lead gen%'
   );

-- Growth: read-only chat tools for dormant / attribution / ROI
UPDATE ai_employees
   SET tool_allowlist = (
         SELECT ARRAY(
           SELECT DISTINCT unnest(
             COALESCE(tool_allowlist, '{}'::text[])
             || ARRAY['growth']::text[]
           )
         )
       ),
       updated_at = NOW()
 WHERE archived_at IS NULL
   AND (
     lower(name) = 'growth'
     OR lower(role) = 'growth'
   );
