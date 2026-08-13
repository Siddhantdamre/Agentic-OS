-------------------------------------------------------------------------------
-- Webhook / inbox hardening — Migration 010
--   * orgs.meta for per-org webhook_secret
--   * per-org unique Chatwoot conversation ids (was global UNIQUE)
--   * inbound message idempotency on chatwoot_msg_id (Meta wamid / Chatwoot id)
--   * SECURITY DEFINER lookups so darex_app can resolve tenant before RLS scope
-- File: infra/db/migrations/010_webhook_inbox.sql
-------------------------------------------------------------------------------

ALTER TABLE orgs ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Global UNIQUE on chatwoot_conv_id collides across tenants. Scope it per org.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_chatwoot_conv_id_key;
DROP INDEX IF EXISTS conversations_chatwoot_conv_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_org_chatwoot_conv
  ON conversations (org_id, chatwoot_conv_id)
  WHERE chatwoot_conv_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_org_chatwoot_msg_id
  ON messages (org_id, chatwoot_msg_id)
  WHERE chatwoot_msg_id IS NOT NULL;

-------------------------------------------------------------------------------
-- Tenant resolution (no org context yet — FORCE RLS would hide channels)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION resolve_whatsapp_channel(p_phone_number_id TEXT)
RETURNS TABLE (id UUID, org_id UUID, meta JSONB)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT c.id, c.org_id, c.meta
  FROM channels c
  WHERE c.channel_type = 'whatsapp'
    AND p_phone_number_id IS NOT NULL
    AND (
      c.meta->>'phone_number_id' = p_phone_number_id
      OR c.meta->>'phoneNumberId' = p_phone_number_id
    )
  ORDER BY c.connected_at DESC NULLS LAST
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION resolve_whatsapp_channel_by_waba(p_waba_id TEXT)
RETURNS TABLE (id UUID, org_id UUID, meta JSONB)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT c.id, c.org_id, c.meta
  FROM channels c
  WHERE c.channel_type = 'whatsapp'
    AND p_waba_id IS NOT NULL
    AND (
      c.meta->>'whatsapp_business_account_id' = p_waba_id
      OR c.meta->>'wabaId' = p_waba_id
    )
  ORDER BY c.connected_at DESC NULLS LAST
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION resolve_single_org_whatsapp_channel()
RETURNS TABLE (id UUID, org_id UUID, meta JSONB)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT c.id, c.org_id, c.meta
  FROM channels c
  WHERE c.channel_type = 'whatsapp'
    AND c.status IN ('active', 'connected')
    AND (SELECT count(*) FROM orgs WHERE status = 'active') = 1
  ORDER BY c.connected_at DESC NULLS LAST
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION resolve_org_by_webhook_secret(p_secret TEXT)
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT o.id
  FROM orgs o
  WHERE o.status = 'active'
    AND p_secret IS NOT NULL
    AND o.meta->>'webhook_secret' = p_secret
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION resolve_active_org(p_org_id UUID)
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT o.id FROM orgs o WHERE o.id = p_org_id AND o.status = 'active';
$$;

CREATE OR REPLACE FUNCTION single_active_org_id()
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT o.id
  FROM orgs o
  WHERE o.status = 'active'
    AND (SELECT count(*) FROM orgs WHERE status = 'active') = 1
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION resolve_conversation_org(p_conversation_id UUID)
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT c.org_id FROM conversations c WHERE c.id = p_conversation_id;
$$;

REVOKE ALL ON FUNCTION resolve_whatsapp_channel(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_whatsapp_channel_by_waba(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_single_org_whatsapp_channel() FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_org_by_webhook_secret(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_active_org(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION single_active_org_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_conversation_org(UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION resolve_whatsapp_channel(TEXT) TO darex, darex_app;
GRANT EXECUTE ON FUNCTION resolve_whatsapp_channel_by_waba(TEXT) TO darex, darex_app;
GRANT EXECUTE ON FUNCTION resolve_single_org_whatsapp_channel() TO darex, darex_app;
GRANT EXECUTE ON FUNCTION resolve_org_by_webhook_secret(TEXT) TO darex, darex_app;
GRANT EXECUTE ON FUNCTION resolve_active_org(UUID) TO darex, darex_app;
GRANT EXECUTE ON FUNCTION single_active_org_id() TO darex, darex_app;
GRANT EXECUTE ON FUNCTION resolve_conversation_org(UUID) TO darex, darex_app;
