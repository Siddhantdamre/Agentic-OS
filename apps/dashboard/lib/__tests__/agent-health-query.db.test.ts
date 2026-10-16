/**
 * @jest-environment node
 *
 * The Agent health board is counted in SQL for one workspace, so it is checked against a real migrated database as
 * the real application role (row-level security on). Skipped unless TRUST_DB_TEST=1, like the Trust page's checks.
 */
import { Pool, type PoolClient } from 'pg';
import { loadAgentHealth } from '../agent-health-query';

const enabled = process.env.TRUST_DB_TEST === '1';
const d = enabled ? describe : describe.skip;

const conn = (user: string | undefined, password: string | undefined) =>
  new Pool({ host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 5432), database: process.env.DB_NAME || 'darex', user, password, max: 2 });

d('loadAgentHealth against a real database', () => {
  const stamp = Date.now();
  let admin: Pool;
  let app: Pool;
  let orgA = '';
  let orgB = '';
  let maya = '';

  const org = async (tag: string) =>
    (await admin.query(`INSERT INTO orgs (name, slug, status) VALUES ($1, $2, 'active') RETURNING id`, [`Health ${tag} ${stamp}`, `health-${tag}-${stamp}`])).rows[0].id as string;
  const employee = async (orgId: string, name: string, role: string, status = 'active', daysOld = 40) =>
    (await admin.query(
      `INSERT INTO ai_employees (org_id, name, role, status, created_at) VALUES ($1, $2, $3, $4, NOW() - ($5 || ' days')::interval) RETURNING id`,
      [orgId, name, role, status, String(daysOld)],
    )).rows[0].id as string;
  const pending = (orgId: string, role: string, employeeId: string, hoursAgo: number) =>
    admin.query(
      `INSERT INTO agent_pending_actions (org_id, workflow_id, action_type, employee_role, payload, token_hash, status, created_at)
       VALUES ($1, 'wf', 'external_send', $2, $3::jsonb, $4, 'pending', NOW() - ($5 || ' hours')::interval)`,
      [orgId, role, JSON.stringify({ tool: 'gmail', employeeId }), `h-${Math.random()}`, String(hoursAgo)],
    );
  const load = async (orgId: string) => {
    const client: PoolClient = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);
      const snap = await loadAgentHealth(client, orgId);
      await client.query('ROLLBACK');
      return snap;
    } finally {
      client.release();
    }
  };

  beforeAll(async () => {
    admin = conn(process.env.DB_RESOLVER_USER, process.env.DB_RESOLVER_PASSWORD);
    app = conn(process.env.DB_USER, process.env.DB_PASSWORD);
    orgA = await org('a');
    orgB = await org('b');
    maya = await employee(orgA, 'Maya', 'customer');
    await employee(orgA, 'Ravi', 'growth');
    await employee(orgA, 'Sunil', 'finance', 'paused');
    await employee(orgA, 'Ayesha', 'research', 'active', 0);
    // Maya acted a day ago, but one approval has waited three days.
    await admin.query(
      `INSERT INTO agent_decision_ledger (org_id, employee_role, employee_id, action_considered, decision, reason_code, reason_summary, confidence_score, context_payload, created_at)
       VALUES ($1, 'customer', $2, 'gmail.send_email', 'executed', 'allowed', 'x', 0.5, '{}'::jsonb, NOW() - INTERVAL '1 day')`,
      [orgA, maya],
    );
    await pending(orgA, 'customer', maya, 72);
    await pending(orgA, 'customer', maya, 5);
    // Two customer messages failed to arrive, one was replayed (not counted).
    for (const status of ['unresolved', 'unresolved', 'replayed']) {
      await admin.query(`INSERT INTO failed_webhooks (channel, org_id, raw_payload, error_message, status) VALUES ('whatsapp', $1, '{}', 'boom', $2)`, [orgA, status]);
    }
    // Heartbeat: one check ran today, one went quiet four days ago. Another workspace's failing check must not leak in.
    await admin.query(
      `INSERT INTO agent_activity_health (org_id, activity, last_ok_at, ok_count) VALUES
         ($1, 'sweepToday', NOW(), 5), ($1, 'sweepQuiet', NOW() - INTERVAL '4 days', 2)`,
      [orgA],
    );
    // Another workspace with its own stuck employee and failed messages must change nothing above.
    const intruder = await employee(orgB, 'Intruder', 'customer');
    await pending(orgB, 'customer', intruder, 200);
    await admin.query(`INSERT INTO failed_webhooks (channel, org_id, raw_payload, error_message, status) VALUES ('whatsapp', $1, '{}', 'boom', 'unresolved')`, [orgB]);
    await admin.query(
      `INSERT INTO agent_activity_health (org_id, activity, last_error_at, last_error, fail_count) VALUES ($1, 'sweepB', NOW(), 'Error: only B', 9)`,
      [orgB],
    );
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM agent_activity_health WHERE org_id = ANY($1::uuid[])`, [[orgA, orgB]]);
    await admin.query(`DELETE FROM failed_webhooks WHERE org_id = ANY($1::uuid[])`, [[orgA, orgB]]);
    await admin.query(`DELETE FROM orgs WHERE id = ANY($1::uuid[])`, [[orgA, orgB]]);
    await admin.end();
    await app.end();
  });

  it('puts the employee with an approval waiting three days first, stuck, with the reason', async () => {
    const s = await load(orgA);
    expect(s.employees[0].name).toBe('Maya');
    expect(s.employees[0].status).toBe('stuck');
    expect(s.employees[0].waiting).toBe(2);
    expect(s.employees[0].oldestWaitingHours).toBeGreaterThanOrEqual(71);
    expect(s.employees[0].reasons[0]).toMatch(/2 approvals are waiting; the oldest for 3 days/);
  });

  it('calls an older employee that never did anything watch, a paused one paused and a new one new', async () => {
    const s = await load(orgA);
    const by = (n: string) => s.employees.find((e) => e.name === n)!;
    expect(by('Ravi').status).toBe('watch');
    expect(by('Sunil').status).toBe('paused');
    expect(by('Ayesha').status).toBe('new');
    expect(s.summary).toEqual({ stuck: 1, watch: 1, ok: 0, new: 1, paused: 1 });
  });

  it('counts only this workspace’s unresolved customer messages', async () => {
    const s = await load(orgA);
    expect(s.notes.map((n) => n.text).join(' ')).toMatch(/2 customer messages failed to arrive/);
  });

  it('reports a background check that went quiet, and only for this workspace', async () => {
    const a = await load(orgA);
    const text = a.notes.map((n) => n.text).join(' ');
    expect(text).toMatch(/A background check has not run for 4 days/);
    expect(text).not.toMatch(/only B/);
    const b = await load(orgB);
    expect(b.notes.map((n) => n.text).join(' ')).toMatch(/background check failed on its last run \(Error: only B\)/);
  });

  it('shows nothing from another workspace', async () => {
    const s = await load(orgA);
    expect(s.employees.map((e) => e.name)).not.toContain('Intruder');
    const b = await load(orgB);
    expect(b.employees.map((e) => e.name)).toEqual(['Intruder']);
    expect(b.notes.map((n) => n.text).join(' ')).toMatch(/1 customer message failed/);
  });
});
