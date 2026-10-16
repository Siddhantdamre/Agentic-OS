import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import { clampBackfillWindow, observationHeadline } from '@/lib/onboarding-rollout';

export interface UnansweredThread { conversationId: string; lastUserAt: Date; snippet: string; }

export async function findUnansweredThreads(client: PoolClient, orgId: string): Promise<UnansweredThread[]> {
  const res = await client.query(
    `SELECT c.id AS conversation_id, last_user.created_at AS last_user_at, LEFT(last_user.content, 180) AS snippet
       FROM conversations c
       JOIN LATERAL (
         SELECT m.created_at, m.content, m.role FROM messages m
          WHERE m.conversation_id = c.id AND m.org_id = $1 ORDER BY m.created_at DESC LIMIT 1
       ) last_user ON TRUE
      WHERE c.org_id = $1 AND c.status <> 'resolved' AND last_user.role = 'user'
        AND last_user.created_at < NOW() - INTERVAL '2 hours'
      ORDER BY last_user.created_at ASC LIMIT 20`,
    [orgId]
  );
  return res.rows.map((row) => ({ conversationId: row.conversation_id, lastUserAt: new Date(row.last_user_at), snippet: String(row.snippet || '') }));
}

export async function persistFirstObservation(client: PoolClient, orgId: string, threads: UnansweredThread[]) {
  const dayLabel = threads[0]?.lastUserAt.toLocaleDateString('en-GB', { weekday: 'long' }) || 'recently';
  const headline = observationHeadline(threads.length, dayLabel);
  const detail = threads.length === 0 ? 'Connect a channel and I will surface unanswered threads here — no model, just the inbox.' : threads.map((t) => t.snippet).filter(Boolean).slice(0, 3).join(' · ');
  const ids = threads.map((t) => t.conversationId);
  const inserted = await client.query(`INSERT INTO org_first_observations (org_id, headline, detail, thread_count, conversation_ids) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [orgId, headline, detail, threads.length, ids]);
  await client.query(`UPDATE org_onboarding SET first_observation_shown_at = COALESCE(first_observation_shown_at, NOW()), first_observation_at = COALESCE(first_observation_at, NOW()), updated_at = NOW() WHERE org_id = $1`, [orgId]);
  return { id: inserted.rows[0].id, headline, detail, threadCount: threads.length, conversationIds: ids };
}

function contentHash(orgId: string, conversationId: string, summary: string): string {
  return createHash('sha256').update(`${orgId}|${conversationId}|${summary}|us`).digest('hex');
}

export async function runConversationBackfill(client: PoolClient, orgId: string, windowDays: number) {
  const days = clampBackfillWindow(windowDays);
  const convos = await client.query(
    `SELECT c.id, c.contact_id, c.summary, c.resolved_at, COALESCE((SELECT LEFT(m.content, 240) FROM messages m WHERE m.conversation_id = c.id AND m.org_id = $1 ORDER BY m.created_at ASC LIMIT 1), '') AS first_quote
       FROM conversations c WHERE c.org_id = $1 AND c.started_at >= NOW() - ($2::int * INTERVAL '1 day') AND c.resolved_at IS NOT NULL LIMIT 200`,
    [orgId, days]
  );
  let loopsImported = 0;
  for (const row of convos.rows) {
    const summary = String(row.summary || 'Resolved conversation').slice(0, 400);
    const inserted = await client.query(
      `INSERT INTO agent_open_loops (org_id, conversation_id, customer_identifier, obligor, promise_summary, source_quote, status, target_check_at, due_basis, assigned_employee_role, confidence, content_hash, closed_at, backfilled, resolution_notes)
       VALUES ($1, $2, $3, 'us', $4, $5, 'closed', NOW(), 'default', 'customer', 0.5, $6, COALESCE($7, NOW()), TRUE, 'imported closed — never chase')
       ON CONFLICT (org_id, content_hash) DO NOTHING`,
      [orgId, row.id, row.contact_id || 'unknown', summary, String(row.first_quote || summary).slice(0, 400), contentHash(orgId, row.id, summary), row.resolved_at]
    );
    loopsImported += inserted.rowCount || 0;
  }
  const won = await client.query(
    `SELECT c.id, c.contact_id, c.summary FROM conversations c
      WHERE c.org_id = $1 AND c.started_at >= NOW() - ($2::int * INTERVAL '1 day')
        AND (COALESCE(c.metadata->>'deal_stage','') IN ('closed_won','won') OR COALESCE(c.metadata->>'closed_won','') IN ('true','1')) LIMIT 50`,
    [orgId, days]
  );
  let wonImported = 0;
  for (const row of won.rows) {
    const body = String(row.summary || 'Closed-won account').slice(0, 800);
    const inserted = await client.query(
      `INSERT INTO entity_memory (org_id, entity_type, entity_id, kind, title, body, source, source_ref, content_hash, metadata)
       VALUES ($1, 'account', $2, 'closed_won', $3, $4, 'backfill', $5, $6, jsonb_build_object('backfilled', true, 'weighted', 'observed'))
       ON CONFLICT (org_id, source, source_ref, content_hash) DO NOTHING`,
      [orgId, row.contact_id || row.id, body.slice(0, 80), body, row.id, contentHash(orgId, `won:${row.id}`, body)]
    );
    wonImported += inserted.rowCount || 0;
  }
  await client.query(
    `INSERT INTO employee_autonomy_rules (org_id, action_type, employee_role, autonomy_tier, reversibility, requires_human_approval)
     SELECT $1, x.action_type, NULL, x.tier, x.rev, x.ask FROM (VALUES ('observe',1,'reversible',FALSE), ('internal_update',2,'reversible',FALSE), ('send_email',3,'visible',TRUE), ('refund_payment',4,'irreversible',TRUE)) AS x(action_type, tier, rev, ask)
      WHERE NOT EXISTS (SELECT 1 FROM employee_autonomy_rules r WHERE r.org_id = $1 AND r.action_type = x.action_type AND r.employee_role IS NULL)
     ON CONFLICT DO NOTHING`,
    [orgId]
  );
  return { loopsImported, wonImported };
}
