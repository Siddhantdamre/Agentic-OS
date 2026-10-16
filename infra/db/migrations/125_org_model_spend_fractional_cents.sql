-------------------------------------------------------------------------------
-- org_model_spend.spend_cents: INTEGER → NUMERIC(14,4).
-- A single agent turn usually costs a fraction of a cent; integer cents
-- rounded every turn to 0, so the daily ceiling could never trip once
-- turns started being metered (RT-G01 / RT-B13). Widening is lossless.
-- File: infra/db/migrations/125_org_model_spend_fractional_cents.sql
-------------------------------------------------------------------------------

ALTER TABLE org_model_spend
  ALTER COLUMN spend_cents TYPE NUMERIC(14,4) USING spend_cents::NUMERIC(14,4);

ALTER TABLE org_model_spend
  ALTER COLUMN spend_cents SET DEFAULT 0;

COMMENT ON COLUMN org_model_spend.spend_cents IS
  'Model spend for the day in fractional US cents (turn-level, see cost/track.ts recordTurnSpend).';
