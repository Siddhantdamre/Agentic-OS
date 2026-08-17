-------------------------------------------------------------------------------
-- Darex SaaS billing — Migration 017 (WS-24 / B2–B3)
-- Subscriptions, invoices, usage meters for the Darex product itself.
-- Isolated from org Stripe/Razorpay *payment-link tools* (those stay in
-- tool-executor). Darex never escrows or holds client funds.
--
-- orgs.plan already exists (001); this wires allowed keys + billing tables.
-- Types: packages/shared-types/src/billing.ts
-- RLS FORCE on tenant tables. Webhook lookups are SECURITY DEFINER so
-- darex_app can resolve org from provider ids *before* session scope.
-- File: infra/db/migrations/017_billing.sql
-------------------------------------------------------------------------------

-- Product plan keys (not PSP/escrow). Keep 'free' as the unpaid default.
UPDATE orgs
   SET plan = 'free'
 WHERE plan IS NULL
    OR btrim(plan) = ''
    OR lower(plan) NOT IN ('free', 'starter', 'growth', 'enterprise');

ALTER TABLE orgs DROP CONSTRAINT IF EXISTS orgs_plan_check;
ALTER TABLE orgs
  ADD CONSTRAINT orgs_plan_check
  CHECK (plan IN ('free', 'starter', 'growth', 'enterprise'));

ALTER TABLE orgs ALTER COLUMN plan SET DEFAULT 'free';

COMMENT ON COLUMN orgs.plan IS
  'Darex SaaS pack (free/starter/growth/enterprise). Price IDs and amounts come from env. Never means Darex holds client funds.';

