/**
 * TEN SHIFTS, AND WHAT VARIES BETWEEN THEM.
 *
 * Three consecutive 6/6 runs is consistency, not proof. "Is it reliable" is a
 * question about the tenth run, not the first, and the honest answer needs a
 * distribution rather than an anecdote.
 *
 * RUN IT FROM INSIDE THE WORKER — it needs Temporal and Postgres on their
 * compose names, and the Docker port proxy drops host connections
 * unpredictably on some machines:
 *
 *   docker exec -i -e SIM_ROUNDS=10 darex-worker node < infra/scripts/simulate-shifts.js
 *
 * Environment:
 *   SIM_ROUNDS   how many full shifts to run (default 10)
 *   SIM_ORG      which workspace (defaults to the seeded demo org)
 *
 * Measures, per employee, across rounds:
 *   reported     produced a non-empty answer AND reported success
 *   tools        how many tools it actually invoked
 *   secs         wall-clock median
 *   reply length min-max spread, because a wildly varying answer to a FIXED
 *                question is instability even when every run "passes"
 *
 * Nothing is retried. A failed round stays failed in the numbers — re-running
 * a suite until it goes green is how a reliability figure becomes a wish.
 *
 * FIRST RESULT, 2 September 2026: 58 of 60 runs reported (97%). Emma, Marcus,
 * Research and Sarah were 10/10; Aisha and Meera 9/10. The first 42 runs were
 * clean. Both failures were the same upstream event — "Upstream error from
 * Nvidia: Service temporarily overloaded" — and the provider actually failed
 * 18 times, so the fallback chain absorbed 16 of 18. The two that got through
 * did so because GROQ_API_KEY and DEEPSEEK_API_KEY are unset, leaving the free
 * tier with nowhere to fall.
 */
const { Connection, Client } = require('@temporalio/client');
const { Client: Pg } = require('pg');
const { planDuty } = require('./dist/duties.js');

const ORG = process.env.SIM_ORG || '90d3c47f-e6e8-49ea-9c4b-8f63cd2ed16f';
const ROUNDS = parseInt(process.env.SIM_ROUNDS || '10', 10);

const pg = () => new Pg({
  host: process.env.DB_HOST || 'pgbouncer',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'darex_app',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'darex',
});

const pad = (s, n) => String(s).padEnd(n);
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

