/**
 * OE-05: capacity-aware routing for incoming leads. Assigns each unassigned
 * enquiry to whichever org rep currently has the fewest active enquiries
 * (pickLeastLoadedRep), skips the sweep entirely during the org's quiet
 * hours so reps are not paged with new work overnight, and mirrors the
 * assignment into HubSpot's contact owner via the existing hubspot tool
 * wrapper (best-effort — a CRM sync failure does not block the internal
 * assignment, since operational_enquiries is the source of truth here).
 */
import { isUndefinedTable, withOrgClient } from '../db.js';
import { inQuietHours } from './guarded-send.js';
import { pickLeastLoadedRep, type RepLoad } from '../operations/coordination.js';
import { registerExpectationFromRule } from '../operations/expected-vs-actual-engine.js';
import { executeAutonomousToolAction } from '../tool-executor.js';

export async function balanceWorkloadActivity(input: {
  orgId: string;
}): Promise<{ assigned: number; deferredForQuietHours: boolean }> {
  if (await inQuietHours(input.orgId)) {
    return { assigned: 0, deferredForQuietHours: true };
  }
  try {
    return await withOrgClient(input.orgId, async (client) => {
      const reps = await client.query<{ id: string; email: string; active_count: string; last_assigned_at: string | null }>(
        `SELECT u.id::text, u.email,
                COUNT(e.id) FILTER (WHERE e.state NOT IN ('closed')) AS active_count,
                MAX(e.updated_at)::text AS last_assigned_at
           FROM users u
           LEFT JOIN operational_enquiries e ON e.org_id = u.org_id AND e.assigned_owner_id = u.id
          WHERE u.org_id = $1
          GROUP BY u.id, u.email`,
        [input.orgId],
      );
      if (reps.rows.length === 0) return { assigned: 0, deferredForQuietHours: false };

      const loads: RepLoad[] = reps.rows.map((r) => ({
        repId: r.id,
        activeCount: Number(r.active_count || 0),
        lastAssignedAt: r.last_assigned_at,
      }));
      const emailById = new Map(reps.rows.map((r) => [r.id, r.email]));

      const pending = await client.query<{
        id: string; email: string | null; priority: string; created_at: string;
      }>(
        `SELECT id::text, metadata->>'contact_email' AS email, priority, created_at::text
           FROM operational_enquiries
          WHERE org_id = $1 AND state = 'new' AND assigned_owner_id IS NULL
          ORDER BY created_at ASC LIMIT 25`,
        [input.orgId],
      );

      let assigned = 0;
      for (const lead of pending.rows) {
        const repId = pickLeastLoadedRep(loads);
        if (!repId) break;

        await client.query(
          `UPDATE operational_enquiries
              SET assigned_owner_id = $1, state = 'assigned', updated_at = NOW()
            WHERE id = $2 AND org_id = $3 AND state = 'new'`,
          [repId, lead.id, input.orgId],
        );

        const repLoad = loads.find((r) => r.repId === repId);
        if (repLoad) {
          repLoad.activeCount += 1;
          repLoad.lastAssignedAt = new Date().toISOString();
        }
        assigned += 1;

        if (lead.priority === 'critical' || lead.priority === 'high') {
          await registerExpectationFromRule(client, {
            orgId: input.orgId,
            ruleName: 'hot_lead_contacted_within_2h',
            objectId: lead.id,
            triggeredAt: new Date(),
          }).catch(() => undefined);
        }

        const repEmail = emailById.get(repId);
        if (lead.email && repEmail) {
          await executeAutonomousToolAction({
            tool: 'hubspot',
            action: 'reassign_owner',
            payload: { email: lead.email, ownerEmail: repEmail },
            orgId: input.orgId,
            employeeRole: 'operations',
            source: 'sweep',
          }).catch(() => undefined);
        }
      }

      return { assigned, deferredForQuietHours: false };
    });
  } catch (err) {
    if (isUndefinedTable(err)) return { assigned: 0, deferredForQuietHours: false };
    throw err;
  }
}
