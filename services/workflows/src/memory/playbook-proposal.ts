import { withOrgScopedClient } from '../tools/shared.js';

export interface ProposePlaybookInput {
  orgId: string;
  employeeRole: string;
  shapeKey: string;
  steps: unknown[];
  summary: string;
}

export interface ProposePlaybookResult {
  proposed: boolean;
  workItemId?: string;
  count: number;
}

function threshold(): number {
  const n = Number(process.env.PLAYBOOK_PROPOSAL_THRESHOLD || '5');
  return Number.isFinite(n) && n >= 2 ? n : 5;
}

export async function maybeProposePlaybook(input: ProposePlaybookInput): Promise<ProposePlaybookResult> {
  const min = threshold();
  return withOrgScopedClient(input.orgId, async (client) => {
    const counted = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM work_items
        WHERE org_id = $1
          AND type = $2
          AND status IN ('done', 'completed', 'closed')
          AND COALESCE(metadata->>'shapeKey', metadata->>'shape_key') = $3`,
      [input.orgId, input.employeeRole, input.shapeKey]
    ).catch(async () => {
      const fallback = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n
           FROM work_items
          WHERE org_id = $1
            AND COALESCE(metadata->>'shapeKey', metadata->>'shape_key') = $2
            AND status IN ('done', 'completed', 'closed')`,
        [input.orgId, input.shapeKey]
      );
      return fallback;
    });
    const count = Number(counted.rows[0]?.n || 0);
    if (count < min) return { proposed: false, count };

    const existing = await client.query<{ id: string }>(
      `SELECT id FROM work_items
        WHERE org_id = $1
          AND type = 'playbook_proposal'
          AND status = 'open'
          AND COALESCE(metadata->>'shapeKey', '') = $2
        LIMIT 1`,
      [input.orgId, input.shapeKey]
    );
    if (existing.rows[0]) {
      return { proposed: false, workItemId: existing.rows[0].id, count };
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO work_items (org_id, type, status, priority, metadata)
       VALUES ($1, 'playbook_proposal', 'open', 'normal', $2::jsonb)
       RETURNING id`,
      [
        input.orgId,
        JSON.stringify({
          shapeKey: input.shapeKey,
          employeeRole: input.employeeRole,
          steps: input.steps,
          summary: input.summary,
          repeatCount: count,
          card: {
            title: 'Promote this as a standard procedure?',
            body: `I've handled this ${count} times the same way. A human must name it before it becomes an org playbook.`,
          },
        }),
      ]
    );
    return { proposed: true, workItemId: inserted.rows[0]?.id, count };
  });
}
