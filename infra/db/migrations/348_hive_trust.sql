-- 348: hive trust — privacy-preserving trust learned ACROSS workspaces.
--
-- WHY (see docs/adr/023-hive-trust.md for the full argument and the evidence)
-- Earned autonomy (034) is per workspace: every new workspace pays ten approvals
-- in a row for actions that thousands have already shown to be safe, and ten in
-- a row is weak evidence — simulated over 150 reviews it graduates ~41% of
-- workspaces whose people would reject more than one action in ten. This lets a
-- workspace borrow a BOUNDED, OPT-IN prior from the workspaces that chose to
-- share, without any of them revealing anything but a pair of noisy counts.
--
-- WHAT LEAVES A WORKSPACE
-- Only, per (action class, cohort, epoch), how many decisions its own people
-- approved and rejected. Never content, recipients, identifiers or timestamps.
-- Those counts are computed HERE, from approval_requests, by a SECURITY DEFINER
-- function — a workspace cannot submit numbers of its choosing, so the only way
-- to poison the hive is to actually generate decisions.
--
-- FOUR PROTECTIONS, each enforced in this file
--   1. OPT-IN + ELIGIBILITY  off by default; paid plan, minimum age and a minimum
--                            volume of real decisions (sybil resistance: the
--                            simulation shows a large fake coalition is the one
--                            attack that matters, so it must be expensive).
--   2. CLIPPING              each workspace's total is capped at `clip`, scaled in
--                            proportion (deterministic randomised rounding), so
--                            no workspace moves the aggregate by more than clip.
--   3. k-THRESHOLD           nothing is stored for a cell with fewer than k
--                            distinct contributing workspaces.
--   4. NOISE, ONCE           discrete-Laplace noise derived from a secret key and
--                            the release label. A release is computed once and
--                            never recomputed, so repeating the query cannot
--                            average the noise away.
--
-- The sampler is the same construction as services/workflows/src/hive/privacy.ts
-- (HMAC-SHA256 -> 48-bit uniform -> two-sided geometric), and
-- infra/scripts/check-hive-trust.js asserts the two produce identical releases.
--
-- WHAT THIS DOES NOT CLAIM: see the ADR. In short, per-release epsilon-DP under
-- basic composition, with a per-workspace cap on epochs per year; not an
-- end-to-end proof; needs independent privacy review before real data flows.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Settings: private, readable only by the functions below ────────────────
CREATE TABLE IF NOT EXISTS hive_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
REVOKE ALL ON hive_settings FROM PUBLIC;
REVOKE ALL ON hive_settings FROM darex_app;
REVOKE ALL ON hive_settings FROM darex_sql_reader;

INSERT INTO hive_settings (key, value) VALUES
  ('k',                    '20'),    -- distinct workspaces needed before anything is released
  ('clip',                 '10'),    -- per-workspace cap on approvals + rejections per cell per epoch
  ('epsilon',              '1'),     -- privacy budget per release (per workspace, per cell)
  ('max_epochs_per_year',  '12'),    -- per-workspace cap on contributing epochs in any 365 days
  ('max_window_days',      '31'),
  ('require_paid_plan',    'true'),
  ('min_org_age_days',     '30'),
  ('min_decided',          '25')     -- decided approval requests a workspace must have, overall
ON CONFLICT (key) DO NOTHING;

-- The noise key is generated once, per database, and never leaves it.
INSERT INTO hive_settings (key, value)
SELECT 'noise_key', encode(gen_random_bytes(32), 'hex')
WHERE NOT EXISTS (SELECT 1 FROM hive_settings WHERE key = 'noise_key');

