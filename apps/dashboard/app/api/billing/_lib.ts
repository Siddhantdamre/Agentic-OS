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
import { summarizeStripeItems, type StripePriceConfig } from './_stripe-items';
import { resolveOrgPlan, type PlanRow } from './_plan-resolve';
import type { PoolClient } from 'pg';
import { recordAuditEvent } from '@/lib/audit-events';
import {
  fetchOrgWeeklyCost,
  LangfuseUnavailableError,
  queryConfirmRejectDrift,
  WEEK_DAYS,
  type ConfirmRejectDrift,
  type OrgWeeklyCost,
} from '@/lib/org-cost';
import { LangfuseConfigError } from '@/lib/langfuse-trace';
import { realtimeHub } from '@/lib/realtime-hub';
import { isProductionEnv } from '@/lib/boot-guards';
import { getOrgScopedClient, pool } from '@/lib/db';
import { loadHumanRole, type HumanRole } from '@/lib/rbac';
import {
  BILLING_PLAN_TYPES,
  BILLING_PROVIDERS,
  type BillingPlanType,
  type BillingProvider,
} from '@darex/shared-types';

export type { BillingProvider, BillingPlanType };

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
    case 'billing':
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
    return {
      error: 'Only owners, admins, and billing can change Darex billing',
      status: 403,
    };
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

/** Every configured Stripe plan price id → plan key, for webhook item resolution. */
export function stripePriceConfig(): StripePriceConfig {
  const planByPriceId: Record<string, string> = {};
  for (const plan of BILLING_PLAN_TYPES) {
    const id = stripePriceId(plan);
    if (id) planByPriceId[id] = plan;
  }
  return { planByPriceId, addonSeatPriceId: stripeAddonSeatPriceId() ?? null };
}

/** Reads a subscription's items from Stripe; null when unavailable (no key, 4xx, network). */
async function fetchStripeSubscriptionItems(subscriptionId: string | null): Promise<unknown | null> {
  if (!subscriptionId || !stripeSecretKey()) return null;
  try {
    const res = await stripeGet(`/subscriptions/${encodeURIComponent(subscriptionId)}`);
    if (res.status >= 400) {
      console.error(`[billing] Stripe subscription fetch ${subscriptionId} failed: ${res.status}`);
      return null;
    }
    return res.json.items ?? null;
  } catch (err) {
    console.error(`[billing] Stripe subscription fetch ${subscriptionId} failed:`, err);
    return null;
  }
}

/** Razorpay plan_id → Darex plan key; null when the id is not a configured plan. */
export function razorpayPlanKeyFromPlanId(planId: string | null): CheckoutPlanKey | null {
  if (!planId) return null;
  for (const plan of BILLING_PLAN_TYPES) {
    if (razorpayPlanId(plan) === planId) return plan;
  }
  return null;
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

type MeterCapPair = { soft: number | null; hard: number | null };

type OrgPlanOverrideCaps = {
  seatCap: number | null;
  meterCaps: Record<string, MeterCapPair>;
};

function isUndefinedRelation(err: unknown): boolean {
  return (err as { code?: string })?.code === '42P01';
}

function parseOverrideCapPair(raw: unknown): MeterCapPair | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const softRaw = (raw as { soft?: unknown }).soft;
  const hardRaw = (raw as { hard?: unknown }).hard;
  const soft =
    softRaw == null || softRaw === ''
      ? null
      : Number.isFinite(Number(softRaw))
        ? Number(softRaw)
        : null;
  const hard =
    hardRaw == null || hardRaw === ''
      ? null
      : Number.isFinite(Number(hardRaw))
        ? Number(hardRaw)
        : null;
  return { soft, hard };
}

/**
 * Tenant-readable org_plan_overrides (migration 120). Missing table → null.
 * Never invents usage; only returns stored soft/hard / seat_cap.
 */
async function loadOrgPlanOverrideCaps(
  client: PoolClient,
  orgId: string
): Promise<OrgPlanOverrideCaps | null> {
  try {
    const res = await client.query<{ seat_cap: number | null; meter_caps: unknown }>(
      `SELECT seat_cap, meter_caps
         FROM org_plan_overrides
        WHERE org_id = $1`,
      [orgId]
    );
    const row = res.rows[0];
    if (!row) return null;
    const meterCaps: Record<string, MeterCapPair> = {};
    if (row.meter_caps && typeof row.meter_caps === 'object' && !Array.isArray(row.meter_caps)) {
      for (const [kind, value] of Object.entries(row.meter_caps as Record<string, unknown>)) {
        const parsed = parseOverrideCapPair(value);
        if (parsed) meterCaps[kind] = parsed;
      }
    }
    const seatCap =
      row.seat_cap == null
        ? null
        : Number.isFinite(Number(row.seat_cap)) && Number(row.seat_cap) >= 1
          ? Math.floor(Number(row.seat_cap))
          : null;
    return { seatCap, meterCaps };
  } catch (err) {
    if (isUndefinedRelation(err)) return null;
    throw err;
  }
}

