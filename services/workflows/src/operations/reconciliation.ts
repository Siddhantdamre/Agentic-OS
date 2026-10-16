/**
 * Cross-system reconciliation auditor (03 §7, Blueprint pp. 79-80).
 * Compares inbound enquiries vs CRM contact tables/entities.
 * Flags missing CRM records, duplicate records, and stale unworked records.
 */

import type { PoolClient } from 'pg';
import { isUndefinedTable } from '../db.js';

export type ReconciliationDiscrepancyKind =
  | 'missing_crm_record'
  | 'duplicate_record'
  | 'stale_record';

export interface ReconciliationDiscrepancy {
  kind: ReconciliationDiscrepancyKind;
  id?: string;
  externalSenderId?: string;
  channel?: string;
  detail: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

export interface ReconciliationReport {
  orgId: string;
  timestamp: string;
  inboundEnquiriesCount: number;
  crmRecordsCount: number;
  discrepancyCount: number;
  discrepancies: ReconciliationDiscrepancy[];
  healthy: boolean;
}

export interface InboundEnquiryRecord {
  id: string;
  externalSenderId: string;
  channel: string;
  state: string;
  createdAt: Date | string;
}

export interface CrmEntityRecord {
  id: string;
  identifier: string;
  entityType?: string;
  createdAt: Date | string;
}

/** Pure reconciliation difference calculator. */
export function computeReconciliationDiff(input: {
  enquiries: InboundEnquiryRecord[];
  crmEntities: CrmEntityRecord[];
  staleDaysThreshold?: number;
  now?: Date;
}): {
  discrepancies: ReconciliationDiscrepancy[];
  missingCount: number;
  duplicateCount: number;
  staleCount: number;
} {
  const discrepancies: ReconciliationDiscrepancy[] = [];
  const now = input.now ?? new Date();
  const staleThresholdMs = (input.staleDaysThreshold ?? 7) * 24 * 60 * 60_000;

  // 1. Map CRM identifiers
  const crmByIdentifier = new Map<string, string[]>();
  for (const crm of input.crmEntities) {
    const key = crm.identifier.trim().toLowerCase();
    if (!key) continue;
    const existing = crmByIdentifier.get(key) || [];
    existing.push(crm.id);
    crmByIdentifier.set(key, existing);
  }

  // 2. Identify duplicate CRM entities
  let duplicateCount = 0;
  for (const [key, ids] of crmByIdentifier.entries()) {
    if (ids.length > 1) {
      duplicateCount += 1;
      discrepancies.push({
        kind: 'duplicate_record',
        id: ids[0],
        detail: `CRM has ${ids.length} duplicate records for identifier "${key}": [${ids.join(', ')}]`,
        severity: 'medium',
      });
    }
  }

  // 3. Compare enquiries vs CRM entities
  let missingCount = 0;
  let staleCount = 0;

  for (const enq of input.enquiries) {
    const senderKey = (enq.externalSenderId || '').trim().toLowerCase();
    const hasCrmMatch = senderKey && crmByIdentifier.has(senderKey);

    // Missing from CRM
    if (!hasCrmMatch && enq.state !== 'closed') {
      missingCount += 1;
      discrepancies.push({
        kind: 'missing_crm_record',
        id: enq.id,
        externalSenderId: enq.externalSenderId,
        channel: enq.channel,
        detail: `Enquiry from "${enq.externalSenderId}" (${enq.channel}) has no corresponding CRM record`,
        severity: 'high',
      });
    }

    // Stale check
    const enqCreated = enq.createdAt instanceof Date ? enq.createdAt : new Date(enq.createdAt);
    if (!Number.isNaN(enqCreated.getTime())) {
      const ageMs = now.getTime() - enqCreated.getTime();
      if (ageMs > staleThresholdMs && (enq.state === 'new' || enq.state === 'assigned')) {
        staleCount += 1;
        const days = Math.floor(ageMs / (24 * 3600_000));
        discrepancies.push({
          kind: 'stale_record',
          id: enq.id,
          externalSenderId: enq.externalSenderId,
          channel: enq.channel,
          detail: `Enquiry "${enq.id}" in state "${enq.state}" has been uncontacted for ${days} days (> threshold)`,
          severity: 'medium',
        });
      }
    }
  }

  return {
    discrepancies,
    missingCount,
    duplicateCount,
    staleCount,
  };
}

/** Execute cross-system reconciliation audit against the database. */
export async function auditCrossSystemReconciliation(
  client: PoolClient,
  orgId: string,
  options?: { staleDaysThreshold?: number; now?: Date }
): Promise<ReconciliationReport> {
  const timestamp = (options?.now ?? new Date()).toISOString();
  try {
    const enqRes = await client.query<InboundEnquiryRecord>(
      `SELECT id::text, external_sender_id AS "externalSenderId", channel, state, created_at AS "createdAt"
         FROM operational_enquiries
        WHERE org_id = $1
        ORDER BY created_at DESC
        LIMIT 500`,
      [orgId]
    );

    const crmRes = await client.query<CrmEntityRecord>(
      `SELECT e.id::text, ei.value_norm AS identifier, e.entity_type AS "entityType", e.created_at AS "createdAt"
         FROM entities e
         JOIN entity_identifiers ei ON ei.entity_id = e.id AND ei.org_id = e.org_id
        WHERE e.org_id = $1
        ORDER BY e.created_at DESC
        LIMIT 1000`,
      [orgId]
    );

    const diff = computeReconciliationDiff({
      enquiries: enqRes.rows,
      crmEntities: crmRes.rows,
      staleDaysThreshold: options?.staleDaysThreshold,
      now: options?.now,
    });

    return {
      orgId,
      timestamp,
      inboundEnquiriesCount: enqRes.rows.length,
      crmRecordsCount: crmRes.rows.length,
      discrepancyCount: diff.discrepancies.length,
      discrepancies: diff.discrepancies,
      healthy: diff.discrepancies.length === 0,
    };
  } catch (err: unknown) {
    if (isUndefinedTable(err)) {
      return {
        orgId,
        timestamp,
        inboundEnquiriesCount: 0,
        crmRecordsCount: 0,
        discrepancyCount: 0,
        discrepancies: [],
        healthy: true,
      };
    }
    throw err;
  }
}
