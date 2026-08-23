#!/usr/bin/env node
'use strict';

/**
 * I6 — RLS job: darex_app session isolation. Never run as superuser.
 *
 *   node infra/scripts/alerting-rls-job.js
 *
 * Connects as DB_USER (must be darex_app). Proves two synthetic orgs cannot
 * see each other's `orgs` row under SET app.current_org_id. If RLS is off or
 * the role is darex, FAIL — do not report green.
 */

// NOTE: 127.0.0.1, never 'localhost'. Node resolves localhost to IPv6 ::1 first;
// Docker publishes on [::] but that path resets the connection, producing
// intermittent ECONNRESET / "fetch failed" that looks like random flakiness.
// curl hides this by falling back to IPv4 — Node's fetch and pg do not.
const path = require('path');

let Pool;
try {
  Pool = require('pg').Pool;
} catch (e) {
  Pool = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Pool;
}

const user = process.env.APP_DB_USER || process.env.DB_USER || 'darex_app';
const password =
  process.env.APP_DB_PASSWORD || process.env.DB_PASSWORD || 'darex_app_dev_secret';

console.log('\n=== Alerting — RLS job (darex_app) ===\n');

if (user === 'darex') {
  console.log('  [FAIL] refusing to run as superuser darex (RLS would be bypassed)');
  process.exit(1);
}

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user,
  password,
  database: process.env.DB_NAME || 'darex',
});

async function main() {
  const client = await pool.connect();
  let orgA;
  let orgB;
  try {
    const who = await client.query('SELECT current_user AS u, current_setting(\'row_security\', true) AS rs');
    const u = who.rows[0].u;
    if (u !== 'darex_app') {
      console.log(`  [FAIL] current_user=${u} (expected darex_app)`);
      process.exit(1);
    }
    console.log(`  [PASS] connected as ${u}`);

    const rls = await client.query(
      `SELECT relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE relname = 'orgs' AND relnamespace = 'public'::regnamespace`,
    );
    if (rls.rows.length === 0) {
      console.log('  [FAIL] public.orgs not found');
      process.exit(1);
    }
    if (!rls.rows[0].relrowsecurity) {
      console.log('  [FAIL] orgs does not have RLS enabled');
      process.exit(1);
    }
    console.log('  [PASS] orgs has RLS enabled');

    // FORCE RLS is on `orgs` as of migration 028, and the policy refuses a
    // direct INSERT with no org context — which is the behaviour this probe
    // exists to confirm. So the fixtures come in through org_provision(), the
    // sanctioned signup door, exactly as the application creates a tenant.
    // Writing them with a raw INSERT made the probe fail on the very policy it
    // was checking for.
    await client.query('BEGIN');
    const a = await client.query(
      `SELECT org_provision('rls-alert-a', 'rls-alert-a-' || substr(md5(random()::text), 1, 12)) AS id`,
    );
    const b = await client.query(
      `SELECT org_provision('rls-alert-b', 'rls-alert-b-' || substr(md5(random()::text), 1, 12)) AS id`,
    );
    orgA = a.rows[0].id;
    orgB = b.rows[0].id;

    await client.query("SELECT set_config('app.current_org_id', $1, true)", [orgA]);
    const seen = await client.query('SELECT id FROM orgs WHERE id = ANY($1::uuid[])', [[orgA, orgB]]);
    const ids = seen.rows.map((r) => r.id);
    const seesA = ids.includes(orgA);
    const seesB = ids.includes(orgB);
    if (!seesA || seesB) {
      console.log(
        `  [FAIL] isolation broken: org A session sees A=${seesA} B=${seesB} (count=${ids.length})`,
      );
      await client.query('ROLLBACK');
      process.exit(1);
    }
    console.log('  [PASS] org A session cannot see org B');
    await client.query('ROLLBACK');
  } finally {
    if (orgA || orgB) {
      try {
        const admin = new Pool({
          host: process.env.DB_HOST || '127.0.0.1',
          port: parseInt(process.env.DB_PORT || '5432', 10),
          user: 'darex',
          password: process.env.DB_PASSWORD || 'darex_dev_secret',
          database: process.env.DB_NAME || 'darex',
        });
        const c = await admin.connect();
        try {
          if (orgA) await c.query('DELETE FROM orgs WHERE id = $1', [orgA]);
          if (orgB) await c.query('DELETE FROM orgs WHERE id = $1', [orgB]);
        } finally {
          c.release();
          await admin.end();
        }
      } catch (e) {
        console.log(`  [INFO] cleanup: ${(e.message || e).toString().split('\n')[0]}`);
      }
    }
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.log(`  [FAIL] ${err.message || err}`);
  process.exit(1);
});
