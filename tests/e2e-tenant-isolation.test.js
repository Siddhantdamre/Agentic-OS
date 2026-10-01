/**
 * E2E Multi-Tenant Isolation & Security Test Suite
 * Validates RLS policies, organization context scoping, and agent execution.
 * Connects as the least-privilege `darex_app` role (not superuser `darex`).
 * Usage: node tests/e2e-tenant-isolation.test.js
 *
 * Runtime: APP_DB_USER / APP_DB_PASSWORD (defaults darex_app / darex_app_dev_secret).
 * Migrations still use superuser DB_USER=darex — do not reuse that here.
 */

let Client;
try {
  Client = require('pg').Client;
} catch (e) {
  Client = require(require('path').join(__dirname, '../apps/dashboard/node_modules/pg')).Client;
}

function appDbConfig() {
  return {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.APP_DB_USER || 'darex_app',
    password: process.env.APP_DB_PASSWORD || 'darex_app_dev_secret',
    database: process.env.DB_NAME || 'darex',
  };
}

function superuserDbConfig() {
  return {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || process.env.DB_SUPERUSER || 'darex',
    password: process.env.POSTGRES_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
    database: process.env.DB_NAME || 'darex',
  };
}

function platformDbConfig() {
  return {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: 'darex_platform',
    password: process.env.DAREX_PLATFORM_DB_PASSWORD || '',
    database: process.env.DB_NAME || 'darex',
  };
}

// Never re-grant table privileges here: the suite must see the grants the
// migrations actually ship, or append-only / read-only regressions hide.
async function withAdmin(fn) {
  const admin = new Client(superuserDbConfig());
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end().catch(() => {});
  }
}

let failures = 0;
function fail(msg, extra) {
  failures += 1;
  console.error(`  ❌ FAIL: ${msg}`, extra ?? '');
}

/** Expect the statement to be rejected (42501 / RLS violation). */
async function expectDenied(client, label, sql, params = []) {
  await client.query('SAVEPOINT deny_probe');
  try {
    const res = await client.query(sql, params);
    // UPDATE/DELETE filtered by RLS succeed with rowCount 0 — that is a denial too.
    if (typeof res.rowCount === 'number' && res.rowCount === 0 && /^\s*(UPDATE|DELETE)/i.test(sql)) {
      console.log(`  ✅ ${label}: 0 rows affected`);
    } else {
      fail(`${label}: statement was allowed`);
    }
  } catch (err) {
    console.log(`  ✅ ${label}: denied (${err.code || err.message})`);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT deny_probe');
  }
}

async function runBoundaryChecks(client, orgAId) {
  console.log('\n[Boundaries] darex_app cannot write global / append-only tables...');
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [orgAId]);
    await expectDenied(client, 'orgs INSERT', `INSERT INTO orgs (name, slug) VALUES ('x', 'x-${Date.now()}')`);
    await expectDenied(client, 'platform_send_counters direct write', `INSERT INTO platform_send_counters (minute_bucket, send_count) VALUES (NOW(), 0)`);
    await expectDenied(client, 'pack_entity_schemas UPDATE', `UPDATE pack_entity_schemas SET updated_at = NOW()`);
    await expectDenied(client, 'predicate_defs DELETE', `DELETE FROM predicate_defs`);
    await expectDenied(client, 'rera_cache INSERT', `INSERT INTO rera_cache (rera_id, url, expires_at) VALUES ('x', 'https://evil.example', NOW())`);
    await expectDenied(client, 'packs UPDATE', `UPDATE packs SET name = name`);
    await expectDenied(client, 'connector_defs DELETE', `DELETE FROM connector_defs`);
    await expectDenied(client, 'platform_admins INSERT', `INSERT INTO platform_admins (user_id, platform_role, reason) VALUES (uuid_generate_v4(), 'operator', 'x')`);
    await expectDenied(client, 'admin_audit_log SELECT', `SELECT 1 FROM admin_audit_log LIMIT 1`);
    await expectDenied(client, 'audit_events UPDATE', `UPDATE audit_events SET kind = kind`);
    await expectDenied(client, 'audit_events DELETE', `DELETE FROM audit_events`);
    await expectDenied(client, 'org_plan_overrides INSERT', `INSERT INTO org_plan_overrides (org_id, reason, updated_by) VALUES ($1, 'x', uuid_generate_v4())`, [orgAId]);

    const bump = await client.query('SELECT platform_send_counter_bump() AS n');
    if (Number(bump.rows[0]?.n) >= 1) console.log('  ✅ platform_send_counter_bump() works for darex_app');
    else fail('platform_send_counter_bump() returned nothing');
  } finally {
    await client.query('ROLLBACK');
  }
}