----------------------------------------------------------------------------
-- 1. BILLING_SUBSCRIPTIONS — one Darex subscription row per org + provider
----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing_subscriptions (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id                   UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  provider                 TEXT NOT NULL,
  provider_customer_id     TEXT,
  provider_subscription_id TEXT,
  plan_key                 TEXT NOT NULL DEFAULT 'free',
  status                   TEXT NOT NULL DEFAULT 'incomplete',
  seats                    INTEGER NOT NULL DEFAULT 1,
  current_period_start     TIMESTAMPTZ,
  current_period_end       TIMESTAMPTZ,
  cancel_at_period_end     BOOLEAN NOT NULL DEFAULT false,
  metadata                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT billing_subscriptions_provider_chk CHECK (provider IN ('stripe', 'razorpay')),
  CONSTRAINT billing_subscriptions_plan_chk CHECK (
    plan_key IN ('free', 'starter', 'growth', 'enterprise')
  ),
  CONSTRAINT billing_subscriptions_status_chk CHECK (
    status IN ('incomplete', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')
  ),
  CONSTRAINT billing_subscriptions_seats_chk CHECK (seats >= 1),
  CONSTRAINT billing_subscriptions_org_provider_uq UNIQUE (org_id, provider)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_subs_provider_sub
  ON billing_subscriptions (provider, provider_subscription_id)
  WHERE provider_subscription_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_subs_provider_customer
  ON billing_subscriptions (provider, provider_customer_id)
  WHERE provider_customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_org_id
  ON billing_subscriptions (org_id);

ALTER TABLE billing_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_subscriptions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS billing_subscriptions_org_isolation ON billing_subscriptions;
CREATE POLICY billing_subscriptions_org_isolation ON billing_subscriptions
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

DROP TRIGGER IF EXISTS trg_billing_subscriptions_updated_at ON billing_subscriptions;
CREATE TRIGGER trg_billing_subscriptions_updated_at
  BEFORE UPDATE ON billing_subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE billing_subscriptions IS
  'Darex SaaS subscriptions (Stripe/Razorpay). Not org payment-link tools. No escrow / client funds.';

----------------------------------------------------------------------------
-- 2. BILLING_INVOICES — tenant-isolated; failed payment must not leak
----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing_invoices (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id              UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  subscription_id     UUID REFERENCES billing_subscriptions(id) ON DELETE SET NULL,
  provider            TEXT NOT NULL,
  provider_invoice_id TEXT,
  status              TEXT NOT NULL DEFAULT 'open',
  amount_cents        INTEGER NOT NULL DEFAULT 0,
  currency            TEXT NOT NULL DEFAULT 'usd',
  hosted_invoice_url  TEXT,
  period_start        TIMESTAMPTZ,
  period_end          TIMESTAMPTZ,
  paid_at             TIMESTAMPTZ,
  failed_at           TIMESTAMPTZ,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT billing_invoices_provider_chk CHECK (provider IN ('stripe', 'razorpay')),
  CONSTRAINT billing_invoices_status_chk CHECK (
    status IN ('draft', 'open', 'paid', 'void', 'uncollectible')
  ),
  CONSTRAINT billing_invoices_provider_invoice_uq UNIQUE (provider, provider_invoice_id)
);

CREATE INDEX IF NOT EXISTS idx_billing_invoices_org_id ON billing_invoices (org_id);
CREATE INDEX IF NOT EXISTS idx_billing_invoices_org_status ON billing_invoices (org_id, status);

ALTER TABLE billing_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_invoices FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS billing_invoices_org_isolation ON billing_invoices;
CREATE POLICY billing_invoices_org_isolation ON billing_invoices
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

DROP TRIGGER IF EXISTS trg_billing_invoices_updated_at ON billing_invoices;
CREATE TRIGGER trg_billing_invoices_updated_at
  BEFORE UPDATE ON billing_invoices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE billing_invoices IS
  'Darex SaaS invoices, FORCE RLS by org_id. Failed payments stay in this tenant; never joined across orgs.';

----------------------------------------------------------------------------
-- 3. BILLING_METERS — LLM (Langfuse) + WhatsApp + seats; notConnected ≠ success
----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing_meters (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  meter_kind    TEXT NOT NULL,
  quantity      NUMERIC NOT NULL DEFAULT 0,
  unit          TEXT NOT NULL DEFAULT 'count',
  soft_limit    NUMERIC,
  hard_limit    NUMERIC,
  source        TEXT NOT NULL,
  truncated     BOOLEAN NOT NULL DEFAULT false,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT billing_meters_kind_chk CHECK (
    meter_kind IN (
      'llm_tokens',
      'whatsapp_conversations',
      'seats',
      'embeddings',
      'successful_actions',
      'disconnected_actions'
    )
  ),
  CONSTRAINT billing_meters_source_chk CHECK (
    source IN ('langfuse', 'conversations', 'users', 'env')
  ),
  CONSTRAINT billing_meters_org_period_kind_uq UNIQUE (org_id, period_start, meter_kind)
);

CREATE INDEX IF NOT EXISTS idx_billing_meters_org_id ON billing_meters (org_id);

ALTER TABLE billing_meters ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_meters FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS billing_meters_org_isolation ON billing_meters;
CREATE POLICY billing_meters_org_isolation ON billing_meters
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

COMMENT ON TABLE billing_meters IS
  'Usage meters. LLM from Langfuse; WhatsApp from conversations. disconnected/notConnected is not successful_actions.';

----------------------------------------------------------------------------
-- 4. BILLING_WEBHOOK_EVENTS — idempotency inbox (not a tenant API surface)
--    No FORCE RLS: org is unknown until the provider id is resolved.
--    Never store raw payloads (card / token material).
----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing_webhook_events (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider           TEXT NOT NULL,
  provider_event_id  TEXT NOT NULL,
  event_type         TEXT NOT NULL,
  org_id             UUID REFERENCES orgs(id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'received',
  error              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at       TIMESTAMPTZ,
  CONSTRAINT billing_webhook_events_provider_chk CHECK (provider IN ('stripe', 'razorpay')),
  CONSTRAINT billing_webhook_events_status_chk CHECK (
    status IN ('received', 'processed', 'ignored', 'error')
  ),
  CONSTRAINT billing_webhook_events_provider_event_uq UNIQUE (provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_billing_webhook_events_org_id
  ON billing_webhook_events (org_id);

COMMENT ON TABLE billing_webhook_events IS
  'Idempotency for Darex billing webhooks. Unsigned requests never insert. No raw payload / secrets.';

----------------------------------------------------------------------------
-- 5. SECURITY DEFINER lookups — webhook resolves tenant without body org_id
----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION billing_lookup_by_provider_customer(
  p_provider TEXT,
  p_customer_id TEXT
)
RETURNS TABLE (org_id UUID, subscription_id UUID, plan_key TEXT, status TEXT, seats INTEGER)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT s.org_id, s.id, s.plan_key, s.status, s.seats
  FROM billing_subscriptions s
  WHERE s.provider = p_provider
    AND p_customer_id IS NOT NULL
    AND s.provider_customer_id = p_customer_id
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION billing_lookup_by_provider_subscription(
  p_provider TEXT,
  p_subscription_id TEXT
)
RETURNS TABLE (org_id UUID, subscription_id UUID, plan_key TEXT, status TEXT, seats INTEGER)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT s.org_id, s.id, s.plan_key, s.status, s.seats
  FROM billing_subscriptions s
  WHERE s.provider = p_provider
    AND p_subscription_id IS NOT NULL
    AND s.provider_subscription_id = p_subscription_id
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION billing_lookup_by_provider_invoice(
  p_provider TEXT,
  p_invoice_id TEXT
)
RETURNS TABLE (org_id UUID, invoice_id UUID, subscription_id UUID)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT i.org_id, i.id, i.subscription_id
  FROM billing_invoices i
  WHERE i.provider = p_provider
    AND p_invoice_id IS NOT NULL
    AND i.provider_invoice_id = p_invoice_id
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION billing_org_exists(p_org_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (SELECT 1 FROM orgs o WHERE o.id = p_org_id);
$$;

CREATE OR REPLACE FUNCTION billing_claim_webhook_event(
  p_provider TEXT,
  p_event_id TEXT,
  p_event_type TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO billing_webhook_events (provider, provider_event_id, event_type, status)
  VALUES (p_provider, p_event_id, p_event_type, 'received');
  RETURN true;
EXCEPTION
  WHEN unique_violation THEN
    RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION billing_finish_webhook_event(
  p_provider TEXT,
  p_event_id TEXT,
  p_org_id UUID,
  p_status TEXT,
  p_error TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE billing_webhook_events
     SET org_id = COALESCE(p_org_id, org_id),
         status = p_status,
         error = p_error,
         processed_at = NOW()
   WHERE provider = p_provider
     AND provider_event_id = p_event_id;
END;
$$;

CREATE OR REPLACE FUNCTION billing_set_org_plan(p_org_id UUID, p_plan TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_plan NOT IN ('free', 'starter', 'growth', 'enterprise') THEN
    RAISE EXCEPTION 'INVALID_PLAN';
  END IF;
  UPDATE orgs
     SET plan = p_plan,
         updated_at = NOW()
   WHERE id = p_org_id;
END;
$$;

REVOKE ALL ON FUNCTION billing_lookup_by_provider_customer(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION billing_lookup_by_provider_subscription(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION billing_lookup_by_provider_invoice(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION billing_org_exists(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION billing_claim_webhook_event(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION billing_finish_webhook_event(TEXT, TEXT, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION billing_set_org_plan(UUID, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION billing_lookup_by_provider_customer(TEXT, TEXT) TO darex_app;
GRANT EXECUTE ON FUNCTION billing_lookup_by_provider_subscription(TEXT, TEXT) TO darex_app;
GRANT EXECUTE ON FUNCTION billing_lookup_by_provider_invoice(TEXT, TEXT) TO darex_app;
GRANT EXECUTE ON FUNCTION billing_org_exists(UUID) TO darex_app;
GRANT EXECUTE ON FUNCTION billing_claim_webhook_event(TEXT, TEXT, TEXT) TO darex_app;
GRANT EXECUTE ON FUNCTION billing_finish_webhook_event(TEXT, TEXT, UUID, TEXT, TEXT) TO darex_app;
GRANT EXECUTE ON FUNCTION billing_set_org_plan(UUID, TEXT) TO darex_app;

-------------------------------------------------------------------------------
-- Grants — match 011 / 013 (explicit + blanket so darex_app can DML)
-------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON billing_subscriptions TO darex_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON billing_invoices TO darex_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON billing_meters TO darex_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON billing_webhook_events TO darex_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO darex_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO darex_app;
