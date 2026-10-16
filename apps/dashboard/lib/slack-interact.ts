import { createHmac, timingSafeEqual } from 'crypto';
import { getOrgScopedClient } from '@/lib/db';
import { getNangoConnection } from '@/lib/nango-server';
import { signalWorkItemDecision } from '@darex/workflows/dist/workflow-client';

export interface SlackButtonPayload {
  workItemId: string;
  decision: 'approve' | 'reject';
  orgId?: string;
  /** Slack workspace that sent the interaction (`team.id`). */
  teamId?: string;
  workflowId?: string | null;
}

export function verifySlackSignature(params: {
  signingSecret: string;
  timestamp: string;
  rawBody: string;
  signature: string;
}): boolean {
  const { signingSecret, timestamp, rawBody, signature } = params;
  if (!signingSecret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const skewSec = Math.abs(Date.now() / 1000 - ts);
  if (skewSec > 60 * 5) return false;
  const base = `v0:${timestamp}:${rawBody}`;
  const digest = `v0=${createHmac('sha256', signingSecret).update(base).digest('hex')}`;
  const a = Buffer.from(digest);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function parseSlackInteraction(rawBody: string): SlackButtonPayload | null {
  let parsed: Record<string, any>;
  try {
    const params = new URLSearchParams(rawBody);
    const payload = params.get('payload') || rawBody;
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  const action = Array.isArray(parsed.actions) ? parsed.actions[0] : null;
  if (!action) return null;
  let value: Record<string, unknown> = {};
  try {
    value = typeof action.value === 'string' ? JSON.parse(action.value) : (action.value || {});
  } catch {
    value = {};
  }
  const workItemId = String(value.workItemId || value.work_item_id || '');
  const decisionRaw = String(value.decision || action.action_id || '').toLowerCase();
  const decision = decisionRaw.includes('reject') ? 'reject' : decisionRaw.includes('approve') ? 'approve' : null;
  if (!workItemId || !decision) return null;
  const teamRaw = parsed.team?.id ?? parsed.user?.team_id;
  return {
    workItemId,
    decision,
    orgId: typeof value.orgId === 'string' ? value.orgId : undefined,
    teamId: typeof teamRaw === 'string' && teamRaw ? teamRaw : undefined,
  };
}

/**
 * Slack workspace id bound to an org's Slack connection. Nango keeps the
 * OAuth v2 response under `credentials.raw.team.id`; some provider configs
 * surface it as `connection_config["team.id"]`.
 */
export function slackTeamIdFromConnection(conn: unknown): string | null {
  if (!conn || typeof conn !== 'object') return null;
  const c = conn as Record<string, any>;
  const candidates = [
    c.credentials?.raw?.team?.id,
    c.connection_config?.['team.id'],
    c.connection_config?.team?.id,
    c.connection_config?.team_id,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * The Slack signature only proves the request came from Slack, not from the
 * org's workspace. `orgId` in the button value is a claim: accept it only
 * when that org's connected Slack workspace is the one that clicked (CH-S02).
 */
export async function assertSlackTeamMatchesOrg(
  payload: SlackButtonPayload,
  loadConnection: (orgId: string) => Promise<unknown> = (orgId) => getNangoConnection(orgId, 'slack')
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!payload.orgId) return { ok: false, reason: 'missing_org' };
  if (!payload.teamId) return { ok: false, reason: 'missing_team' };
  const bound = slackTeamIdFromConnection(await loadConnection(payload.orgId));
  if (!bound) return { ok: false, reason: 'org_has_no_slack_workspace' };
  if (bound !== payload.teamId) return { ok: false, reason: 'team_mismatch' };
  return { ok: true };
}

export async function persistSlackDecision(payload: SlackButtonPayload): Promise<{
  orgId: string;
  workItemId: string;
  decision: 'approve' | 'reject';
  workflowId: string | null;
}> {
  if (!payload.orgId) {
    throw new Error('orgId is required to persist a Slack decision');
  }
  const { client, orgId } = await getOrgScopedClient(payload.orgId);
  try {
    const existing = await client.query<{
      id: string;
      temporal_workflow_id: string | null;
      metadata: Record<string, unknown> | null;
    }>(
      `SELECT id, temporal_workflow_id, metadata
         FROM work_items
        WHERE id = $1 AND org_id = $2`,
      [payload.workItemId, orgId]
    );
    const row = existing.rows[0];
    if (!row) throw new Error('Work item not found');
    const status = payload.decision === 'reject' ? 'cancelled' : 'in_progress';
    const metadata = { ...(row.metadata || {}), slackDecision: payload.decision };
    await client.query(
      `UPDATE work_items
          SET status = $1, metadata = $2::jsonb, updated_at = NOW()
        WHERE id = $3 AND org_id = $4`,
      [status, JSON.stringify(metadata), payload.workItemId, orgId]
    );
    await client.query(
      `INSERT INTO work_events (org_id, work_item_id, kind, payload, actor)
       VALUES ($1, $2, $3, $4::jsonb, 'slack')`,
      [
        orgId,
        payload.workItemId,
        payload.decision === 'reject' ? 'card_rejected' : 'card_approved',
        JSON.stringify({ source: 'slack', decision: payload.decision }),
      ]
    );
    return {
      orgId,
      workItemId: payload.workItemId,
      decision: payload.decision,
      workflowId: row.temporal_workflow_id,
    };
  } finally {
    client.release();
  }
}

export async function fireSlackDecisionSignal(workflowId: string | null, decision: 'approve' | 'reject'): Promise<void> {
  if (!workflowId) return;
  await signalWorkItemDecision({
    workflowId,
    decision: decision === 'reject' ? 'rejected' : 'approved',
  });
}
