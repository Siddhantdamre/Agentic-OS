import { patched, proxyActivities } from '@temporalio/workflow';
import type * as governance from '../activities/sweep-governance.js';

const { sweepOrgActiveActivity } = proxyActivities<typeof governance>({
  startToCloseTimeout: '30 seconds',
  retry: { initialInterval: '2s', backoffCoefficient: 2, maximumAttempts: 5 },
});

/** Patch id for the per-pass org status gate. Keep stable: running histories depend on it. */
export const SWEEP_ORG_GATE_PATCH = 'sweep-org-gate-v1';

/**
 * Per-pass org status gate for periodic sweeps (OPS-G07). A suspended or
 * deleted org ends its sweep on the next pass instead of running until the
 * next worker boot. Guarded by patched() so histories recorded before the
 * gate existed still replay.
 */
export async function orgSweepAllowed(orgId: string): Promise<boolean> {
  if (!patched(SWEEP_ORG_GATE_PATCH)) return true;
  const { active } = await sweepOrgActiveActivity({ orgId });
  return active;
}
