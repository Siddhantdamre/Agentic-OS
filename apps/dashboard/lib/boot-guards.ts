/**
 * Production fail-fast for tenancy + demo-auth. Called from instrumentation
 * on Next.js boot and from `createPool()` so a missed instrumentation hook
 * still refuses to run as the Postgres superuser or with demo OAuth.
 *
 * Dev may keep local defaults (`DB_USER` → darex_app). Production must set
 * `DB_USER` explicitly and it must not be `darex`.
 */

const SUPERUSER_DB_USERS = new Set(['darex', 'postgres']);

function isNextProductionBuild(): boolean {
  return process.env.NEXT_PHASE === 'phase-production-build';
}

export function isProductionEnv(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function resolveRuntimeDbUser(): string {
  const configured = process.env.DB_USER;
  if (isProductionEnv() && !isNextProductionBuild()) {
    if (!configured) {
      throw new Error(
        'DB_USER must be set in production. Use the least-privilege role darex_app — do not fall back to the superuser.'
      );
    }
    if (SUPERUSER_DB_USERS.has(configured)) {
      throw new Error(
        `DB_USER=${configured} is a Postgres superuser. Production must run as darex_app (no silent superuser fallback).`
      );
    }
    return configured;
  }
  return configured || 'darex_app';
}

export function assertProductionBoot(): void {
  if (!isProductionEnv()) return;
  // `next build` sets NODE_ENV=production but is not a running app. Fail-fast
  // applies to `next start` / instrumentation / createPool at runtime.
  if (isNextProductionBuild()) return;

  if (process.env.ALLOW_DEMO_AUTH === 'true') {
    throw new Error(
      'ALLOW_DEMO_AUTH=true is forbidden when NODE_ENV=production. Refuse boot; demo OAuth must never ship.'
    );
  }

  resolveRuntimeDbUser();

  if (!process.env.DB_PASSWORD) {
    throw new Error('DB_PASSWORD must be set in production');
  }
  if (!process.env.DB_HOST) {
    throw new Error('DB_HOST must be set in production');
  }
}
