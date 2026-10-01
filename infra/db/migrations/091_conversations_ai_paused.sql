-- Inbox hardening: human takeover, assignment, unread, SLA, attachments, notes.
-- Migration number 091 chosen to avoid collisions with parallel swarm migrations.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_paused_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ai_paused BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS assigned_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS unread_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sla_deadline_at TIMESTAMPTZ;

COMMENT ON COLUMN conversations.ai_paused_until IS
  'When set and > NOW(), autonomous AI replies should be skipped (human takeover).';
COMMENT ON COLUMN conversations.ai_paused IS
  'Explicit human takeover flag; cleared when AI is resumed.';
COMMENT ON COLUMN conversations.assigned_user_id IS
  'Human staff assignee (not AI employee_id).';
COMMENT ON COLUMN conversations.unread_count IS
  'Unread inbound customer messages since last operator open/reply.';
COMMENT ON COLUMN conversations.sla_deadline_at IS
  'First-response SLA deadline for open/needs_attention conversations.';

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS is_internal BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN messages.attachments IS
  'Structured media metadata [{type,url,name,mime}]. Empty array when none.';
COMMENT ON COLUMN messages.is_internal IS
  'Staff-only note; never dispatched to external channels.';

CREATE INDEX IF NOT EXISTS idx_conversations_inbox_cursor
  ON conversations (org_id, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_assigned_user
  ON conversations (org_id, assigned_user_id)
  WHERE assigned_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_conversation_ordered
  ON messages (org_id, conversation_id, created_at DESC, id DESC);