async function runPlatformChecks(orgAId, orgBId, actorUserId) {
  const cfg = platformDbConfig();
  if (!cfg.password) {
    if (process.env.CI === 'true') {
      fail('DAREX_PLATFORM_DB_PASSWORD must be set in CI so the darex_platform grants are exercised');
    } else {
      console.log('\n[Platform] skipped — DAREX_PLATFORM_DB_PASSWORD not set');
    }
    return;
  }
  console.log('\n[Platform] darex_platform sees nothing without platform_begin, both orgs with it...');
  const platform = new Client(cfg);
  await platform.connect();
  try {
    await platform.query('BEGIN');
    const before = await platform.query('SELECT id FROM orgs WHERE id = ANY($1::uuid[])', [[orgAId, orgBId]]);
    if (before.rows.length === 0) console.log('  ✅ no audit row → 0 orgs visible');
    else fail('darex_platform read orgs without an audit row');
    await platform.query('ROLLBACK');

    await platform.query('BEGIN');
    await platform.query(
      `SELECT platform_begin($1::uuid, 'operator', 'isolation_test', NULL, NULL, NULL, 'tenant isolation suite')`,
      [actorUserId]
    );
    const orgs = await platform.query('SELECT id FROM orgs WHERE id = ANY($1::uuid[])', [[orgAId, orgBId]]);
    if (orgs.rows.length === 2) console.log('  ✅ audited platform tx reads both orgs');
    else fail(`audited platform tx saw ${orgs.rows.length} of 2 orgs`);
    const msgs = await platform.query('SELECT count(*)::int AS n FROM messages WHERE org_id = $1', [orgAId]);
    if (msgs.rows[0].n >= 1) console.log('  ✅ audited platform tx reads messages');
    else fail('audited platform tx could not read messages');
    const upd = await platform.query(`UPDATE orgs SET status = status WHERE id = $1`, [orgAId]);
    if (upd.rowCount === 1) console.log('  ✅ audited platform tx updates orgs.status');
    else fail('audited platform tx could not update orgs');
    await platform.query('ROLLBACK');
  } catch (err) {
    fail('darex_platform query failed', err.message);
    await platform.query('ROLLBACK').catch(() => {});
  } finally {
    await platform.end().catch(() => {});
  }
}

