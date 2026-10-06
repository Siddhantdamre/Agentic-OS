'use strict';
// Makes one throwaway workspace with an owner, a signed session cookie and one employee, straight in the
// sandbox database. `node seed.js [stage]` prints JSON. Used by the flow checks; deleted by cleanup().
const { spawnSync } = require('child_process');
const crypto = require('crypto');
// Must be the same value the harness dashboard server is started with (run-flows.sh sets both).
const SECRET = process.env.DAREX_SESSION_SECRET || 'harness-only-session-secret-0123456789abcdef';
// Seeds as the database owner (row-level security does not apply), exactly like the other check scripts.
function psql(sql) {
  const env = { ...process.env, PGPASSWORD: process.env.DB_RESOLVER_PASSWORD || 'darex_dev_secret' };
  const r = spawnSync('psql', ['-h', process.env.DB_HOST || '127.0.0.1', '-p', process.env.DB_PORT || '5432', '-U', process.env.DB_RESOLVER_USER || 'darex', '-d', process.env.DB_NAME || 'darex', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', env });
  if (r.status !== 0) throw new Error('psql failed: ' + r.stderr + '\n' + sql.slice(0, 200));
  return r.stdout.trim().split('\n')[0];
}
function seed({ stage = 1, role = 'owner', tag = 'flow', tools = ['gmail', 'google-calendar', 'customer-ops'] } = {}) {
  const stamp = Date.now() + '' + Math.floor(Math.random() * 1000);
  const orgId = psql(`INSERT INTO orgs (name, slug, status, plan, employees_seeded) VALUES ('Flow ${tag} ${stamp}', 'flow-${tag}-${stamp}', 'active', 'growth', true) RETURNING id`);
  const email = `${tag}-${stamp}@example.test`;
  const userId = psql(`INSERT INTO users (org_id, email, role, terms_accepted_at) VALUES ('${orgId}', '${email}', '${role}', now()) RETURNING id`);
  psql(`INSERT INTO organization_memberships (user_id, org_id, role, is_default) VALUES ('${userId}', '${orgId}', '${role}', true) RETURNING 1`);
  psql(`INSERT INTO org_onboarding (org_id, wizard_step) VALUES ('${orgId}', 'done') ON CONFLICT (org_id) DO UPDATE SET wizard_step='done' RETURNING 1`);
  psql(`INSERT INTO org_runtime_controls (org_id, autonomy_stage, kill_switch) VALUES ('${orgId}', ${stage}, false) ON CONFLICT (org_id) DO UPDATE SET autonomy_stage=${stage}, kill_switch=false RETURNING 1`);
  const allow = '{' + tools.map((t) => `"${t}"`).join(',') + '}';
  const employeeId = psql(`INSERT INTO ai_employees (org_id, name, role, status, tool_allowlist, persona) VALUES ('${orgId}', 'Emma', 'Customer Support', 'active', '${allow}', '{}'::jsonb) RETURNING id`);
  const exp = Math.floor(Date.now() / 1000) + 7200;
  const payload = `${userId}.0.${exp}`;
  const cookie = `${payload}.${crypto.createHmac('sha256', SECRET).update(payload).digest('hex')}`;
  return { orgId, userId, email, employeeId, cookie };
}
function cleanup(orgId) { psql(`DELETE FROM orgs WHERE id='${orgId}' RETURNING 1`); }
module.exports = { seed, cleanup, psql };
if (require.main === module) console.log(JSON.stringify(seed({ stage: Number(process.argv[2] || 1) })));
