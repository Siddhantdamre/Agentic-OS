export type CheckResult = {
  status: 'ok' | 'error' | 'skipped' | 'not_configured';
  latencyMs?: number;
  detail?: string;
  waitingCount?: number;
  totalCount?: number;
  idleCount?: number;
};

export type ReadyStatus = 'healthy' | 'degraded' | 'unhealthy';

export function evaluateReadiness(checks: Record<string, CheckResult>): {
  status: ReadyStatus;
  httpStatus: number;
} {
  const postgres = checks.postgres || { status: 'not_configured' };
  const db_pool = checks.db_pool || { status: 'skipped' };
  const worker = checks.worker || { status: 'not_configured' };
  const nango = checks.nango || { status: 'not_configured' };

  // Postgres and pool are critical.
  // When configured, Worker and Nango are also critical dependencies (OPS-G02: without them, no AI employee can act or run tasks).
  // A down worker or down Nango returns 503 so traffic does not hit broken backends.
  const requiredDown =
    postgres.status === 'error' ||
    db_pool.status === 'error' ||
    worker.status === 'error' ||
    nango.status === 'error';

  const optionalConfiguredFailing = Object.entries(checks)
    .filter(([k]) => !['postgres', 'db_pool', 'worker', 'nango'].includes(k))
    .some(([, c]) => c.status === 'error');

  let status: ReadyStatus = 'healthy';
  let httpStatus = 200;
  if (requiredDown) {
    status = 'unhealthy';
    httpStatus = 503;
  } else if (optionalConfiguredFailing) {
    status = 'degraded';
    httpStatus = 200;
  }

  return { status, httpStatus };
}