-- ── Opt-in: off by default, one row per workspace ──────────────────────────
CREATE TABLE IF NOT EXISTS org_hive_optin (
  org_id     UUID PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  enabled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE org_hive_optin ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_hive_optin FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_hive_optin_org_isolation ON org_hive_optin;
CREATE POLICY org_hive_optin_org_isolation ON org_hive_optin
  USING (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid);
-- Migration 011 sets DEFAULT PRIVILEGES that hand darex_app full DML on every new table in this schema.
-- That is right for ordinary tenant tables, where RLS is the wall, and wrong for anything meant to be
-- write-protected, so each hive table starts from REVOKE ALL and grants the minimum.
REVOKE ALL ON org_hive_optin FROM PUBLIC;
REVOKE ALL ON org_hive_optin FROM darex_app;
GRANT SELECT, INSERT, UPDATE ON org_hive_optin TO darex_app;
GRANT SELECT ON org_hive_optin TO darex_sql_reader;

-- ── What one workspace contributed, per epoch: written only by hive_contribute
CREATE TABLE IF NOT EXISTS hive_contributions (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  action_class TEXT NOT NULL,
  cohort       TEXT NOT NULL DEFAULT 'all',
  epoch        TEXT NOT NULL,
  approvals    INT  NOT NULL CHECK (approvals >= 0),
  rejections   INT  NOT NULL CHECK (rejections >= 0),
  window_start TIMESTAMPTZ NOT NULL,
  window_end   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT hive_contributions_once UNIQUE (org_id, action_class, cohort, epoch),
  CONSTRAINT hive_contributions_window CHECK (window_end > window_start)
);
CREATE INDEX IF NOT EXISTS idx_hive_contributions_cell ON hive_contributions (action_class, cohort, epoch);
ALTER TABLE hive_contributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hive_contributions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hive_contributions_org_isolation ON hive_contributions;
CREATE POLICY hive_contributions_org_isolation ON hive_contributions
  USING (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid)
  WITH CHECK (org_id = (NULLIF(current_setting('app.current_org_id', true), ''))::uuid);
REVOKE ALL ON hive_contributions FROM PUBLIC;
REVOKE ALL ON hive_contributions FROM darex_app;         -- see the note on default privileges above
GRANT SELECT ON hive_contributions TO darex_app;         -- a workspace may SEE what it shared; it cannot write it
GRANT SELECT ON hive_contributions TO darex_sql_reader;

-- ── What has been released: global, noisy, computed once, unreadable directly
CREATE TABLE IF NOT EXISTS hive_releases (
  action_class TEXT NOT NULL,
  cohort       TEXT NOT NULL,
  epoch        TEXT NOT NULL,
  approvals    INT  NOT NULL CHECK (approvals >= 0),
  rejections   INT  NOT NULL CHECK (rejections >= 0),
  at_least_k   INT  NOT NULL,
  epsilon      DOUBLE PRECISION NOT NULL,
  clip         INT  NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (action_class, cohort, epoch)
);
REVOKE ALL ON hive_releases FROM PUBLIC;
REVOKE ALL ON hive_releases FROM darex_app;
REVOKE ALL ON hive_releases FROM darex_sql_reader;

-- ── The sampler: same construction as hive/privacy.ts ──────────────────────
CREATE OR REPLACE FUNCTION hive_uniform(p_key TEXT, p_label TEXT, p_index INT)
RETURNS DOUBLE PRECISION
LANGUAGE plpgsql IMMUTABLE
SET search_path = public
AS $$
DECLARE
  h BYTEA := hmac(convert_to(p_label || ':' || p_index::text, 'UTF8'), convert_to(p_key, 'UTF8'), 'sha256');
  v BIGINT;
BEGIN
  v := (get_byte(h, 0)::BIGINT << 40) | (get_byte(h, 1)::BIGINT << 32) | (get_byte(h, 2)::BIGINT << 24)
     | (get_byte(h, 3)::BIGINT << 16) | (get_byte(h, 4)::BIGINT << 8)  |  get_byte(h, 5)::BIGINT;
  RETURN (v + 1)::DOUBLE PRECISION / 281474976710656.0;   -- (v + 1) / 2^48, in (0, 1]
END
$$;

CREATE OR REPLACE FUNCTION hive_noise(p_key TEXT, p_label TEXT, p_epsilon DOUBLE PRECISION, p_sensitivity INT)
RETURNS INT
LANGUAGE plpgsql IMMUTABLE
SET search_path = public
AS $$
DECLARE
  ln_alpha DOUBLE PRECISION := -p_epsilon / p_sensitivity;
BEGIN
  IF NOT (p_epsilon > 0) THEN RAISE EXCEPTION 'epsilon must be > 0'; END IF;
  IF NOT (p_sensitivity >= 1) THEN RAISE EXCEPTION 'sensitivity must be >= 1'; END IF;
  -- Two-sided geometric: G1 - G2, each floor(ln(U) / ln(alpha)).
  RETURN (floor(ln(hive_uniform(p_key, p_label, 0)) / ln_alpha)
        - floor(ln(hive_uniform(p_key, p_label, 1)) / ln_alpha))::INT;
END
$$;

/** Approvals after clipping a workspace's total to p_clip, keeping its rate (randomised rounding, keyed). */
CREATE OR REPLACE FUNCTION hive_clip_approvals(p_a BIGINT, p_r BIGINT, p_clip INT, p_key TEXT, p_label TEXT, p_org UUID)
RETURNS INT
LANGUAGE plpgsql IMMUTABLE
SET search_path = public
AS $$
DECLARE
  t     BIGINT := p_a + p_r;
  num   NUMERIC;
  whole BIGINT;
  rem   DOUBLE PRECISION;
  a2    BIGINT;
BEGIN
  IF t <= p_clip THEN RETURN p_a::INT; END IF;
  num   := p_a::NUMERIC * p_clip;
  whole := floor(num / t)::BIGINT;
  rem   := (num - whole::NUMERIC * t)::DOUBLE PRECISION / t::DOUBLE PRECISION;
  a2    := whole + CASE WHEN hive_uniform(p_key, p_label || '|clip|' || p_org::text, 0) <= rem THEN 1 ELSE 0 END;
  RETURN LEAST(a2, p_clip)::INT;
END
$$;

CREATE OR REPLACE FUNCTION hive_setting(p_key TEXT)
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$ SELECT value FROM hive_settings WHERE key = p_key $$;

-- ── Contributing: computed from the workspace's own decisions ──────────────
/**
 * Snapshot this workspace's human approve/reject counts for one window and
 * record them for the epoch. The caller must be inside the workspace's own org
 * context; the numbers come from approval_requests, not from the caller.
 *
 * Only classes that may graduate (send, publish, price) are shared — the hive
 * has nothing to say about pay, sign, legal or compliance stops, which never
 * graduate. auto_approved rows are the AGENT acting on an already-graduated
 * class, not a person's judgement, and are not counted.
 */
CREATE OR REPLACE FUNCTION hive_contribute(p_org UUID, p_epoch TEXT, p_from TIMESTAMPTZ, p_to TIMESTAMPTZ, p_cohort TEXT DEFAULT 'all')
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ctx     UUID := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
  v_plan    TEXT;
  v_created TIMESTAMPTZ;
  v_decided INT;
  v_epochs  INT;
  v_rows    INT;
BEGIN
  IF v_ctx IS NULL OR v_ctx <> p_org THEN
    RAISE EXCEPTION 'hive_contribute: a workspace may contribute only for itself';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM org_hive_optin WHERE org_id = p_org AND enabled) THEN
    RAISE EXCEPTION 'hive_contribute: this workspace has not opted in';
  END IF;
  IF p_to <= p_from OR p_to - p_from > make_interval(days => hive_setting('max_window_days')::int) THEN
    RAISE EXCEPTION 'hive_contribute: window must be positive and at most % days', hive_setting('max_window_days');
  END IF;

  SELECT plan, created_at INTO v_plan, v_created FROM orgs WHERE id = p_org;
  IF hive_setting('require_paid_plan') = 'true' AND v_plan = 'free' THEN
    RAISE EXCEPTION 'hive_contribute: not eligible (free plan)';
  END IF;
  IF v_created > NOW() - make_interval(days => hive_setting('min_org_age_days')::int) THEN
    RAISE EXCEPTION 'hive_contribute: not eligible (workspace too new)';
  END IF;
  SELECT COUNT(*) INTO v_decided FROM approval_requests
   WHERE org_id = p_org AND status IN ('approved', 'rejected');
  IF v_decided < hive_setting('min_decided')::int THEN
    RAISE EXCEPTION 'hive_contribute: not eligible (only % decided requests)', v_decided;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('hive:' || p_org::text));

  -- One decision may be counted once. A window that overlaps an earlier one would count it twice and
  -- break the sensitivity the noise is calibrated to.
  IF EXISTS (
    SELECT 1 FROM hive_contributions
     WHERE org_id = p_org AND epoch <> p_epoch AND window_start < p_to AND window_end > p_from
  ) THEN
    RAISE EXCEPTION 'hive_contribute: window overlaps an earlier contribution';
  END IF;

  -- Privacy budget: a workspace may contribute in at most N distinct epochs in any 365 days.
  SELECT COUNT(DISTINCT epoch) INTO v_epochs FROM hive_contributions
   WHERE org_id = p_org AND created_at > NOW() - INTERVAL '365 days' AND epoch <> p_epoch;
  IF v_epochs >= hive_setting('max_epochs_per_year')::int THEN
    RAISE EXCEPTION 'hive_contribute: privacy budget for this workspace is spent for the year';
  END IF;

  INSERT INTO hive_contributions (org_id, action_class, cohort, epoch, approvals, rejections, window_start, window_end)
  SELECT p_org, ar.action_class, p_cohort, p_epoch,
         COUNT(*) FILTER (WHERE ar.status = 'approved')::int,
         COUNT(*) FILTER (WHERE ar.status = 'rejected')::int,
         p_from, p_to
    FROM approval_requests ar
   WHERE ar.org_id = p_org
     AND ar.status IN ('approved', 'rejected')
     AND ar.decided_at >= p_from AND ar.decided_at < p_to
     AND action_class_may_graduate(ar.action_class)
   GROUP BY ar.action_class
  ON CONFLICT (org_id, action_class, cohort, epoch) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END
