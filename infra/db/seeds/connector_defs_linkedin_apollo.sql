-- LinkedIn + Apollo catalog rows. Additive. A def is not a connection.
-- Apply after connector_defs.sql (pnpm db:seed).

INSERT INTO connector_defs (
  key, nango_key, name, category, icon, description, auth_mode,
  risk_class, confirm_policy, vertical_tags, mcp_tools,
  extra_connect_fields, extra_test_fields, executor_status, testable,
  scopes, env_vars, webhook_events, operator_hint, sort_order, updated_at
) VALUES
  (
    'linkedin',
    'linkedin',
    'LinkedIn Signals',
    'Prospecting',
    'Linkedin',
    'People search and company hiring/funding/leadership signals',
    'oauth',
    'read',
    'none',
    ARRAY['growth', 'prospecting']::text[],
    ARRAY['linkedin_search_people', 'linkedin_company_signals']::text[],
    $j$[]$j$::jsonb,
    $j$[]$j$::jsonb,
    'live',
    TRUE,
    ARRAY['r_liteprofile', 'r_organization_social']::text[],
    $j$[{"name":"LINKEDIN_CLIENT_ID","desc":"LinkedIn app client ID (paste into Nango UI)"},{"name":"LINKEDIN_CLIENT_SECRET","desc":"LinkedIn app secret (paste into Nango UI)"}]$j$::jsonb,
    ARRAY[]::text[],
    'Needs a real LinkedIn OAuth client ID in the Nango UI. Disconnected orgs get notConnected, never fabricated signals.',
    40,
    NOW()
  ),
  (
    'apollo',
    'apollo',
    'Apollo.io Discovery',
    'Prospecting',
    'Search',
    'People search and company enrichment for the Growth employee',
    'oauth',
    'read',
    'none',
    ARRAY['growth', 'prospecting']::text[],
    ARRAY['apollo_search_people', 'apollo_enrich_company']::text[],
    $j$[]$j$::jsonb,
    $j$[]$j$::jsonb,
    'live',
    TRUE,
    ARRAY[]::text[],
    $j$[{"name":"APOLLO_API_KEY","desc":"Optional BYOK fallback; prefer Nango"}]$j$::jsonb,
    ARRAY[]::text[],
    'Connect Apollo via Nango or BYOK. Missing connection returns connected:false + /connectors.',
    41,
    NOW()
  )
ON CONFLICT (key) DO UPDATE SET
  mcp_tools = EXCLUDED.mcp_tools,
  executor_status = EXCLUDED.executor_status,
  operator_hint = EXCLUDED.operator_hint,
  updated_at = NOW();
