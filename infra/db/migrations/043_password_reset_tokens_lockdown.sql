-- 043: close the last table the application role could read directly.
--
-- WHAT WAS WRONG
-- A full-system review found three tables without row-level security. Two are
-- correct and stay that way: `_migrations` is schema bookkeeping and
-- `provider_spend_snapshots` is provider-wide rather than per-tenant. Neither
-- has an org_id, so there is nothing to scope by.
--
-- The third was `password_reset_tokens`, which held:
--
--   GRANT SELECT, INSERT, UPDATE, DELETE ON password_reset_tokens TO darex_app;
--
-- granted in 009 before the reset flow was moved behind SECURITY DEFINER
-- functions. The grant was simply never taken back.
--
-- HOW BAD IT ACTUALLY WAS — measured, not assumed
-- Low. The table stores `token_hash`, never the token, so reading it does not
-- let anyone reset a password: you would need the preimage. It is empty on
-- this deployment, SuperTokens now owns authentication, and no application
-- code references the table at all:
--
--   grep -rn password_reset_tokens apps/ services/   -> no matches
--
-- What the grant did leave open was nuisance and denial: darex_app could
-- DELETE pending resets, or UPDATE used_at to burn a token before its owner
-- clicked the link. Neither is a disclosure; both are worth closing before
-- real users exist rather than after.
--
-- THE FIX, IN TWO LAYERS
-- Revoking the grant is enough today. Enabling RLS as well means that if
-- someone re-adds a grant later — the likely future mistake, since the
-- original one was itself an unrevoked leftover — the table is still closed.
-- Belt and braces, because the cost of both is zero.

-- ── Layer 1: take the grant back ───────────────────────────────────────────
REVOKE ALL ON password_reset_tokens FROM darex_app;

-- ── Layer 2: deny by default, with no policy to permit anything ────────────
-- A table with RLS enabled and NO permissive policy denies every row to every
-- non-superuser. That is exactly the intent here: there is no legitimate
-- direct access, only the two doors below.
--
-- FORCE so the table owner is bound too — without it, RLS is skipped for the
-- owner and a maintenance script silently sees everything, which is how a
-- policy passes review and protects nothing.
--
-- The doors keep working because auth_create_password_reset and
-- auth_consume_password_reset are SECURITY DEFINER and execute as `darex`, a
-- superuser, and superusers bypass RLS regardless of FORCE. Same load-bearing
-- assumption written down in 028: if this deployment ever moves these tables
-- to a non-superuser owner, those functions need `SET row_security = off` or
-- password reset goes dark.
ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_tokens FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE password_reset_tokens IS
  'Deny-by-default: RLS enabled with no permissive policy and no grants to '
  'darex_app. Reached only through auth_create_password_reset and '
  'auth_consume_password_reset, which are SECURITY DEFINER. Stores a hash, '
  'never a token.';

-- ── The doors stay open ────────────────────────────────────────────────────
-- Restated rather than assumed: a migration that closed the wall without
-- confirming the doors would take password reset down silently, and nothing
-- in the suite exercises that flow end to end yet.
GRANT EXECUTE ON FUNCTION auth_create_password_reset(TEXT, TEXT, TIMESTAMPTZ) TO darex_app;
GRANT EXECUTE ON FUNCTION auth_consume_password_reset(TEXT) TO darex_app;