(async () => {
  const db = pg();
  await db.connect();
  // The worker runs as darex_app under FORCE row-level security, so a query
  // with no org context returns zero rows rather than an error. That is the
  // tenant wall behaving correctly, and it is why the first run of this harness
  // reported "0 EMPLOYEES" instead of failing loudly.
  await db.query('SELECT set_config($1, $2, false)', ['app.current_org_id', ORG]);
  const staff = (await db.query(
    `SELECT id, name, role, tool_allowlist FROM ai_employees
      WHERE org_id = $1 AND status = 'active' ORDER BY name`, [ORG])).rows;

  // The market every employee works in. Each fact carries its source, and the
  // agent is instructed to cite that source in any sentence relying on it.
  const marketFacts = (await db.query(
    `SELECT body AS fact, source_ref AS source FROM org_memory
      WHERE org_id = $1 AND kind = 'market' ORDER BY created_at DESC LIMIT 8`, [ORG])).rows;
  await db.end();
  console.log(`  market context: ${marketFacts.length} fact(s), each with a source
`);

  const plans = staff
    .map((s) => planDuty(
      { id: s.id, name: s.name, role: s.role, toolAllowlist: s.tool_allowlist || [] },
      process.env, [], marketFacts))
    .filter((p) => p.runnable);

  console.log(`\n=== ${ROUNDS} SHIFTS x ${plans.length} EMPLOYEES = ${ROUNDS * plans.length} AGENT RUNS ===\n`);

  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS || 'temporal:7233' });
  const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE || 'default' });

  // name -> { completed, reported, tools[], secs[], lens[] }
  const stats = new Map(plans.map((p) => [p.employeeName, {
    completed: 0, reported: 0, tools: [], secs: [], lens: [], errors: [],
  }]));

  for (let round = 1; round <= ROUNDS; round++) {
    const tag = `sim-r${round}-${Date.now()}`;
    const jobs = plans.map((p) => ({
      name: p.employeeName,
      workflowId: `shift:${ORG}:${p.employeeId}:${tag}`,
      args: {
        orgId: ORG,
        employeeId: p.employeeId,
        employeeName: p.employeeName,
        employeeRole: p.role,
        employeePersona: p.duty.summary,
        toolAllowlist: p.dutyAllowlist,
        userMessage: p.instruction,
        skipPersist: true,
        idempotencyKey: `shift:${ORG}:${p.employeeId}:${tag}`,
      },
    }));

    const started = Date.now();
    for (const j of jobs) {
      await client.workflow.start('AutonomousAgentWorkflow', {
        taskQueue: process.env.TEMPORAL_TASK_QUEUE || 'darex-agent-tasks',
        workflowId: j.workflowId,
        args: [j.args],
      });
    }

    // Wait for the round. Capped so one wedged run cannot stall the study.
    const deadline = Date.now() + 6 * 60 * 1000;
    const pending = new Set(jobs.map((j) => j.workflowId));
    const byId = new Map(jobs.map((j) => [j.workflowId, j]));

    while (pending.size && Date.now() < deadline) {
      for (const id of [...pending]) {
        const h = client.workflow.getHandle(id);
        const d = await h.describe();
        if (d.status.name === 'RUNNING') continue;
        pending.delete(id);

        const j = byId.get(id);
        const st = stats.get(j.name);
        const secs = Math.round((Date.now() - started) / 1000);

        if (d.status.name !== 'COMPLETED') {
          st.errors.push(d.status.name);
          continue;
        }
        st.completed += 1;
        st.secs.push(secs);
        try {
          const r = await h.result();
          const reply = String(r.replyMessage || '').trim();
          st.tools.push(r.usedTools.length);
          st.lens.push(reply.length);
          if (reply.length > 0 && r.success) st.reported += 1;
          else st.errors.push(r.error ? String(r.error).slice(0, 40) : 'empty');
        } catch (e) {
          st.errors.push(String(e.message).slice(0, 40));
        }
      }
      if (pending.size) await new Promise((res) => setTimeout(res, 5000));
    }
    for (const id of pending) stats.get(byId.get(id).name).errors.push('TIMEOUT');

    const done = [...stats.values()].reduce((a, s) => a + s.reported, 0);
    console.log(`  round ${String(round).padStart(2)}/${ROUNDS}  cumulative reported: ${done}/${round * plans.length}`);
  }

  await connection.close();

  console.log(`\n  ${pad('EMPLOYEE', 11)}${pad('REPORTED', 10)}${pad('TOOLS', 8)}${pad('SECS med', 10)}${pad('REPLY LEN', 22)}FAILURES`);
  let totalReported = 0;
  for (const [name, s] of stats) {
    totalReported += s.reported;
    const lenMin = s.lens.length ? Math.min(...s.lens) : 0;
    const lenMax = s.lens.length ? Math.max(...s.lens) : 0;
    const toolMode = s.tools.length ? median(s.tools) : 0;
    console.log(
      `  ${pad(name, 11)}${pad(`${s.reported}/${ROUNDS}`, 10)}${pad(toolMode, 8)}` +
      `${pad(median(s.secs), 10)}${pad(`${lenMin}-${lenMax} (med ${median(s.lens)})`, 22)}` +
      `${s.errors.length ? s.errors.slice(0, 3).join(', ') : '—'}`
    );
  }

  const runs = ROUNDS * plans.length;
  console.log(`\n  ${totalReported} of ${runs} runs produced a real report `
    + `(${Math.round((totalReported / runs) * 100)}%).\n`);
})().catch((e) => {
  console.log('\n  HARNESS ERROR: ' + e.message + '\n');
  process.exit(1);
});
