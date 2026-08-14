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

  assertProductionBillingConfig();
  assertProductionSsoConfig();
}

function envSet(name: string): boolean {
  const raw = process.env[name];
  return raw != null && raw.trim() !== '';
}

function stripeBillingComplete(): boolean {
  return (
    envSet('DAREX_STRIPE_SECRET_KEY') &&
    envSet('DAREX_STRIPE_WEBHOOK_SECRET') &&
    (envSet('DAREX_STRIPE_PRICE_STARTER') ||
      envSet('DAREX_STRIPE_PRICE_GROWTH') ||
      envSet('DAREX_STRIPE_PRICE_ENTERPRISE'))
  );
}

function razorpayBillingComplete(): boolean {
  return (
    envSet('DAREX_RAZORPAY_KEY_ID') &&
    envSet('DAREX_RAZORPAY_KEY_SECRET') &&
    envSet('DAREX_RAZORPAY_WEBHOOK_SECRET') &&
    (envSet('DAREX_RAZORPAY_PLAN_STARTER') ||
      envSet('DAREX_RAZORPAY_PLAN_GROWTH') ||
      envSet('DAREX_RAZORPAY_PLAN_ENTERPRISE'))
  );
}

/**
 * Darex platform billing (B2) — not org payment-link tools.
 * Partial PSP config in production refuses boot. Staging sets
 * DAREX_BILLING_REQUIRED=true so missing keys also refuse boot.
 * Checkout still 503s honestly when keys are absent and the flag is off.
 */
export function assertProductionBillingConfig(): void {
  if (!isProductionEnv() || isNextProductionBuild()) return;

  if (envSet('DAREX_STRIPE_SECRET_KEY') && !stripeBillingComplete()) {
    throw new Error(
      'Partial Darex Stripe billing config in production. Set DAREX_STRIPE_WEBHOOK_SECRET and at least one DAREX_STRIPE_PRICE_*. No silent invoices.'
    );
  }
  if (envSet('DAREX_RAZORPAY_KEY_ID') && !razorpayBillingComplete()) {
    throw new Error(
      'Partial Darex Razorpay billing config in production. Set DAREX_RAZORPAY_KEY_SECRET, DAREX_RAZORPAY_WEBHOOK_SECRET, and at least one DAREX_RAZORPAY_PLAN_*.'
    );
  }
  if (
    process.env.DAREX_BILLING_REQUIRED === 'true' &&
    !stripeBillingComplete() &&
    !razorpayBillingComplete()
  ) {
    throw new Error(
      'DAREX_BILLING_REQUIRED=true but neither Stripe nor Razorpay is fully configured. See .env.example DAREX_STRIPE_* / DAREX_RAZORPAY_*.'
    );
  }
}

/**
 * S7 — test IdP localhost defaults are forbidden in production.
 * Password login stays enabled regardless of SSO env.
 */
export function assertProductionSsoConfig(): void {
  if (!isProductionEnv() || isNextProductionBuild()) return;
  if (process.env.SUPERTOKENS_SAML_TEST_IDP === 'true') {
    throw new Error(
      'SUPERTOKENS_SAML_TEST_IDP=true is forbidden when NODE_ENV=production. Set SUPERTOKENS_SAML_BOXY_URL, SUPERTOKENS_SAML_CLIENT_ID, and SUPERTOKENS_SAML_CLIENT_SECRET for a real IdP.'
    );
  }
}
