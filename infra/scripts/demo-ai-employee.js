#!/usr/bin/env node
'use strict';
/**
 * AN AI EMPLOYEE DOING ACTUAL WORK — through the real execution path.
 *
 * The product promise is not "an agent that writes replies". It is an employee
 * that DOES the work a person in that seat would do, inside a business that
 * controls what it may touch. 95 tools are wired to the agent over MCP — Gmail,
 * Calendar, Drive, HubSpot, Salesforce, Stripe, Razorpay, DocuSign, Leegality,
 * Twilio, and a real-estate set.
 *
 * And until this script ran, `agent_actions` contained only `reply_sent` and
 * `followup_sent`. Ninety-five hands, never used once.
 *
 * ── WHY THIS RUNS WITHOUT MODEL CREDIT OR OAUTH ───────────────────────────
 * The model DECIDES which tool to call. It is not needed to prove the tool
 * WORKS, or that the control plane governs it. Two tools — database_query and
 * metrics_query — read the tenant's own data and need no external credential,
 * so the whole path is exercisable today:
 *
 *     allowlist check -> risk classification -> approval gate -> execute
 *
 * Everything below goes through executeAutonomousToolAction, the same function
 * the MCP bridge calls when the agent asks for a tool. Nothing is mocked. A
 * blocked call is blocked by the real allowlist, not by a printed message.
 *
 * Usage: node infra/scripts/demo-ai-employee.js [--org <uuid>]
 */
const path = require('path');
require('./lib/env').loadRepoEnv();

let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client; }

const W = path.join(__dirname, '..', '..', 'services', 'workflows', 'dist');
const { executeAutonomousToolAction } = require(path.join(W, 'tool-executor.js'));
const { decideToolCall, ROLE_HANDS, riskOf } = require(path.join(W, 'tools', 'capability.js'));

const args = process.argv.slice(2);
const ORG = args.includes('--org') ? args[args.indexOf('--org') + 1] : null;

const db = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

const line = (s = '') => console.log(s);
const rule = () => line('  ' + '─'.repeat(66));

