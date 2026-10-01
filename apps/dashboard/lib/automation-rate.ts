/**
 * Single definition of "Automation Rate" shared by Home (/api/dashboard/stats)
 * and Analytics (/api/analytics): the share of conversations that had at least
 * one message in the window and got at least one assistant reply.
 */

export interface AutomationRateQueryable {
  query: (
    text: string,
    values?: unknown[]
  ) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface AutomationRate {
  withMessages: number;
  aiHandled: number;
  /** Whole-number percent, or null when there were no conversations in the window. */
  rate: number | null;
}

export function computeAutomationRate(withMessages: number, aiHandled: number): number | null {
  if (!Number.isFinite(withMessages) || withMessages <= 0) return null;
  const handled = Math.min(Math.max(aiHandled, 0), withMessages);
  return Math.round((handled / withMessages) * 100);
}

/** `interval` is a Postgres interval literal such as '7 days' (bound as a parameter). */
export async function queryAutomationRate(
  client: AutomationRateQueryable,
  orgId: string,
  interval: string
): Promise<AutomationRate> {
  const res = await client.query(
    `SELECT
       COUNT(DISTINCT conversation_id) AS with_messages,
       COUNT(DISTINCT conversation_id) FILTER (WHERE role = 'assistant') AS ai_handled
     FROM messages
     WHERE org_id = $1 AND created_at >= NOW() - $2::interval`,
    [orgId, interval]
  );
  const withMessages = parseInt(String(res.rows[0]?.with_messages ?? '0'), 10) || 0;
  const aiHandled = parseInt(String(res.rows[0]?.ai_handled ?? '0'), 10) || 0;
  return { withMessages, aiHandled, rate: computeAutomationRate(withMessages, aiHandled) };
}
