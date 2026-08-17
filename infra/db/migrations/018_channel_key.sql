-------------------------------------------------------------------------------
-- Unified channel_key + Chatwoot inbox→org map — Migration 018 (WS-18 / H2, Q5)
-- Stop special-casing WhatsApp vs Chatwoot on messages. Inbox filters by
-- channel_key without a new page per channel.
-- Q5: Chatwoot org comes from inbox mapping, not a leaked ?org_id= query param.
-- H1 Meta token rotation is ops — see infra/scripts/OPERATOR_HYGIENE.md §4.
-- Never commit tokens.
-- File: infra/db/migrations/018_channel_key.sql
-------------------------------------------------------------------------------

ALTER TABLE messages ADD COLUMN IF NOT EXISTS channel_key TEXT;

UPDATE messages m
   SET channel_key = COALESCE(
     (
       SELECT ch.channel_type
         FROM conversations c
         LEFT JOIN channels ch ON ch.id = c.channel_id
        WHERE c.id = m.conversation_id
        LIMIT 1
     ),
     (
       SELECT NULLIF(btrim(c.metadata->>'channel'), '')
         FROM conversations c
        WHERE c.id = m.conversation_id
        LIMIT 1
     ),
     'unknown'
   )
 WHERE m.channel_key IS NULL;

CREATE INDEX IF NOT EXISTS idx_messages_org_channel_key
  ON messages (org_id, channel_key);

COMMENT ON COLUMN messages.channel_key IS
  'Unified inbound surface (whatsapp, chatwoot, gmail, instagram, sms, owner_whatsapp, widget, inbox). Inbox filters by this column; do not add a page per channel.';

-------------------------------------------------------------------------------
-- Chatwoot inbox → org map (Q5). Looked up before RLS via SECURITY DEFINER.
-- Unique on (account, inbox) so two orgs cannot claim the same inbox.
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS chatwoot_inbox_map (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id                UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  chatwoot_account_id   TEXT NOT NULL DEFAULT '',
  chatwoot_inbox_id     INTEGER NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chatwoot_inbox_map_account_inbox UNIQUE (chatwoot_account_id, chatwoot_inbox_id)
);

CREATE INDEX IF NOT EXISTS idx_chatwoot_inbox_map_org_id ON chatwoot_inbox_map (org_id);
CREATE INDEX IF NOT EXISTS idx_chatwoot_inbox_map_inbox ON chatwoot_inbox_map (chatwoot_inbox_id);

ALTER TABLE chatwoot_inbox_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE chatwoot_inbox_map FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chatwoot_inbox_map_org_isolation ON chatwoot_inbox_map;
CREATE POLICY chatwoot_inbox_map_org_isolation ON chatwoot_inbox_map
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

DROP TRIGGER IF EXISTS trg_chatwoot_inbox_map_updated_at ON chatwoot_inbox_map;
CREATE TRIGGER trg_chatwoot_inbox_map_updated_at
  BEFORE UPDATE ON chatwoot_inbox_map
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

GRANT SELECT, INSERT, UPDATE, DELETE ON chatwoot_inbox_map TO darex_app;

COMMENT ON TABLE chatwoot_inbox_map IS
  'Q5: server-side Chatwoot inbox → org. Prefer this over ?org_id= on the webhook URL.';

-------------------------------------------------------------------------------
-- Public widget embed tokens (H6). Stolen token cannot call admin APIs;
-- allowlist is enforced in /api/widget (session + listings.search only).
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS widget_embed_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT widget_embed_tokens_status_chk CHECK (status IN ('active', 'revoked'))
);

CREATE INDEX IF NOT EXISTS idx_widget_embed_tokens_org_id ON widget_embed_tokens (org_id);

ALTER TABLE widget_embed_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE widget_embed_tokens FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS widget_embed_tokens_org_isolation ON widget_embed_tokens;
CREATE POLICY widget_embed_tokens_org_isolation ON widget_embed_tokens
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

GRANT SELECT, INSERT, UPDATE, DELETE ON widget_embed_tokens TO darex_app;

-------------------------------------------------------------------------------
-- Tenant resolution (no org context yet — FORCE RLS would hide rows)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION resolve_org_by_chatwoot_inbox(
  p_account_id TEXT,
  p_inbox_id INTEGER
)
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT s.org_id
    FROM (
      (
        SELECT m.org_id, 0 AS rank
          FROM chatwoot_inbox_map m
         WHERE p_inbox_id IS NOT NULL
           AND m.chatwoot_inbox_id = p_inbox_id
           AND (
             p_account_id IS NULL
             OR p_account_id = ''
             OR m.chatwoot_account_id = p_account_id
             OR m.chatwoot_account_id = ''
           )
         ORDER BY CASE WHEN m.chatwoot_account_id = p_account_id THEN 0 ELSE 1 END
         LIMIT 1
      )
      UNION ALL
      (
        SELECT c.org_id, 1 AS rank
          FROM channels c
         WHERE p_inbox_id IS NOT NULL
           AND c.chatwoot_inbox_id = p_inbox_id
           AND NOT EXISTS (
             SELECT 1 FROM chatwoot_inbox_map m
              WHERE m.chatwoot_inbox_id = p_inbox_id
           )
         LIMIT 1
      )
    ) s
   ORDER BY s.rank
   LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION resolve_channel_by_meta(
  p_channel_type TEXT,
  p_meta_key TEXT,
  p_meta_value TEXT
)
RETURNS TABLE (id UUID, org_id UUID, meta JSONB)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT c.id, c.org_id, c.meta
    FROM channels c
   WHERE c.channel_type = p_channel_type
     AND p_meta_value IS NOT NULL
     AND p_meta_value <> ''
     AND (
       c.meta ->> p_meta_key = p_meta_value
     )
   ORDER BY c.connected_at DESC NULLS LAST
   LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION resolve_widget_org_by_token_hash(p_token_hash TEXT)
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT t.org_id
    FROM widget_embed_tokens t
   WHERE t.token_hash = p_token_hash
     AND t.status = 'active'
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION resolve_org_by_chatwoot_inbox(TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_channel_by_meta(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_widget_org_by_token_hash(TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION resolve_org_by_chatwoot_inbox(TEXT, INTEGER) TO darex, darex_app;
GRANT EXECUTE ON FUNCTION resolve_channel_by_meta(TEXT, TEXT, TEXT) TO darex, darex_app;
GRANT EXECUTE ON FUNCTION resolve_widget_org_by_token_hash(TEXT) TO darex, darex_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO darex_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO darex_app;
