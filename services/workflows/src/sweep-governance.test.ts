import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  BREACH_SLA_SQL,
  EXPIRE_DECISIONS_SQL,
  isoWeekKey,
  isSweepRunnableStatus,
  localDateKey,
} from './activities/sweep-governance.js';
import { PERIODIC_SWEEPS, startSweepsForOrg, type SweepStartClient } from './periodic-registry.js';

test('only active/provisioning orgs keep running sweeps', () => {
  assert.equal(isSweepRunnableStatus('active'), true);
  assert.equal(isSweepRunnableStatus('provisioning'), true);
  for (const s of ['suspended', 'soft_deleted', 'past_due', '', null, undefined]) {
    assert.equal(isSweepRunnableStatus(s as string), false, String(s));
  }
});

test('brief claim key follows the org-local date, not UTC', () => {
  const t = new Date('2026-09-28T20:30:00Z');
  assert.equal(localDateKey(t, 'UTC'), '2026-09-28');
  assert.equal(localDateKey(t, 'Asia/Kolkata'), '2026-09-29');
  assert.equal(localDateKey(t, 'Not/AZone'), '2026-09-28');
});

test('iso week key', () => {
  assert.equal(isoWeekKey(new Date('2026-01-01T00:00:00Z')), '2026-W01');
  assert.equal(isoWeekKey(new Date('2026-09-28T12:00:00Z')), '2026-W40');
});

test('expiry never approves and leaves decided_by empty', () => {
  assert.match(EXPIRE_DECISIONS_SQL, /SET status = 'expired'/);
  assert.match(EXPIRE_DECISIONS_SQL, /decided_by = NULL/);
  assert.match(EXPIRE_DECISIONS_SQL, /status = 'pending'/);
  assert.doesNotMatch(EXPIRE_DECISIONS_SQL, /'approved'/);
  assert.match(BREACH_SLA_SQL, /sla_breached_at IS NULL/);
});

test('one sweep list: includes governance + dormant revival, all registered in workflows/index', () => {
  const types = PERIODIC_SWEEPS.map((s) => s.workflowType);
  assert.ok(types.includes('GovernanceSweepWorkflow'));
  assert.ok(types.includes('DormantLeadRevivalWorkflow'));
  assert.equal(new Set(types).size, types.length);
  const ids = PERIODIC_SWEEPS.map((s) => s.id('org-1'));
  assert.equal(new Set(ids).size, ids.length);
  const indexSrc = readFileSync(path.join(__dirname, 'workflows', 'index.js'), 'utf8');
  for (const t of types) {
    assert.match(indexSrc, new RegExp(`\\b${t}\\b`), `${t} not exported from workflows/index`);
  }
});

test('startSweepsForOrg restarts ended sweeps and tolerates running ones', async () => {
  const calls: Array<{ type: string; opts: { args: unknown[]; workflowIdReusePolicy: string } }> = [];
  const client: SweepStartClient = {
    workflow: {
      start: async (type, opts) => {
        calls.push({ type, opts });
        if (type === 'OpenLoopMonitorWorkflow') {
          const err = new Error('already');
          err.name = 'WorkflowExecutionAlreadyStartedError';
          throw err;
        }
        return {};
      },
    },
  };
  const counts = await startSweepsForOrg(client, 'org-1');
  assert.equal(counts.already, 1);
  assert.equal(counts.started, PERIODIC_SWEEPS.length - 1);
  assert.ok(calls.every((c) => c.opts.workflowIdReusePolicy === 'ALLOW_DUPLICATE'));
  const dormant = calls.find((c) => c.type === 'DormantLeadRevivalWorkflow');
  assert.deepEqual(dormant?.opts.args, [{ orgId: 'org-1', repeat: true }]);
});
