#!/usr/bin/env node
/**
 * Can the webhook route actually identify a tenant? Asked of a real Postgres, as the app role.
 *
 * `orgs` is FORCE ROW LEVEL SECURITY. The Chatwoot webhook route runs before any org is known, so it
 * connects as darex_app with NO org context. A plain SELECT on orgs from that connection returns zero
 * rows; only the SECURITY DEFINER resolvers can see an org. This check proves both halves against the
 * running database, so it cannot pass because of a mock:
 *
 *   1. the failure mode is real     — the raw read sees nothing, even though the org exists
 *   2. the resolvers work           — right id + right secret resolves, every wrong pairing does not
 *   3. a secret opens only its org  — A's secret with B's id is refused
 *   4. inactive orgs stay closed    — a suspended org cannot receive inbound messages
 *
 * Creates two throwaway orgs and removes them. Env: DB_HOST, DB_PORT, DB_NAME, DB_USER/DB_PASSWORD (app role),
 * DB_RESOLVER_USER/DB_RESOLVER_PASSWORD (owner, to create the fixtures).
 *
 * Usage: node infra/scripts/check-webhook-org-resolution.js
 */
const crypto = require('crypto');
const path = require('path');

let Client;
try {
  Client = require('pg').Client;
} catch {
  Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client;
}

const base = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'darex',
};
const owner = new Client({
  ...base,
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || 'darex_dev_secret',
});
const app = new Client({
  ...base,
  user: process.env.DB_USER || 'darex_app',
  password: process.env.DB_PASSWORD || process.env.APP_DB_PASSWORD || 'darex_app_dev_secret',
});

let passed = 0;
let failed = 0;
const ok = (name, detail = '') => { passed++; console.log(`  [PASS] ${name}${detail ? ' — ' + detail : ''}`); };
const no = (name, detail = '') => { failed++; console.log(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`); };

async function main() {
  console.log('=== WEBHOOK ORG RESOLUTION — can the route identify a tenant? ===');
  await owner.connect();
  await app.connect();
  const tag = crypto.randomBytes(4).toString('hex');
  const secretA = 'whsec_a_' + crypto.randomBytes(12).toString('hex');
  const secretB = 'whsec_b_' + crypto.randomBytes(12).toString('hex');
  const made = [];
  try {
    for (const [label, secret, status] of [['A', secretA, 'active'], ['B', secretB, 'active'], ['S', 'whsec_s_' + tag, 'suspended']]) {
      const r = await owner.query(
        `INSERT INTO orgs (name, slug, status, meta) VALUES ($1, $2, $3, jsonb_build_object('webhook_secret', $4::text)) RETURNING id`,
        [`resolution-${label}-${tag}`, `resolution-${label.toLowerCase()}-${tag}`, status, secret]
      );
      made.push(r.rows[0].id);
    }
    const [A, B, S] = made;
    const secretS = 'whsec_s_' + tag;

    console.log('\n1. The failure mode is real');
    const raw = await app.query(`SELECT id FROM orgs WHERE id = $1 AND status = 'active' AND meta->>'webhook_secret' = $2 LIMIT 1`, [A, secretA]);
    raw.rows.length === 0
      ? ok('a plain SELECT on orgs finds nothing as the app role', 'the org exists; the policy hides it')
      : no('a plain SELECT on orgs finds nothing as the app role', `it returned ${raw.rows.length} row(s) — RLS is not protecting orgs`);

    console.log('\n2. The resolvers');
    const bearer = await app.query(`SELECT resolve_org_by_webhook_secret($1) AS id`, [secretA]);
    bearer.rows[0].id === A ? ok('Authorization: Bearer <secret> resolves its org') : no('Authorization: Bearer <secret> resolves its org', String(bearer.rows[0].id));

    let pair;
    try {
      pair = await app.query(`SELECT org_resolve_by_id_and_secret($1::uuid, $2::text) AS id`, [A, secretA]);
    } catch (e) {
      pair = { rows: [{ id: 'ERR ' + e.message.split('\n')[0] }] };
    }
    pair.rows[0].id === A
      ? ok('?org_id=<id>&token=<secret> resolves its org')
      : no('?org_id=<id>&token=<secret> resolves its org', String(pair.rows[0].id) + ' — the per-tenant webhook URL cannot work');

    console.log('\n3. A secret opens only its own org');
    const cross = await app.query(`SELECT org_resolve_by_id_and_secret($1::uuid, $2::text) AS id`, [B, secretA]).catch((e) => ({ rows: [{ id: 'ERR ' + e.message }] }));
    cross.rows[0].id === null ? ok("org B's id with org A's secret is refused") : no("org B's id with org A's secret is refused", String(cross.rows[0].id));
    const wrong = await app.query(`SELECT org_resolve_by_id_and_secret($1::uuid, $2::text) AS id`, [A, 'nope']).catch((e) => ({ rows: [{ id: 'ERR ' + e.message }] }));
    wrong.rows[0].id === null ? ok('the right id with a wrong secret is refused') : no('the right id with a wrong secret is refused', String(wrong.rows[0].id));
    const empty = await app.query(`SELECT org_resolve_by_id_and_secret($1::uuid, $2::text) AS id`, [A, '']).catch((e) => ({ rows: [{ id: 'ERR ' + e.message }] }));
    empty.rows[0].id === null ? ok('an empty secret is refused') : no('an empty secret is refused', String(empty.rows[0].id));

    console.log('\n4. Inactive orgs stay closed');
    const susp = await app.query(`SELECT org_resolve_by_id_and_secret($1::uuid, $2::text) AS id`, [S, secretS]).catch((e) => ({ rows: [{ id: 'ERR ' + e.message }] }));
    susp.rows[0].id === null ? ok('a suspended org cannot receive inbound messages') : no('a suspended org cannot receive inbound messages', String(susp.rows[0].id));
    const suspBearer = await app.query(`SELECT resolve_org_by_webhook_secret($1) AS id`, [secretS]);
    suspBearer.rows[0].id === null ? ok('a suspended org cannot be reached by Bearer either') : no('a suspended org cannot be reached by Bearer either', String(suspBearer.rows[0].id));
  } finally {
    for (const id of made) await owner.query(`DELETE FROM orgs WHERE id = $1`, [id]).catch(() => {});
    await app.end().catch(() => {});
    await owner.end().catch(() => {});
  }
  console.log(`\n  passed ${passed} / ${passed + failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('check crashed: ' + e.message); process.exit(1); });
