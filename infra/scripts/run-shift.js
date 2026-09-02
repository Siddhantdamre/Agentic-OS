#!/usr/bin/env node
'use strict';
/**
 * A SHIFT — every employee does its own job, or says why it cannot.
 *
 * Work only ever reached an employee as an inbound customer message. With no
 * channel connected that meant no work at all: eight of nine employees in the
 * demo workspace held zero actions and zero threads while the roster looked
 * fully staffed. The permission model was enforced the whole time and governed
 * nothing.
 *
 * A shift runs each employee's standing duty (services/workflows/src/duties.ts)
 * through AutonomousAgentWorkflow — the same engine that handles a customer
 * message, so the tool loop, allowlist check, critic, supervision and
 * attribution all apply unchanged.
 *
 * Two properties worth knowing before running it unattended:
 *
 *   A duty LOOKS AND REPORTS. Nothing sends, books, charges or replies.
 *   A duty runs with the MINIMUM TOOL, not the employee's full authority —
 *   Sarah holds gmail and whatsapp; her duty runs with database_query alone.
 *
 * Both are asserted in duties.test.js, 16/16.
 *
 * Usage:
 *   node infra/scripts/run-shift.js                    # plan only, every org
 *   node infra/scripts/run-shift.js --org <uuid>       # plan one workspace
 *   node infra/scripts/run-shift.js --org <uuid> --run # actually dispatch
 */
const path = require('path');
require('./lib/env').loadRepoEnv();

const ROOT = path.join(__dirname, '..', '..');

// 127.0.0.1, never 'localhost' — Node resolves localhost to IPv6 ::1 first and
// Docker's published port resets that path. Same trap as check-e2e-inbound.js.
if (!process.env.TEMPORAL_ADDRESS) process.env.TEMPORAL_ADDRESS = '127.0.0.1:7233';

let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(ROOT, 'apps/dashboard/node_modules/pg')).Client; }

const { planDuty, explainBlock } = require(path.join(ROOT, 'services/workflows/dist/duties.js'));

const args = process.argv.slice(2);
const DO_RUN = args.includes('--run');
const ORG = args.includes('--org') ? args[args.indexOf('--org') + 1] : null;

const db = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

const line = (s = '') => console.log(s);

/**
 * Which OAuth providers this workspace has actually consented to.
 *
 * Read from Nango's own connection table, never from an environment variable:
 * a client id in the environment means the operator *can* offer a provider, not
 * that this tenant has connected it. Conflating those would report every
 * workspace as connected the moment one OAuth app existed.
 */
async function liveOauthProviders(orgId) {
  const n = new Client({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_RESOLVER_USER || 'darex',
    password: process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
    database: 'nango',
  });
  try {
    await n.connect();
    const rows = (await n.query(
      `SELECT DISTINCT provider_config_key FROM nango._nango_connections
        WHERE connection_id LIKE $1`, [`${orgId}%`]
    )).rows;
    return rows.map((r) => String(r.provider_config_key));
  } catch {
    return []; // Nango unreachable: nothing is connected, which is the safe read.
  } finally {
    await n.end().catch(() => {});
  }
}