/** Env soft/hard for a meter kind, overridden by org_plan_overrides.meter_caps when set. */
function resolveMeterSoftHard(
  kind: MeterKind | 'llm_tokens' | 'whatsapp_conversations' | 'seats',
  envSoft: number,
  envHard: number,
  override: OrgPlanOverrideCaps | null
): { soft: number; hard: number } {
  const cap = override?.meterCaps?.[kind];
  const soft =
    cap?.soft != null && Number.isFinite(cap.soft) ? Number(cap.soft) : envSoft;
  const hard =
    cap?.hard != null && Number.isFinite(cap.hard) ? Number(cap.hard) : envHard;
  return { soft, hard };
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

export function assertPortalReady(provider?: BillingProvider): void {
  if (!provider || provider === 'stripe') {
    if (stripeSecretKey()) return;
    if (provider === 'stripe') {
      const mode = isProductionEnv() ? 'production fail-fast' : 'dev';
      throw new BillingConfigError(
        `Darex Stripe billing is not configured (${mode}). Missing: DAREX_STRIPE_SECRET_KEY. See .env.example.`
      );
    }
  }
  if (!provider || provider === 'razorpay') {
    if (razorpayKeyId() && razorpayKeySecret()) return;
    if (provider === 'razorpay') {
      const mode = isProductionEnv() ? 'production fail-fast' : 'dev';
      throw new BillingConfigError(
        `Darex Razorpay billing is not configured (${mode}). Missing: DAREX_RAZORPAY_KEY_ID / DAREX_RAZORPAY_KEY_SECRET. See .env.example.`
      );
    }
  }
  if (stripeSecretKey() || (razorpayKeyId() && razorpayKeySecret())) return;
  const mode = isProductionEnv() ? 'production fail-fast' : 'dev';
  throw new BillingConfigError(
    `Darex billing portal is not configured (${mode}). Configure Stripe and/or Razorpay. See .env.example.`
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

async function stripeGet(path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const secret = stripeSecretKey();
  if (!secret) throw new BillingConfigError('DAREX_STRIPE_SECRET_KEY is not configured');
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${secret}`,
    },
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

async function razorpayRequest(
  method: 'GET' | 'POST' | 'PATCH',
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

/**
 * Drop an in-flight webhook claim so the PSP can retry after a 5xx.
 * Only removes rows still in 'received' (never delete processed/ignored).
 */
export async function releaseWebhookClaim(
  provider: BillingProvider,
  eventId: string
): Promise<void> {
  await pool.query(
    `DELETE FROM billing_webhook_events
     WHERE provider = $1 AND provider_event_id = $2 AND status = 'received'`,
    [provider, eventId]
  );
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
  dunning_grace_ends_at?: Date | null;
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
       -- Checkout visits write status='incomplete'. Never demote an active/trialing
       -- paid row (or its plan/seats) just because someone opened checkout again.
       plan_key = CASE
         WHEN billing_subscriptions.status IN ('active', 'trialing')
              AND EXCLUDED.status = 'incomplete'
           THEN billing_subscriptions.plan_key
         ELSE EXCLUDED.plan_key
       END,
       status = CASE
         WHEN billing_subscriptions.status IN ('active', 'trialing')
              AND EXCLUDED.status = 'incomplete'
           THEN billing_subscriptions.status
         ELSE EXCLUDED.status
       END,
       seats = CASE
         WHEN billing_subscriptions.status IN ('active', 'trialing')
              AND EXCLUDED.status = 'incomplete'
           THEN billing_subscriptions.seats
         ELSE EXCLUDED.seats
       END,
       current_period_start = COALESCE(EXCLUDED.current_period_start, billing_subscriptions.current_period_start),
       current_period_end = COALESCE(EXCLUDED.current_period_end, billing_subscriptions.current_period_end),
       cancel_at_period_end = CASE
         WHEN billing_subscriptions.status IN ('active', 'trialing')
              AND EXCLUDED.status = 'incomplete'
           THEN billing_subscriptions.cancel_at_period_end
         ELSE EXCLUDED.cancel_at_period_end
       END
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
  // Derive the plan from every provider row, not just the one that changed:
  // cancelling Razorpay must not drop an org with a live Stripe sub to free.
  const all = await client.query<PlanRow>(
    `SELECT provider, plan_key, status FROM billing_subscriptions WHERE org_id = $1`,
    [input.orgId]
  );
  const rows = all.rows.length > 0 ? all.rows : [row];
  const next = resolveOrgPlan(rows);
  if (next.action === 'set' && isOrgPlanKey(next.plan)) {
    await setOrgPlan(input.orgId, next.plan);
  }
  // Webhook or user-driven change: refresh any open billing tab.
  realtimeHub.publish(input.orgId, { type: 'billing_updated', message: 'subscription' });
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
  realtimeHub.publish(input.orgId, { type: 'billing_updated', message: 'invoice' });
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
    source: 'langfuse' | 'conversations' | 'users' | 'env' | 'model_spend';
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
       -- llm_tokens is also written by the worker from org_model_spend; keep
       -- the larger reading so a partial Langfuse window cannot lower it.
       quantity = CASE WHEN EXCLUDED.meter_kind = 'llm_tokens'
                       THEN GREATEST(billing_meters.quantity, EXCLUDED.quantity)
                       ELSE EXCLUDED.quantity END,
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

/**
 * Aggregates actual model spend from Postgres `org_model_spend` (RT-G01).
 * Always reflects every in-process, worker, sweep, and sidecar turn recorded by `recordModelSpend`.
 */
export async function getOrgModelSpend(
  client: PoolClient,
  orgId: string,
  fromDate?: Date | string
): Promise<{ spendCents: number; spendUsd: number; modelCalls: number }> {
  const from = fromDate instanceof Date ? fromDate.toISOString().slice(0, 10) : fromDate;
  const res = await client.query<{ total_cents: string; total_calls: string }>(
    `SELECT COALESCE(SUM(spend_cents), 0)::text AS total_cents,
            COALESCE(SUM(model_calls), 0)::text AS total_calls
       FROM org_model_spend
      WHERE org_id = $1 ${from ? 'AND spend_date >= $2' : ''}`,
    from ? [orgId, from] : [orgId]
  );
  const spendCents = parseInt(res.rows[0]?.total_cents || '0', 10) || 0;
  const modelCalls = parseInt(res.rows[0]?.total_calls || '0', 10) || 0;
  return {
    spendCents,
    spendUsd: spendCents / 100,
    modelCalls,
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
  let override: OrgPlanOverrideCaps | null = null;

  const scoped = await getOrgScopedClient(orgId);
  try {
    override = await loadOrgPlanOverrideCaps(scoped.client, orgId);
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

  const waCaps = resolveMeterSoftHard(
    'whatsapp_conversations',
    caps.whatsappSoft,
    caps.whatsappHard,
    override
  );
  const seatCaps = resolveMeterSoftHard('seats', caps.seatSoft, caps.seatHard, override);
  const llmCaps = resolveMeterSoftHard('llm_tokens', caps.llmSoftUsd, caps.llmHardUsd, override);

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

  let totalLlmCostUsd = 0;
  let llmSource: 'langfuse' | 'model_spend' = 'model_spend';

  const write = await getOrgScopedClient(orgId);
  try {
    const modelSpend = await getOrgModelSpend(write.client, orgId, periodStart);
    totalLlmCostUsd = Math.max(llm?.weeklyCostUsd ?? 0, modelSpend.spendUsd);
    llmSource = modelSpend.spendUsd > (llm?.weeklyCostUsd ?? 0) ? 'model_spend' : (llm ? 'langfuse' : 'model_spend');

    await upsertMeter(write.client, {
      orgId,
      periodStart,
      periodEnd,
      kind: 'whatsapp_conversations',
      quantity: whatsappConversations,
      unit: 'conversations',
      soft: waCaps.soft,
      hard: waCaps.hard,
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
      soft: seatCaps.soft,
      hard: seatCaps.hard,
      source: 'users',
      truncated: false,
    });
    await upsertMeter(write.client, {
      orgId,
      periodStart: llm?.period.from.slice(0, 10) || periodStart,
      periodEnd: llm?.period.to.slice(0, 10) || periodEnd,
      kind: 'llm_tokens',
      quantity: totalLlmCostUsd,
      unit: 'usd',
      soft: llmCaps.soft,
      hard: llmCaps.hard,
      source: llmSource,
      truncated: llm?.truncated ?? false,
    });
    if (llm) {
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

  const llmFlags = overFlags(totalLlmCostUsd, llmCaps.soft, llmCaps.hard);
  const waMeterFlags = overFlags(whatsappConversations, waCaps.soft, waCaps.hard);
  const seatFlags = overFlags(seatsUsed, seatCaps.soft, seatCaps.hard);

  const meters: MeterSnapshot[] = [
    {
      kind: 'llm_tokens',
      quantity: totalLlmCostUsd,
      unit: 'usd',
      softLimit: llmCaps.soft,
      hardLimit: llmCaps.hard,
      ...llmFlags,
      source: llmSource,
      truncated: llm?.truncated ?? false,
      periodStart: llm?.period.from.slice(0, 10) || periodStart,
      periodEnd: llm?.period.to.slice(0, 10) || periodEnd,
    },
    {
      kind: 'whatsapp_conversations',
      quantity: whatsappConversations,
      unit: 'conversations',
      softLimit: waCaps.soft,
      hardLimit: waCaps.hard,
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
      softLimit: seatCaps.soft,
      hardLimit: seatCaps.hard,
      ...seatFlags,
      source: 'users',
      truncated: false,
      periodStart,
      periodEnd,
    },
  ];
  if (llm) {
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

export async function listInvoices(
  client: PoolClient,
  orgId: string,
  opts?: { limit?: number; offset?: number }
): Promise<{ invoices: InvoiceRow[]; total: number; limit: number; offset: number }> {
  const limit = Math.min(100, Math.max(1, opts?.limit ?? 50));
  const offset = Math.max(0, opts?.offset ?? 0);
  const countRes = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM billing_invoices WHERE org_id = $1`,
    [orgId]
  );
  const total = parseInt(countRes.rows[0]?.count || '0', 10) || 0;
  const res = await client.query<InvoiceRow>(
    `SELECT id, org_id, provider, provider_invoice_id, status, amount_cents, currency,
            hosted_invoice_url, period_start, period_end, paid_at, failed_at, created_at
     FROM billing_invoices
     WHERE org_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [orgId, limit, offset]
  );
  return { invoices: res.rows, total, limit, offset };
}

export type BillingAuditAction =
  | 'checkout_started'
  | 'plan_changed'
  | 'cancel_requested'
  | 'cancel_immediate'
  | 'portal_opened'
  | 'dunning_entered'
  | 'dunning_cleared'
  | 'downgrade_to_free';

/**
 * Append-only billing mutation audit. Org must already be RLS-scoped on client.
 * Never accepts orgId from a client body — caller passes session/webhook-resolved id.
 */
export async function recordBillingAudit(
  client: PoolClient,
  input: {
    orgId: string;
    action: BillingAuditAction;
    actorUserId?: string | null;
    provider?: BillingProvider | null;
    planKey?: string | null;
    payload?: Record<string, unknown>;
  }
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO billing_audit_log (org_id, actor_user_id, action, provider, plan_key, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        input.orgId,
        input.actorUserId ?? null,
        input.action,
        input.provider ?? null,
        input.planKey ?? null,
        JSON.stringify(input.payload ?? {}),
      ]
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/billing_audit_log|does not exist|relation/i.test(message)) {
      console.warn('[billing] billing_audit_log missing — apply 093_billing_packs_gaps.sql');
      return;
    }
    throw err;
  }
  // Mirror into the shared audit trail so billing changes show on /audit-log.
  try {
    await recordAuditEvent(
      {
        orgId: input.orgId,
        kind: 'billing.change',
        actor: input.actorUserId
          ? { actorType: 'user', userId: input.actorUserId }
          : { actorType: 'system', component: 'billing' },
        action: input.action,
        resultStatus: 'ok',
        riskClass: 'high',
        payload: { provider: input.provider ?? null, planKey: input.planKey ?? null, ...(input.payload ?? {}) },
      },
      { client, orgId: input.orgId }
    );
  } catch (err) {
    console.warn('[billing] audit_events insert failed:', err instanceof Error ? err.message : String(err));
  }
}

export function dunningGraceDays(): number {
  return Math.max(1, envInt('DAREX_BILLING_DUNNING_GRACE_DAYS', 7));
}

/**
 * Enter or clear dunning grace on past_due / unpaid. Auto-downgrades to free after grace.
 * Writes orgs.status: past_due while grace open; suspended (by dunning) when grace elapsed.
 * Clearing only lifts past_due / dunning suspensions — never a platform suspension.
 */
export async function applyDunningState(
  client: PoolClient,
  input: {
    orgId: string;
    provider: BillingProvider;
    status: SubscriptionStatus;
    actorUserId?: string | null;
  }
): Promise<{ dunning: boolean; downgraded: boolean; graceEndsAt: string | null }> {
  const now = Date.now();
  if (input.status === 'past_due' || input.status === 'unpaid') {
    const existing = await client.query<{ dunning_grace_ends_at: Date | null }>(
      `SELECT dunning_grace_ends_at FROM billing_subscriptions
       WHERE org_id = $1 AND provider = $2 LIMIT 1`,
      [input.orgId, input.provider]
    );
    let graceEnds = existing.rows[0]?.dunning_grace_ends_at
      ? new Date(existing.rows[0].dunning_grace_ends_at).getTime()
      : null;
    if (graceEnds == null) {
      graceEnds = now + dunningGraceDays() * 24 * 60 * 60 * 1000;
      try {
        await client.query(
          `UPDATE billing_subscriptions
              SET dunning_grace_ends_at = to_timestamp($3 / 1000.0), updated_at = NOW()
            WHERE org_id = $1 AND provider = $2`,
          [input.orgId, input.provider, graceEnds]
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/dunning_grace_ends_at|does not exist/i.test(message)) throw err;
      }
      await recordBillingAudit(client, {
        orgId: input.orgId,
        action: 'dunning_entered',
        actorUserId: input.actorUserId,
        provider: input.provider,
        payload: { graceEndsAt: new Date(graceEnds).toISOString(), status: input.status },
      });
    }
    if (graceEnds <= now) {
      await setOrgPlan(input.orgId, 'free');
      try {
        await client.query(
          `UPDATE orgs
              SET status = 'suspended',
                  suspended_by = 'dunning',
                  suspended_at = NOW(),
                  updated_at = NOW()
            WHERE id = $1`,
          [input.orgId]
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/suspended_by|orgs_status_check|does not exist/i.test(message)) throw err;
      }
      await recordBillingAudit(client, {
        orgId: input.orgId,
        action: 'downgrade_to_free',
        actorUserId: input.actorUserId,
        provider: input.provider,
        payload: { reason: 'dunning_grace_elapsed', status: input.status },
      });
      return { dunning: true, downgraded: true, graceEndsAt: new Date(graceEnds).toISOString() };
    }
    try {
      await client.query(
        `UPDATE orgs
            SET status = 'past_due', updated_at = NOW()
          WHERE id = $1
            AND status IS DISTINCT FROM 'suspended'
            AND status IS DISTINCT FROM 'soft_deleted'`,
        [input.orgId]
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/orgs_status_check|does not exist/i.test(message)) throw err;
    }
    return { dunning: true, downgraded: false, graceEndsAt: new Date(graceEnds).toISOString() };
  }

  if (input.status === 'active' || input.status === 'trialing') {
    try {
      await client.query(
        `UPDATE billing_subscriptions
            SET dunning_grace_ends_at = NULL, updated_at = NOW()
          WHERE org_id = $1 AND provider = $2 AND dunning_grace_ends_at IS NOT NULL`,
        [input.orgId, input.provider]
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/dunning_grace_ends_at|does not exist/i.test(message)) throw err;
    }
    try {
      await client.query(
        `UPDATE orgs
            SET status = 'active',
                suspended_by = NULL,
                suspended_at = NULL,
                updated_at = NOW()
          WHERE id = $1
            AND (
              status = 'past_due'
              OR (status = 'suspended' AND suspended_by = 'dunning')
            )`,
        [input.orgId]
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/suspended_by|orgs_status_check|does not exist/i.test(message)) throw err;
    }
    await recordBillingAudit(client, {
      orgId: input.orgId,
      action: 'dunning_cleared',
      actorUserId: input.actorUserId,
      provider: input.provider,
      payload: { status: input.status },
    });
  }
  return { dunning: false, downgraded: false, graceEndsAt: null };
}

export async function listBillingAudit(
  client: PoolClient,
  orgId: string,
  opts?: { limit?: number }
): Promise<
  Array<{
    id: string;
    action: string;
    provider: string | null;
    plan_key: string | null;
    payload: Record<string, unknown>;
    created_at: Date;
    actor_user_id: string | null;
  }>
> {
  const limit = Math.min(100, Math.max(1, opts?.limit ?? 25));
  try {
    const res = await client.query(
      `SELECT id, action, provider, plan_key, payload, created_at, actor_user_id
       FROM billing_audit_log
       WHERE org_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [orgId, limit]
    );
    return res.rows as Array<{
      id: string;
      action: string;
      provider: string | null;
      plan_key: string | null;
      payload: Record<string, unknown>;
      created_at: Date;
      actor_user_id: string | null;
    }>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/billing_audit_log|does not exist|relation/i.test(message)) return [];
    throw err;
  }
}

