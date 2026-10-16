/**
 * @jest-environment node
 *
 * The Trust page's numbers are counted in SQL, so they are checked against a real
 * migrated database as the real application role (row-level security on), not against
 * a stub that returns whatever the test expects.
 *
 * Skipped unless TRUST_DB_TEST=1, because the normal unit run has no database. CI's
 * isolation job (which has one) and the local check-in set it. Seeding runs as the
 * superuser (DB_RESOLVER_*); collecting runs as the application role (DB_USER).
 */
import { Pool, type PoolClient } from 'pg';
import { collectTrustSnapshot } from '../trust-query';
import { listShadowDecisions, recordShadowReview, shadowCounts } from '../trust-shadow';

const enabled = process.env.TRUST_DB_TEST === '1';
const d = enabled ? describe : describe.skip;

const conn = (user: string | undefined, password: string | undefined) =>
  new Pool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || 'darex',
    user,
    password,
    max: 2,
  });

d('collectTrustSnapshot against a real database', () => {
  const stamp = Date.now();
  let admin: Pool;
  let app: Pool;
  let orgA = '';
  let orgB = '';
  let maya = '';
  let ravi = '';

  const org = async (tag: string): Promise<string> =>
    (await admin.query(`INSERT INTO orgs (name, slug, status) VALUES ($1, $2, 'active') RETURNING id`, [`Trust ${tag} ${stamp}`, `trust-${tag}-${stamp}`])).rows[0].id;

  const employee = async (orgId: string, name: string, role: string): Promise<string> =>
    (await admin.query(`INSERT INTO ai_employees (org_id, name, role, status) VALUES ($1, $2, $3, 'active') RETURNING id`, [orgId, name, role])).rows[0].id;

  const parked = async (
    orgId: string,
    o: { status: string; employeeId?: string | null; role: string; edited?: boolean; daysAgo?: number },
  ) => {
    const when = new Date(Date.now() - (o.daysAgo ?? 1) * 86_400_000).toISOString();
    await admin.query(
      `INSERT INTO agent_pending_actions
         (org_id, workflow_id, action_type, employee_role, payload, token_hash, status, modified_payload, created_at, decided_at)
       VALUES ($1, 'wf', 'external_send', $2, $3::jsonb, $4, $5, $6::jsonb, $7, $8)`,
      [
        orgId, o.role, JSON.stringify({ tool: 'gmail', employeeId: o.employeeId ?? null }), `h-${Math.random()}`, o.status,
        o.edited ? JSON.stringify({ edited: true }) : null, when, o.status === 'pending' ? null : when,
      ],
    );
  };

  const ledger = async (orgId: string, o: { decision: string; reason: string; employeeId?: string | null; role: string; summary?: string }): Promise<string> =>
    (await admin.query(
      `INSERT INTO agent_decision_ledger (org_id, employee_role, employee_id, action_considered, decision, reason_code, reason_summary, confidence_score, context_payload)
       VALUES ($1, $2, $3, 'gmail.send_email', $4, $5, 'x', 0.5, $6::jsonb) RETURNING id`,
      [orgId, o.role, o.employeeId ?? null, o.decision, o.reason, JSON.stringify(o.summary ? { summary: o.summary } : {})],
    )).rows[0].id;

  /** Runs `fn` as the application role, inside the given workspace, rolled back afterwards. */
  const asApp = async <T>(orgId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  };
  let reviewer = '';
  let shadowIds: string[] = [];
  let otherOrgShadow = '';

  const collect = async (orgId: string) => {
    const client: PoolClient = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);
      const snap = await collectTrustSnapshot(client, orgId);
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
    // Org A has been around for 100 days, so its older decisions fall inside its current stage.
    await admin.query(`UPDATE orgs SET created_at = NOW() - INTERVAL '100 days' WHERE id = $1`, [orgA]);
    reviewer = (await admin.query(`INSERT INTO users (org_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'FAKE') RETURNING id`, [orgA, `reviewer-${stamp}@example.test`])).rows[0].id;
    maya = await employee(orgA, 'Maya', 'customer');
    ravi = await employee(orgA, 'Ravi', 'growth');
    const bEmp = await employee(orgB, 'Intruder', 'customer');

    // Maya: 3 approved as is, 1 approved after editing, 2 rejected, 1 expired, 1 waiting, 1 approved then failed.
    for (let i = 0; i < 3; i++) await parked(orgA, { status: 'executed', employeeId: maya, role: 'customer' });
    await parked(orgA, { status: 'approved', employeeId: maya, role: 'customer', edited: true });
    for (let i = 0; i < 2; i++) await parked(orgA, { status: 'rejected', employeeId: maya, role: 'customer' });
    await parked(orgA, { status: 'expired', employeeId: maya, role: 'customer' });
    await parked(orgA, { status: 'pending', employeeId: maya, role: 'customer' });
    await parked(orgA, { status: 'execution_failed', employeeId: maya, role: 'customer' });
    // Attribution: a made-up employee id with a role only Maya holds goes to Maya; a role nobody holds goes to nobody.
    await parked(orgA, { status: 'executed', employeeId: '11111111-1111-4111-8111-111111111111', role: 'customer' });
    await parked(orgA, { status: 'rejected', employeeId: null, role: 'finance' });
    // Ravi has one old decision, outside the 30 day window.
    await parked(orgA, { status: 'rejected', employeeId: ravi, role: 'growth', daysAgo: 90 });
    // Another workspace with a lot going on must change nothing above.
    for (let i = 0; i < 40; i++) await parked(orgB, { status: 'rejected', employeeId: bEmp, role: 'customer' });

    // Watching mode: 4 recorded decisions, 2 reviewed (1 agreed, 1 not). A real run for Maya.
    const shadow: string[] = [];
    for (let i = 0; i < 4; i++) shadow.push(await ledger(orgA, { decision: 'suppressed', reason: 'shadow_stage', employeeId: maya, role: 'customer', summary: i === 3 ? 'Send email "Hi" to a@b.co' : undefined }));
    shadowIds = shadow;
    await admin.query(`INSERT INTO agent_shadow_reviews (org_id, ledger_id, agreed) VALUES ($1,$2,TRUE), ($1,$3,FALSE)`, [orgA, shadow[0], shadow[1]]);
    await ledger(orgA, { decision: 'executed', reason: 'allowed', employeeId: maya, role: 'customer' });
    otherOrgShadow = await ledger(orgB, { decision: 'suppressed', reason: 'shadow_stage', employeeId: bEmp, role: 'customer' });
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM orgs WHERE id = ANY($1::uuid[])`, [[orgA, orgB]]);
    await admin.end();
    await app.end();
  });

  it('counts a person’s decisions per employee, in the last 30 days', async () => {
    const s = await collect(orgA);
    const m = s.employees.find((e) => e.id === maya)!.evidence;
    expect(m).toMatchObject({ approvedAsIs: 5, approvedEdited: 1, rejected: 2, expired: 1, waiting: 1, failedToRun: 1 });
    // decided = approved (5 + 1) + rejected 2 = 8; the made-up id was attributed to the only customer employee
    expect(m.decided).toBe(8);
    expect(m.enough).toBe(false);
  });

  it('does not count another workspace’s decisions, and leaves a role nobody holds unattributed', async () => {
    const s = await collect(orgA);
    // Since the stage began (100 days ago): Maya's 8, the unattributed finance one, and Ravi's old one.
    expect(s.workspace.decisionsInStage).toBe(8 + 1 + 1);
    expect(s.workspace.weeksInStage).toBeGreaterThan(14);
    expect(s.unattributed.rejected).toBe(1);
    // ...but only the last 30 days count toward an employee's own record, and Ravi's one decision is 90 days old.
    expect(s.employees.find((e) => e.id === ravi)!.evidence.decided).toBe(0);
    expect(s.workspace.recentDecided).toBe(8 + 1);
  });

  it('counts watching-mode reviews from the review table, not from a stored counter', async () => {
    const s = await collect(orgA);
    expect(s.shadow).toEqual({ reviewed: 2, agreed: 1, waiting: 2 });
    expect(s.workspace.shadowReviewed).toBe(2);
    expect(s.workspace.shadowAgreed).toBe(1);
  });

  it('says outcomes are not tracked when nothing records undo or complaint signals', async () => {
    const s = await collect(orgA);
    expect(s.outcomesTracked).toBe(false);
    expect(s.employees.find((e) => e.id === maya)!.evidence.problemRate).toBeNull();
  });

  it('starts a workspace with no recorded stage change at its current stage, flagged as approximate', async () => {
    const s = await collect(orgA);
    expect(s.stage).toBe(0);
    expect(s.sinceApproximate).toBe(true);
    expect(s.history).toEqual([]);
  });

  it('dates the current stage from the newest recorded change when it matches where the workspace is', async () => {
    const c = await org('c');
    await admin.query(`INSERT INTO users (org_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'FAKE')`, [c, `owner-${stamp}@example.test`]);
    const who = (await admin.query(`SELECT id FROM users WHERE org_id = $1`, [c])).rows[0].id;
    await admin.query(`INSERT INTO org_runtime_controls (org_id, autonomy_stage) VALUES ($1, 1)`, [c]);
    await admin.query(
      `INSERT INTO org_autonomy_stage_events (org_id, from_stage, to_stage, kind, reason, evidence, actor_user_id, created_at)
       VALUES ($1, 0, 1, 'advance', 'Ready', '{}'::jsonb, $2, NOW() - INTERVAL '40 days')`,
      [c, who],
    );
    try {
      const s = await collect(c);
      expect(s.stage).toBe(1);
      expect(s.sinceApproximate).toBe(false);
      expect(s.workspace.weeksInStage).toBeGreaterThan(5.5);
      expect(s.history).toHaveLength(1);
      expect(s.history[0]).toMatchObject({ fromStage: 0, toStage: 1, kind: 'advance', by: `owner-${stamp}@example.test` });
    } finally {
      await admin.query(`DELETE FROM orgs WHERE id = $1`, [c]);
    }
  });

  it('calls the date approximate when the history ends at a different level than the workspace is at now', async () => {
    const e = await org('e');
    await admin.query(`INSERT INTO org_runtime_controls (org_id, autonomy_stage) VALUES ($1, 0)`, [e]); // paused by support: not recorded
    await admin.query(
      `INSERT INTO org_autonomy_stage_events (org_id, from_stage, to_stage, kind, evidence, created_at)
       VALUES ($1, 0, 1, 'advance', '{}'::jsonb, NOW() - INTERVAL '60 days')`,
      [e],
    );
    try {
      const s = await collect(e);
      expect(s.stage).toBe(0);
      expect(s.sinceApproximate).toBe(true);
      expect(s.workspace.weeksInStage).toBeLessThan(1); // dated from the last write to the level, not 60 days ago
    } finally {
      await admin.query(`DELETE FROM orgs WHERE id = $1`, [e]);
    }
  });

  it('lists only watching-mode decisions nobody has answered yet, newest first, in words', async () => {
    const items = await asApp(orgA, (c) => listShadowDecisions(c, orgA));
    expect(items.map((i) => i.id).sort()).toEqual([shadowIds[2], shadowIds[3]].sort());
    expect(items.every((i) => i.employee === 'Maya')).toBe(true);
    expect(items.map((i) => i.what)).toContain('Send email "Hi" to a@b.co');
    expect(items.map((i) => i.what)).toContain('Gmail: send email'); // no sentence saved: the action id, in words
  });

  it('records one answer per decision, and a changed mind replaces it instead of adding a second', async () => {
    const counts = await asApp(orgA, async (c) => {
      expect(await recordShadowReview(c, orgA, reviewer, shadowIds[2], true)).toBe('ok');
      expect(await recordShadowReview(c, orgA, reviewer, shadowIds[2], false)).toBe('ok');
      return shadowCounts(c, orgA);
    });
    expect(counts).toEqual({ waiting: 1, reviewed: 3, agreed: 1 });
  });

  it('will not record an answer about another workspace’s decision, or about a decision that is not a watching-mode one', async () => {
    const executedId = await ledger(orgA, { decision: 'executed', reason: 'allowed', employeeId: maya, role: 'customer' });
    const results = await asApp(orgA, async (c) => [
      await recordShadowReview(c, orgA, reviewer, otherOrgShadow, true),
      await recordShadowReview(c, orgA, reviewer, executedId, true),
      await recordShadowReview(c, orgA, reviewer, '99999999-9999-4999-8999-999999999999', true),
    ]);
    expect(results).toEqual(['not_found', 'not_found', 'not_found']);
  });

  it('can only see its own workspace as the application role (row-level security)', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgA]);
      const seen = await client.query(`SELECT DISTINCT org_id::text FROM agent_pending_actions`);
      expect(seen.rows.map((r) => r.org_id)).toEqual([orgA]);
      const reviews = await client.query(`SELECT DISTINCT org_id::text FROM agent_shadow_reviews`);
      expect(reviews.rows.map((r) => r.org_id)).toEqual([orgA]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
