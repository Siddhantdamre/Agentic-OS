export const CUSTOMER_OPERATIONAL_STATES = [
  'new',
  'existing',
  'waiting',
  'unresolved',
  'frustrated',
  'vip',
  'at_risk',
  'escalated',
  'resolved',
] as const;

export type CustomerOperationalState = (typeof CUSTOMER_OPERATIONAL_STATES)[number];

export type DecisionCardOption = {
  id: string;
  label: string;
  cost?: string;
};

export type DecisionCard = {
  title: string;
  customer: string;
  situation: string;
  policy: string;
  recommendation: string;
  options: DecisionCardOption[];
  status?: 'open' | 'approved' | 'rejected';
};

export type ExtractedObligation = {
  obligor: 'us' | 'them';
  promiseSummary: string;
  quote: string;
  dueAtIso: string;
  dueBasis: 'explicit' | 'relative' | 'default';
  confidence: number;
  reasonCode?: 'ungrounded_quote' | 'obligor_sender_mismatch';
};
