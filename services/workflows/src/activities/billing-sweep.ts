import { Context } from '@temporalio/activity';
import { listBillableOrgIds, refreshOrgMetersInWorker } from '../billing/meter-refresh.js';

export type BillingSweepResult = {
  orgs: number;
  refreshed: number;
  failed: number;
  overHardOrgs: number;
};

function heartbeat(details: unknown): void {
  try {
    Context.current().heartbeat(details);
  } catch {
    // Called outside an activity context (tests): nothing to heartbeat.
  }
}

/**
 * BIZ-B01: refresh billing_meters for every billable org so the usage gate
 * never reads a row older than one sweep interval. One org failing does not
 * stop the rest; failures are logged with the org id and counted.
 */
export async function refreshAllOrgMetersActivity(): Promise<BillingSweepResult> {
  const orgIds = await listBillableOrgIds();
  let refreshed = 0;
  let failed = 0;
  let overHardOrgs = 0;
  for (const orgId of orgIds) {
    try {
      const res = await refreshOrgMetersInWorker(orgId);
      refreshed += 1;
      if (res.overHard.length > 0) overHardOrgs += 1;
    } catch (err) {
      failed += 1;
      console.error(
        `[billing-sweep] meter refresh failed for org ${orgId}:`,
        err instanceof Error ? err.message : err
      );
    }
    heartbeat({ done: refreshed + failed, total: orgIds.length });
  }
  return { orgs: orgIds.length, refreshed, failed, overHardOrgs };
}
