import { withOrgClient } from './db.js';
import type { HealthRecord } from './activity-health.js';

/** Upserts the heartbeat row. Called through activityHealthInterceptor, which swallows any failure. */
export async function recordActivityHealth(r: HealthRecord): Promise<void> {
  await withOrgClient(r.orgId, async (client) => {
    await client.query(
      `INSERT INTO agent_activity_health (org_id, activity, last_ok_at, last_error_at, last_error, ok_count, fail_count)
       VALUES ($1, $2, CASE WHEN $3 THEN NOW() END, CASE WHEN $3 THEN NULL ELSE NOW() END, $4,
               CASE WHEN $3 THEN 1 ELSE 0 END, CASE WHEN $3 THEN 0 ELSE 1 END)
       ON CONFLICT (org_id, activity) DO UPDATE SET
         last_ok_at    = CASE WHEN $3 THEN NOW() ELSE agent_activity_health.last_ok_at END,
         last_error_at = CASE WHEN $3 THEN agent_activity_health.last_error_at ELSE NOW() END,
         last_error    = CASE WHEN $3 THEN agent_activity_health.last_error ELSE $4 END,
         ok_count      = agent_activity_health.ok_count + CASE WHEN $3 THEN 1 ELSE 0 END,
         fail_count    = agent_activity_health.fail_count + CASE WHEN $3 THEN 0 ELSE 1 END,
         updated_at    = NOW()`,
      [r.orgId, r.activity, r.ok, r.error],
    );
  });
}
