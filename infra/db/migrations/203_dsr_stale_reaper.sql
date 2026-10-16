-------------------------------------------------------------------------------
-- DSR stale-job reaper (gap26sept dsr.md: delete stuck at `running`).
--
-- A worker crash mid-delete leaves dsr_requests.status = 'running' forever.
-- runDsrDelete stamps progress.heartbeatAt on every save; this SECURITY
-- DEFINER function (cross-org, so RLS-exempt like failed_webhooks_purge)
-- marks delete jobs with no heartbeat for p_stale_minutes as failed, so the
-- operator sees the failure and can retry. Progress is kept.
--
-- Idempotent. File: infra/db/migrations/203_dsr_stale_reaper.sql
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION dsr_requests_reap_stale(p_stale_minutes integer DEFAULT 30)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  IF p_stale_minutes IS NULL OR p_stale_minutes < 5 THEN
    RAISE EXCEPTION 'dsr_requests_reap_stale: stale window must be at least 5 minutes';
  END IF;
  UPDATE dsr_requests
     SET status = 'failed',
         completed_at = NOW(),
         error = 'stalled: no progress for ' || p_stale_minutes || ' minutes; retry the request'
   WHERE kind = 'delete'
     AND status = 'running'
     AND COALESCE(NULLIF(progress->>'heartbeatAt', '')::timestamptz, created_at)
         < NOW() - make_interval(mins => p_stale_minutes);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION dsr_requests_reap_stale(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dsr_requests_reap_stale(integer) TO darex_app;
