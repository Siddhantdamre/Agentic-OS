/** Tool / connector risk classes and confirm policy. Exhaustive-switch the unions. */

export const RISK_CLASSES = [
  'read',
  'draft',
  'send',
  'write_sor',
  'pay',
  'sign',
  'publish',
  'delete',
] as const;

export type RiskClass = (typeof RISK_CLASSES)[number];

/** Plan execute must go through Temporal when any step is in this set (O4). */
export const IRREVERSIBLE_RISK_CLASSES = [
  'send',
  'pay',
  'sign',
  'publish',
  'delete',
] as const;

export type IrreversibleRiskClass = (typeof IRREVERSIBLE_RISK_CLASSES)[number];

/** Never lower without explicit owner setting + audit. */
export const ALWAYS_CONFIRM_RISK_CLASSES = ['pay', 'sign'] as const;

export type AlwaysConfirmRiskClass = (typeof ALWAYS_CONFIRM_RISK_CLASSES)[number];

export type ConfirmMode = 'never' | 'always' | 'org_setting';

/**
 * Confirm policy keyed by class + org settings + pack extras.
 * Switch on `kind`.
 */
export type ConfirmPolicy =
  | { kind: 'never' }
  | { kind: 'always' }
  | { kind: 'org_setting' }
  | { kind: 'by_class'; classes: readonly RiskClass[] };

/** Per-provider module export: `{ actions, risk, confirm }` (R5 / C4). */
export interface ToolRiskMeta {
  actions: string[];
  risk: RiskClass;
  confirm: ConfirmPolicy;
}

export const DATA_CLASSES = [
  'public',
  'internal',
  'pii',
  'financial',
  'kyc_pointer',
  'health_pointer',
  'child_related',
] as const;

export type DataClass = (typeof DATA_CLASSES)[number];
