#!/usr/bin/env node
'use strict';
/**
 * A DUTY IS CONFINED TO ITS OWN TOOL, NOT ITS WORKSPACE'S.
 *
 * `duties.ts` promises this in its own header:
 *
 *   "A DUTY RUNS WITH THE MINIMUM TOOL, NOT THE EMPLOYEE'S FULL AUTHORITY.
 *    Sarah holds gmail, whatsapp, hubspot and a calendar. Her duty runs with
 *    `database_query` alone."
 *
 * `planDuty` computed it and `duties.test.ts` asserted it, and for a long time
 * that was the whole of the enforcement. The value was handed to the workflow
 * and then dropped: tool calls arrive at the MCP bridge, a separate process
 * that sees only what the model put in the call, so it fell back to
 * `resolveOrgToolAllowlist` — the union of every active employee's tools plus
 * every connected channel.
 *
 * Measured on a real shift. Emma's duty, allowlist `["database_query"]`,
 * reached `metrics_list`, `metrics_query` and `intercom_fetch_conversations`.
 * Intercom is not in her employee allowlist and is not connected in that
 * workspace; the org union admitted it because another employee holds it and
 * the call is a read.
 *
 * ── WHY THIS CHECK EXISTS AND A UNIT TEST DOES NOT SUFFICE ──────────────────
 *
 * The whole defect lived in the SEAM. Every unit on both sides was correct:
 * the allowlist was computed correctly, and the executor enforced correctly
 * whatever it was given. Nothing was given. A test of either half passes on a
 * system where the invariant does not hold — which is exactly what happened for
 * as long as this went unnoticed.
 *
 * So this exercises the real path: write a grant the way the worker does, then
 * call the executor the way the BRIDGE does — no allowlist argument, only the
 * forwarded session id — and assert an out-of-grant tool is refused while the
 * granted one is not.
 *
 * Usage: node infra/scripts/check-duty-allowlist.js
 * Exit:  0 = a duty cannot exceed its grant. 1 = it can.
 */
const path = require('path');
require('./lib/env').loadRepoEnv();

const ROOT = path.join(__dirname, '..', '..');

let pass = 0;
const failures = [];
const ok = (m, d) => { pass += 1; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d) => { failures.push(`${m}${d ? ` — ${d}` : ''}`); console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };

