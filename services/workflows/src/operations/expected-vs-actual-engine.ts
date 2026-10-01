/**
 * Expected vs actual comparator (P3-EVA-1/2, 11 §5).
 * Persist no-ops when 023 tables are missing (42P01).
 */
import type { ExpectationBasis } from '@darex/shared-types';
import type { PoolClient } from 'pg';
import { isUndefinedTable } from '../db.js';

export interface Comparison {
  isDiscrepancy: boolean;
  expectedState: string;
  actualState: string;
  expectedBy: Date;
  overdueMs: number;
  magnitude: string;
}

export function compareExpectation(input: {
  expectedState: string;
  actualState: string;
  expectedBy: Date;
  now?: Date;
}): Comparison {
  const now = input.now ?? new Date();
  const overdueMs = now.getTime() - input.expectedBy.getTime();
  const met = input.actualState === input.expectedState;
  const isDiscrepancy = !met && overdueMs >= 0;
  const overdueHours = Math.max(0, overdueMs) / 3_600_000;
  const magnitude = met
    ? 'met on time'
    : overdueMs < 0
      ? `due in ${Math.ceil(-overdueMs / 60_000)}m`
      : `expected ${input.expectedState}, actual ${input.actualState}, ${overdueHours.toFixed(1)}h late`;
  return {
    isDiscrepancy,
    expectedState: input.expectedState,
    actualState: input.actualState,
    expectedBy: input.expectedBy,
    overdueMs,
    magnitude,
  };
}

export function discrepancyCardPayload(cmp: Comparison, objectType: string, objectId: string) {
  return {
    kind: 'operational_discrepancy',
    objectType,
    objectId,
    expected: cmp.expectedState,
    actual: cmp.actualState,
    gap: cmp.magnitude,
    overdueHours: Number((Math.max(0, cmp.overdueMs) / 3_600_000).toFixed(2)),
  };
}

export function inferredDeadline(samplesMs: number[], fallbackMs: number): number {
  if (samplesMs.length === 0) return fallbackMs;
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.8) - 1)];
}

export async function declareExpectation(
  client: PoolClient,
  draft: {
    orgId: string;
    objectType: string;
    objectId: string;
    expectedState: string;
    expectedBy: Date;
    actualState?: string;
    basis: ExpectationBasis;
  }
): Promise<{ id: string; created: boolean }> {
  try {
    const res = await client.query(
      `INSERT INTO operational_expectations (
         org_id, object_type, object_id, expected_state, expected_by_timestamp, actual_state, basis
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        draft.orgId,
        draft.objectType,
        draft.objectId,
        draft.expectedState,
        draft.expectedBy.toISOString(),
        draft.actualState ?? 'pending',
        draft.basis,
      ]
    );
    if (!res.rows[0]) return { id: `existing:${draft.objectId}`, created: false };
    return { id: String(res.rows[0].id), created: true };
  } catch (err) {
    if (isUndefinedTable(err)) return { id: `pending:${draft.objectType}:${draft.objectId}`, created: false };
    throw err;
  }
}

export async function scanOpenExpectations(
  client: PoolClient,
  orgId: string
): Promise<Array<{ id: string; objectType: string; objectId: string; comparison: Comparison; basis: ExpectationBasis }>> {
  try {
    const res = await client.query(
      `SELECT id, object_type, object_id, expected_state, expected_by_timestamp, actual_state, basis
         FROM operational_expectations
        WHERE org_id = $1 AND settled_at IS NULL
          AND expected_by_timestamp <= NOW() AND actual_state <> expected_state
        ORDER BY expected_by_timestamp ASC
        LIMIT 50`,
      [orgId]
    );
    return res.rows.map((row) => ({
      id: String(row.id),
      objectType: String(row.object_type),
      objectId: String(row.object_id),
      basis: row.basis as ExpectationBasis,
      comparison: compareExpectation({
        expectedState: String(row.expected_state),
        actualState: String(row.actual_state),
        expectedBy: new Date(row.expected_by_timestamp),
      }),
    }));
  } catch (err) {
    if (isUndefinedTable(err)) return [];
    throw err;
  }
}

/**
 * OE-03: declarative operational-rule registry. Each rule states what should
 * be true of an object by a deadline relative to when the triggering event
 * happened; scanOpenExpectations (via runMorningCheckActivity/
 * StuckWorkDetectorWorkflow) flags anything still short of that state past
 * the deadline as a discrepancy. Adding a new operational standard is adding
 * a row here, not new comparator code.
 */
export interface OperationalExpectationRule {
  name: string;
  objectType: string;
  expectedState: string;
  /** Time allowed between the triggering event and the expected state, in ms. */
  slaMs: number;
  basis: ExpectationBasis;
  description: string;
}

export const OPERATIONAL_EXPECTATION_RULES: readonly OperationalExpectationRule[] = [
  {
    name: 'hot_lead_contacted_within_2h',
    objectType: 'enquiry',
    expectedState: 'contacted',
    slaMs: 2 * 60 * 60 * 1000,
    basis: 'declared',
    description: 'A high-value lead assigned to a rep must be contacted within 2 hours.',
  },
  {
    name: 'contact_no_duplicate',
    objectType: 'contact',
    expectedState: 'deduped',
    slaMs: 0,
    basis: 'declared',
    description: 'A newly created contact must not remain flagged as a duplicate of an existing record.',
  },
] as const;

export function findExpectationRule(name: string): OperationalExpectationRule | undefined {
  return OPERATIONAL_EXPECTATION_RULES.find((rule) => rule.name === name);
}

/** Declare an expectation for `objectId` per a named rule, anchored to `triggeredAt`. */
export async function registerExpectationFromRule(
  client: PoolClient,
  input: { orgId: string; ruleName: string; objectId: string; triggeredAt: Date; actualState?: string }
): Promise<{ id: string; created: boolean } | null> {
  const rule = findExpectationRule(input.ruleName);
  if (!rule) return null;
  return declareExpectation(client, {
    orgId: input.orgId,
    objectType: rule.objectType,
    objectId: input.objectId,
    expectedState: rule.expectedState,
    expectedBy: new Date(input.triggeredAt.getTime() + rule.slaMs),
    actualState: input.actualState,
    basis: rule.basis,
  });
}

export async function attachDiscrepancyWorkItem(
  client: PoolClient,
  orgId: string,
  expectation: { id: string; objectType: string; objectId: string; comparison: Comparison }
): Promise<{ workItemId: string | null }> {
  const payload = discrepancyCardPayload(
    expectation.comparison,
    expectation.objectType,
    expectation.objectId
  );
  try {
    const inserted = await client.query(
      `INSERT INTO work_items (org_id, type, status, priority, metadata)
       VALUES ($1, 'operational_discrepancy', 'needs_attention', 'high', $2::jsonb)
       RETURNING id`,
      [orgId, JSON.stringify(payload)]
    );
    const workItemId = String(inserted.rows[0].id);
    try {
      await client.query(
        `UPDATE operational_expectations
            SET is_discrepancy = TRUE, discrepancy_magnitude = $3, work_item_id = $4
          WHERE id = $1 AND org_id = $2`,
        [expectation.id, orgId, expectation.comparison.magnitude, workItemId]
      );
    } catch (err) {
      if (!isUndefinedTable(err)) throw err;
    }
    return { workItemId };
  } catch (err) {
    if (isUndefinedTable(err)) return { workItemId: null };
    throw err;
  }
}
