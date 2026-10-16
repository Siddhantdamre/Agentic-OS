-- 033: a way for money to enter the ledger.
--
-- WHY
-- outcome_events has carried value_numeric, value_currency and the kinds
-- meeting_booked / payment_received / deal_closed since migration 022. Nothing
-- has ever written one. Measured:
--
--   outcome_kind           rows   with a value
--   conversation_resolved   648              0
--   customer_replied        704              0
--
-- So the money metrics could only ever have reported zero, and no payment
-- provider is connected to change that.
--
-- This is the door money comes through. Today it is called by an operator or
-- by a test; tomorrow it is the same door a Razorpay or Stripe webhook uses,
-- which is why it validates rather than trusts.
--
-- WHY VALIDATION MATTERS MORE HERE THAN ANYWHERE ELSE
-- This is the number a business will quote back at renewal. A figure it
-- cannot trace to real rows is worse than no figure at all — it discredits
-- every other number on the page. So every value outcome carries
-- (source_table, source_id) back to its origin, the same as every other row
-- in the ledger, and an amount without a currency is refused rather than
-- guessed at.

/**
 * Record a meeting, a payment or a closed deal.
 *
 * Idempotent on (org, source_table, source_id, kind) via the unique
 * constraint already on outcome_events: a webhook that retries, or an operator
 * who double-clicks, must not double-count revenue. Returns the row id, or
 * NULL when it was already recorded.
 */
CREATE OR REPLACE FUNCTION record_value_outcome(
  p_org_id          UUID,
  p_conversation_id UUID,
  p_kind            TEXT,
  p_amount          NUMERIC,
  p_currency        TEXT,
  p_source_table    TEXT,
  p_source_id       TEXT,
  p_occurred_at     TIMESTAMPTZ DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id       UUID;
  v_currency TEXT;
BEGIN
  IF p_kind NOT IN ('meeting_booked', 'payment_received', 'deal_closed') THEN
    RAISE EXCEPTION 'not a value outcome: %', p_kind;
  END IF;
  IF p_source_id IS NULL OR btrim(p_source_id) = '' THEN
    -- Without a source this is an unfalsifiable number. Every other row in
    -- this ledger traces back to something; money does not get an exemption.
    RAISE EXCEPTION 'a value outcome needs a source_id to trace back to';
  END IF;

  v_currency := NULLIF(btrim(UPPER(COALESCE(p_currency, ''))), '');

  -- An amount with no currency is refused, not defaulted. "420000" of what?
  -- Guessing the currency of somebody's revenue is not a defensible default,
  -- and INR-by-default would silently misreport every overseas customer.
  IF p_amount IS NOT NULL AND v_currency IS NULL THEN
    RAISE EXCEPTION 'an amount needs a currency';
  END IF;

  -- A meeting with no money attached is normal and welcome. A payment without
  -- one is a data-entry mistake worth catching at the door.
  IF p_kind = 'payment_received' AND p_amount IS NULL THEN
    RAISE EXCEPTION 'a payment needs an amount';
  END IF;

  INSERT INTO outcome_events
    (org_id, conversation_id, outcome_kind, value_numeric, value_currency,
     occurred_at, source_table, source_id, metadata)
  VALUES
    (p_org_id, p_conversation_id, p_kind, p_amount, v_currency,
     COALESCE(p_occurred_at, NOW()), p_source_table, btrim(p_source_id),
     jsonb_build_object('recorded_via', 'record_value_outcome'))
  ON CONFLICT (org_id, source_table, source_id, outcome_kind) DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION record_value_outcome(UUID, UUID, TEXT, NUMERIC, TEXT, TEXT, TEXT, TIMESTAMPTZ) IS
  'The door money enters the ledger through. Idempotent per source row, so a '
  'retrying webhook cannot double-count revenue. Refuses an amount with no '
  'currency and a payment with no amount.';

REVOKE ALL ON FUNCTION record_value_outcome(UUID, UUID, TEXT, NUMERIC, TEXT, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_value_outcome(UUID, UUID, TEXT, NUMERIC, TEXT, TEXT, TEXT, TIMESTAMPTZ) TO darex, darex_app;

-- The money query is "value outcomes for this org in this window", and it runs
-- on every dashboard load. Without this it scans an outcome_events table whose
-- overwhelming majority of rows are replies and resolutions.
CREATE INDEX IF NOT EXISTS idx_outcome_events_value
  ON outcome_events (org_id, occurred_at DESC)
  WHERE outcome_kind IN ('meeting_booked', 'payment_received', 'deal_closed');