export async function listSubscriptions(client: PoolClient, orgId: string): Promise<SubscriptionRow[]> {
  try {
    const res = await client.query<SubscriptionRow>(
      `SELECT id, org_id, provider, provider_customer_id, provider_subscription_id,
              plan_key, status, seats, current_period_start, current_period_end, cancel_at_period_end,
              dunning_grace_ends_at
       FROM billing_subscriptions
       WHERE org_id = $1
       ORDER BY updated_at DESC`,
      [orgId]
    );
    return res.rows;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/dunning_grace_ends_at/i.test(message)) throw err;
    const res = await client.query<SubscriptionRow>(
      `SELECT id, org_id, provider, provider_customer_id, provider_subscription_id,
              plan_key, status, seats, current_period_start, current_period_end, cancel_at_period_end
       FROM billing_subscriptions
       WHERE org_id = $1
       ORDER BY updated_at DESC`,
      [orgId]
    );
    return res.rows.map((r) => ({ ...r, dunning_grace_ends_at: null }));
  }
}

/**
 * Seat limit at invite / add-user time.
 * When org_plan_overrides.seat_cap is non-null it is the hard ceiling (even above
 * subscription seats). Else purchased seats from active|trialing subscriptions;
 * else env meter hard cap. Missing override table → current behavior.
 * Never trusts client-sent seat counts. Invite routes under auth/settings should call this.
 */
