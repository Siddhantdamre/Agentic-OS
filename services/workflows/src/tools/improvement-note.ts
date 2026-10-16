/**
 * "What should we improve?": reads where people corrected the AI (rejected drafts, thumbs-down) in the last 60
 * days, groups them by topic, and writes ONE plain-language suggestion for the owner. It only reads and reports.
 * Nothing is changed, scheduled or applied; any change goes through the approval and test rules in improve/.
 */
import { clusterFailures, proposalSummary, type FailureEvent } from '../improve/propose.js';
import { topicOf } from '../replay/grade.js';
import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk, withOrgScopedClient } from './shared.js';

const ACTIONS = ['read', 'propose'] as const;

function riskFor(_action: string): ToolRisk {
  return 'read';
}

const textOf = (payload: unknown): string => {
  if (!payload || typeof payload !== 'object') return '';
  const p = payload as Record<string, unknown>;
  return ['body', 'text', 'message', 'subject', 'draft'].map((k) => (typeof p[k] === 'string' ? (p[k] as string) : '')).join(' ').slice(0, 1000);
};

async function execute(ctx: ToolActionContext) {
  const { orgId, timestamp, actionName } = ctx;
  const base = { tool: 'improvement_note', action: actionName || 'read', timestamp };
  try {
    const events = await withOrgScopedClient(orgId, async (client) => {
      const out: FailureEvent[] = [];
      const rej = await client.query<{ id: string; payload: unknown }>(
        `SELECT id::text AS id, payload FROM agent_pending_actions
          WHERE org_id = $1 AND status = 'rejected' AND created_at >= NOW() - INTERVAL '60 days' LIMIT 500`,
        [orgId],
      );
      for (const r of rej.rows) out.push({ id: `rej:${r.id}`, kind: 'rejection', topic: topicOf(textOf(r.payload)) });
      const down = await client.query<{ id: string; comment: string | null }>(
        `SELECT id::text AS id, comment FROM ask_ai_feedback
          WHERE org_id = $1 AND vote = 'down' AND created_at >= NOW() - INTERVAL '60 days' LIMIT 500`,
        [orgId],
      );
      for (const d of down.rows) out.push({ id: `down:${d.id}`, kind: 'thumbs_down', topic: topicOf(d.comment ?? '') });
      return out;
    });
    const cluster = clusterFailures(events);
    if (!cluster) {
      return {
        ...base,
        status: 'executed' as const,
        message: 'Not enough corrections yet to suggest a change. I need at least 5 on one topic before I say anything.',
        data: { proposal: null, eventsSeen: events.length },
      };
    }
    const change = `Add clearer guidance for ${cluster.topic} replies, based on how you corrected them.`;
    return {
      ...base,
      status: 'executed' as const,
      message: proposalSummary({ cluster, change, kind: 'instruction' }),
      data: { proposal: { topic: cluster.topic, count: cluster.count, kind: 'instruction', applied: false }, eventsSeen: events.length },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...base, status: 'error' as const, message: `Improvement note unavailable: ${message}`, data: { proposal: null } };
  }
}

export const improvementNote: ToolModule = { actions: ACTIONS, risk: riskFor, confirm: confirmFromRisk(riskFor), execute };