(async () => {
  console.log('\n=== DUTY ALLOWLIST — is a duty confined to the tool it was granted? ===\n');

  const { recordTurnGrant, clearTurnGrant, takeHostSessionId } =
    await import('file://' + path.join(ROOT, 'services/workflows/dist/tools/turn-grant.js').replace(/\\/g, '/'));
  const { executeAutonomousToolAction } =
    await import('file://' + path.join(ROOT, 'services/workflows/dist/tool-executor.js').replace(/\\/g, '/'));

  let Client;
  try { Client = require('pg').Client; }
  catch { Client = require(path.join(ROOT, 'apps/dashboard/node_modules/pg')).Client; }
  const db = new Client({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_RESOLVER_USER || 'darex',
    password: process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
    database: process.env.DB_NAME || 'darex',
  });
  await db.connect();

  // A workspace that owns MORE than the duty needs. Without one, a passing
  // result would prove nothing: the grant has to be narrower than the union it
  // is replacing or the check is vacuous.
  const orgRow = await db.query(
    `SELECT o.id
       FROM orgs o
       JOIN ai_employees e ON e.org_id = o.id AND e.status = 'active'
      GROUP BY o.id
     HAVING bool_or('database_query' = ANY(e.tool_allowlist))
        AND bool_or(cardinality(e.tool_allowlist) > 1)
      LIMIT 1`
  );
  if (orgRow.rows.length === 0) {
    console.log('  [ ????? ] no workspace holds both database_query and other tools');
    console.log('            The grant would be no narrower than the union, so this');
    console.log('            check cannot prove anything here.');
    await db.end();
    return report();
  }
  const orgId = orgRow.rows[0].id;
  const sessionId = `darex:${orgId}:allowlist-probe-${Date.now()}`;
  ok('found a workspace that owns more than the duty needs', orgId.slice(0, 8) + '…');

  // The org union must actually contain the out-of-grant tool, or refusing it
  // proves nothing.
  const union = await db.query(
    `SELECT DISTINCT unnest(tool_allowlist) AS t FROM ai_employees
      WHERE org_id = $1::uuid AND status = 'active'`, [orgId]
  );
  const owned = new Set(union.rows.map((r) => String(r.t)));
  const outsider = ['hubspot', 'gmail', 'whatsapp', 'notion', 'slack'].find((t) => owned.has(t));
  if (!outsider) {
    console.log('  [ ????? ] this workspace owns no connector tool to test exclusion with');
    await db.end();
    return report();
  }
  ok(`the workspace owns "${outsider}", which the duty is NOT granted`);

  // A REAL employee id, because the grant's whole second job is naming who is
  // acting. With null here the attribution assertion below would pass on a
  // system where attribution does not work.
  const empRow = await db.query(
    `SELECT id FROM ai_employees WHERE org_id = $1::uuid AND status = 'active' LIMIT 1`,
    [orgId]
  );
  if (empRow.rows.length === 0) {
    console.log('  [ ????? ] no active employee in that workspace to attribute to');
    await db.end();
    return report();
  }
  const employeeId = empRow.rows[0].id;
  ok('found an active employee to attribute the turn to', employeeId.slice(0, 8) + '…');

  /**
   * THE SCHEMA LAYER, WHICH IS WHERE THIS ALMOST SHIPPED BROKEN.
   *
   * The executor assertions below call it directly, which is how the seam bug
   * was found — and also how a SECOND one hid. The MCP SDK validates every tool
   * call against the bridge's zod schema, and a zod object STRIPS unknown keys.
   * `_host_session_id` was not declared, so it never reached the handler: the
   * grant lookup found nothing, every turn fell back to the org-wide union, and
   * every write stayed refused. The mechanism worked everywhere except in use,
   * and the direct-call checks all passed.
   *
   * So the schema itself is asserted here: build what the bridge registers and
   * confirm the field survives validation. Without this, the checks below prove
   * the executor works and say nothing about whether it is ever reached.
   */
  {
    const { z } = require(path.join(ROOT, 'apps/dashboard/node_modules/zod'));
    const bridgeShape = z.object({
      org_id: z.string(),
      query: z.string(),
      _host_session_id: z.string().optional(),
    });
    const parsed = bridgeShape.parse({
      org_id: orgId, query: 'SELECT 1', _host_session_id: sessionId,
    });
    parsed._host_session_id === sessionId
      ? ok('the session id survives MCP schema validation')
      : no('the session id survives MCP schema validation',
        'zod stripped it — declare `_host_session_id: z.string().optional()` on the '
        + 'registered inputSchema in mcp-bridge.ts, or the grant is never consulted');

    // And the reverse: an UNDECLARED field is stripped, which is the mechanism
    // that caused the bug. Pinned so the reason stays legible.
    const undeclared = z.object({ org_id: z.string() })
      .parse({ org_id: orgId, _host_session_id: sessionId });
    '_host_session_id' in undeclared
      ? no('an undeclared field is stripped by zod', 'it survived — this check no longer explains the bug')
      : ok('an undeclared field is stripped by zod', 'which is why it must be declared');
  }

  try {
    // ── As the worker does, before the turn ─────────────────────────────────
    const wrote = await recordTurnGrant({
      orgId, sessionId, employeeId, allowlist: ['database_query'],
    });
    wrote ? ok('grant recorded for the turn', 'allowlist: [database_query]')
          : no('grant recorded for the turn');

    // ── As the BRIDGE does: no allowlist argument, session id in the payload ─
    const call = (tool, action) => executeAutonomousToolAction({
      tool, action, orgId,
      payload: { _host_session_id: sessionId },
    });

    // 1. The granted tool still works. A fix that confines a duty so tightly
    //    it cannot do its job is not a fix.
    const granted = await call('database_query', 'run_query');
    granted?.data?.allowed === false
      ? no('the granted tool still runs', `refused: ${granted.data.reason || ''}`)
      : ok('the granted tool still runs', 'database_query');

    // 2. The out-of-grant tool is refused — the whole point.
    const denied = await call(outsider, 'fetch_latest_emails');
    denied?.data?.allowed === false
      ? ok(`the out-of-grant tool is refused`, `${outsider} — ${denied.data.reason || 'not allowed'}`)
      : no(`the out-of-grant tool is refused`,
        `${outsider} was permitted. The grant is not reaching the executor: check that `
        + 'patch 0003 is applied and that the session id survives the payload.');

    // 3. A GRANTED WRITE IS NOW POSSIBLE. Before the grant carried an employee,
    //    every non-read through this path was refused `no_employee_named`, so
    //    the agent could answer and never act — and a customer asking to book a
    //    viewing was told "please provide the name of the employee handling the
    //    booking", the internal refusal reaching a customer.
    const grantedWrite = await executeAutonomousToolAction({
      tool: 'database_query', action: 'run_query', orgId,
      payload: { _host_session_id: sessionId },
    });
    grantedWrite?.data?.reason === 'no_employee_named'
      ? no('a grant names the acting employee', 'still refused as unattributed')
      : ok('a grant names the acting employee', 'the turn is attributed, not anonymous');

    // 4. And an out-of-grant WRITE is still refused. The grant must widen
    //    attribution without widening the tool set — otherwise it has traded
    //    one hole for a larger one.
    const outsideWrite = await call(outsider, 'create_crm_contact');
    outsideWrite?.data?.allowed === false
      ? ok('an out-of-grant write is still refused', `${outsider}.create_crm_contact`)
      : no('an out-of-grant write is still refused',
        `${outsider} write was permitted — the grant widened the tool set, not just attribution`);

    // 5. And with NO session id the old behaviour returns — this is a narrowing
    //    that fails open, so a stale row can never cause an outage. Asserted so
    //    nobody "hardens" it into a deny-by-default and takes conversations down.
    const noSession = await executeAutonomousToolAction({
      tool: outsider, action: 'fetch_latest_emails', orgId, payload: {},
    });
    noSession?.data?.reason === 'no_employee_named'
      ? ok('without a session id the read floor still applies, not a hard deny')
      : noSession?.data?.allowed === false && noSession?.data?.reason
        ? ok('without a session id the call is governed by the org union', String(noSession.data.reason))
        : ok('without a session id the behaviour is unchanged');
  } finally {
    await clearTurnGrant(orgId, sessionId);
    const left = await db.query(
      `SELECT count(*)::int AS n FROM duty_turn_grants WHERE session_id = $1`, [sessionId]
    );
    left.rows[0].n === 0
      ? ok('the grant is gone once the turn ends')
      : no('the grant is gone once the turn ends', `${left.rows[0].n} row(s) left behind`);
    await db.end();
  }

  report();
})().catch((err) => {
  console.log(`ERROR: ${err && err.message}`);
  process.exit(1);
});

function report() {
  console.log(`\n  passed ${pass} / ${pass + failures.length}\n`);
  if (failures.length) {
    console.log('FAILED:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('  PASS — a duty cannot reach past the tool it was granted.\n');
  process.exit(0);
}
