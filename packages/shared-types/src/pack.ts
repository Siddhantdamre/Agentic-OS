/** Vertical pack manifest + org install contracts. */

import type { RiskClass } from './risk.js';

export const KNOWN_PACK_IDS = [
  'core-b2b',
  'real-estate-brokerage',
  'real-estate-pm',
  'real-estate-developer',
  'agencies',
  'saas-gtm',
  'ecommerce',
  'prof-services',
] as const;

export type KnownPackId = (typeof KNOWN_PACK_IDS)[number];

export type PackId = KnownPackId | (string & {});

export const PACK_INSTALL_STATES = [
  'pending',
  'installing',
  'installed',
  'failed',
  'uninstalling',
  'disabled',
  'uninstalled',
] as const;

export type PackInstallState = (typeof PACK_INSTALL_STATES)[number];

export type PackConfirmClass = RiskClass | (string & {});

export interface PackConnectors {
  required: string[];
  recommended: string[];
  optional: string[];
}

export interface PackEmployeeTemplate {
  name: string;
  role: string;
  personaTemplate: string;
  toolAllowlist: string[];
}

export interface PackWorkflowRef {
  temporalWorkflowName: string;
  triggers: string[];
}

export interface PackEntitySchema {
  entityType: string;
  jsonSchema: Record<string, unknown>;
}

export interface PackKpiRef {
  id: string;
  insightCopy?: string;
  recommendedAction?: string;
}

export interface PackCompliance {
  extraConfirmClasses: PackConfirmClass[];
  bannedPhrases: string[];
  requiredDisclosures: string[];
  blockedDataClasses: string[];
  retentionNotes?: string;
  marketModules: string[];
}

export interface PackManifest {
  id: PackId;
  name: string;
  version: string;
  extends?: PackId;
  markets: string[];
  entities: string[];
  connectors: PackConnectors;
  employees: PackEmployeeTemplate[];
  workflows: PackWorkflowRef[];
  entitySchemas: PackEntitySchema[];
  kpis: PackKpiRef[];
  compliance?: PackCompliance;
  onboardingCopy?: string;
}

export interface Pack {
  id: PackId;
  name: string;
  version: string;
}

export interface OrgPack {
  orgId: string;
  packId: PackId;
  status: PackInstallState;
  config: Record<string, unknown>;
  installedAt?: string | null;
  primary: boolean;
}

export interface InstallPackWorkflowInput {
  orgId: string;
  packId: PackId;
  idempotencyKey?: string;
}

export interface InstallPackWorkflowResult {
  orgId: string;
  packId: PackId;
  status: PackInstallState;
  noop: boolean;
}
