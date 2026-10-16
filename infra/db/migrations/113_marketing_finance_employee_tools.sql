-- 113_marketing_finance_employee_tools.sql
-- Backfill Marcus (Marketing & Analytics) and Finance allowlists with analytics /
-- QuickBooks / billing tools. Additive only — never strips org-added tools.

BEGIN;

-- Marcus: keep meta-ads, google-ads, gmail; add GA / Search Console / Business Profile.
UPDATE ai_employees
   SET tool_allowlist = (
         SELECT ARRAY(
           SELECT DISTINCT t
           FROM unnest(
             COALESCE(tool_allowlist, '{}'::text[])
             || ARRAY[
               'meta-ads',
               'google-ads',
               'gmail',
               'google-analytics',
               'google-search-console',
               'google-business-profile'
             ]
           ) AS t
         )
       ),
       updated_at = NOW()
 WHERE status IN ('active', 'paused')
   AND (
     lower(name) = 'marcus'
     OR role ILIKE '%Marketing%'
     OR role ILIKE '%Analytics%'
   );

-- Finance: keep stripe, razorpay; add QuickBooks + billing_usage. Persona keeps confirmClasses pay.
UPDATE ai_employees
   SET tool_allowlist = (
         SELECT ARRAY(
           SELECT DISTINCT t
           FROM unnest(
             COALESCE(tool_allowlist, '{}'::text[])
             || ARRAY['stripe', 'razorpay', 'quickbooks', 'billing_usage']
           ) AS t
         )
       ),
       persona = CASE
         WHEN persona IS NULL OR persona::text = 'null' THEN
           jsonb_build_object(
             'text', 'Invoices and payment links. Always confirm before pay. Never create a charge or payout without owner confirmation. Hand refunds to Customer.',
             'rosterKey', 'finance',
             'confirmClasses', jsonb_build_array('pay')
           )
         WHEN jsonb_typeof(persona) = 'object' THEN
           persona
             || jsonb_build_object('rosterKey', COALESCE(persona->>'rosterKey', 'finance'))
             || jsonb_build_object(
                  'confirmClasses',
                  COALESCE(persona->'confirmClasses', '["pay"]'::jsonb)
                )
         ELSE persona
       END,
       updated_at = NOW()
 WHERE status IN ('active', 'paused')
   AND (
     lower(name) = 'finance'
     OR role ILIKE 'Finance%'
   );

COMMIT;