export type SeatAvailability = {
  allowed: boolean;
  seatsUsed: number;
  seatLimit: number;
  source: 'plan_override' | 'subscription' | 'meter_hard_cap';
  reason?: string;
};

/**
 * Seats in use = members (users.org_id ∪ organization_memberships) plus open,
 * unexpired invites for emails that are not members yet (BIZ-B08). Invites
 * reserve a seat, otherwise N parallel invites each saw the same free seat.
 */
export const SEATS_IN_USE_SQL = `SELECT (
     (SELECT COUNT(*) FROM (
        SELECT id AS user_id FROM users WHERE org_id = $1
        UNION
        SELECT user_id FROM organization_memberships WHERE org_id = $1
      ) m)
   + (SELECT COUNT(*) FROM org_invites i
       WHERE i.org_id = $1 AND i.accepted_at IS NULL AND i.expires_at > NOW()
         AND NOT EXISTS (
           SELECT 1 FROM users u WHERE u.org_id = $1 AND lower(u.email) = lower(i.email)
         ))
   )::text AS count`;

const SEATS_IN_USE_FALLBACK_SQL = `SELECT (
     (SELECT COUNT(*) FROM users WHERE org_id = $1)
   + (SELECT COUNT(*) FROM org_invites
       WHERE org_id = $1 AND accepted_at IS NULL AND expires_at > NOW())
   )::text AS count`;

