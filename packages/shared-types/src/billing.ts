/** Darex SaaS billing — separate from org payment-link tools. */

export const BILLING_PLAN_TYPES = ['starter', 'growth', 'enterprise'] as const;

export type BillingPlanType = (typeof BILLING_PLAN_TYPES)[number];

export const BILLING_PROVIDERS = ['stripe', 'razorpay'] as const;

export type BillingProvider = (typeof BILLING_PROVIDERS)[number];

export const BILLING_METER_TYPES = [
  'llm_tokens',
  'whatsapp_conversations',
  'seats',
  'embeddings',
] as const;

export type BillingMeterType = (typeof BILLING_METER_TYPES)[number];

export const SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export type UsageLimitKind = 'soft' | 'hard';

export type BillingSubscription =
  | {
      provider: 'stripe';
      orgId: string;
      plan: BillingPlanType;
      status: SubscriptionStatus;
      customerId: string;
      subscriptionId: string;
      seatCount: number;
      primaryPackId?: string;
      addonPackIds: string[];
      currentPeriodEnd?: string;
    }
  | {
      provider: 'razorpay';
      orgId: string;
      plan: BillingPlanType;
      status: SubscriptionStatus;
      customerId: string;
      subscriptionId: string;
      seatCount: number;
      primaryPackId?: string;
      addonPackIds: string[];
      currentPeriodEnd?: string;
    };

export type UsageMeter =
  | {
      meterType: 'llm_tokens';
      orgId: string;
      used: number;
      unit: 'tokens';
      periodStart: string;
      periodEnd: string;
    }
  | {
      meterType: 'whatsapp_conversations';
      orgId: string;
      used: number;
      unit: 'conversations';
      periodStart: string;
      periodEnd: string;
    }
  | {
      meterType: 'seats';
      orgId: string;
      used: number;
      unit: 'seats';
      periodStart: string;
      periodEnd: string;
    }
  | {
      meterType: 'embeddings';
      orgId: string;
      used: number;
      unit: 'tokens';
      periodStart: string;
      periodEnd: string;
    };

export type UsageLimit =
  | { kind: 'soft'; orgId: string; meterType: BillingMeterType; cap: number }
  | { kind: 'hard'; orgId: string; meterType: BillingMeterType; cap: number };

export interface BillingInvoice {
  id: string;
  orgId: string;
  provider: BillingProvider;
  amountMinor: number;
  currency: string;
  status: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';
  hostedUrl?: string | null;
  createdAt: string;
}
