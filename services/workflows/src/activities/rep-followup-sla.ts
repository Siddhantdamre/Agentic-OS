/**
 * OE-04: rep-inactivity SLA sentinel. A high-value lead (state='assigned',
 * priority critical/high) that sits untouched past 3 hours gets a private
 * nudge to the assigned rep; if still untouched 2 hours after the nudge, it
 * escalates to the org's manager channel. Nudge/escalation state is tracked
 * in operational_enquiries.metadata so this activity is idempotent across
 * repeated sweeps — it never double-nudges or double-escalates the same
 * enquiry.
 */
import { isUndefinedTable, withOrgClient } from '../db.js';
import { executeAutonomousToolAction } from '../tool-executor.js';
import { logDecision } from '../operations/decision-ledger.js';

const NUDGE_SLA_HOURS = 3;
const ESCALATION_SLA_HOURS = 2;

type ColdLeadRow = {
  id: string;
  customer_name: string | null;
  company_name: string | null;
  rep_email: string | null;
};

async function opsChannel(client: import('pg').PoolClient, orgId: string, key: string, fallback: string): Promise<string> {
  const res = await client.query<{ channel: string | null }>(
    `SELECT NULLIF(meta->>$2, '') AS channel FROM orgs WHERE id = $1`,
    [orgId, key],
  );
  return res.rows[0]?.channel || fallback;
}

export async function runRepFollowUpSlaActivity(input: {
  orgId: string;
}): Promise<{ nudged: number; escalated: number }> {
  try {
    return await withOrgClient(input.orgId, async (client) => {
      let nudged = 0;
      let escalated = 0;

      const cold = await client.query<ColdLeadRow>(
        `SELECT e.id::text, e.customer_name, e.company_name, u.email AS rep_email
           FROM operational_enquiries e
           JOIN users u ON u.id = e.assigned_owner_id
          WHERE e.org_id = $1 AND e.state = 'assigned'
            AND e.priority IN ('critical', 'high')
            AND e.updated_at <= NOW() - ($2 || ' hours')::interval
            AND e.metadata->>'rep_nudge_sent_at' IS NULL
          ORDER BY e.updated_at ASC
          LIMIT 25`,
        [input.orgId, String(NUDGE_SLA_HOURS)],
      );
      const nudgeChannel = await opsChannel(client, input.orgId, 'ops_slack_channel', '#general');
      for (const row of cold.rows) {
        const lead = row.company_name || row.customer_name || row.id;
        const message =
          `Heads up @${row.rep_email || 'rep'} — the lead *${lead}* has been assigned to you for ` +
          `over ${NUDGE_SLA_HOURS} hours with no contact logged yet. Reply here once you've reached out, ` +
          `or reassign it if you can't get to it.`;
        const result = await executeAutonomousToolAction({
          tool: 'slack',
          action: 'send_channel_message',
          payload: { channel: nudgeChannel, message },
          orgId: input.orgId,
          employeeRole: 'operations',
          source: 'sweep',
        });
        const sent = result?.status === 'executed';
        await client.query(
          `UPDATE operational_enquiries
              SET metadata = jsonb_set(metadata, '{rep_nudge_sent_at}', to_jsonb(NOW()::text)), updated_at = updated_at
            WHERE id = $1 AND org_id = $2`,
          [row.id, input.orgId],
        );
        await logDecision(client, {
          orgId: input.orgId,
          employeeRole: 'operations',
          actionConsidered: 'rep_followup_nudge',
          decision: sent ? 'executed' : 'deferred',
          reasonCode: sent ? 'executed' : 'missing_connector_scope',
          reasonSummary: sent
            ? `Nudged rep about cold lead ${lead} via Slack.`
            : `Rep nudge for cold lead ${lead} could not be delivered: ${result?.message || 'slack not connected'}.`,
          confidence: 1,
          entityId: row.id,
        });
        nudged += 1;
      }

      const overdue = await client.query<ColdLeadRow>(
        `SELECT e.id::text, e.customer_name, e.company_name, u.email AS rep_email
           FROM operational_enquiries e
           JOIN users u ON u.id = e.assigned_owner_id
          WHERE e.org_id = $1 AND e.state = 'assigned'
            AND e.metadata->>'rep_nudge_sent_at' IS NOT NULL
            AND (e.metadata->>'rep_nudge_sent_at')::timestamptz <= NOW() - ($2 || ' hours')::interval
            AND e.metadata->>'rep_escalated_at' IS NULL
          ORDER BY e.updated_at ASC
          LIMIT 25`,
        [input.orgId, String(ESCALATION_SLA_HOURS)],
      );
      const managerChannel = await opsChannel(client, input.orgId, 'manager_slack_channel', nudgeChannel);
      for (const row of overdue.rows) {
        const lead = row.company_name || row.customer_name || row.id;
        const message =
          `Escalation: lead *${lead}* assigned to ${row.rep_email || 'a rep'} is still uncontacted ` +
          `${NUDGE_SLA_HOURS + ESCALATION_SLA_HOURS}+ hours after assignment despite a nudge. Needs manager attention.`;
        const result = await executeAutonomousToolAction({
          tool: 'slack',
          action: 'send_channel_message',
          payload: { channel: managerChannel, message },
          orgId: input.orgId,
          employeeRole: 'operations',
          source: 'sweep',
        });
        const sent = result?.status === 'executed';
        await client.query(
          `UPDATE operational_enquiries
              SET metadata = jsonb_set(metadata, '{rep_escalated_at}', to_jsonb(NOW()::text)), updated_at = updated_at
            WHERE id = $1 AND org_id = $2`,
          [row.id, input.orgId],
        );
        await logDecision(client, {
          orgId: input.orgId,
          employeeRole: 'operations',
          actionConsidered: 'rep_followup_escalation',
          decision: sent ? 'escalated' : 'deferred',
          reasonCode: sent ? 'executed' : 'missing_connector_scope',
          reasonSummary: sent
            ? `Escalated cold lead ${lead} to manager channel.`
            : `Escalation for cold lead ${lead} could not be delivered: ${result?.message || 'slack not connected'}.`,
          confidence: 1,
          entityId: row.id,
        });
        escalated += 1;
      }

      return { nudged, escalated };
    });
  } catch (err) {
    if (isUndefinedTable(err)) return { nudged: 0, escalated: 0 };
    throw err;
  }
}