$$;

-- ── Publishing: the only place workspaces are combined ─────────────────────
/**
 * Combine the epoch's contributions into releases. Trusted-job only (EXECUTE is
 * granted to the maintenance role, not to the application role): it is the one
 * function that reads across workspaces.
 *
 * A cell with fewer than k distinct opted-in workspaces stores NOTHING. A
 * release is INSERT ... ON CONFLICT DO NOTHING: computed once, never re-noised.
 */
CREATE OR REPLACE FUNCTION hive_publish(p_epoch TEXT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_k      INT              := hive_setting('k')::int;
  v_clip   INT              := hive_setting('clip')::int;
  v_eps    DOUBLE PRECISION := hive_setting('epsilon')::double precision;
  v_key    TEXT             := hive_setting('noise_key');
  cell     RECORD;
  v_label  TEXT;
  v_a      BIGINT;
  v_r      BIGINT;
  v_n      INT;
  v_total  INT := 0;
  v_rows   INT;
BEGIN
  FOR cell IN
    SELECT DISTINCT c.action_class, c.cohort
      FROM hive_contributions c
      JOIN org_hive_optin o ON o.org_id = c.org_id AND o.enabled
     WHERE c.epoch = p_epoch
  LOOP
    v_label := cell.action_class || '|' || cell.cohort || '|' || p_epoch;

    SELECT COUNT(DISTINCT c.org_id),
           COALESCE(SUM(hive_clip_approvals(c.approvals, c.rejections, v_clip, v_key, v_label, c.org_id)), 0),
           COALESCE(SUM(CASE WHEN c.approvals + c.rejections <= v_clip THEN c.rejections
                             ELSE v_clip - hive_clip_approvals(c.approvals, c.rejections, v_clip, v_key, v_label, c.org_id) END), 0)
      INTO v_n, v_a, v_r
      FROM hive_contributions c
      JOIN org_hive_optin o ON o.org_id = c.org_id AND o.enabled
     WHERE c.epoch = p_epoch AND c.action_class = cell.action_class AND c.cohort = cell.cohort;

    CONTINUE WHEN v_n < v_k;   -- below k: nothing is stored, not even a small number

    INSERT INTO hive_releases (action_class, cohort, epoch, approvals, rejections, at_least_k, epsilon, clip)
    VALUES (cell.action_class, cell.cohort, p_epoch,
            GREATEST(0, v_a + hive_noise(v_key, v_label || '|A', v_eps, v_clip)),
            GREATEST(0, v_r + hive_noise(v_key, v_label || '|R', v_eps, v_clip)),
            v_k, v_eps, v_clip)
    ON CONFLICT (action_class, cohort, epoch) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_total := v_total + v_rows;
  END LOOP;
  RETURN v_total;
END
$$;

-- ── Consuming: reciprocity — only a contributing workspace gets the prior ──
CREATE OR REPLACE FUNCTION hive_prior_for(p_org UUID, p_action_class TEXT, p_cohort TEXT DEFAULT 'all')
RETURNS TABLE (out_epoch TEXT, out_approvals INT, out_rejections INT, out_at_least_k INT, out_epsilon DOUBLE PRECISION)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ctx UUID := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
BEGIN
  IF v_ctx IS NULL OR v_ctx <> p_org THEN
    RAISE EXCEPTION 'hive_prior_for: a workspace may ask only for itself';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM org_hive_optin WHERE org_id = p_org AND enabled) THEN
    RETURN;   -- no prior, and no veto, for a workspace that does not share
  END IF;
  RETURN QUERY
    SELECT r.epoch, r.approvals, r.rejections, r.at_least_k, r.epsilon
      FROM hive_releases r
     WHERE r.action_class = p_action_class AND r.cohort = p_cohort
     ORDER BY r.published_at DESC, r.epoch DESC
     LIMIT 1;
