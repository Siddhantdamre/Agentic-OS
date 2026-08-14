/**
 * Darex SaaS billing helpers (B2/B3).
 *
 * Isolated from org Stripe/Razorpay *payment-link* tools in tool-executor.
 * Price IDs, plan amounts, and meter caps come from env — never hardcoded
 * and never from a request-body org_id.
 *
 * Env (placeholders only; no secrets in git):
 *   DAREX_STRIPE_SECRET_KEY
 *   DAREX_STRIPE_WEBHOOK_SECRET
 *   DAREX_STRIPE_PRICE_STARTER | _GROWTH | _ENTERPRISE | _ADDON_SEAT
 *   DAREX_RAZORPAY_KEY_ID / DAREX_RAZORPAY_KEY_SECRET
 *   DAREX_RAZORPAY_WEBHOOK_SECRET
 *   DAREX_RAZORPAY_PLAN_STARTER | _GROWTH | _ENTERPRISE
 *   DAREX_PLAN_CURRENCY
 *   DAREX_PLAN_STARTER_AMOUNT_CENTS | _GROWTH_ | _ENTERPRISE_
 *   DAREX_SEAT_AMOUNT_CENTS
 *   DAREX_SEAT_MAX
 *   DAREX_METER_LLM_SOFT_USD / DAREX_METER_LLM_HARD_USD
 *   DAREX_METER_WHATSAPP_SOFT / DAREX_METER_WHATSAPP_HARD
 *   DAREX_METER_SEAT_SOFT / DAREX_METER_SEAT_HARD
 */

import crypto from 'crypto';
import type { PoolClient } from 'pg';
import {
  fetchOrgWeeklyCost,
  LangfuseUnavailableError,
  queryConfirmRejectDrift,
  WEEK_DAYS,
  type ConfirmRejectDrift,
  type OrgWeeklyCost,
} from '@/lib/org-cost';
import { LangfuseConfigError } from '@/lib/langfuse-trace';
import { isProductionEnv } from '@/lib/boot-guards';
import { getOrgScopedClient, pool } from '@/lib/db';
import { loadHumanRole, type HumanRole } from '@/lib/rbac';
import {
  BILLING_PLAN_TYPES,
  BILLING_PROVIDERS,
  type BillingPlanType,
  type BillingProvider,
} from '@darex/shared-types';

export type OrgPlanKey = 'free' | BillingPlanType;
export type CheckoutPlanKey = BillingPlanType;

export type SubscriptionStatus =
  | 'incomplete'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'paused';

export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';

export type MeterKind =
  | 'llm_tokens'
  | 'whatsapp_conversations'
  | 'seats'
  | 'embeddings'
  | 'successful_actions'
  | 'disconnected_actions';

export type WebhookEventStatus = 'received' | 'processed' | 'ignored' | 'error';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const STRIPE_TOLERANCE_SEC = 300;
const PROVIDER_TIMEOUT_MS = 15_000;

export class BillingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingConfigError';
  }
}

export class BillingSignatureError extends Error {
  readonly status = 401 as const;
  constructor(message: string) {
    super(message);
    this.name = 'BillingSignatureError';
  }
}

function envString(name: string): string | undefined {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return undefined;
  return raw.trim();
}

