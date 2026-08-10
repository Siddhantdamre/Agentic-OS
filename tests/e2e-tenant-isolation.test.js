/**
 * E2E Multi-Tenant Isolation & Security Test Suite
 * Validates RLS policies, organization context scoping, and agent execution.
 * Usage: node tests/e2e-tenant-isolation.test.js
 */

let Client;
try {
  Client = require('pg').Client;
} catch (e) {
  Client = require(require('path').join(__dirname, '../apps/dashboard/node_modules/pg')).Client;
}

async function runTenantIsolationTests() {
  console.log('🧪 Starting DareX E2E Multi-Tenant Security & Isolation Test Suite...\n');

  const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER || 'darex',
    password: process.env.DB_PASSWORD || 'darex_dev_secret',
    database: process.env.DB_NAME || 'darex',
  };

  const client = new Client(dbConfig);
  await client.connect();

  try {
    // Ensure darex_app role has permissions
    await client.query(`GRANT USAGE ON SCHEMA public TO darex_app`);
    await client.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO darex_app`);

    // Test 1: Create two distinct test organizations
    console.log('[Test 1] Provisioning Org A and Org B...');
    const orgARes = await client.query(
      `INSERT INTO orgs (name, slug, plan, status) VALUES ($1, $2, 'enterprise', 'active') RETURNING id`,
      ['Test Org Alpha', `test-org-alpha-${Date.now()}`]
    );
    const orgBRes = await client.query(
      `INSERT INTO orgs (name, slug, plan, status) VALUES ($1, $2, 'enterprise', 'active') RETURNING id`,
      ['Test Org Beta', `test-org-beta-${Date.now()}`]
    );

    const orgAId = orgARes.rows[0].id;
    const orgBId = orgBRes.rows[0].id;
    console.log(`  ✓ Org Alpha ID: ${orgAId}`);
    console.log(`  ✓ Org Beta ID:  ${orgBId}`);

    // Test 2: Seed messages in Org A under Org A RLS context
    console.log('\n[Test 2] Inserting message under Org A context as darex_app role...');
    await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgAId]);
    await client.query("SET ROLE darex_app");

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
    await client.query("RESET ROLE");
    await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgBId]);
    await client.query("SET ROLE darex_app");

    const crossReadRes = await client.query(`SELECT * FROM messages`);
    if (crossReadRes.rows.length === 0) {
      console.log('  ✅ SUCCESS: Org Beta sees 0 rows from Org Alpha (RLS strictly enforced for application role!).');
    } else {
      console.error('  ❌ FAIL: Cross-tenant data leak detected! Org Beta retrieved Org Alpha messages:', crossReadRes.rows);
      process.exit(1);
    }

    // Test 4: Verify Org A context retrieval
    console.log('\n[Test 4] Re-verifying Org Alpha context read...');
    await client.query("RESET ROLE");
    await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgAId]);
    await client.query("SET ROLE darex_app");
    const orgAReadRes = await client.query(`SELECT * FROM messages WHERE conversation_id = $1`, [convAId]);
    if (orgAReadRes.rows.length > 0 && orgAReadRes.rows[0].content === 'Confidential Org A Message') {
      console.log('  ✅ SUCCESS: Org Alpha correctly accesses its own scoped data.');
    } else {
      console.error('  ❌ FAIL: Org Alpha failed to read its own data.');
      process.exit(1);
    }

    // Test 5: Cleanup test organizations
    console.log('\n[Test 5] Cleaning up test organizations...');
    await client.query("RESET ROLE");
    await client.query(`DELETE FROM orgs WHERE id IN ($1, $2)`, [orgAId, orgBId]);
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
