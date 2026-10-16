/**
 * Connector route guard. Connecting, disconnecting, pasting BYOK keys,
 * changing connector config, and firing test/ping calls all act on the
 * org's shared credentials, so only owners and admins may do them.
 */
import { NextResponse } from 'next/server';
import type { PoolClient } from 'pg';
import { recordAuditEvent, type AuditEventInsert } from '@/lib/audit-events';
import { canManageOrgSettings, loadHumanRole, type HumanRole } from '@/lib/rbac';

export const CONNECTOR_FORBIDDEN_MESSAGE = 'Only owners and admins can manage connectors';

export function connectorForbiddenResponse(): NextResponse {
  return NextResponse.json(
    { success: false, error: CONNECTOR_FORBIDDEN_MESSAGE, message: CONNECTOR_FORBIDDEN_MESSAGE },
    { status: 403 }
  );
}

/** Returns a 403 response when the caller may not manage connectors, otherwise null. */
export async function denyUnlessConnectorManager(
  client: PoolClient,
  userId: string
): Promise<NextResponse | null> {
  const role: HumanRole = await loadHumanRole(client, userId);
  return canManageOrgSettings(role) ? null : connectorForbiddenResponse();
}

/**
 * Emits a connector audit row. Failures are logged, not thrown: the credential
 * change has already been committed and the caller must still get its answer.
 */
export async function auditConnectorChange(
  client: PoolClient,
  event: Omit<AuditEventInsert, 'riskClass'> & { riskClass?: string }
): Promise<void> {
  try {
    await recordAuditEvent({ riskClass: 'high', ...event }, { client, orgId: event.orgId });
  } catch (err) {
    console.error('[connector-audit] failed to record', event.kind, event.tool, err);
  }
}
