-------------------------------------------------------------------------------
-- failed_webhooks retention (gap26sept webhooks #15, CH-S07).
--
-- DLQ rows hold raw payloads and were never deleted; darex_app has no DELETE
-- grant on the table. Rather than widening that grant, the worker calls this
-- SECURITY DEFINER function, which can only remove rows that are already
-- closed out (replayed / discarded) or older than the retention window.
-- Unresolved rows younger than the window are kept for replay.
--
-- Idempotent. File: infra/db/migrations/202_failed_webhooks_retention.sql
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION failed_webhooks_purge(p_retention_days integer DEFAULT 30)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  IF p_retention_days IS NULL OR p_retention_days < 1 THEN
    RAISE EXCEPTION 'failed_webhooks_purge: retention must be at least 1 day';
  END IF;
  DELETE FROM failed_webhooks
   WHERE created_at < NOW() - make_interval(days => p_retention_days);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION failed_webhooks_purge(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION failed_webhooks_purge(integer) TO darex_app;
