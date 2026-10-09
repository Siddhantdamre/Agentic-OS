-- 212: money owed to the owner ("Dues").
--
-- WHAT WAS MISSING
-- A small supplier's biggest recurring money problem is customers paying late, and the product had no place to
-- record who owes what. The only related table, pm_charges, is for rent on a lease.
--
-- WHAT THIS ADDS
--   org_dues   one row per invoice or amount a buyer owes the workspace: who, how much, when it was raised, the
--              agreed credit days, the day it falls due, whether it is open, paid or disputed, and when the buyer
--              was last reminded. Paid is only set by the owner or by a matched payment; a buyer saying "I paid"
--              does not close it (same rule as pm_charges).
--
-- Tenant table: row-level security forced, org policy in the same hardened form as every other tenant table.
-- It holds a buyer's name, phone and email, so it is personal data: it is listed for erasure requests, and
-- darex_sql_reader (the restricted role behind model-written SQL) gets no access to it.

CREATE TABLE IF NOT EXISTS org_dues (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id           UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  buyer_name       TEXT NOT NULL,
  buyer_phone      TEXT,
  buyer_email      TEXT,
  invoice_no       TEXT,
  amount           NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  currency         TEXT NOT NULL DEFAULT 'INR',
  invoice_date     DATE NOT NULL,
  credit_days      INTEGER CHECK (credit_days IS NULL OR credit_days BETWEEN 0 AND 365),
  due_date         DATE NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'disputed')),
  paid_at          TIMESTAMPTZ,
  payment_ref      TEXT,
  last_reminder_at TIMESTAMPTZ,
  reminders_sent   INTEGER NOT NULL DEFAULT 0,
  note             TEXT,
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_org_dues_org_status_due ON org_dues (org_id, status, due_date);

ALTER TABLE org_dues ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_dues FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_dues_org_isolation ON org_dues;
CREATE POLICY org_dues_org_isolation ON org_dues
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::UUID);
GRANT SELECT, INSERT, UPDATE, DELETE ON org_dues TO darex_app;

-- Model-written SQL may answer "who owes me money and how late" from the business columns only. The buyer's phone,
-- email and the free-text note stay out of its reach, as credential columns do in 207. Row-level security still
-- limits the reader role to one workspace.
GRANT SELECT (id, org_id, buyer_name, invoice_no, amount, currency, invoice_date, credit_days, due_date, status,
              paid_at, last_reminder_at, reminders_sent, created_at, updated_at)
  ON org_dues TO darex_sql_reader;
