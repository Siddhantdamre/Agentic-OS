/** Platform console types. Fields are optional where the parallel API may lag. */

export type PlatformRole = 'operator' | 'support';

export type OrgStatus =
  | 'provisioning'
  | 'active'
  | 'past_due'
  | 'suspended'
  | 'soft_deleted'
  | string;

export type PlatformOrgRow = {
  id: string;
  name: string;
  slug?: string | null;
  status: OrgStatus;
  plan?: string | null;
  subscriptionStatus?: string | null;
  seatsUsed?: number | null;
  seatCap?: number | null;
  seats?: number | null;
  lastActivityAt?: string | null;
  connectorCount?: number | null;
  dunningGraceEndsAt?: string | null;
  dunning?: boolean | null;
  suspendedBy?: string | null;
  health?: 'alert' | 'ok' | 'unknown' | string | null;
  healthAlertCount?: number | null;
};

export type PlatformMember = {
  userId: string;
  email?: string | null;
  role?: string | null;
  sessionEpoch?: number | null;
  lastLoginAt?: string | null;
};

export type PlatformMeter = {
  kind: string;
  quantity?: number | null;
  softLimit?: number | null;
  hardLimit?: number | null;
  soft?: number | null;
  hard?: number | null;
  overSoft?: boolean;
  overHard?: boolean;
  unit?: string | null;
};

export type PlatformConnector = {
  id: string;
  provider?: string | null;
  status?: string | null;
  nangoConnectionId?: string | null;
};

export type PlatformAuditRow = {
  id: string;
  action?: string | null;
  kind?: string | null;
  reason?: string | null;
  actorUserId?: string | null;
  platformRole?: string | null;
  createdAt?: string | null;
  payloadPreview?: string | null;
  resultStatus?: string | null;
};

export type PlatformBillingHealth = {
  plan?: string | null;
  provider?: 'stripe' | 'razorpay' | string | null;
  status?: string | null;
  seats?: number | null;
  cancelAtPeriodEnd?: boolean | null;
  dunningGraceEndsAt?: string | null;
  providerCustomerId?: string | null;
  providerSubscriptionId?: string | null;
  lastInvoiceStatus?: string | null;
  invoices?: Array<{
    id: string;
    status?: string | null;
    amountMinor?: number | null;
    currency?: string | null;
    createdAt?: string | null;
  }>;
};

export type PlatformOverrides = {
  seatCap?: number | null;
  meterCaps?: Record<string, { soft?: number | null; hard?: number | null }>;
  featureFlags?: Record<string, boolean>;
};

export type PlatformOrgDetail = {
  id: string;
  name: string;
  slug?: string | null;
  status: OrgStatus;
  plan?: string | null;
  suspendedBy?: string | null;
  suspendedAt?: string | null;
  supportAccessEnabled?: boolean | null;
  killSwitch?: boolean | null;
  rolloutStage?: number | null;
  platformRole?: PlatformRole;
  members?: PlatformMember[];
  meters?: PlatformMeter[];
  llmCost?: number | string | null;
  llmCostError?: string | null;
  failedWebhookCount?: number | null;
  unresolvedWebhookCount?: number | null;
  connectors?: PlatformConnector[];
  orgAudit?: PlatformAuditRow[];
  platformAudit?: PlatformAuditRow[];
  billing?: PlatformBillingHealth;
  overrides?: PlatformOverrides;
};

export type PlatformObservability = {
  ready?: {
    status?: string | null;
    checks?: Record<string, { status?: string; detail?: string }>;
  } | null;
  orgCountsByStatus?: Record<string, number> | null;
  dunningCount?: number | null;
  pastDueCount?: number | null;
  meterTotals?: Record<string, number | 'unknown' | null> | null;
  llmCost?: number | 'unknown' | null;
  /** null = observability snapshot missing (show unknown, not green zero). */
  alertOrgs?: Array<{ orgId: string; name?: string; metric?: string }> | null;
  failedWebhooks?: Array<{ orgId: string | null; count: number }> | null;
  observabilityMissing?: boolean;
  error?: string;
};

export type ImpersonationCurrent = {
  active: boolean;
  sessionId?: string | null;
  actorUserId?: string | null;
  actorEmail?: string | null;
  targetUserId?: string | null;
  targetOrgId?: string | null;
  expiresAt?: string | null;
  breakGlass?: boolean | null;
  reason?: string | null;
};

/**
 * Allowed override feature-flag keys (mirrors lib/platform-admin registry).
 * Unknown keys are rejected by the API with 400.
 */
export const PLATFORM_FEATURE_FLAG_KEYS = [
  'packs_install',
  'crew_spawn',
  'memory_write',
  'external_web_tools',
  'whatsapp_outbound',
  'autonomous_send',
  'autonomous_actions',
] as const;

export type PlatformFeatureFlagKey = (typeof PLATFORM_FEATURE_FLAG_KEYS)[number];

/** Flags marked safety in the server registry — UI confirms before enabling. */
export const PLATFORM_FEATURE_FLAG_SAFETY: Record<PlatformFeatureFlagKey, boolean> = {
  packs_install: false,
  crew_spawn: false,
  memory_write: false,
  external_web_tools: false,
  whatsapp_outbound: true,
  autonomous_send: true,
  autonomous_actions: true,
};

export const METER_KINDS = [
  'llm_tokens',
  'whatsapp_conversations',
  'seats',
  'embeddings',
  'successful_actions',
  'disconnected_actions',
] as const;

export const MIN_REASON_LENGTH = 12;
