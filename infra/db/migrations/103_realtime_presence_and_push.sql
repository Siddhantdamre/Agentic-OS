-- Operator presence heartbeats + Web Push subscription storage (realtime SSE).

CREATE TABLE IF NOT EXISTS conversation_presence (
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_name TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'viewing'
    CHECK (action IN ('viewing', 'typing', 'left')),
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_conv_presence_heartbeat
  ON conversation_presence (org_id, conversation_id, last_heartbeat_at DESC);

ALTER TABLE conversation_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_presence FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conv_presence_isolation ON conversation_presence;
CREATE POLICY conv_presence_isolation ON conversation_presence
  FOR ALL
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

CREATE TABLE IF NOT EXISTS web_push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_web_push_subs_org
  ON web_push_subscriptions (org_id);

ALTER TABLE web_push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE web_push_subscriptions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS web_push_subs_isolation ON web_push_subscriptions;
CREATE POLICY web_push_subs_isolation ON web_push_subscriptions
  FOR ALL
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
