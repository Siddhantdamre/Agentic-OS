-- 140_billing_meter_refresh.sql
-- BIZ-B01 / BIZ-B19: the worker now refreshes billing_meters on a schedule
-- from org_model_spend, and the usage gate reads the latest row per kind.
--
-- 1. Allow source = 'model_spend' for rows written by BillingSweepWorkflow.
-- 2. Index the gate's DISTINCT ON (meter_kind) ... ORDER BY period_end DESC
--    lookup so it stops scanning every meter row the org ever had.

ALTER TABLE billing_meters DROP CONSTRAINT IF EXISTS billing_meters_source_chk;
ALTER TABLE billing_meters
  ADD CONSTRAINT billing_meters_source_chk
  CHECK (source IN ('langfuse', 'conversations', 'users', 'env', 'model_spend'));

CREATE INDEX IF NOT EXISTS idx_billing_meters_org_kind_period_end
  ON billing_meters (org_id, meter_kind, period_end DESC, period_start DESC);
