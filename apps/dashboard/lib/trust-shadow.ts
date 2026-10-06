/**
 * Watching-mode decisions and the operator's answers about them.
 *
 * In level 0 an employee records what it WOULD have done and does none of it. A person reads each
 * one and says whether they would have done the same. Those answers, counted from the review table,
 * are the evidence for leaving level 0 (see employee-rollout.ts).
 */
import type { PoolClient } from 'pg';

const MAX_SENTENCE = 240;
export const FALLBACK_ACTION = 'An action it would have taken';

function words(id: string): string {
  return id.replace(/[_-]+/g, ' ').trim();
}

/** A sentence a person can read: the saved one when present, else the action id turned into words. */
export function describeShadowAction(summary: string | null | undefined, actionId: string | null | undefined): string {
  const saved = typeof summary === 'string' ? summary.trim() : '';
  let text: string;
  if (saved) {
    text = saved;
  } else if (typeof actionId === 'string' && actionId.trim()) {
    const [first, ...rest] = actionId.trim().split('.');
    const act = words(rest.join(' '));
    const tool = words(first);
    text = act ? `${tool.charAt(0).toUpperCase()}${tool.slice(1)}: ${act}` : `${tool.charAt(0).toUpperCase()}${tool.slice(1)}`;
  } else {
    text = FALLBACK_ACTION;
  }
  return text.length > MAX_SENTENCE ? `${text.slice(0, MAX_SENTENCE - 1)}…` : text;
}

export interface ShadowItem {
  id: string;
  employee: string;
  what: string;
  at: string;
}

export interface ShadowCounts {
  waiting: number;
  reviewed: number;
  agreed: number;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function shadowCounts(client: PoolClient, orgId: string): Promise<ShadowCounts> {
  const res = await client.query(
    `SELECT COUNT(*) FILTER (WHERE r.id IS NULL)    AS waiting,
            COUNT(*) FILTER (WHERE r.id IS NOT NULL) AS reviewed,
            COUNT(*) FILTER (WHERE r.agreed)         AS agreed
       FROM agent_decision_ledger l
       LEFT JOIN agent_shadow_reviews r ON r.ledger_id = l.id AND r.org_id = l.org_id
      WHERE l.org_id = $1 AND l.decision = 'suppressed' AND l.reason_code = 'shadow_stage'`,
    [orgId],
  );
  return { waiting: num(res.rows[0]?.waiting), reviewed: num(res.rows[0]?.reviewed), agreed: num(res.rows[0]?.agreed) };
}

export async function listShadowDecisions(client: PoolClient, orgId: string, limit = 20): Promise<ShadowItem[]> {
  const res = await client.query(
    `SELECT l.id::text AS id, l.created_at, l.employee_role, l.action_considered,
            l.context_payload ->> 'summary' AS summary, e.name AS employee_name
       FROM agent_decision_ledger l
       LEFT JOIN agent_shadow_reviews r ON r.ledger_id = l.id AND r.org_id = l.org_id
       LEFT JOIN ai_employees e ON e.id = l.employee_id AND e.org_id = l.org_id
      WHERE l.org_id = $1 AND l.decision = 'suppressed' AND l.reason_code = 'shadow_stage' AND r.id IS NULL
      ORDER BY l.created_at DESC
      LIMIT $2`,
    [orgId, Math.max(1, Math.min(50, Math.floor(limit)))],
  );
  return res.rows.map((r) => ({
    id: String(r.id),
    employee: String(r.employee_name || r.employee_role || 'Your team'),
    what: describeShadowAction(r.summary, r.action_considered),
    at: new Date(r.created_at).toISOString(),
  }));
}

/** Records (or changes) one answer. 'not_found' when the id is not a watching-mode decision of this workspace. */
export async function recordShadowReview(
  client: PoolClient,
  orgId: string,
  userId: string,
  ledgerId: string,
  agreed: boolean,
): Promise<'ok' | 'not_found'> {
  const exists = await client.query(
    `SELECT id FROM agent_decision_ledger
      WHERE id = $1 AND org_id = $2 AND decision = 'suppressed' AND reason_code = 'shadow_stage'`,
    [ledgerId, orgId],
  );
  if (exists.rows.length === 0) return 'not_found';
  await client.query(
    `INSERT INTO agent_shadow_reviews (org_id, ledger_id, agreed, reviewed_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (ledger_id) DO UPDATE SET agreed = EXCLUDED.agreed, reviewed_by = EXCLUDED.reviewed_by, reviewed_at = NOW()`,
    [orgId, ledgerId, agreed, userId],
  );
  return 'ok';
}