async function countSeatsInUse(client: PoolClient, orgId: string): Promise<number> {
  let res;
  try {
    res = await client.query<{ count: string }>(SEATS_IN_USE_SQL, [orgId]);
  } catch (err) {
    // organization_memberships (097) missing on partial migrations.
    if (!isUndefinedRelation(err)) throw err;
    res = await client.query<{ count: string }>(SEATS_IN_USE_FALLBACK_SQL, [orgId]);
  }
  return parseInt(res.rows[0]?.count || '0', 10) || 0;
}

export async function checkSeatAvailability(
  orgId: string,
  additionalSeats = 1,
  opts: { client?: PoolClient } = {}
): Promise<SeatAvailability> {
  if (opts.client) return checkSeatAvailabilityWith(opts.client, orgId, additionalSeats);
  const scoped = await getOrgScopedClient(orgId);
  try {
    return await checkSeatAvailabilityWith(scoped.client, orgId, additionalSeats);
  } finally {
    scoped.client.release();
  }
}

/**
 * Invite with a seat reservation, serialised per org (BIZ-B08). Runs the
 * existing-invite check, the seat check and `write` in one transaction under
 * an org advisory lock, so two concurrent invites cannot both take the last
 * seat. Resending a pending invite does not consume a seat.
 */
export async function reserveInviteSeat(
  client: PoolClient,
  orgId: string,
  email: string,
  write: () => Promise<void>
): Promise<SeatAvailability | null> {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('darex-seats:' || $1))`, [orgId]);
    const existingInvite = await client.query<{ id: string }>(
      `SELECT id FROM org_invites
       WHERE org_id = $1 AND lower(email) = $2 AND accepted_at IS NULL AND expires_at > NOW()
       LIMIT 1`,
      [orgId, email]
    );
    if (existingInvite.rows.length === 0) {
      const seats = await checkSeatAvailabilityWith(client, orgId, 1);
      if (!seats.allowed) {
        await client.query('ROLLBACK');
        return seats;
      }
    }
    await write();
    await client.query('COMMIT');
    return null;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

async function checkSeatAvailabilityWith(
  client: PoolClient,
  orgId: string,
  additionalSeats: number
): Promise<SeatAvailability> {
  const caps = meterCaps();
  const seatsUsed = await countSeatsInUse(client, orgId);

  const override = await loadOrgPlanOverrideCaps(client, orgId);
  if (override?.seatCap != null) {
    const seatLimit = Math.max(1, override.seatCap);
    const next = seatsUsed + Math.max(0, additionalSeats);
    if (next > seatLimit) {
      return {
        allowed: false,
        seatsUsed,
        seatLimit,
        source: 'plan_override',
        reason: `Seat limit reached (${seatsUsed}/${seatLimit}). Upgrade seats or remove a member before inviting.`,
      };
    }
    return { allowed: true, seatsUsed, seatLimit, source: 'plan_override' };
  }

  const subRes = await client.query<{ seats: number }>(
    `SELECT seats
     FROM billing_subscriptions
     WHERE org_id = $1 AND status IN ('active', 'trialing')
     ORDER BY seats DESC
     LIMIT 1`,
    [orgId]
  );
  const purchased = subRes.rows[0]?.seats;
  const source: 'subscription' | 'meter_hard_cap' =
    purchased != null && purchased > 0 ? 'subscription' : 'meter_hard_cap';
  const seatLimit =
    purchased != null && purchased > 0 ? Math.max(1, purchased) : Math.max(1, caps.seatHard);

  const next = seatsUsed + Math.max(0, additionalSeats);
  if (next > seatLimit) {
    return {
      allowed: false,
      seatsUsed,
      seatLimit,
      source,
      reason: `Seat limit reached (${seatsUsed}/${seatLimit}). Upgrade seats or remove a member before inviting.`,
    };
  }
  return { allowed: true, seatsUsed, seatLimit, source };
}

export function hasPaidSubscription(row: SubscriptionRow | undefined | null): boolean {
  if (!row) return false;
  return row.status === 'active' || row.status === 'trialing';
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
    'metadata[darex_seats]': String(Math.max(1, opts.seats)),
    'subscription_data[metadata][darex_seats]': String(Math.max(1, opts.seats)),
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

/**
 * Cancel at period end (Stripe) or cancel immediately / at cycle end (Razorpay).
 * Never trusts client-sent subscription ids — caller must pass the row from session org.
 */
export async function cancelProviderSubscription(opts: {
  provider: BillingProvider;
  subscriptionId: string;
  atPeriodEnd?: boolean;
}): Promise<{ status: string; cancelAtPeriodEnd: boolean; raw: Record<string, unknown> }> {
  if (!opts.subscriptionId) {
    throw new BillingConfigError('No provider subscription id to cancel');
  }
  switch (opts.provider) {
    case 'stripe': {
      const atPeriodEnd = opts.atPeriodEnd !== false;
      if (atPeriodEnd) {
        const updated = await stripePost(`/subscriptions/${encodeURIComponent(opts.subscriptionId)}`, {
          cancel_at_period_end: 'true',
        });
        if (updated.status >= 400) {
          throw new BillingConfigError(
            `Stripe cancel failed: ${updated.status} ${JSON.stringify(updated.json).slice(0, 200)}`
          );
        }
        return {
          status: asString(updated.json.status) || 'active',
          cancelAtPeriodEnd: true,
          raw: updated.json,
        };
      }
      const secret = stripeSecretKey();
      if (!secret) throw new BillingConfigError('DAREX_STRIPE_SECRET_KEY is not configured');
      const cancel = await fetch(
        `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(opts.subscriptionId)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        }
      );
      const json = (await cancel.json().catch(() => ({}))) as Record<string, unknown>;
      if (cancel.status >= 400) {
        throw new BillingConfigError(
          `Stripe cancel failed: ${cancel.status} ${JSON.stringify(json).slice(0, 200)}`
        );
      }
      return {
        status: asString(json.status) || 'canceled',
        cancelAtPeriodEnd: false,
        raw: json,
      };
    }
    case 'razorpay': {
      const atCycleEnd = opts.atPeriodEnd !== false;
      const canceled = await razorpayRequest(
        'POST',
        `/subscriptions/${encodeURIComponent(opts.subscriptionId)}/cancel`,
        { cancel_at_cycle_end: atCycleEnd ? 1 : 0 }
      );
      if (canceled.status >= 400) {
        throw new BillingConfigError(
          `Razorpay cancel failed: ${canceled.status} ${JSON.stringify(canceled.json).slice(0, 200)}`
        );
      }
      return {
        status: asString(canceled.json.status) || (atCycleEnd ? 'active' : 'cancelled'),
        cancelAtPeriodEnd: atCycleEnd,
        raw: canceled.json,
      };
    }
    default: {
      const _exhaustive: never = opts.provider;
      return _exhaustive;
    }
  }
}

