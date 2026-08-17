'use strict';

/**
 * Darex Phase 6 — Memory / RAG probe (M1–M6, A2).
 *
 * Proves two-org vector isolation as darex_app and empty-org emptiness.
 * Fail-closed if memory tables are missing (M1 not applied) unless
 * EVAL_ALLOW_MISSING_MEMORY=1 (honest skip, not a fake pass).
 *
 * Usage: node infra/scripts/check-phase6-memory.js
 */

const fs = require('fs');
const path = require('path');
const {
  MEMORY_TABLES,
  loadPg,
  superuserConfig,
  appRoleName,
  missingMemoryTables,
  tableColumns,
  vectorDims,
  zeroVectorLiteral,
  setOrg,
  resetRole,
  setAppRole,
} = require('../evals/lib/db');

console.log('\n=== Darex Phase 6 — Memory tables, empty org, two-org vector isolation ===\n');

let pass = 0;
let fail = 0;
let skip = 0;

function allowMissingMemory() {
  return process.env.EVAL_ALLOW_MISSING_MEMORY === '1';
}

async function insertOrgMemory(client, orgId, body) {
  const cols = await tableColumns(client, 'org_memory');
  const names = new Set(cols.map((c) => c.column_name));
  if (!names.has('org_id')) {
    throw new Error('M1 schema mismatch: org_memory missing org_id');
  }

  const fields = ['org_id'];
  const values = [orgId];
  const add = (col, value) => {
    if (names.has(col)) {
      fields.push(col);
      values.push(value);
    }
  };

  if (names.has('body')) add('body', body);
  else if (names.has('content')) add('content', body);
  else throw new Error('M1 schema mismatch: org_memory has neither body nor content');

  add('kind', 'eval_probe');
  add('title', 'Org A secret');
  add('source', 'eval-fixture');
  add('source_ref', 'check-phase6-memory');
  add('content_hash', `eval-m1-${orgId}`);

  if (names.has('embedding')) {
    const dims = await vectorDims(client, 'org_memory', 'embedding');
    if (dims && dims > 0) {
      fields.push('embedding');
      values.push(zeroVectorLiteral(dims));
    } else {
      const col = cols.find((c) => c.column_name === 'embedding');
      if (col && col.is_nullable === 'NO') {
        throw new Error('org_memory.embedding is NOT NULL but vector dim could not be read');
      }
    }
  }

  const placeholders = fields.map((name, i) => (name === 'embedding' ? `$${i + 1}::vector` : `$${i + 1}`));
  const sql = `INSERT INTO org_memory (${fields.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`;
  const res = await client.query(sql, values);
  return { row: res.rows[0], usedEmbedding: fields.includes('embedding') };
}