function envInt(name: string, fallback: number): number {
  const raw = envString(name);
  if (raw == null) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function envNumber(name: string, fallback: number): number {
  const raw = envString(name);
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function timingSafeEqualString(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    crypto.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export function isBillingProvider(value: unknown): value is BillingProvider {
  return typeof value === 'string' && (BILLING_PROVIDERS as readonly string[]).includes(value);
}

export function isCheckoutPlan(value: unknown): value is CheckoutPlanKey {
  return typeof value === 'string' && (BILLING_PLAN_TYPES as readonly string[]).includes(value);
}

export function isOrgPlanKey(value: string): value is OrgPlanKey {
  return value === 'free' || isCheckoutPlan(value);
}

export function parseOrgPlanKey(value: unknown): OrgPlanKey {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  if (isOrgPlanKey(raw)) return raw;
  return 'free';
}

export function canManageBilling(role: HumanRole): boolean {
  switch (role) {
    case 'owner':
    case 'admin':
      return true;
    case 'member':
    case 'auditor':
      return false;
    default: {
      const _exhaustive: never = role;
      return _exhaustive;
    }
  }
}

export async function requireBillingManager(
  client: PoolClient,
  userId: string
): Promise<{ role: HumanRole } | { error: string; status: number }> {
  const role = await loadHumanRole(client, userId);
  if (!canManageBilling(role)) {
    return { error: 'Only owners and admins can change Darex billing', status: 403 };
  }
  return { role };
}

export function stripeSecretKey(): string | undefined {
  return envString('DAREX_STRIPE_SECRET_KEY');
}

export function stripeWebhookSecret(): string | undefined {
  return envString('DAREX_STRIPE_WEBHOOK_SECRET');
}

export function razorpayKeyId(): string | undefined {
  return envString('DAREX_RAZORPAY_KEY_ID');
}

export function razorpayKeySecret(): string | undefined {
  return envString('DAREX_RAZORPAY_KEY_SECRET');
}

export function razorpayWebhookSecret(): string | undefined {
  return envString('DAREX_RAZORPAY_WEBHOOK_SECRET');
}

export function planCurrency(provider: BillingProvider): string {
  const explicit = envString('DAREX_PLAN_CURRENCY');
  if (explicit) return explicit.toLowerCase();
  switch (provider) {
    case 'stripe':
      return 'usd';
    case 'razorpay':
      return 'inr';
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}

export function planAmountCents(plan: CheckoutPlanKey): number | null {
  switch (plan) {
    case 'starter':
      return envInt('DAREX_PLAN_STARTER_AMOUNT_CENTS', 0) || null;
    case 'growth':
      return envInt('DAREX_PLAN_GROWTH_AMOUNT_CENTS', 0) || null;
    case 'enterprise':
      return envInt('DAREX_PLAN_ENTERPRISE_AMOUNT_CENTS', 0) || null;
    default: {
      const _exhaustive: never = plan;
      return _exhaustive;
    }
  }
}

export function seatAmountCents(): number | null {
  return envInt('DAREX_SEAT_AMOUNT_CENTS', 0) || null;
}

export function seatMax(): number {
  return Math.max(1, envInt('DAREX_SEAT_MAX', 50));
}

export function stripePriceId(plan: CheckoutPlanKey): string | undefined {
  switch (plan) {
    case 'starter':
      return envString('DAREX_STRIPE_PRICE_STARTER');
    case 'growth':
      return envString('DAREX_STRIPE_PRICE_GROWTH');
    case 'enterprise':
      return envString('DAREX_STRIPE_PRICE_ENTERPRISE');
    default: {
      const _exhaustive: never = plan;
      return _exhaustive;
    }
  }
}

export function stripeAddonSeatPriceId(): string | undefined {
  return envString('DAREX_STRIPE_PRICE_ADDON_SEAT');
}

export function razorpayPlanId(plan: CheckoutPlanKey): string | undefined {
  switch (plan) {
    case 'starter':
      return envString('DAREX_RAZORPAY_PLAN_STARTER');
    case 'growth':
      return envString('DAREX_RAZORPAY_PLAN_GROWTH');
    case 'enterprise':
      return envString('DAREX_RAZORPAY_PLAN_ENTERPRISE');
    default: {
      const _exhaustive: never = plan;
      return _exhaustive;
    }
  }
}

export function meterCaps(): {
  llmSoftUsd: number;
  llmHardUsd: number;
  whatsappSoft: number;
  whatsappHard: number;
  seatSoft: number;
  seatHard: number;
} {
  return {
    llmSoftUsd: envNumber('DAREX_METER_LLM_SOFT_USD', 50),
    llmHardUsd: envNumber('DAREX_METER_LLM_HARD_USD', 200),
    whatsappSoft: envInt('DAREX_METER_WHATSAPP_SOFT', 500),
    whatsappHard: envInt('DAREX_METER_WHATSAPP_HARD', 2000),
    seatSoft: envInt('DAREX_METER_SEAT_SOFT', 5),
    seatHard: envInt('DAREX_METER_SEAT_HARD', 25),
  };
}

export function providerConfigured(provider: BillingProvider): boolean {
  switch (provider) {
    case 'stripe':
      return Boolean(stripeSecretKey());
    case 'razorpay':
      return Boolean(razorpayKeyId() && razorpayKeySecret());
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}

export const CLIENT_ORG_ID_ERROR =
  'org_id is not accepted from the client; it is resolved from the session.';

export function requestHasClientOrgId(
  request: Request,
  body?: Record<string, unknown> | null
): boolean {
  const url = new URL(request.url);
  if (url.searchParams.get('org_id') || url.searchParams.get('orgId')) return true;
  if (!body) return false;
  return Boolean(body.orgId || body.org_id);
}

export function requestHasClientCustomerId(body?: Record<string, unknown> | null): boolean {
  if (!body) return false;
  return Boolean(body.customerId || body.customer_id || body.subscriptionId || body.subscription_id);
}

/**
 * Env names a human must paste for this Darex PSP (not org payment-link tools).
 * Production also requires the webhook secret so paid sessions can be reconciled.
 */
export function missingProviderEnv(
  provider: BillingProvider,
  plan?: CheckoutPlanKey
): string[] {
  const missing: string[] = [];
  const prod = isProductionEnv();
  switch (provider) {
    case 'stripe':
      if (!stripeSecretKey()) missing.push('DAREX_STRIPE_SECRET_KEY');
      if (prod && !stripeWebhookSecret()) missing.push('DAREX_STRIPE_WEBHOOK_SECRET');
      if (plan) {
        if (!stripePriceId(plan)) missing.push(`DAREX_STRIPE_PRICE_${plan.toUpperCase()}`);
      } else if (!stripePriceId('starter') && !stripePriceId('growth') && !stripePriceId('enterprise')) {
        missing.push('DAREX_STRIPE_PRICE_STARTER|GROWTH|ENTERPRISE');
      }
      break;
    case 'razorpay':
      if (!razorpayKeyId()) missing.push('DAREX_RAZORPAY_KEY_ID');
      if (!razorpayKeySecret()) missing.push('DAREX_RAZORPAY_KEY_SECRET');
      if (prod && !razorpayWebhookSecret()) missing.push('DAREX_RAZORPAY_WEBHOOK_SECRET');
      if (plan) {
        if (!razorpayPlanId(plan)) missing.push(`DAREX_RAZORPAY_PLAN_${plan.toUpperCase()}`);
      } else if (!razorpayPlanId('starter') && !razorpayPlanId('growth') && !razorpayPlanId('enterprise')) {
        missing.push('DAREX_RAZORPAY_PLAN_STARTER|GROWTH|ENTERPRISE');
      }
      break;
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
  return missing;
}

export function billingProviderGaps(): { stripe: string[]; razorpay: string[] } {
  return {
    stripe: missingProviderEnv('stripe'),
    razorpay: missingProviderEnv('razorpay'),
  };
}

export function assertCheckoutReady(provider: BillingProvider, plan: CheckoutPlanKey): void {
  const missing = missingProviderEnv(provider, plan);
  if (missing.length === 0) return;
  const mode = isProductionEnv() ? 'production fail-fast' : 'dev';
  throw new BillingConfigError(
    `Darex ${provider} billing is not configured (${mode}). Missing: ${missing.join(', ')}. See .env.example. No invoice was created.`
  );
}

export function assertPortalReady(): void {
  if (stripeSecretKey()) return;
  const mode = isProductionEnv() ? 'production fail-fast' : 'dev';
  throw new BillingConfigError(
    `Darex Stripe billing is not configured (${mode}). Missing: DAREX_STRIPE_SECRET_KEY. See .env.example.`
  );
}

export type CatalogPlan = {
  key: CheckoutPlanKey;
  amountCents: number | null;
  currency: string;
  stripePriceId: string | null;
  razorpayPlanId: string | null;
};

export function catalogPlans(): CatalogPlan[] {
  return BILLING_PLAN_TYPES.map((key) => ({
    key,
    amountCents: planAmountCents(key),
    currency: envString('DAREX_PLAN_CURRENCY')?.toLowerCase() || 'usd',
    stripePriceId: stripePriceId(key) ?? null,
    razorpayPlanId: razorpayPlanId(key) ?? null,
  }));
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function formBody(fields: Record<string, string>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== '') body.set(k, v);
  }
  return body;
}

async function stripePost(
  path: string,
  fields: Record<string, string>
): Promise<{ status: number; json: Record<string, unknown> }> {
  const secret = stripeSecretKey();
  if (!secret) throw new BillingConfigError('DAREX_STRIPE_SECRET_KEY is not configured');
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formBody(fields),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

async function razorpayRequest(
  method: 'GET' | 'POST',
  path: string,
  jsonBody?: Record<string, unknown>
): Promise<{ status: number; json: Record<string, unknown> }> {
  const keyId = razorpayKeyId();
  const keySecret = razorpayKeySecret();
  if (!keyId || !keySecret) {
    throw new BillingConfigError('DAREX_RAZORPAY_KEY_ID / DAREX_RAZORPAY_KEY_SECRET are not configured');
  }
  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: jsonBody ? JSON.stringify(jsonBody) : undefined,
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

export function verifyStripeSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const parts: Record<string, string> = {};
  for (const piece of header.split(',')) {
    const idx = piece.indexOf('=');
    if (idx <= 0) continue;
    const k = piece.slice(0, idx).trim();
    const v = piece.slice(idx + 1).trim();
    if (k === 't' || (k === 'v1' && !parts.v1)) parts[k] = v;
  }
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;
  const ts = Number(t);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > STRIPE_TOLERANCE_SEC) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return timingSafeEqualString(v1, expected);
}

export function verifyRazorpaySignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return timingSafeEqualString(header, expected);
}

export type DetectedBillingProvider = BillingProvider;

export function detectWebhookProvider(headers: Headers): DetectedBillingProvider | null {
  if (headers.get('stripe-signature')) return 'stripe';
  if (headers.get('x-razorpay-signature')) return 'razorpay';
  return null;
}

export function assertBillingWebhookSignature(
  provider: BillingProvider,
  rawBody: string,
  headers: Headers
): void {
  switch (provider) {
    case 'stripe': {
      const secret = stripeWebhookSecret();
      if (!secret) {
        throw new BillingSignatureError('DAREX_STRIPE_WEBHOOK_SECRET is not configured');
      }
      if (!verifyStripeSignature(rawBody, headers.get('stripe-signature'), secret)) {
        throw new BillingSignatureError('Invalid Stripe billing webhook signature');
      }
      return;
    }
    case 'razorpay': {
      const secret = razorpayWebhookSecret();
      if (!secret) {
        throw new BillingSignatureError('DAREX_RAZORPAY_WEBHOOK_SECRET is not configured');
      }
      if (!verifyRazorpaySignature(rawBody, headers.get('x-razorpay-signature'), secret)) {
        throw new BillingSignatureError('Invalid Razorpay billing webhook signature');
      }
      return;
    }
    default: {
      const _exhaustive: never = provider;
      throw new BillingSignatureError(`Unhandled billing provider: ${String(_exhaustive)}`);
    }
  }
}

type StripeEventKind =
  | 'checkout.session.completed'
  | 'customer.subscription.updated'
  | 'customer.subscription.deleted'
  | 'invoice.paid'
  | 'invoice.payment_failed'
  | 'invoice.finalized'
  | 'ignored';

function classifyStripeEvent(type: string): StripeEventKind {
  switch (type) {
    case 'checkout.session.completed':
      return 'checkout.session.completed';
    case 'customer.subscription.updated':
      return 'customer.subscription.updated';
    case 'customer.subscription.deleted':
      return 'customer.subscription.deleted';
    case 'invoice.paid':
      return 'invoice.paid';
    case 'invoice.payment_failed':
      return 'invoice.payment_failed';
    case 'invoice.finalized':
      return 'invoice.finalized';
    default:
      return 'ignored';
  }
}

type RazorpayEventKind =
  | 'subscription.activated'
  | 'subscription.charged'
  | 'subscription.pending'
  | 'subscription.halted'
  | 'subscription.cancelled'
  | 'payment.failed'
  | 'ignored';

function classifyRazorpayEvent(type: string): RazorpayEventKind {
  switch (type) {
    case 'subscription.activated':
    case 'subscription.authenticated':
      return 'subscription.activated';
    case 'subscription.charged':
      return 'subscription.charged';
    case 'subscription.pending':
      return 'subscription.pending';
    case 'subscription.halted':
      return 'subscription.halted';
    case 'subscription.cancelled':
      return 'subscription.cancelled';
    case 'payment.failed':
      return 'payment.failed';
    default:
      return 'ignored';
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asInt(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim()) {
    const n = parseInt(value, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function unixToIso(value: unknown): string | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

function mapStripeSubStatus(raw: string | null): SubscriptionStatus {
  switch (raw) {
    case 'trialing':
      return 'trialing';
    case 'active':
      return 'active';
    case 'past_due':
      return 'past_due';
    case 'canceled':
      return 'canceled';
    case 'unpaid':
      return 'unpaid';
    case 'paused':
      return 'paused';
    case 'incomplete':
    case 'incomplete_expired':
      return 'incomplete';
    default:
      return 'incomplete';
  }
}

function mapInvoiceStatus(raw: string | null, failed: boolean): InvoiceStatus {
  if (failed) return 'uncollectible';
  switch (raw) {
    case 'draft':
      return 'draft';
    case 'open':
      return 'open';
    case 'paid':
      return 'paid';
    case 'void':
      return 'void';
    case 'uncollectible':
      return 'uncollectible';
    default:
      return 'open';
  }
}

export type ProviderLookup = {
  org_id: string;
  subscription_id: string;
  plan_key: string;
  status: string;
  seats: number;
};

export async function lookupByCustomer(
  provider: BillingProvider,
  customerId: string | null
): Promise<ProviderLookup | null> {
  if (!customerId) return null;
  const res = await pool.query<ProviderLookup>(
    `SELECT org_id, subscription_id, plan_key, status, seats
     FROM billing_lookup_by_provider_customer($1, $2)`,
    [provider, customerId]
  );
  return res.rows[0] ?? null;
}

export async function lookupBySubscription(
  provider: BillingProvider,
  subscriptionId: string | null
): Promise<ProviderLookup | null> {
  if (!subscriptionId) return null;
  const res = await pool.query<ProviderLookup>(
    `SELECT org_id, subscription_id, plan_key, status, seats
     FROM billing_lookup_by_provider_subscription($1, $2)`,
    [provider, subscriptionId]
  );
  return res.rows[0] ?? null;
}

export async function orgExists(orgId: string): Promise<boolean> {
  const res = await pool.query<{ exists: boolean }>(`SELECT billing_org_exists($1::uuid) AS exists`, [orgId]);
  return Boolean(res.rows[0]?.exists);
}

export async function claimWebhookEvent(
  provider: BillingProvider,
  eventId: string,
  eventType: string
): Promise<boolean> {
  const res = await pool.query<{ billing_claim_webhook_event: boolean }>(
    `SELECT billing_claim_webhook_event($1, $2, $3)`,
    [provider, eventId, eventType]
  );
  return Boolean(res.rows[0]?.billing_claim_webhook_event);
}

export async function finishWebhookEvent(
  provider: BillingProvider,
  eventId: string,
  orgId: string | null,
  status: WebhookEventStatus,
  error?: string
): Promise<void> {
  await pool.query(`SELECT billing_finish_webhook_event($1, $2, $3::uuid, $4, $5)`, [
    provider,
    eventId,
    orgId,
    status,
    error ?? null,
  ]);
}

async function setOrgPlan(orgId: string, plan: OrgPlanKey): Promise<void> {
  await pool.query(`SELECT billing_set_org_plan($1::uuid, $2)`, [orgId, plan]);
}

export type SubscriptionRow = {
  id: string;
  org_id: string;
  provider: BillingProvider;
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  plan_key: string;
  status: SubscriptionStatus;
  seats: number;
  current_period_start: Date | null;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
};

export type InvoiceRow = {
  id: string;
  org_id: string;
  provider: BillingProvider;
  provider_invoice_id: string | null;
  status: InvoiceStatus;
  amount_cents: number;
  currency: string;
  hosted_invoice_url: string | null;
  period_start: Date | null;
  period_end: Date | null;
  paid_at: Date | null;
  failed_at: Date | null;
  created_at: Date;
};

export async function upsertSubscription(
  client: PoolClient,
  input: {
    orgId: string;
    provider: BillingProvider;
    planKey: OrgPlanKey;
    status: SubscriptionStatus;
    seats: number;
    customerId?: string | null;
    subscriptionId?: string | null;
    periodStart?: string | null;
    periodEnd?: string | null;
    cancelAtPeriodEnd?: boolean;
  }
): Promise<SubscriptionRow> {
  const res = await client.query<SubscriptionRow>(
    `INSERT INTO billing_subscriptions (
       org_id, provider, provider_customer_id, provider_subscription_id,
       plan_key, status, seats, current_period_start, current_period_end, cancel_at_period_end
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (org_id, provider) DO UPDATE SET
       provider_customer_id = COALESCE(EXCLUDED.provider_customer_id, billing_subscriptions.provider_customer_id),
       provider_subscription_id = COALESCE(EXCLUDED.provider_subscription_id, billing_subscriptions.provider_subscription_id),
       plan_key = EXCLUDED.plan_key,
       status = EXCLUDED.status,
       seats = EXCLUDED.seats,
       current_period_start = COALESCE(EXCLUDED.current_period_start, billing_subscriptions.current_period_start),
       current_period_end = COALESCE(EXCLUDED.current_period_end, billing_subscriptions.current_period_end),
       cancel_at_period_end = EXCLUDED.cancel_at_period_end
     RETURNING id, org_id, provider, provider_customer_id, provider_subscription_id,
               plan_key, status, seats, current_period_start, current_period_end, cancel_at_period_end`,
    [
      input.orgId,
      input.provider,
      input.customerId ?? null,
      input.subscriptionId ?? null,
      input.planKey,
      input.status,
      Math.max(1, input.seats),
      input.periodStart ?? null,
      input.periodEnd ?? null,
      input.cancelAtPeriodEnd ?? false,
    ]
  );
  const row = res.rows[0];
  if (input.status === 'canceled' || input.status === 'unpaid') {
    await setOrgPlan(input.orgId, 'free');
  } else if (input.status === 'active' || input.status === 'trialing') {
    if (input.planKey !== 'free') {
      await setOrgPlan(input.orgId, input.planKey);
    }
  }
  return row;
}

export async function upsertInvoice(
  client: PoolClient,
  input: {
    orgId: string;
    provider: BillingProvider;
    subscriptionId?: string | null;
    providerInvoiceId: string;
    status: InvoiceStatus;
    amountCents: number;
    currency: string;
    hostedUrl?: string | null;
    periodStart?: string | null;
    periodEnd?: string | null;
    paidAt?: string | null;
    failedAt?: string | null;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO billing_invoices (
       org_id, subscription_id, provider, provider_invoice_id, status,
       amount_cents, currency, hosted_invoice_url, period_start, period_end, paid_at, failed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (provider, provider_invoice_id)
     DO UPDATE SET
       status = EXCLUDED.status,
       amount_cents = EXCLUDED.amount_cents,
       currency = EXCLUDED.currency,
       hosted_invoice_url = COALESCE(EXCLUDED.hosted_invoice_url, billing_invoices.hosted_invoice_url),
       paid_at = COALESCE(EXCLUDED.paid_at, billing_invoices.paid_at),
       failed_at = COALESCE(EXCLUDED.failed_at, billing_invoices.failed_at)
     WHERE billing_invoices.org_id = EXCLUDED.org_id`,
    [
      input.orgId,
      input.subscriptionId ?? null,
      input.provider,
      input.providerInvoiceId,
      input.status,
      input.amountCents,
      input.currency,
      input.hostedUrl ?? null,
      input.periodStart ?? null,
      input.periodEnd ?? null,
      input.paidAt ?? null,
      input.failedAt ?? null,
    ]
  );
}

async function upsertMeter(
  client: PoolClient,
  input: {
    orgId: string;
    periodStart: string;
    periodEnd: string;
    kind: MeterKind;
    quantity: number;
    unit: string;
    soft: number | null;
    hard: number | null;
    source: 'langfuse' | 'conversations' | 'users' | 'env';
    truncated: boolean;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO billing_meters (
       org_id, period_start, period_end, meter_kind, quantity, unit,
       soft_limit, hard_limit, source, truncated, updated_at
     ) VALUES ($1, $2::date, $3::date, $4, $5, $6, $7, $8, $9, $10, NOW())
     ON CONFLICT (org_id, period_start, meter_kind) DO UPDATE SET
       period_end = EXCLUDED.period_end,
       quantity = EXCLUDED.quantity,
       unit = EXCLUDED.unit,
       soft_limit = EXCLUDED.soft_limit,
       hard_limit = EXCLUDED.hard_limit,
       source = EXCLUDED.source,
       truncated = EXCLUDED.truncated,
       updated_at = NOW()`,
    [
      input.orgId,
      input.periodStart,
      input.periodEnd,
      input.kind,
      input.quantity,
      input.unit,
      input.soft,
      input.hard,
      input.source,
      input.truncated,
    ]
  );
}

export type MeterSnapshot = {
  kind: MeterKind;
  quantity: number;
  unit: string;
  softLimit: number | null;
  hardLimit: number | null;
  overSoft: boolean;
  overHard: boolean;
  source: string;
  truncated: boolean;
  periodStart: string;
  periodEnd: string;
};

function overFlags(quantity: number, soft: number | null, hard: number | null): {
  overSoft: boolean;
  overHard: boolean;
} {
  return {
    overSoft: soft != null && quantity >= soft,
    overHard: hard != null && quantity >= hard,
  };
}

export type MeterRefresh = {
  meters: MeterSnapshot[];
  llm: OrgWeeklyCost | null;
  llmError: string | null;
  confirmReject: ConfirmRejectDrift | null;
  whatsappConversations: number;
  seatsUsed: number;
  usageBlocked: boolean;
};

export async function refreshOrgMeters(orgId: string): Promise<MeterRefresh> {
  const caps = meterCaps();
  const from = new Date(Date.now() - WEEK_DAYS * 24 * 60 * 60 * 1000);
  const periodStart = from.toISOString().slice(0, 10);
  const periodEnd = new Date().toISOString().slice(0, 10);

  let confirmReject: ConfirmRejectDrift | null = null;
  let whatsappConversations = 0;
  let seatsUsed = 0;

  const scoped = await getOrgScopedClient(orgId);
  try {
    confirmReject = await queryConfirmRejectDrift(scoped.client, orgId, from);
    const wa = await scoped.client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM conversations c
       LEFT JOIN channels ch ON ch.id = c.channel_id AND ch.org_id = c.org_id
       WHERE c.org_id = $1
         AND c.started_at >= $2
         AND (
           ch.channel_type = 'whatsapp'
           OR (ch.channel_type IS NULL AND COALESCE(c.metadata->>'channel', '') = 'whatsapp')
         )`,
      [orgId, from.toISOString()]
    );
    whatsappConversations = parseInt(wa.rows[0]?.count || '0', 10) || 0;
    const seats = await scoped.client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM users WHERE org_id = $1`,
      [orgId]
    );
    seatsUsed = parseInt(seats.rows[0]?.count || '0', 10) || 0;
  } finally {
    scoped.client.release();
  }

  let llm: OrgWeeklyCost | null = null;
  let llmError: string | null = null;
  try {
    llm = await fetchOrgWeeklyCost(orgId);
  } catch (err) {
    if (err instanceof LangfuseUnavailableError || err instanceof LangfuseConfigError) {
      llmError = err.message;
    } else {
      throw err;
    }
  }

  const write = await getOrgScopedClient(orgId);
  try {
    await upsertMeter(write.client, {
      orgId,
      periodStart,
      periodEnd,
      kind: 'whatsapp_conversations',
      quantity: whatsappConversations,
      unit: 'conversations',
      soft: caps.whatsappSoft,
      hard: caps.whatsappHard,
      source: 'conversations',
      truncated: false,
    });
    await upsertMeter(write.client, {
      orgId,
      periodStart,
      periodEnd,
      kind: 'seats',
      quantity: seatsUsed,
      unit: 'seats',
      soft: caps.seatSoft,
      hard: caps.seatHard,
      source: 'users',
      truncated: false,
    });
    if (llm) {
      await upsertMeter(write.client, {
        orgId,
        periodStart: llm.period.from.slice(0, 10),
        periodEnd: llm.period.to.slice(0, 10),
        kind: 'llm_tokens',
        quantity: llm.weeklyCostUsd,
        unit: 'usd',
        soft: caps.llmSoftUsd,
        hard: caps.llmHardUsd,
        source: 'langfuse',
        truncated: llm.truncated,
      });
      await upsertMeter(write.client, {
        orgId,
        periodStart: llm.period.from.slice(0, 10),
        periodEnd: llm.period.to.slice(0, 10),
        kind: 'successful_actions',
        quantity: llm.successfulActions,
        unit: 'actions',
        soft: null,
        hard: null,
        source: 'langfuse',
        truncated: llm.truncated,
      });
      await upsertMeter(write.client, {
        orgId,
        periodStart: llm.period.from.slice(0, 10),
        periodEnd: llm.period.to.slice(0, 10),
        kind: 'disconnected_actions',
        quantity: llm.disconnectedActions,
        unit: 'actions',
        soft: null,
        hard: null,
        source: 'langfuse',
        truncated: llm.truncated,
      });
    }
  } finally {
    write.client.release();
  }

  const llmFlags = llm
    ? overFlags(llm.weeklyCostUsd, caps.llmSoftUsd, caps.llmHardUsd)
    : { overSoft: false, overHard: false };
  const waMeterFlags = overFlags(whatsappConversations, caps.whatsappSoft, caps.whatsappHard);
  const seatFlags = overFlags(seatsUsed, caps.seatSoft, caps.seatHard);

  const meters: MeterSnapshot[] = [
    {
      kind: 'whatsapp_conversations',
      quantity: whatsappConversations,
      unit: 'conversations',
      softLimit: caps.whatsappSoft,
      hardLimit: caps.whatsappHard,
      ...waMeterFlags,
      source: 'conversations',
      truncated: false,
      periodStart,
      periodEnd,
    },
    {
      kind: 'seats',
      quantity: seatsUsed,
      unit: 'seats',
      softLimit: caps.seatSoft,
      hardLimit: caps.seatHard,
      ...seatFlags,
      source: 'users',
      truncated: false,
      periodStart,
      periodEnd,
    },
  ];
  if (llm) {
    meters.unshift({
      kind: 'llm_tokens',
      quantity: llm.weeklyCostUsd,
      unit: 'usd',
      softLimit: caps.llmSoftUsd,
      hardLimit: caps.llmHardUsd,
      ...llmFlags,
      source: 'langfuse',
      truncated: llm.truncated,
      periodStart: llm.period.from.slice(0, 10),
      periodEnd: llm.period.to.slice(0, 10),
    });
    meters.push({
      kind: 'successful_actions',
      quantity: llm.successfulActions,
      unit: 'actions',
      softLimit: null,
      hardLimit: null,
      overSoft: false,
      overHard: false,
      source: 'langfuse',
      truncated: llm.truncated,
      periodStart: llm.period.from.slice(0, 10),
      periodEnd: llm.period.to.slice(0, 10),
    });
    meters.push({
      kind: 'disconnected_actions',
      quantity: llm.disconnectedActions,
      unit: 'actions',
      softLimit: null,
      hardLimit: null,
      overSoft: false,
      overHard: false,
      source: 'langfuse',
      truncated: llm.truncated,
      periodStart: llm.period.from.slice(0, 10),
      periodEnd: llm.period.to.slice(0, 10),
    });
  }

  return {
    meters,
    llm,
    llmError,
    confirmReject,
    whatsappConversations,
    seatsUsed,
    usageBlocked: llmFlags.overHard || waMeterFlags.overHard,
  };
}

export async function listInvoices(client: PoolClient, orgId: string): Promise<InvoiceRow[]> {
  const res = await client.query<InvoiceRow>(
    `SELECT id, org_id, provider, provider_invoice_id, status, amount_cents, currency,
            hosted_invoice_url, period_start, period_end, paid_at, failed_at, created_at
     FROM billing_invoices
     WHERE org_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [orgId]
  );
  return res.rows;
}

export async function listSubscriptions(client: PoolClient, orgId: string): Promise<SubscriptionRow[]> {
  const res = await client.query<SubscriptionRow>(
    `SELECT id, org_id, provider, provider_customer_id, provider_subscription_id,
            plan_key, status, seats, current_period_start, current_period_end, cancel_at_period_end
     FROM billing_subscriptions
     WHERE org_id = $1
     ORDER BY updated_at DESC`,
    [orgId]
  );
  return res.rows;
}

export async function loadOrgPlan(client: PoolClient, orgId: string): Promise<OrgPlanKey> {
  const res = await client.query<{ plan: string }>(`SELECT plan FROM orgs WHERE id = $1`, [orgId]);
  return parseOrgPlanKey(res.rows[0]?.plan);
}

export async function createStripeCheckout(opts: {
  orgId: string;
  plan: CheckoutPlanKey;
  seats: number;
  customerId: string | null;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ url: string; customerId: string | null; sessionId: string }> {
  const priceId = stripePriceId(opts.plan);
  if (!priceId) {
    throw new BillingConfigError(`DAREX_STRIPE_PRICE_${opts.plan.toUpperCase()} is not configured`);
  }
  let customerId = opts.customerId;
  if (!customerId) {
    const created = await stripePost('/customers', {
      'metadata[darex_org_id]': opts.orgId,
    });
    if (created.status >= 400) {
      throw new BillingConfigError(
        `Stripe customer create failed: ${created.status} ${JSON.stringify(created.json).slice(0, 200)}`
      );
    }
    customerId = asString(created.json.id);
  }
  const fields: Record<string, string> = {
    mode: 'subscription',
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    client_reference_id: opts.orgId,
    'metadata[darex_org_id]': opts.orgId,
    'metadata[darex_plan]': opts.plan,
    'subscription_data[metadata][darex_org_id]': opts.orgId,
    'subscription_data[metadata][darex_plan]': opts.plan,
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': String(Math.max(1, opts.seats)),
  };
  if (customerId) fields.customer = customerId;
  const addon = stripeAddonSeatPriceId();
  if (addon && opts.seats > 1) {
    fields['line_items[1][price]'] = addon;
    fields['line_items[1][quantity]'] = String(opts.seats - 1);
    fields['line_items[0][quantity]'] = '1';
  }
  const session = await stripePost('/checkout/sessions', fields);
  if (session.status >= 400 || !asString(session.json.url)) {
    throw new BillingConfigError(
      `Stripe checkout failed: ${session.status} ${JSON.stringify(session.json).slice(0, 200)}`
    );
  }
  return {
    url: asString(session.json.url) as string,
    customerId,
    sessionId: asString(session.json.id) || '',
  };
}

export async function createStripePortal(opts: {
  customerId: string;
  returnUrl: string;
}): Promise<{ url: string }> {
  const portal = await stripePost('/billing_portal/sessions', {
    customer: opts.customerId,
    return_url: opts.returnUrl,
  });
  if (portal.status >= 400 || !asString(portal.json.url)) {
    throw new BillingConfigError(
      `Stripe portal failed: ${portal.status} ${JSON.stringify(portal.json).slice(0, 200)}`
    );
  }
  return { url: asString(portal.json.url) as string };
}

export async function createRazorpaySubscription(opts: {
  orgId: string;
  plan: CheckoutPlanKey;
  seats: number;
  customerId: string | null;
  email?: string;
}): Promise<{ shortUrl: string; customerId: string | null; subscriptionId: string }> {
  const planId = razorpayPlanId(opts.plan);
  if (!planId) {
    throw new BillingConfigError(`DAREX_RAZORPAY_PLAN_${opts.plan.toUpperCase()} is not configured`);
  }
  let customerId = opts.customerId;
  if (!customerId) {
    const created = await razorpayRequest('POST', '/customers', {
      fail_existing: 0,
      notes: { darex_org_id: opts.orgId },
      email: opts.email,
    });
    if (created.status >= 400) {
      throw new BillingConfigError(
        `Razorpay customer create failed: ${created.status} ${JSON.stringify(created.json).slice(0, 200)}`
      );
    }
    customerId = asString(created.json.id);
  }
  const created = await razorpayRequest('POST', '/subscriptions', {
    plan_id: planId,
    total_count: 120,
    quantity: Math.max(1, opts.seats),
    customer_id: customerId,
    customer_notify: 1,
    notes: { darex_org_id: opts.orgId, darex_plan: opts.plan },
  });
  if (created.status >= 400) {
    throw new BillingConfigError(
      `Razorpay subscription failed: ${created.status} ${JSON.stringify(created.json).slice(0, 200)}`
    );
  }
  const shortUrl = asString(created.json.short_url);
  const subscriptionId = asString(created.json.id);
  if (!shortUrl || !subscriptionId) {
    throw new BillingConfigError('Razorpay subscription response missing short_url');
  }
  return { shortUrl, customerId, subscriptionId };
}

async function resolveWebhookOrg(opts: {
  provider: BillingProvider;
  customerId: string | null;
  subscriptionId: string | null;
  metadataOrgId: string | null;
}): Promise<string | null> {
  const bySub = await lookupBySubscription(opts.provider, opts.subscriptionId);
  if (bySub) return bySub.org_id;
  const byCust = await lookupByCustomer(opts.provider, opts.customerId);
  if (byCust) return byCust.org_id;
  if (opts.metadataOrgId && isUuid(opts.metadataOrgId) && (await orgExists(opts.metadataOrgId))) {
    return opts.metadataOrgId;
  }
  return null;
}

function expandStripe(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = obj[key];
  if (typeof value === 'string') return { id: value };
  return asRecord(value);
}

export async function processStripeEvent(raw: Record<string, unknown>): Promise<{
  orgId: string | null;
  status: WebhookEventStatus;
}> {
  const kind = classifyStripeEvent(asString(raw.type) || '');
  const data = asRecord(asRecord(raw.data).object);
  switch (kind) {
    case 'ignored':
      return { orgId: null, status: 'ignored' };
    case 'checkout.session.completed': {
      const customerId = asString(data.customer);
      const subscriptionId = asString(data.subscription);
      const metadata = asRecord(data.metadata);
      const orgId = await resolveWebhookOrg({
        provider: 'stripe',
        customerId,
        subscriptionId,
        metadataOrgId: asString(metadata.darex_org_id) || asString(data.client_reference_id),
      });
      if (!orgId) return { orgId: null, status: 'ignored' };
      const existing =
        (await lookupBySubscription('stripe', subscriptionId)) ||
        (await lookupByCustomer('stripe', customerId));
      const scoped = await getOrgScopedClient(orgId);
      try {
        await upsertSubscription(scoped.client, {
          orgId,
          provider: 'stripe',
          planKey: parseOrgPlanKey(
            asString(metadata.darex_plan) || asString(metadata.plan) || existing?.plan_key || 'starter'
          ),
          status: 'active',
          seats: asInt(data.quantity, existing?.seats ?? 1),
          customerId,
          subscriptionId,
        });
      } finally {
        scoped.client.release();
      }
      return { orgId, status: 'processed' };
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const customerId = asString(data.customer);
      const subscriptionId = asString(data.id);
      const metadata = asRecord(data.metadata);
      const items = asRecord(data.items);
      const itemData = Array.isArray(items.data) ? items.data : [];
      const firstItem = asRecord(itemData[0]);
      const orgId = await resolveWebhookOrg({
        provider: 'stripe',
        customerId,
        subscriptionId,
        metadataOrgId: asString(metadata.darex_org_id),
      });
      if (!orgId) return { orgId: null, status: 'ignored' };
      const status =
        kind === 'customer.subscription.deleted' ? 'canceled' : mapStripeSubStatus(asString(data.status));
      const planKey = parseOrgPlanKey(asString(metadata.plan) || asString(metadata.darex_plan) || 'starter');
      const scoped = await getOrgScopedClient(orgId);
      try {
        await upsertSubscription(scoped.client, {
          orgId,
          provider: 'stripe',
          planKey,
          status,
          seats: asInt(firstItem.quantity, asInt(data.quantity, 1)),
          customerId,
          subscriptionId,
          periodStart: unixToIso(data.current_period_start),
          periodEnd: unixToIso(data.current_period_end),
          cancelAtPeriodEnd: data.cancel_at_period_end === true,
        });
      } finally {
        scoped.client.release();
      }
      return { orgId, status: 'processed' };
    }
    case 'invoice.paid':
    case 'invoice.payment_failed':
    case 'invoice.finalized': {
      const customerId = asString(data.customer);
      const sub = expandStripe(data, 'subscription');
      const subscriptionId = asString(sub.id);
      const metadata = asRecord(data.metadata);
      const orgId = await resolveWebhookOrg({
        provider: 'stripe',
        customerId,
        subscriptionId,
        metadataOrgId: asString(metadata.darex_org_id),
      });
      if (!orgId) return { orgId: null, status: 'ignored' };
      const failed = kind === 'invoice.payment_failed';
      const invoiceId = asString(data.id);
      if (!invoiceId) return { orgId, status: 'ignored' };
      const existing = await lookupBySubscription('stripe', subscriptionId);
      const scoped = await getOrgScopedClient(orgId);
      try {
        await upsertInvoice(scoped.client, {
          orgId,
          provider: 'stripe',
          subscriptionId: existing?.subscription_id ?? null,
          providerInvoiceId: invoiceId,
          status: mapInvoiceStatus(asString(data.status), failed),
          amountCents: asInt(data.amount_paid, asInt(data.amount_due)),
          currency: (asString(data.currency) || 'usd').toLowerCase(),
          hostedUrl: asString(data.hosted_invoice_url),
          periodStart: unixToIso(asRecord(data.lines).period_start) || unixToIso(data.period_start),
          periodEnd: unixToIso(data.period_end),
          paidAt: failed ? null : unixToIso(data.status_transitions ? asRecord(data.status_transitions).paid_at : data.created),
          failedAt: failed ? new Date().toISOString() : null,
        });
        if (failed) {
          await upsertSubscription(scoped.client, {
            orgId,
            provider: 'stripe',
            planKey: parseOrgPlanKey(existing?.plan_key || 'starter'),
            status: 'past_due',
            seats: existing?.seats || 1,
            customerId,
            subscriptionId,
          });
        }
      } finally {
        scoped.client.release();
      }
      return { orgId, status: 'processed' };
    }
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      return { orgId: null, status: 'ignored' };
    }
  }
}

export async function processRazorpayEvent(raw: Record<string, unknown>): Promise<{
  orgId: string | null;
  status: WebhookEventStatus;
}> {
  const kind = classifyRazorpayEvent(asString(raw.event) || '');
  const payload = asRecord(raw.payload);
  const subEntity = asRecord(asRecord(payload.subscription).entity);
  const paymentEntity = asRecord(asRecord(payload.payment).entity);
  const invoiceEntity = asRecord(asRecord(payload.invoice).entity);
  switch (kind) {
    case 'ignored':
      return { orgId: null, status: 'ignored' };
    case 'subscription.activated':
    case 'subscription.charged':
    case 'subscription.pending':
    case 'subscription.halted':
    case 'subscription.cancelled': {
      const notes = asRecord(subEntity.notes);
      const orgId = await resolveWebhookOrg({
        provider: 'razorpay',
        customerId: asString(subEntity.customer_id),
        subscriptionId: asString(subEntity.id),
        metadataOrgId: asString(notes.darex_org_id),
      });
      if (!orgId) return { orgId: null, status: 'ignored' };
      let status: SubscriptionStatus = 'active';
      switch (kind) {
        case 'subscription.activated':
        case 'subscription.charged':
          status = 'active';
          break;
        case 'subscription.pending':
          status = 'past_due';
          break;
        case 'subscription.halted':
          status = 'unpaid';
          break;
        case 'subscription.cancelled':
          status = 'canceled';
          break;
        default: {
          const _exhaustive: never = kind;
          void _exhaustive;
          status = 'incomplete';
        }
      }
      const scoped = await getOrgScopedClient(orgId);
      try {
        await upsertSubscription(scoped.client, {
          orgId,
          provider: 'razorpay',
          planKey: parseOrgPlanKey(asString(notes.darex_plan) || 'starter'),
          status,
          seats: asInt(subEntity.quantity, 1),
          customerId: asString(subEntity.customer_id),
          subscriptionId: asString(subEntity.id),
          periodStart: unixToIso(subEntity.current_start),
          periodEnd: unixToIso(subEntity.current_end),
        });
        const invoiceId = asString(invoiceEntity.id) || asString(paymentEntity.invoice_id);
        if (invoiceId && (kind === 'subscription.charged' || kind === 'subscription.pending')) {
          await upsertInvoice(scoped.client, {
            orgId,
            provider: 'razorpay',
            providerInvoiceId: invoiceId,
            status: kind === 'subscription.charged' ? 'paid' : 'uncollectible',
            amountCents: asInt(paymentEntity.amount, asInt(invoiceEntity.amount)),
            currency: (asString(paymentEntity.currency) || asString(invoiceEntity.currency) || 'inr').toLowerCase(),
            hostedUrl: asString(invoiceEntity.short_url),
            paidAt: kind === 'subscription.charged' ? new Date().toISOString() : null,
            failedAt: kind === 'subscription.pending' ? new Date().toISOString() : null,
          });
        }
      } finally {
        scoped.client.release();
      }
      return { orgId, status: 'processed' };
    }
    case 'payment.failed': {
      const notes = asRecord(paymentEntity.notes);
      const orgId = await resolveWebhookOrg({
        provider: 'razorpay',
        customerId: asString(paymentEntity.customer_id),
        subscriptionId: asString(paymentEntity.subscription_id),
        metadataOrgId: asString(notes.darex_org_id),
      });
      if (!orgId) return { orgId: null, status: 'ignored' };
      const invoiceId = asString(paymentEntity.invoice_id) || asString(paymentEntity.id);
      if (!invoiceId) return { orgId, status: 'ignored' };
      const existing = await lookupBySubscription('razorpay', asString(paymentEntity.subscription_id));
      const scoped = await getOrgScopedClient(orgId);
      try {
        await upsertInvoice(scoped.client, {
          orgId,
          provider: 'razorpay',
          subscriptionId: existing?.subscription_id ?? null,
          providerInvoiceId: invoiceId,
          status: 'uncollectible',
          amountCents: asInt(paymentEntity.amount),
          currency: (asString(paymentEntity.currency) || 'inr').toLowerCase(),
          failedAt: new Date().toISOString(),
        });
        await upsertSubscription(scoped.client, {
          orgId,
          provider: 'razorpay',
          planKey: parseOrgPlanKey(existing?.plan_key || 'starter'),
          status: 'past_due',
          seats: existing?.seats || 1,
          customerId: asString(paymentEntity.customer_id),
          subscriptionId: asString(paymentEntity.subscription_id),
        });
      } finally {
        scoped.client.release();
      }
      return { orgId, status: 'processed' };
    }
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      return { orgId: null, status: 'ignored' };
    }
  }
}
