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

async function ensureAppGrants() {
  const adminCfg = superuserDbConfig();
  const appCfg = appDbConfig();
  if (adminCfg.user === appCfg.user) return;
  const admin = new Client(adminCfg);
  try {
    await admin.connect();
    await admin.query(`GRANT USAGE ON SCHEMA public TO darex_app`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO darex_app`);
    await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO darex_app`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`  (optional superuser GRANT skipped: ${message})`);
  } finally {
    try {
      await admin.end();
    } catch {
      // ignore
    }
  }
}

async function runTenantIsolationTests() {
  console.log('🧪 Starting DareX E2E Multi-Tenant Security & Isolation Test Suite...\n');

  await ensureAppGrants();

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
    //
    // THROUGH THE SIGNUP DOOR, NOT AROUND IT. This used to be a raw
    // `INSERT INTO orgs`, which migration 028 deliberately made impossible:
    // `orgs` is now under FORCE row-level security and the policy's WITH CHECK
    // requires the new row's id to equal the session's org. At signup there is
    // no session org and there cannot be — the row being written is what
    // establishes it. So 028 added `org_provision()` as a named SECURITY
    // DEFINER door and closed the wall behind it.
    //
    // The old insert had been failing here with
    //   42501  new row violates row-level security policy for table "orgs"
    // on every CI run since. That is the policy working, not a regression: the
    // test was asserting a path the product had correctly removed. Going
    // through the same door the dashboard's signup uses also means this suite
    // now exercises the real path instead of a privileged shortcut.
    console.log('[Test 1] Provisioning Org A and Org B via org_provision()...');
    const orgARes = await client.query(
      `SELECT org_provision($1, $2) AS id`,
      ['Test Org Alpha', `test-org-alpha-${Date.now()}`]
    );
    const orgBRes = await client.query(
      `SELECT org_provision($1, $2) AS id`,
      ['Test Org Beta', `test-org-beta-${Date.now()}`]
    );

    const orgAId = orgARes.rows[0].id;
    const orgBId = orgBRes.rows[0].id;
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

    // Test 5: Cleanup test organizations
    console.log('\n[Test 5] Cleaning up test organizations...');
    await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgAId]);
    await client.query(`DELETE FROM orgs WHERE id = $1`, [orgAId]);
    await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgBId]);
    await client.query(`DELETE FROM orgs WHERE id = $1`, [orgBId]);
    console.log('  ✓ Test cleanup complete.');

    console.log('\n🎉 ALL MULTI-TENANT ISOLATION TESTS PASSED CLEANLY!');
  } finally {
    await client.end();
  }
}

runTenantIsolationTests().catch((err) => {
  console.error('Test Execution Error:', err);
  process.exit(1);
});
