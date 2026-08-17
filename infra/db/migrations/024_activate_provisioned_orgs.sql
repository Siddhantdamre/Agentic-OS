-------------------------------------------------------------------------------
-- Activate stranded organizations — Migration 024
--
-- THE BUG
-- createOrgForEmail (apps/dashboard/lib/db.ts) inserted every auto-provisioned
-- org with status 'provisioning'. Nothing ever advanced it: only
-- /api/org/create sets 'active', and a user registering normally never passes
-- through that route.
--
-- Webhook org resolution requires status = 'active'
-- (app/api/webhooks/chatwoot/route.ts), so EVERY tenant created by ordinary
-- registration silently could not receive inbound messages. Sign up, connect
-- Chatwoot, and every delivery is rejected HTTP 400 "Cannot resolve
-- organization" — with nothing in the UI explaining why.
--
-- Each half was individually correct, which is why component tests never caught
-- it: registration created a working org, and the webhook correctly refused an
-- org that was not active. Only running the whole chain exposed the gap.
--
-- The source fix is in lib/db.ts, which now inserts 'active' directly. This
-- migration repairs rows created before that fix.
--
-- SAFETY: deliberately narrow — only 'provisioning' is touched. Orgs that were
-- suspended or cancelled on purpose keep their status; silently reactivating a
-- suspended tenant would be a worse bug than the one being fixed.
--
-- File: infra/db/migrations/024_activate_provisioned_orgs.sql
-------------------------------------------------------------------------------

UPDATE orgs
   SET status = 'active',
       updated_at = NOW()
 WHERE status = 'provisioning';

COMMENT ON COLUMN orgs.status IS
  'active | suspended | cancelled. Orgs are active on creation (see createOrgForEmail). Never default new orgs to provisioning: webhook org resolution requires active, so a stuck provisioning org cannot receive inbound messages.';
