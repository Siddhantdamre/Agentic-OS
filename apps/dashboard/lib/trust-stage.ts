/**
 * Changing a workspace's autonomy level.
 *
 * The evidence that decides whether a workspace may move up is measured here, on
 * the server, from the database. A request says only which level it wants and,
 * optionally, why it is overriding. Numbers in a request body are never read.
 *
 * Every change is written together with the evidence it relied on (or a note that it
 * was an override), in one transaction, so "why is this team at level 2?" always has
 * an answer.
 */
import type { PoolClient } from 'pg';
import { writeRolloutStage } from '@/lib/employee-metrics-query';
import { canAdvanceStage, type RolloutStage, type StageRequirement } from '@/lib/employee-rollout';
import { collectTrustSnapshot } from '@/lib/trust-query';
import { recommendStage } from '@/lib/trust-evidence';

export const MAX_REASON_LENGTH = 500;

export type StageChangeKind = 'advance' | 'override' | 'pull_back';

export type StageChangeResult =
  | { ok: true; unchanged: true; stage: RolloutStage }
  | { ok: true; unchanged: false; stage: RolloutStage; from: RolloutStage; kind: StageChangeKind; reason: string }
  | { ok: false; status: 400 | 409; error: string; stage?: RolloutStage; requirements?: StageRequirement[] };

function parseTarget(value: unknown): RolloutStage | null {
  return value === 0 || value === 1 || value === 2 || value === 3 ? value : null;
}

function cleanReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t ? t.slice(0, MAX_REASON_LENGTH) : null;
}

export async function changeStage(
  client: PoolClient,
  orgId: string,
  userId: string,
  input: { stage?: unknown; force?: unknown; reason?: unknown },
): Promise<StageChangeResult> {
  const target = parseTarget(input.stage);
  if (target === null) return { ok: false, status: 400, error: 'Choose a level from 0 to 3.' };

  const snap = await collectTrustSnapshot(client, orgId);
  const from = snap.stage;
  if (target === from) return { ok: true, unchanged: true, stage: from };

  const reason = cleanReason(input.reason);
  const recommendation = recommendStage(snap.workspace);
  const evidence = { workspace: snap.workspace, requirements: recommendation.requirements };

  let kind: StageChangeKind;
  let note: string;
  if (target < from) {
    kind = 'pull_back';
    note = reason ?? 'Moved back a level.';
  } else {
    if (target !== from + 1) return { ok: false, status: 400, error: 'Move up one level at a time.', stage: from };
    if (snap.killSwitch) {
      return { ok: false, status: 409, error: 'Your team is paused. Resume it before moving it up a level.', stage: from };
    }
    const check = canAdvanceStage({
      from,
      shadowReviewed: snap.workspace.shadowReviewed,
      shadowAgreed: snap.workspace.shadowAgreed,
      weeksInStage: snap.workspace.weeksInStage,
      stateDivergences: snap.workspace.stateDivergences,
      approvalRate: snap.workspace.approvalRate,
      decisionsInStage: snap.workspace.decisionsInStage,
    });
    if (check.ok) {
      kind = 'advance';
      note = reason ?? check.reason;
    } else if (input.force === true) {
      kind = 'override';
      note = reason ?? 'Moved up before the requirements were met.';
    } else {
      return { ok: false, status: 409, error: check.reason, stage: from, requirements: recommendation.requirements };
    }
  }

  await client.query('BEGIN');
  try {
    await writeRolloutStage(client, orgId, target);
    await client.query(
      `INSERT INTO org_autonomy_stage_events (org_id, from_stage, to_stage, kind, reason, evidence, actor_user_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [orgId, from, target, kind, note, JSON.stringify(evidence), userId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
  return { ok: true, unchanged: false, stage: target, from, kind, reason: note };
}
