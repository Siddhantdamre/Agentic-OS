-- Inquiry pipeline: SLA, soft-delete, assignment, active-contact dedup index.

ALTER TABLE re_inquiries
  ADD COLUMN IF NOT EXISTS sla_deadline_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS responded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_breached BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS assigned_agent_id UUID REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN re_inquiries.sla_deadline_at IS
  '15-minute first-response SLA for new inquiries.';
COMMENT ON COLUMN re_inquiries.deleted_at IS
  'Soft-delete timestamp; Kanban queries exclude deleted rows.';

CREATE INDEX IF NOT EXISTS idx_re_inquiries_org_status_updated
  ON re_inquiries (org_id, status, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_re_inquiries_sla_monitoring
  ON re_inquiries (org_id, sla_deadline_at)
  WHERE status = 'new' AND deleted_at IS NULL AND sla_breached = false;

-- One active "new" inquiry per contact (race-safe ingest).
CREATE UNIQUE INDEX IF NOT EXISTS idx_re_inquiries_active_contact_dedup
  ON re_inquiries (org_id, contact_id)
  WHERE status = 'new' AND deleted_at IS NULL AND contact_id IS NOT NULL;
