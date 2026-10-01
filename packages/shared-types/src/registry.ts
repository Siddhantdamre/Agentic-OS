/** Connector registry: defs, org connections, sync cursors. */

import type { ConfirmPolicy, RiskClass } from './risk.js';

export const ORG_CONNECTOR_STATUSES = [
  'pending',
  'connected',
  'disconnected',
  'error',
  'disabled',
] as const;

export type OrgConnectorStatus = (typeof ORG_CONNECTOR_STATUSES)[number];

export interface ConnectorDef {
  key: string;
  nangoKey: string;
  riskClass: RiskClass;
  confirmPolicy: ConfirmPolicy;
  verticalTags: string[];
  mcpTools: string[];
  displayName?: string;
  oauth: boolean;
}

export interface OrgConnector {
  id: string;
  orgId: string;
  connectorKey: string;
  status: OrgConnectorStatus;
  nangoConnectionId?: string | null;
  scopes: string[];
  lastOkAt?: string | null;
  lastError?: string | null;
}

export interface SyncCursor {
  orgId: string;
  connectorKey: string;
  stream: string;
  cursor: string;
  updatedAt: string;
}
