import { withOrgScopedClient } from '../tools/shared.js';

export interface RouteFactConflictsResult {
  routed: number;
  workItemIds: string[];
}

export async function routeActionImpactConflicts(orgId: string): Promise<RouteFactConflictsResult> {
  const workItemIds: string[] = [];
  const routed = await withOrgScopedClient(orgId, async (client) => {
    const open = await client.query<{
      id: string;
      subject_id: string;
      predicate: string;
      fact_a: string;
      fact_b: string;
    }>(
      `SELECT id, subject_id, predicate, fact_a, fact_b
         FROM fact_conflicts
        WHERE org_id = $1
          AND resolution = 'open'
          AND work_item_id IS NULL
        ORDER BY created_at ASC
        LIMIT 25`,
      [orgId]
    );

    let count = 0;
    for (const row of open.rows) {
      const item = await client.query<{ id: string }>(
        `INSERT INTO work_items (
           org_id, type, status, priority, metadata
         ) VALUES ($1, 'fact_conflict', 'open', 'high', $2::jsonb)
         RETURNING id`,
        [
          orgId,
          JSON.stringify({
            factConflictId: row.id,
            subjectId: row.subject_id,
            predicate: row.predicate,
            factA: row.fact_a,
            factB: row.fact_b,
            reason: 'action_impact',
          }),
        ]
      );
      const workItemId = item.rows[0]?.id;
      if (!workItemId) continue;
      await client.query(
        `UPDATE fact_conflicts
            SET work_item_id = $1
          WHERE id = $2 AND org_id = $3 AND work_item_id IS NULL`,
        [workItemId, row.id, orgId]
      );
      workItemIds.push(workItemId);
      count += 1;
    }
    return count;
  });

  return { routed, workItemIds };
}