async function run() {
  const { Client } = loadPg();
  const client = new Client(superuserConfig());

  try {
    await client.connect();
    console.log('  [PASS] Postgres accepted a superuser connection');
    pass += 1;
  } catch (err) {
    console.log(`  [FAIL] Postgres connection — ${err.message}`);
    process.exit(1);
  }

  try {
    const ext = await client.query(`SELECT extname FROM pg_extension WHERE extname = 'vector'`);
    if (ext.rows.length > 0) {
      console.log('  [PASS] pgvector extension enabled');
      pass += 1;
    } else {
      console.log('  [FAIL] pgvector extension missing');
      fail += 1;
    }
  } catch (err) {
    console.log(`  [FAIL] pgvector check — ${err.message}`);
    fail += 1;
  }

  let missing;
  try {
    missing = await missingMemoryTables(client);
  } catch (err) {
    console.log(`  [FAIL] Could not inspect memory tables — ${err.message}`);
    fail += 1;
    await client.end().catch(() => {});
    process.exit(1);
  }

  console.log('\n--- M1 memory tables ---');
  if (missing.length > 0) {
    const msg = `M1 not applied — missing tables: ${missing.join(', ')}. Need infra/db/migrations/013_memory_rag.sql`;
    if (allowMissingMemory()) {
      console.log(`  [SKIP] ${msg}`);
      console.log('         EVAL_ALLOW_MISSING_MEMORY=1 — honest skip, not a green pass of two-org isolation.');
      skip += 1;
      console.log('\n--- Summary ---');
      console.log(`  pass=${pass} fail=${fail} skip=${skip} — memory probe skipped (M1 missing).`);
      await client.end().catch(() => {});
      process.exit(0);
    }
    console.log(`  [FAIL] ${msg}`);
    console.log('         Default is fail-closed. Override with EVAL_ALLOW_MISSING_MEMORY=1 for an honest skip.');
    fail += 1;
    console.log('\n--- Summary ---');
    console.log(`  ${fail} FAILED — M1 not applied. Two-org vector isolation NOT proven.`);
    await client.end().catch(() => {});
    process.exit(1);
  }

  for (const table of MEMORY_TABLES) {
    console.log(`  [PASS] ${table} exists`);
    pass += 1;
  }

  const retrievePath = path.join(__dirname, '../../services/workflows/src/memory/retrieve.ts');
  if (fs.existsSync(retrievePath)) {
    console.log('  [PASS] retrieveMemory source present (M3)');
    pass += 1;
  } else {
    console.log('  [FAIL] services/workflows/src/memory/retrieve.ts missing — M3 retrieve is required');
    fail += 1;
  }

  const role = appRoleName();
  let orgAId;
  let orgBId;
  let orgCId;
  const stamp = Date.now();

  try {
    console.log('\n--- Two-org vector isolation (darex_app) ---');
    const orgA = await client.query(
      `INSERT INTO orgs (name, slug, plan, status) VALUES ($1, $2, 'enterprise', 'active') RETURNING id`,
      ['Eval Memory Org A', `eval-m1-a-${stamp}`],
    );
    const orgB = await client.query(
      `INSERT INTO orgs (name, slug, plan, status) VALUES ($1, $2, 'enterprise', 'active') RETURNING id`,
      ['Eval Memory Org B', `eval-m1-b-${stamp}`],
    );
    const orgC = await client.query(
      `INSERT INTO orgs (name, slug, plan, status) VALUES ($1, $2, 'enterprise', 'active') RETURNING id`,
      ['Eval Memory Empty C', `eval-m1-c-${stamp}`],
    );
    orgAId = orgA.rows[0].id;
    orgBId = orgB.rows[0].id;
    orgCId = orgC.rows[0].id;
    console.log(`  [PASS] provisioned org A/B/C (${orgAId.slice(0, 8)}…)`);
    pass += 1;

    await resetRole(client);
    await setOrg(client, orgAId);
    await setAppRole(client);

    const secret = `org-A secret vector fact ${stamp}`;
    const inserted = await insertOrgMemory(client, orgAId, secret);
    if (inserted.usedEmbedding) {
      console.log('  [PASS] inserted org_memory row with embedding for Org A as darex_app');
    } else {
      console.log('  [PASS] inserted org_memory row for Org A as darex_app (no embedding column/dim)');
    }
    pass += 1;

    await resetRole(client);
    await setOrg(client, orgBId);
    await setAppRole(client);
    const cross = await client.query(`SELECT * FROM org_memory`);
    if (cross.rows.length === 0) {
      console.log(`  [PASS] Org B as ${role} sees 0 org_memory rows from Org A`);
      pass += 1;
    } else {
      console.log(`  [FAIL] Cross-tenant vector leak: Org B saw ${cross.rows.length} org_memory row(s)`);
      fail += 1;
    }

    await resetRole(client);
    await setOrg(client, orgAId);
    await setAppRole(client);
    const own = await client.query(`SELECT * FROM org_memory`);
    const bodies = own.rows.map((r) => r.body || r.content || '');
    if (own.rows.length >= 1 && bodies.some((b) => String(b).includes(secret))) {
      console.log('  [PASS] Org A reads back its own memory row');
      pass += 1;
    } else {
      console.log('  [FAIL] Org A failed to read its own org_memory row');
      fail += 1;
    }

    console.log('\n--- Empty org ---');
    await resetRole(client);
    await setOrg(client, orgCId);
    await setAppRole(client);
    let emptyCount = 0;
    for (const table of ['org_memory', 'employee_memory', 'entity_memory', 'conversation_memory']) {
      const countRes = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
      emptyCount += countRes.rows[0].n;
    }
    if (emptyCount === 0) {
      console.log('  [PASS] Empty org C has 0 memory rows (no invented facts in the index)');
      pass += 1;
    } else {
      console.log(`  [FAIL] Empty org C has ${emptyCount} memory rows — index is not empty`);
      fail += 1;
    }
  } catch (err) {
    console.log(`  [FAIL] isolation probe — ${err.message}`);
    fail += 1;
  } finally {
    try {
      await resetRole(client);
      const ids = [orgAId, orgBId, orgCId].filter(Boolean);
      if (ids.length > 0) {
        await client.query(`DELETE FROM orgs WHERE id = ANY($1::uuid[])`, [ids]);
        console.log('  [INFO] cleaned up eval orgs');
      }
    } catch (err) {
      console.log(`  [INFO] cleanup warning: ${err.message}`);
    }
    await client.end().catch(() => {});
  }

  console.log('\n--- Summary ---');
  const total = pass + fail + skip;
  if (fail === 0) {
    console.log(`  ALL CHECKS PASSED (${pass}/${total}) — Phase 6 memory probe green.\n`);
    process.exit(0);
  }
  console.log(`  ${fail}/${total} CHECKS FAILED — do not treat memory as shipped.\n`);
  process.exit(1);
}

run().catch((err) => {
  console.error('Phase 6 memory probe error:', err);
  process.exit(1);
});