async function runTenantIsolationTests() {
  console.log('🧪 Starting DareX E2E Multi-Tenant Security & Isolation Test Suite...\n');

  const dbConfig = appDbConfig();
  const client = new Client(dbConfig);
  await client.connect();

  try {
    const who = await client.query('SELECT current_user');
    const currentUser = who.rows[0]?.current_user;
    if (currentUser !== 'darex_app') {
      console.error(
        `  ❌ FAIL: isolation suite must run as darex_app, got current_user=${currentUser}`
      );
      process.exit(1);
    }
    console.log(`  ✓ Connected as ${currentUser} (least-privilege app role)`);

    // Test 1: Create two distinct test organizations
    console.log('[Test 1] Provisioning Org A and Org B...');
    // Orgs are provisioned through the SECURITY DEFINER path (darex_app has no
    // INSERT on orgs); the actor user for the platform check is seeded as superuser.
    const { orgAId, orgBId, actorUserId } = await withAdmin(async (admin) => {
      const a = await admin.query(
        `INSERT INTO orgs (name, slug, plan, status) VALUES ($1, $2, 'enterprise', 'active') RETURNING id`,
        ['Test Org Alpha', `test-org-alpha-${Date.now()}`]
      );
      const b = await admin.query(
        `INSERT INTO orgs (name, slug, plan, status) VALUES ($1, $2, 'enterprise', 'active') RETURNING id`,
        ['Test Org Beta', `test-org-beta-${Date.now()}`]
      );
      const u = await admin.query(
        `INSERT INTO users (org_id, email, role) VALUES ($1, $2, 'owner') RETURNING id`,
        [a.rows[0].id, `isolation-${Date.now()}@example.test`]
      );
      return { orgAId: a.rows[0].id, orgBId: b.rows[0].id, actorUserId: u.rows[0].id };
    });
    console.log(`  ✓ Org Alpha ID: ${orgAId}`);
    console.log(`  ✓ Org Beta ID:  ${orgBId}`);

    // Test 2: Seed messages in Org A under Org A RLS context
    console.log('\n[Test 2] Inserting message under Org A context as darex_app role...');
    await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgAId]);

    const convRes = await client.query(
      `INSERT INTO conversations (org_id, status) VALUES ($1, 'open') RETURNING id`,
      [orgAId]
    );
    const convAId = convRes.rows[0].id;

    await client.query(
      `INSERT INTO messages (org_id, conversation_id, role, content) VALUES ($1, $2, 'user', 'Confidential Org A Message')`,
      [orgAId, convAId]
    );
    console.log('  ✓ Confidential message inserted for Org Alpha.');

    // Test 3: Switch context to Org B and attempt to query Org A's data
    console.log('\n[Test 3] Switching RLS context to Org Beta (as darex_app role) and attempting cross-tenant read...');
    await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgBId]);

    const crossReadRes = await client.query(`SELECT * FROM messages`);
    if (crossReadRes.rows.length === 0) {
      console.log('  ✅ SUCCESS: Org Beta sees 0 rows from Org Alpha (RLS strictly enforced for application role!).');
    } else {
      console.error('  ❌ FAIL: Cross-tenant data leak detected! Org Beta retrieved Org Alpha messages:', crossReadRes.rows);
      process.exit(1);
    }

    // Test 4: Verify Org A context retrieval
    console.log('\n[Test 4] Re-verifying Org Alpha context read...');
    await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgAId]);
    const orgAReadRes = await client.query(`SELECT * FROM messages WHERE conversation_id = $1`, [convAId]);
    if (orgAReadRes.rows.length > 0 && orgAReadRes.rows[0].content === 'Confidential Org A Message') {
      console.log('  ✅ SUCCESS: Org Alpha correctly accesses its own scoped data.');
    } else {
      console.error('  ❌ FAIL: Org Alpha failed to read its own data.');
      process.exit(1);
    }

    await runBoundaryChecks(client, orgAId);
    await runPlatformChecks(orgAId, orgBId, actorUserId);

    // Test 5: Cleanup test organizations
    console.log('\n[Test 5] Cleaning up test organizations...');
    await withAdmin(async (admin) => {
      await admin.query(`DELETE FROM admin_audit_log WHERE actor_user_id = $1`, [actorUserId]);
      await admin.query(`DELETE FROM orgs WHERE id = ANY($1::uuid[])`, [[orgAId, orgBId]]);
    });
    console.log('  ✓ Test cleanup complete.');

    if (failures > 0) {
      console.error(`\n❌ ${failures} isolation check(s) failed`);
      process.exit(1);
    }
    console.log('\n🎉 ALL MULTI-TENANT ISOLATION TESTS PASSED CLEANLY!');
  } finally {
    await client.end();
  }
}

runTenantIsolationTests().catch((err) => {
  console.error('Test Execution Error:', err);
  process.exit(1);
});
