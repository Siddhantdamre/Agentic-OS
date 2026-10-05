-------------------------------------------------------------------------------
-- 210_executive_workspace_tools.sql
-- Grant Google Workspace (Gmail, Calendar, Drive, Docs, Sheets, Slides) and
-- Slack to Executive employee so the primary coordinator can read and triage
-- emails, events, and workspace files directly in chat.
-- Additive only: never deletes org-added tools. Idempotent.
-------------------------------------------------------------------------------

UPDATE ai_employees
   SET tool_allowlist = (
         SELECT ARRAY(
           SELECT DISTINCT t
             FROM unnest(
               COALESCE(tool_allowlist, '{}'::text[])
               || ARRAY[
                    'gmail',
                    'google-calendar',
                    'google-drive',
                    'google-docs',
                    'google-sheets',
                    'google-slides',
                    'slack'
                  ]::text[]
             ) AS t
            ORDER BY t
         )
       ),
       updated_at = NOW()
 WHERE (role = 'Executive' OR name = 'Executive')
   AND NOT (
     COALESCE(tool_allowlist, '{}'::text[]) @> ARRAY[
       'gmail',
       'google-calendar',
       'google-drive',
       'google-docs',
       'google-sheets',
       'google-slides',
       'slack'
     ]::text[]
   );
