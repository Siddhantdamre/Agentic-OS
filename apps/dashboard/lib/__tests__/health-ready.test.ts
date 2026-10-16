import { evaluateReadiness } from '@/lib/health-readiness';

describe('evaluateReadiness (OPS-G02)', () => {
  it('returns 200 healthy when all checks are ok', () => {
    const checks = {
      postgres: { status: 'ok' as const },
      db_pool: { status: 'ok' as const },
      worker: { status: 'ok' as const },
      nango: { status: 'ok' as const },
      redis: { status: 'ok' as const },
      temporal: { status: 'ok' as const },
    };
    const res = evaluateReadiness(checks);
    expect(res.status).toBe('healthy');
    expect(res.httpStatus).toBe(200);
  });

  it('returns 503 unhealthy when worker is down', () => {
    const checks = {
      postgres: { status: 'ok' as const },
      db_pool: { status: 'ok' as const },
      worker: { status: 'error' as const, detail: 'worker unreachable' },
      nango: { status: 'ok' as const },
    };
    const res = evaluateReadiness(checks);
    expect(res.status).toBe('unhealthy');
    expect(res.httpStatus).toBe(503);
  });

  it('returns 503 unhealthy when nango is down', () => {
    const checks = {
      postgres: { status: 'ok' as const },
      db_pool: { status: 'ok' as const },
      worker: { status: 'ok' as const },
      nango: { status: 'error' as const, detail: 'Nango unreachable' },
    };
    const res = evaluateReadiness(checks);
    expect(res.status).toBe('unhealthy');
    expect(res.httpStatus).toBe(503);
  });

  it('returns 503 unhealthy when postgres is down', () => {
    const checks = {
      postgres: { status: 'error' as const, detail: 'Database unreachable' },
      db_pool: { status: 'ok' as const },
      worker: { status: 'ok' as const },
      nango: { status: 'ok' as const },
    };
    const res = evaluateReadiness(checks);
    expect(res.status).toBe('unhealthy');
    expect(res.httpStatus).toBe(503);
  });

  it('returns 200 degraded when optional service fails', () => {
    const checks = {
      postgres: { status: 'ok' as const },
      db_pool: { status: 'ok' as const },
      worker: { status: 'ok' as const },
      nango: { status: 'ok' as const },
      redis: { status: 'error' as const, detail: 'Redis timeout' },
    };
    const res = evaluateReadiness(checks);
    expect(res.status).toBe('degraded');
    expect(res.httpStatus).toBe(200);
  });

  it('tolerates unconfigured optional dependencies as healthy', () => {
    const checks = {
      postgres: { status: 'ok' as const },
      db_pool: { status: 'ok' as const },
      worker: { status: 'ok' as const },
      nango: { status: 'ok' as const },
      cognee: { status: 'not_configured' as const },
      langfuse: { status: 'not_configured' as const },
    };
    const res = evaluateReadiness(checks);
    expect(res.status).toBe('healthy');
    expect(res.httpStatus).toBe(200);
  });
});
