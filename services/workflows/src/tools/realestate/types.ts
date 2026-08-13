/** RE listing / inquiry / showing / charge records. Prices from source only. */

export const LISTING_STATUSES = [
  'draft',
  'active',
  'under_offer',
  'reserved',
  'sold',
  'rented',
  'withdrawn',
  'stale',
] as const;

export type ListingStatus = (typeof LISTING_STATUSES)[number];

export const INQUIRY_STATUSES = ['new', 'contacted', 'showing', 'closed', 'lost'] as const;
export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];

export const SHOWING_STATUSES = ['proposed', 'booked', 'completed', 'cancelled', 'no_show'] as const;
export type ShowingStatus = (typeof SHOWING_STATUSES)[number];

export const CHARGE_STATUSES = ['open', 'closed', 'void'] as const;
export type ChargeStatus = (typeof CHARGE_STATUSES)[number];

export interface ListingRecord {
  id: string;
  orgId: string;
  source: string;
  sourceRef: string;
  title: string | null;
  locality: string | null;
  city: string | null;
  bhk: number | null;
  listPrice: number | null;
  currency: string;
  reraId: string | null;
  status: ListingStatus;
  lastSourceSyncAt: string | null;
}

export interface ListingFilters {
  bhk?: number;
  locality?: string;
  city?: string;
  maxPrice?: number;
  status?: ListingStatus[];
}

export interface ChargeRecord {
  id: string;
  orgId: string;
  status: ChargeStatus;
  amount: number;
  currency: string;
  pspPaymentId: string | null;
  closedReason: string | null;
  claimedPaidAt: string | null;
}

export type ChargeCloseAttempt =
  | { kind: 'tenant_claim' }
  | { kind: 'psp_webhook'; pspPaymentId: string }
  | { kind: 'human_confirm' };

export function isListingStatus(value: string): value is ListingStatus {
  return (LISTING_STATUSES as readonly string[]).includes(value);
}

export function isInquiryStatus(value: string): value is InquiryStatus {
  return (INQUIRY_STATUSES as readonly string[]).includes(value);
}

export function isShowingStatus(value: string): value is ShowingStatus {
  return (SHOWING_STATUSES as readonly string[]).includes(value);
}