let pass = 0;
let fail = 0;
const ok = (m, d = '') => { pass++; line(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d = '') => { fail++; line(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };

(async () => {
  await db.connect();
  line('\n╔════════════════════════════════════════════════════════════════════╗');
  line('║  AN AI EMPLOYEE AT WORK — real execution path, no model needed     ║');
  line('╚════════════════════════════════════════════════════════════════════╝\n');

  try {
    const org = ORG || (await db.query(
      `SELECT o.id FROM orgs o
        ORDER BY (SELECT COUNT(*) FROM ai_employees e WHERE e.org_id = o.id) DESC LIMIT 1`
    )).rows[0]?.id;
    const orgName = (await db.query(`SELECT name FROM orgs WHERE id=$1`, [org])).rows[0]?.name;

    const staff = (await db.query(
      `SELECT name, role, tool_allowlist FROM ai_employees WHERE org_id=$1 ORDER BY name`, [org])).rows;

    line(`  Business : ${orgName}`);
    line(`  Workforce: ${staff.length} AI employees\n`);
    for (const s of staff.slice(0, 6)) {
      line(`    ${String(s.name).padEnd(9)} ${String(s.role).padEnd(24)} ${(s.tool_allowlist || []).join(', ')}`);
    }

    // ── ACT 1 — the work an employee is hired to do ────────────────────────
    rule();
    line('\n  ACT 1 — The analyst is asked how the business is doing.\n');

    // Cast by CAPABILITY, not by job title. Two employees can both be "sales"
    // and hold completely different hands, which is the entire point of the
    // permission model — so the demo has to look at the hands.
    const holder = (tool) => staff.find((s) => (s.tool_allowlist || [])
      .some((t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '_') === tool));
    const analyst = holder('database_query') || holder('metrics') || staff[0];
    const readTool = (analyst.tool_allowlist || []).some((t) => /database/i.test(t))
      ? 'database_query' : 'metrics';
    line(`  Employee : ${analyst.name} (${analyst.role})`);
    line(`  Asked    : "How many conversations have we handled?"`);
    // A real query, because the tool validates: SELECT or WITH only, single
    // statement, auto-limited, and executed through an ORG-SCOPED client — so
    // row-level security confines the agent to its own tenant even if the SQL
    // it wrote would have reached further.
    const sql = 'SELECT status, COUNT(*) AS n FROM conversations GROUP BY status ORDER BY n DESC';
    line(`  Chooses  : ${readTool}`);
    line(`  Writes   : ${sql}\n`);

    const work = await executeAutonomousToolAction({
      tool: readTool,
      action: 'query',
      payload: { query: sql, metric: 'conversations' },
      orgId: org,
      toolAllowlist: analyst.tool_allowlist || ROLE_HANDS.analyst,
    });
    if (work.data && Array.isArray(work.data.rows)) {
      for (const r of work.data.rows) {
        line(`             ${String(r.status).padEnd(18)} ${r.n}`);
      }
      line('');
    }

    line(`  RESULT   : ${work.status.toUpperCase()} — ${String(work.message).slice(0, 90)}`);
    work.status === 'executed'
      ? ok('the employee did real work', 'read its own tenant data through the production path')
      : no('the employee did real work', `${work.status}: ${work.message}`);

    // ── ACT 2 — something it is not allowed to touch ───────────────────────
    rule();
    line('\n  ACT 2 — The SUPPORT agent tries to move money.\n');

    const support = staff.find((s) => /support/i.test(s.role)) || staff[1] || staff[0];
    const supportHands = support.tool_allowlist || ROLE_HANDS.support;
    line(`  Employee : ${support.name} (${support.role})`);
    line(`  Holds    : ${supportHands.join(', ')}`);
    line(`  Attempts : razorpay / payout   (customer asked for a refund)\n`);

    const verdict = decideToolCall({ tool: 'razorpay', action: 'payout', allowlist: supportHands });
    line(`  Risk     : ${riskOf('razorpay', 'payout')}`);
    line(`  Decision : allowed=${verdict.allowed}  needsApproval=${verdict.needsApproval}`);
    line(`  Reason   : ${verdict.reason}\n`);

    const blocked = await executeAutonomousToolAction({
      tool: 'razorpay',
      action: 'payout',
      payload: { amount: 25000, to: 'cust_2941' },
      orgId: org,
      toolAllowlist: supportHands,
    });
    line(`  RESULT   : ${blocked.status.toUpperCase()} — ${String(blocked.message).slice(0, 90)}`);

    (!verdict.allowed && blocked.status !== 'executed')
      ? ok('the payment was refused', 'blocked by the allowlist, before any side effect')
      : no('the payment was refused', `allowed=${verdict.allowed} status=${blocked.status}`);

    // ── ACT 3 — allowed, but not without a person ──────────────────────────
    rule();
    line('\n  ACT 3 — The SALES agent tries something it IS allowed to do,\n'
       + '          but which is too consequential to do alone.\n');

    const sales = holder('gmail') || staff[0];
    const salesHands = sales.tool_allowlist || ROLE_HANDS.sales;
    line(`  Employee : ${sales.name} (${sales.role})`);
    line(`  Attempts : gmail / send   (emailing a price quote to a client)\n`);

    const gate = decideToolCall({ tool: 'gmail', action: 'send', allowlist: salesHands, autonomyLevel: 0 });
    line(`  Risk     : ${riskOf('gmail', 'send')}`);
    line(`  Decision : allowed=${gate.allowed}  needsApproval=${gate.needsApproval}`);
    line(`  Reason   : ${gate.reason}\n`);

    gate.needsApproval
      ? ok('sending to a customer waits for a person',
        'granted, but held for approval — autonomy is earned, not assumed')
      : no('sending to a customer waits for a person', JSON.stringify(gate));

    // ── What the business can see afterwards ───────────────────────────────
    rule();
    line('\n  THE RECORD — what an operator can see afterwards\n');

    const acts = (await db.query(
      `SELECT e.name, a.action_kind, COUNT(*)::int AS n
         FROM agent_actions a LEFT JOIN ai_employees e ON e.id = a.employee_id
        WHERE a.org_id = $1 GROUP BY 1,2 ORDER BY n DESC LIMIT 5`, [org])).rows;
    if (acts.length) {
      // '(console)' not '(unknown)': a null employee here means a person acted
      // through Ask AI, which is known, not missing.
      for (const a of acts) line(`    ${String(a.name || '(console)').padEnd(10)} ${String(a.action_kind).padEnd(16)} ${a.n}`);
    } else {
      line('    (no recorded actions in this workspace yet)');
    }

    /**
     * The invariant is that no action is ANONYMOUS — not that every action was
     * taken by an employee.
     *
     * This asserted `COUNT(employee_id) === COUNT(*)` and went red the first
     * time somebody used the Ask AI console, because a console reply genuinely
     * has no employee: the operator asked the platform a question directly, and
     * no member of the roster did anything. Attributing it to an employee to
     * make the number round would have recorded a person's action against an
     * agent that never acted, which is a worse lie than the one it fixed.
     *
     * The action is still fully traced — the Ask AI conversation carries the
     * asking user in `contact_id` ('ask-ai:<userId>') and in metadata — so the
     * right question is whether any action has NO actor at all. That is the
     * thing that would actually break accountability, and the answer must be
     * zero.
     */
    const attributed = (await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE a.employee_id IS NOT NULL)::int                                    AS by_employee,
         COUNT(*) FILTER (WHERE a.employee_id IS NULL AND c.metadata->>'userId' IS NOT NULL)::int  AS by_operator,
         COUNT(*) FILTER (WHERE a.employee_id IS NULL AND c.metadata->>'userId' IS NULL)::int      AS anonymous,
         COUNT(*)::int                                                                             AS total
       FROM agent_actions a
       LEFT JOIN conversations c ON c.id = a.conversation_id`)).rows[0];
    line('');
    line(`    by an AI employee   ${attributed.by_employee}`);
    line(`    by a human operator ${attributed.by_operator}   (Ask AI console — no employee acted)`);
    line(`    by nobody           ${attributed.anonymous}`);
    line('');
    attributed.anonymous === 0
      ? ok('every action names an actor',
        `${attributed.by_employee} employee + ${attributed.by_operator} operator, 0 anonymous`)
      : no('every action names an actor', `${attributed.anonymous} of ${attributed.total} name nobody`);

  } finally {
    await db.end().catch(() => {});
  }

  rule();
  line(`\n  passed ${pass} / ${pass + fail}\n`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  line(`\n  ERROR: ${e.message}\n`);
  try { await db.end(); } catch { /* closed */ }
  process.exit(1);
});
