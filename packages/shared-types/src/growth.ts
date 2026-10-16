/** Growth Employee contracts — lookalike ICP, signals, opportunity cards. */

export const GROWTH_SIGNAL_TYPES = [
  'hiring',
  'funding',
  'leadership',
  'intent',
  'news',
  'other',
] as const;

export type GrowthSignalType = (typeof GROWTH_SIGNAL_TYPES)[number];

export interface WonAccountFeatures {
  companyName: string;
  domain?: string;
  industry?: string;
  geo?: string;
  headcount?: number;
  techTags?: string[];
  amountCents?: number;
}

export interface IcpProfile {
  industries: string[];
  geos: string[];
  employeeMin: number;
  employeeMax: number;
  techTags: string[];
  decisionMakerTitles: string[];
  sampleSize: number;
}

export interface PreferenceRule {
  field: 'headcount' | 'industry' | 'geo' | 'title';
  op: 'gte' | 'lte' | 'in' | 'not_in';
  value: string | number | string[];
  source?: string;
}

export interface PreferenceSuppression {
  id: string;
  field: string;
  value: string;
  reason: string;
  createdAt: string;
}

export interface RankedCandidate {
  companyName: string;
  domain: string;
  industry?: string;
  geo?: string;
  headcount?: number;
  techTags?: string[];
  title?: string;
  contactName?: string;
  contactEmail?: string;
  linkedin?: string;
  activeSignals: Array<{ type: GrowthSignalType; summary: string; timestamp: string }>;
  fit: number;
  now: number;
  score: number;
}

export interface GrowthOpportunityPayload {
  companyName: string;
  companyDomain?: string;
  icpScore: number;
  whyThisCompany: string;
  targetContact: {
    name: string;
    title: string;
    email?: string;
    linkedin?: string;
  };
  whyThisPerson: string;
  buyingSignals: Array<{ type: string; summary: string; timestamp: string }>;
  whyNow: string;
  draftedMessage: { subject: string; body: string };
}

export const REJECTION_REASONS = [
  'wrong_fit',
  'wrong_timing',
  'wrong_channel',
  'just_not_now',
] as const;

export type RejectionReason = (typeof REJECTION_REASONS)[number];

export const AUTONOMY_ACTION_TYPES = [
  'read',
  'draft',
  'write',
  'external_send',
  'high_risk',
] as const;

export type AutonomyActionType = (typeof AUTONOMY_ACTION_TYPES)[number];

/** Owner-facing card from gap/17 §2. Distinct from customer DecisionCardPayload. */
export interface OwnerDecisionCardPayload {
  title: string;
  who: string;
  whenLabel: string;
  situation: string;
  options: Array<{ id: string; label: string; cost: string }>;
  recommendedOptionId: string;
  recommendationBasis: string;
  urgency?: 'routine' | 'urgent';
}