END
$$;

-- ── Who may call what ─────────────────────────────────────────────────────
-- The helpers are pure and hold no secret; the settings reader and the publisher are not for the app role.
REVOKE ALL ON FUNCTION hive_uniform(TEXT, TEXT, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION hive_noise(TEXT, TEXT, DOUBLE PRECISION, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION hive_clip_approvals(BIGINT, BIGINT, INT, TEXT, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION hive_setting(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION hive_contribute(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION hive_publish(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION hive_prior_for(UUID, TEXT, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION hive_uniform(TEXT, TEXT, INT) TO darex;
GRANT EXECUTE ON FUNCTION hive_noise(TEXT, TEXT, DOUBLE PRECISION, INT) TO darex;
GRANT EXECUTE ON FUNCTION hive_clip_approvals(BIGINT, BIGINT, INT, TEXT, TEXT, UUID) TO darex;
GRANT EXECUTE ON FUNCTION hive_setting(TEXT) TO darex;                       -- and to the definer-owned callers, which run as darex
GRANT EXECUTE ON FUNCTION hive_publish(TEXT) TO darex;                       -- the maintenance role only
GRANT EXECUTE ON FUNCTION hive_contribute(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT) TO darex, darex_app;
GRANT EXECUTE ON FUNCTION hive_prior_for(UUID, TEXT, TEXT) TO darex, darex_app;

COMMENT ON TABLE hive_releases IS
  'Noisy, k-thresholded aggregates. Computed once per (class, cohort, epoch) and never recomputed. '
  'Not readable by the application role: consumed only through hive_prior_for, which gates on opt-in.';
