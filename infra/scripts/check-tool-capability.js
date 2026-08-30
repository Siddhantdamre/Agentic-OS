#!/usr/bin/env node
'use strict';
/**
 * REAL HANDS — can each role do its own job, and only its own job?
 *
 * Before this work: 56 AI employees, every one holding the identical
 * tool_allowlist `{database_query}`. The roles were name badges.
 *
 * Every assertion below runs through executeAutonomousToolAction — the real
 * enforcement point, the one that runs before any side effect — rather than
 * against the decision module. The unit tests already pin the rules; what is
 * checked here is that the rules are REACHED. This codebase's characteristic
 * defect is a correct module nothing calls, and an authorization module
 * nothing calls is the worst instance of it.
 *
 * Usage: node infra/scripts/check-tool-capability.js
 * Exit:  0 = the hands are real and bounded, 1 = they are not
 */
const path = require('path');
require('./lib/env').loadRepoEnv();

const { executeAutonomousToolAction } =
  require(path.join(__dirname, '..', '..', 'services', 'workflows', 'dist', 'tool-executor.js'));
const { ROLE_HANDS, riskOf } =
  require(path.join(__dirname, '..', '..', 'services', 'workflows', 'dist', 'tools', 'capability.js'));

let pass = 0;
let fail = 0;
const ok = (m, d = '') => { pass++; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d = '') => { fail++; console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };

// A workspace id that does not exist. Every assertion here is about the
// allowlist gate, which runs BEFORE any provider is contacted, so no external
// call is made and no credential is needed.
const ORG = '00000000-0000-0000-0000-0000000000ff';

/** Was the call refused by the authorization gate (not by a provider)? */
async function blocked(tool, action, allowlist) {
  const r = await executeAutonomousToolAction({
    tool, action, orgId: ORG, payload: {},
    ...(allowlist ? { toolAllowlist: allowlist } : {}),
  });
  return r.status === 'error' && r.data && r.data.allowed === false;
}

(async () => {
  console.log('\n=== REAL HANDS — WHAT MAY EACH EMPLOYEE ACTUALLY DO? ===\n');

  // ── 1. The escalation that shipped ────────────────────────────────────────
  console.log('1. A narrow grant must not confer the whole provider');
  // The shipped matcher compared `held.startsWith(want + "-")` as well, so
  // permission to read a refund status returned true for `razorpay`.
  await blocked('razorpay', 'payout', ['razorpay-refund-status'])
    ? ok('checking a refund status does NOT confer payouts',
      'permission flows downward only')
    : no('checking a refund status does NOT confer payouts',
      'PRIVILEGE ESCALATION: a read-only grant reached the payments provider');

  !(await blocked('razorpay-refund-status', 'get', ['razorpay']))
    ? ok('but holding the provider does confer what is under it')
    : no('holding the provider confers what is under it', 'the grant no longer flows downward');

  await blocked('razorpayx', 'payout', ['razorpay'])
    ? ok('a lookalike provider does not inherit', 'razorpayx is not under razorpay')
    : no('a lookalike provider does not inherit', 'prefix matching ignored the separator');

  // ── 2. Nobody named, nothing changed ──────────────────────────────────────
  console.log('\n2. An unattributed call may read, never act');
  // Without an employee, the executor falls back to the union of EVERY active
  // employee's tools. That is the right answer to "does the org own this" and
  // the wrong one to "may this employee use it" — it meant one employee with
  // razorpay let any unattributed call charge a card.
  await blocked('razorpay', 'payout', null)
    ? ok('a pay action with no employee named is refused', 'reason: no_employee_named')
    : no('a pay action with no employee named is refused', 'IT WOULD HAVE CHARGED');
  await blocked('gmail', 'send', null)
    ? ok('so is anything that reaches a person')
    : no('so is anything that reaches a person');

  // ── 3. The roles differ ───────────────────────────────────────────────────
  console.log('\n3. Each role can do its own job, and not another\'s');
  const support = ROLE_HANDS.support;
  const sales = ROLE_HANDS.sales;
  const collections = ROLE_HANDS.collections;

  !(await blocked('google-calendar', 'create', sales))
    ? ok('sales can book a viewing')
    : no('sales can book a viewing');
  await blocked('google-calendar', 'create', support)
    ? ok('support cannot', 'the roles are no longer name badges')
    : no('support cannot book into the calendar');

  !(await blocked('zendesk', 'update', support))
    ? ok('support owns the ticket queue')
    : no('support owns the ticket queue');
  await blocked('zendesk', 'update', sales)
    ? ok('sales does not')
    : no('sales does not own the ticket queue');

  !(await blocked('quickbooks', 'get_invoice', collections))
    ? ok('collections can see what is owed')
    : no('collections can see what is owed');
  await blocked('quickbooks', 'get_invoice', support)
    ? ok('support cannot see the books')
    : no('support cannot see the books');

  // ── 4. What no role gets by default ───────────────────────────────────────
  console.log('\n4. No role is handed money, a signature, or a shell');
  let leaked = [];
  for (const [role, hands] of Object.entries(ROLE_HANDS)) {
    for (const t of ['razorpay', 'stripe', 'docusign', 'leegality', 'sandbox', 'file-ops']) {
      if (!(await blocked(t, 'execute', hands))) leaked.push(`${role}:${t}`);
    }
  }
  leaked.length === 0
    ? ok('every default role is refused all six', 'these are granted per employee, by a person')
    : no('a default role holds a dangerous tool', leaked.join(', '));

  // ── 5. Unknown tools are not assumed safe ─────────────────────────────────
  console.log('\n5. A tool nobody has classified is treated as dangerous');
  riskOf('some-provider-shipped-last-week') !== 'read'
    ? ok('an unclassified tool is not a read', `classified as ${riskOf('some-provider-shipped-last-week')}`)
    : no('an unclassified tool is not a read', 'a new provider defaulted to safe');
  await blocked('some-provider-shipped-last-week', 'do', null)
    ? ok('and an unattributed call cannot reach it')
    : no('and an unattributed call cannot reach it');

  // ── 6. Reads still work, or nobody can do anything ────────────────────────
  console.log('\n6. The floor: every role can still read');
  let cannotRead = [];
  for (const [role, hands] of Object.entries(ROLE_HANDS)) {
    if (await blocked('database_query', 'get', hands)) cannotRead.push(role);
  }
  cannotRead.length === 0
    ? ok('all five roles can query the database', 'a locked-down employee is still an employee')
    : no('a role cannot read', cannotRead.join(', '));

  console.log(`\n  passed ${pass} / ${pass + fail}\n`);
  finish(fail ? 1 : 0);
})().catch((e) => {
  console.log(`\n  ERROR: ${e.message}\n`);
  finish(1);
});

/**
 * Exit without racing the connection pool.
 *
 * The tool executor opens a Postgres pool that this script has no handle on.
 * Calling process.exit() straight away tore a closing handle out from under
 * libuv and printed:
 *
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c
 *
 * It exited 0 anyway — this time. An assertion at exit is a RACE, so it would
 * eventually exit non-zero and be indistinguishable from a real failure, which
 * is precisely the nondeterminism this suite exists to keep out of the verdict.
 *
 * So: set the code and let the loop drain. The unref'd timer is the backstop
 * for a pool that never closes — it cannot itself keep the process alive.
 */
function finish(code) {
  process.exitCode = code;
  const bail = setTimeout(() => process.exit(code), 3000);
  if (typeof bail.unref === 'function') bail.unref();
}