(async () => {
  await db.connect();
  line('\n╔══════════════════════════════════════════════════════════════════════╗');
  line('║  SHIFT — what each employee does when nobody has asked                ║');
  line('╚══════════════════════════════════════════════════════════════════════╝\n');

  const orgs = (await db.query(
    ORG
      ? `SELECT id, name FROM orgs WHERE id = $1`
      : `SELECT o.id, o.name FROM orgs o
           JOIN ai_employees e ON e.org_id = o.id AND e.status = 'active'
          WHERE EXISTS (SELECT 1 FROM conversations c WHERE c.org_id = o.id)
          GROUP BY o.id, o.name HAVING COUNT(DISTINCT e.id) > 1`,
    ORG ? [ORG] : []
  )).rows;

  if (orgs.length === 0) {
    line('  No workspace matched.\n');
    await db.end().catch(() => {});
    return;
  }

  let client = null;
  if (DO_RUN) {
    const { getTemporalClient } = require(path.join(ROOT, 'services/workflows/dist/workflow-client.js'));
    client = await getTemporalClient();
    if (!client) {
      line('  Temporal is unreachable — planning only, nothing dispatched.\n');
    }
  }

  let dispatched = 0;
  let blocked = 0;

  for (const org of orgs) {
    const staff = (await db.query(
      `SELECT id, name, role, tool_allowlist FROM ai_employees
        WHERE org_id = $1 AND status = 'active' ORDER BY name`, [org.id]
    )).rows;

    const connected = await liveOauthProviders(org.id);

    line(`  ${org.name}   —   ${staff.length} active, ${connected.length} provider(s) connected\n`);
    line(`  ${'EMPLOYEE'.padEnd(11)}${'ROLE'.padEnd(24)}${'TOOL'.padEnd(17)}WILL IT RUN`);

    for (const s of staff) {
      const plan = planDuty(
        { id: s.id, name: s.name, role: s.role, toolAllowlist: s.tool_allowlist || [] },
        process.env,
        connected
      );

      const verdict = plan.runnable
        ? 'yes'
        : plan.blockedBecause === 'not-connected' ? 'no — not connected'
          : plan.blockedBecause === 'not-permitted' ? 'no — not permitted'
            : 'no — no duty for this role';

      line(`  ${String(s.name).slice(0, 9).padEnd(11)}`
        + `${String(s.role).slice(0, 22).padEnd(24)}`
        + `${String(plan.duty?.needs || '—').padEnd(17)}${verdict}`);

      if (!plan.runnable) { blocked += 1; continue; }
      if (!DO_RUN || !client) { dispatched += 1; continue; }

      // One shift per employee per day. The id makes a second run today a
      // no-op rather than a second pass over the same work.
      const day = new Date().toISOString().slice(0, 10);
      const workflowId = `shift:${org.id}:${s.id}:${day}`;
      try {
        await client.workflow.start('AutonomousAgentWorkflow', {
          taskQueue: process.env.TEMPORAL_TASK_QUEUE || 'darex-agent-tasks',
          workflowId,
          args: [{
            orgId: org.id,
            employeeId: s.id,
            employeeName: s.name,
            employeeRole: s.role,
            employeePersona: plan.duty.summary,
            // The minimum tool, not the employee's authority.
            toolAllowlist: plan.dutyAllowlist,
            userMessage: plan.duty.instruction,
            // A duty is not a customer conversation and must not become one.
            skipPersist: true,
            idempotencyKey: workflowId,
          }],
        });
        dispatched += 1;
      } catch (err) {
        const msg = String(err?.message || err);
        if (/already started|AlreadyStarted/i.test(msg)) {
          line(`             (already ran today)`);
        } else {
          line(`             DISPATCH FAILED — ${msg.slice(0, 60)}`);
        }
      }
    }

    // Say the blocks out loud. A row reading "no" is a fact; the sentence
    // underneath is what an operator can act on.
    const blockedPlans = staff
      .map((s) => planDuty(
        { id: s.id, name: s.name, role: s.role, toolAllowlist: s.tool_allowlist || [] },
        process.env, connected
      ))
      .filter((p) => !p.runnable);

    if (blockedPlans.length) {
      line('');
      for (const p of blockedPlans) line(`    ${explainBlock(p)}`);
    }
    line('');
  }

  await db.end().catch(() => {});

  if (DO_RUN && client) {
    line(`  ${dispatched} shift(s) dispatched, ${blocked} blocked.\n`);
  } else {
    line(`  ${dispatched} would run, ${blocked} blocked. Pass --run to dispatch.\n`);
  }
})().catch(async (e) => {
  line(`\n  ERROR: ${e.message}\n`);
  try { await db.end(); } catch { /* closed */ }
  process.exit(1);
});