/**
 * Modify-in-place plan change. Stripe uses subscriptions.update + create_prorations.
 * Razorpay uses subscriptions update with schedule_change_at=now (no Stripe-style proration API).
 */
export async function changeProviderPlan(opts: {
  provider: BillingProvider;
  subscriptionId: string;
  plan: CheckoutPlanKey;
  seats: number;
  orgId: string;
}): Promise<{
  status: string;
  plan: CheckoutPlanKey;
  seats: number;
  prorated: boolean;
  raw: Record<string, unknown>;
}> {
  const seats = Math.max(1, Math.min(seatMax(), opts.seats));
  switch (opts.provider) {
    case 'stripe': {
      const priceId = stripePriceId(opts.plan);
      if (!priceId) {
        throw new BillingConfigError(`DAREX_STRIPE_PRICE_${opts.plan.toUpperCase()} is not configured`);
      }
      const current = await stripeGet(
        `/subscriptions/${encodeURIComponent(opts.subscriptionId)}?expand[]=items.data`
      );
      if (current.status >= 400) {
        throw new BillingConfigError(
          `Stripe subscription fetch failed: ${current.status} ${JSON.stringify(current.json).slice(0, 200)}`
        );
      }
      const itemsObj = asRecord(current.json.items);
      const data = Array.isArray(itemsObj.data) ? itemsObj.data : [];
      const first = data.length > 0 ? asRecord(data[0]) : {};
      const itemId = asString(first.id);
      if (!itemId) {
        throw new BillingConfigError('Stripe subscription has no line items to update');
      }
      const fields: Record<string, string> = {
        'items[0][id]': itemId,
        'items[0][price]': priceId,
        'items[0][quantity]': String(seats),
        proration_behavior: 'create_prorations',
        'metadata[darex_org_id]': opts.orgId,
        'metadata[darex_plan]': opts.plan,
      };
      const updated = await stripePost(
        `/subscriptions/${encodeURIComponent(opts.subscriptionId)}`,
        fields
      );
      if (updated.status >= 400) {
        throw new BillingConfigError(
          `Stripe plan change failed: ${updated.status} ${JSON.stringify(updated.json).slice(0, 200)}`
        );
      }
      return {
        status: asString(updated.json.status) || 'active',
        plan: opts.plan,
        seats,
        prorated: true,
        raw: updated.json,
      };
    }
    case 'razorpay': {
      const planId = razorpayPlanId(opts.plan);
      if (!planId) {
        throw new BillingConfigError(`DAREX_RAZORPAY_PLAN_${opts.plan.toUpperCase()} is not configured`);
      }
      const updated = await razorpayRequest(
        'PATCH',
        `/subscriptions/${encodeURIComponent(opts.subscriptionId)}`,
        {
          plan_id: planId,
          quantity: seats,
          schedule_change_at: 'now',
          customer_notify: 1,
          notes: { darex_org_id: opts.orgId, darex_plan: opts.plan },
        }
      );
      if (updated.status >= 400) {
        throw new BillingConfigError(
          `Razorpay plan change failed: ${updated.status} ${JSON.stringify(updated.json).slice(0, 200)}`
        );
      }
      return {
        status: asString(updated.json.status) || 'active',
        plan: opts.plan,
        seats,
        prorated: false,
        raw: updated.json,
      };
    }
    default: {
      const _exhaustive: never = opts.provider;
      return _exhaustive;
    }
  }
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
      // The session carries no line items; read them off the subscription.
      const items = summarizeStripeItems(await fetchStripeSubscriptionItems(subscriptionId), stripePriceConfig());
      const scoped = await getOrgScopedClient(orgId);
      try {
        await upsertSubscription(scoped.client, {
          orgId,
          provider: 'stripe',
          planKey: parseOrgPlanKey(
            items.planKey ||
              asString(metadata.darex_plan) ||
              asString(metadata.plan) ||
              existing?.plan_key ||
              'starter'
          ),
          status: 'active',
          seats: items.seats ?? asInt(metadata.darex_seats, existing?.seats ?? 1),
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
      const items = summarizeStripeItems(data.items, stripePriceConfig());
      const orgId = await resolveWebhookOrg({
        provider: 'stripe',
        customerId,
        subscriptionId,
        metadataOrgId: asString(metadata.darex_org_id),
      });
      if (!orgId) return { orgId: null, status: 'ignored' };
      const status =
        kind === 'customer.subscription.deleted' ? 'canceled' : mapStripeSubStatus(asString(data.status));
      const existing = await lookupBySubscription('stripe', subscriptionId);
      // Price id wins: a portal plan switch leaves metadata.darex_plan stale.
      const planKey = parseOrgPlanKey(
        items.planKey ||
          asString(metadata.plan) ||
          asString(metadata.darex_plan) ||
          existing?.plan_key ||
          'starter'
      );
      const scoped = await getOrgScopedClient(orgId);
      try {
        await upsertSubscription(scoped.client, {
          orgId,
          provider: 'stripe',
          planKey,
          status,
          seats: items.seats ?? existing?.seats ?? 1,
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
          await applyDunningState(scoped.client, {
            orgId,
            provider: 'stripe',
            status: 'past_due',
          });
        } else if (kind === 'invoice.paid') {
          await applyDunningState(scoped.client, {
            orgId,
            provider: 'stripe',
            status: 'active',
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
      const existing = await lookupBySubscription('razorpay', asString(subEntity.id));
      const scoped = await getOrgScopedClient(orgId);
      try {
        await upsertSubscription(scoped.client, {
          orgId,
          provider: 'razorpay',
          // plan_id wins over notes: a plan change via PATCH keeps the old notes.
          planKey: parseOrgPlanKey(
            razorpayPlanKeyFromPlanId(asString(subEntity.plan_id)) ||
              asString(notes.darex_plan) ||
              existing?.plan_key ||
              'starter'
          ),
          status,
          seats: asInt(subEntity.quantity, existing?.seats ?? 1),
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
        // Mirror Stripe invoice.paid / payment_failed dunning for Razorpay status events.
        if (status === 'active') {
          await applyDunningState(scoped.client, { orgId, provider: 'razorpay', status: 'active' });
        } else if (status === 'past_due' || status === 'unpaid') {
          await applyDunningState(scoped.client, { orgId, provider: 'razorpay', status });
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
        await applyDunningState(scoped.client, {
          orgId,
          provider: 'razorpay',
          status: 'past_due',
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
