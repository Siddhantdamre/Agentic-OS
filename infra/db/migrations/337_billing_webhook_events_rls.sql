-- 037: close the last tenant table with no wall around it.
--
-- WHY
-- billing_webhook_events carries an org_id and had neither RLS nor a policy.
-- Migration 028 closed exactly this hole on `orgs`, where `SELECT COUNT(*)`
-- as darex_app returned all 58 workspaces. This is the same class of defect on
-- a table that will eventually hold payment-provider event history.
--
-- Found by auditing pg_class rather than by a test: every existing test asks
-- "can tenant A read tenant B's rows" for the tables somebody remembered to
-- write a test for. A table nobody wrote a test for passes every test.
--
-- The table is empty today, so nothing is currently exposed. That is the
-- reason to fix it now rather than the reason to defer it — once Stripe or
-- Razorpay events start landing, this becomes a live cross-tenant read of
-- billing history, and the fix stops being free.
--
-- WHY THIS DOES NOT BREAK WEBHOOK INGESTION
-- Both write paths (billing_start_webhook_event, billing_finish_webhook_event
-- in migration 017) are SECURITY DEFINER functions owned by `darex`, which is
-- a superuser and therefore bypasses row security even under FORCE. They
-- continue to insert and update rows for events whose tenant is not yet known.
-- What changes is that darex_app — the role the application uses to serve all
-- 59 workspaces — can no longer read another workspace's rows.
--
-- A row whose org_id is still NULL (received, not yet attributed to a
-- workspace) matches no tenant policy and is therefore invisible to every
-- tenant. That is the correct outcome: an unattributed event belongs to
-- nobody, and guessing an owner for it would be worse than hiding it.

ALTER TABLE billing_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_webhook_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS billing_webhook_events_org_isolation ON billing_webhook_events;
CREATE POLICY billing_webhook_events_org_isolation ON billing_webhook_events
  USING (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid);

-- NULLIF guards the empty-string case. Migration 029 exists because 43
-- policies were written as `current_setting(...)::uuid` and every one of them
-- threw `invalid input syntax for type uuid: ""` the moment a connection was
-- RESET and reused from the pool. Do not remove it.

COMMENT ON TABLE billing_webhook_events IS
  'Payment-provider webhook receipts. RLS added in 037: darex_app sees only '
  'the current workspace; rows not yet attributed to a workspace (org_id '
  'NULL) are visible to no tenant. The SECURITY DEFINER ingestion functions '
  'in 017 are unaffected.';
