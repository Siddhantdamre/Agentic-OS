'use strict';

/**
 * WS-05 / M3 — retrieveMemory prefix goldens.
 *
 * 1. Empty index formatter never invents Kapoor / listings.
 * 2. Same query, two orgs, zero cross hits (org_id filter + RLS), including
 *    a vector neighbor that would match without the org GUC.
 * 3. Grounded user message cites `[M-n]` and keeps the org+channels prefix.
 *
 * Usage: node infra/scripts/check-retrieve-memory.js
 * Requires: compiled @darex/workflows (pnpm --filter @darex/workflows exec tsc)
 */

// NOTE: 127.0.0.1, never 'localhost'. Node resolves localhost to IPv6 ::1 first;
// Docker publishes on [::] but that path resets the connection, producing
// intermittent ECONNRESET / "fetch failed" that looks like random flakiness.
// curl hides this by falling back to IPv4 — Node's fetch and pg do not.
const fs = require('fs');
const path = require('path');
const {
  loadPg,
  superuserConfig,
  missingMemoryTables,
  tableColumns,
  vectorDims,
  setOrg,
  resetRole,
  setAppRole,
} = require('../evals/lib/db');

console.log('\n=== Darex M3 — retrieveMemory two-org + empty-index goldens ===\n');

let pass = 0;
let fail = 0;
let skip = 0;

function allowMissingMemory() {
  return process.env.EVAL_ALLOW_MISSING_MEMORY === '1';
}

function loadRetrieveModule() {
  const retrievePath = path.join(__dirname, '../../services/workflows/dist/memory/retrieve.js');
  const clientPath = path.join(__dirname, '../../services/workflows/dist/atomic-agent-client.js');
  if (!fs.existsSync(retrievePath) || !fs.existsSync(clientPath)) {
    throw new Error(
      'compiled retrieve missing — run pnpm --filter @darex/workflows exec tsc (emit to dist/)',
    );
  }
  process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
  process.env.DB_PORT = process.env.DB_PORT || '5432';
  process.env.DB_NAME = process.env.DB_NAME || 'darex';
  const savedPassword = process.env.DB_PASSWORD;
  process.env.DB_USER = process.env.APP_DB_USER || process.env.DB_USER || 'darex_app';
  process.env.DB_PASSWORD = process.env.APP_DB_PASSWORD || 'darex_app_dev_secret';
  const retrieve = require(retrievePath);
  const client = require(clientPath);
  if (savedPassword !== undefined) process.env.DB_PASSWORD = savedPassword;
  else delete process.env.DB_PASSWORD;
  return { retrieve, client };
}

function unitVectorLiteral(dims, axis) {
  const arr = Array(dims).fill(0);
  arr[Math.max(0, Math.min(dims - 1, axis))] = 1;
  return `[${arr.join(',')}]`;
}

function unitVector(dims, axis) {
  const arr = Array(dims).fill(0);
  arr[Math.max(0, Math.min(dims - 1, axis))] = 1;
  return arr;
}

async function insertOrgMemory(pgClient, orgId, body, embeddingLiteral) {
  const cols = await tableColumns(pgClient, 'org_memory');
  const names = new Set(cols.map((c) => c.column_name));
  const fields = ['org_id'];
  const values = [orgId];
  const add = (col, value) => {
    if (names.has(col)) {
      fields.push(col);
      values.push(value);
    }
  };
  add('body', body);
  add('kind', 'eval_probe');
  add('title', 'Retrieve probe');
  add('source', 'eval-fixture');
  add('source_ref', `check-retrieve-${orgId}`);
  add('content_hash', `eval-m3-${orgId}-${Date.now()}`);
  if (names.has('embedding') && embeddingLiteral) {
    fields.push('embedding');
    values.push(embeddingLiteral);
  }
  const placeholders = fields.map((name, i) => (name === 'embedding' ? `$${i + 1}::vector` : `$${i + 1}`));
  const sql = `INSERT INTO org_memory (${fields.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`;
  const res = await pgClient.query(sql, values);
  return res.rows[0];
}

async function run() {
  let retrieveMod;
  try {
    retrieveMod = loadRetrieveModule();
    console.log('  [PASS] compiled retrieveMemory + atomic-agent-client loaded');
    pass += 1;
  } catch (err) {
    console.log(`  [FAIL] ${err.message}`);
    process.exit(1);
  }

  const { formatRetrievedFactsBlock, emptyMemoryResult, retrieveMemory, EMPTY_MEMORY_BLOCK } =
    retrieveMod.retrieve;
  const { buildGroundedUserMessage } = retrieveMod.client;

  console.log('\n--- Golden empty index (no DB) ---');
  const emptyBlock = formatRetrievedFactsBlock(emptyMemoryResult('00000000-0000-4000-8000-000000000000'));
  const invented = 'Priya Kapoor last viewed a 3BHK in Andheri West, budget 2.4–2.8 Cr';
  if (emptyBlock.includes('no stored memory') && emptyBlock === EMPTY_MEMORY_BLOCK) {
    console.log('  [PASS] empty index emits "no stored memory"');
    pass += 1;
  } else {
    console.log('  [FAIL] empty index formatter did not emit canonical no-stored-memory block');
    fail += 1;
  }
  const forbidden = ['Priya Kapoor', '3BHK', 'Andheri', '2.4'];
  if (forbidden.every((tok) => !emptyBlock.includes(tok)) && !emptyBlock.includes(invented)) {
    console.log('  [PASS] empty index does not invent Kapoor / listing facts');
    pass += 1;
  } else {
    console.log('  [FAIL] empty index invented prior facts');
    fail += 1;
  }

  const cited = formatRetrievedFactsBlock({
    orgId: '00000000-0000-4000-8000-000000000000',
    emptyIndex: false,
    citations: [
      {
        id: 'M-17',
        tier: 'entity',
        snippet: 'Contact sample-name budget band, wants 3BHK sample-area',
        source: 'whatsapp',
        stale: false,
        updatedAt: '2026-08-10T00:00:00.000Z',
      },
    ],
  });
  const grounded = buildGroundedUserMessage(
    {
      orgId: '00000000-0000-4000-8000-000000000001',
      employeeName: 'Exec',
      employeeRole: 'Assistant',
      employeePersona: 'Helpful',
      toolAllowlist: [],
      userMessage: 'What do we know?',
      connectedChannels: ['gmail'],
    },
    {
      orgId: '00000000-0000-4000-8000-000000000001',
      emptyIndex: false,
      citations: [
        {
          id: 'M-17',
          tier: 'org',
          snippet: 'Org SOP: confirm before send',
          source: 'upload',
          stale: false,
          updatedAt: '2026-08-10T00:00:00.000Z',
        },
      ],
    },
  );
  if (cited.includes('[M-17]') && grounded.includes('[M-17]') && grounded.includes('org_id=')) {
    console.log('  [PASS] grounded user message cites [M-17] and keeps org prefix');
    pass += 1;
  } else {
    console.log('  [FAIL] citation [M-17] missing from grounded user message');
    fail += 1;
  }
  if (grounded.includes('CONNECTED CONNECTORS') && grounded.includes('gmail')) {
    console.log('  [PASS] existing org+channels prefix retained');
    pass += 1;
  } else {
    console.log('  [FAIL] org+channels prefix dropped from grounded user message');
    fail += 1;
  }
  if (grounded.includes('USER REQUEST:') && grounded.includes('What do we know?')) {
    console.log('  [PASS] user request still present after memory prefix');
    pass += 1;
  } else {
    console.log('  [FAIL] user request missing from grounded message');
    fail += 1;
  }

  const { Client } = loadPg();
  const pgClient = new Client(superuserConfig());
  try {
    await pgClient.connect();
    console.log('\n--- Live two-org retrieve ---');
  } catch (err) {
    console.log(`  [FAIL] Postgres connection — ${err.message}`);
    process.exit(1);
  }

  let missing;
  try {
    missing = await missingMemoryTables(pgClient);
  } catch (err) {
    console.log(`  [FAIL] Could not inspect memory tables — ${err.message}`);
    await pgClient.end().catch(() => {});
    process.exit(1);
  }

  if (missing.length > 0) {
    const msg = `M1 not applied — missing tables: ${missing.join(', ')}`;
    if (allowMissingMemory()) {
      console.log(`  [SKIP] ${msg}`);
      skip += 1;
      console.log('\n--- Summary ---');
      console.log(`  pass=${pass} fail=${fail} skip=${skip} — live retrieve skipped (M1 missing).`);
      await pgClient.end().catch(() => {});
      process.exit(fail === 0 ? 0 : 1);
    }
    console.log(`  [FAIL] ${msg}`);
    fail += 1;
    await pgClient.end().catch(() => {});
    process.exit(1);
  }

  const stamp = Date.now();
  let orgAId;
  let orgBId;
  let orgCId;
  try {
    const orgA = await pgClient.query(
      `INSERT INTO orgs (name, slug, plan, status) VALUES ($1, $2, 'enterprise', 'active') RETURNING id`,
      ['Eval Retrieve Org A', `eval-m3-a-${stamp}`],
    );
    const orgB = await pgClient.query(
      `INSERT INTO orgs (name, slug, plan, status) VALUES ($1, $2, 'enterprise', 'active') RETURNING id`,
      ['Eval Retrieve Org B', `eval-m3-b-${stamp}`],
    );
    const orgC = await pgClient.query(
      `INSERT INTO orgs (name, slug, plan, status) VALUES ($1, $2, 'enterprise', 'active') RETURNING id`,
      ['Eval Retrieve Empty C', `eval-m3-c-${stamp}`],
    );
    orgAId = orgA.rows[0].id;
    orgBId = orgB.rows[0].id;
    orgCId = orgC.rows[0].id;

    const dims = await vectorDims(pgClient, 'org_memory', 'embedding');
    const secretA = `alphavectfact${stamp} org-A-only listing never share with B`;
    const secretB = `betavectfact${stamp} org-B-only invoice never share with A`;

    await resetRole(pgClient);
    await setOrg(pgClient, orgAId);
    await setAppRole(pgClient);
    await insertOrgMemory(
      pgClient,
      orgAId,
      secretA,
      dims ? unitVectorLiteral(dims, 0) : undefined,
    );

    await resetRole(pgClient);
    await setOrg(pgClient, orgBId);
    await setAppRole(pgClient);
    await insertOrgMemory(
      pgClient,
      orgBId,
      secretB,
      dims ? unitVectorLiteral(dims, 1) : undefined,
    );
    await resetRole(pgClient);

    const query = `alphavectfact${stamp} listing`;
    const embedOpts = dims ? { queryEmbedding: unitVector(dims, 0) } : {};

    const hitA = await retrieveMemory({ orgId: orgAId, query, ...embedOpts });
    const bodiesA = (hitA.citations || []).map((c) => c.snippet).join('\n');
    if (bodiesA.includes(`alphavectfact${stamp}`) && !bodiesA.includes(`betavectfact${stamp}`)) {
      console.log('  [PASS] Org A retrieve returns Org A fact (FTS/vector) and not Org B');
      pass += 1;
    } else {
      console.log(`  [FAIL] Org A retrieve missed own fact or leaked B — citations=${hitA.citations.length}`);
      fail += 1;
    }
    if ((hitA.citations || []).some((c) => /^M-\d+$/.test(c.id))) {
      console.log('  [PASS] citations use [M-n] ids');
      pass += 1;
    } else {
      console.log('  [FAIL] citation ids are not M-n');
      fail += 1;
    }

    const hitB = await retrieveMemory({ orgId: orgBId, query, ...embedOpts });
    const bodiesB = (hitB.citations || []).map((c) => c.snippet).join('\n');
    if (
      hitB.citations.length === 0 &&
      hitB.emptyIndex === true &&
      !bodiesB.includes(`alphavectfact${stamp}`)
    ) {
      console.log('  [PASS] same query as Org B: zero cross hits (RLS + org_id)');
      pass += 1;
    } else {
      console.log(
        `  [FAIL] cross-tenant retrieve leak: Org B citations=${hitB.citations.length} emptyIndex=${hitB.emptyIndex}`,
      );
      fail += 1;
    }

    const formattedB = formatRetrievedFactsBlock(hitB);
    if (formattedB.includes('no stored memory') && !formattedB.includes(`alphavectfact${stamp}`)) {
      console.log('  [PASS] Org B prefix is no stored memory for Org A query');
      pass += 1;
    } else {
      console.log('  [FAIL] Org B prefix invented or leaked Org A memory');
      fail += 1;
    }

    console.log('\n--- Golden empty org C ---');
    const emptyC = await retrieveMemory({
      orgId: orgCId,
      query: 'What did we last show the Kapoors?',
    });
    const formattedC = formatRetrievedFactsBlock(emptyC);
    if (
      emptyC.emptyIndex === true &&
      emptyC.citations.length === 0 &&
      formattedC.includes('no stored memory') &&
      !formattedC.includes('Priya Kapoor') &&
      !formattedC.includes('3BHK') &&
      !formattedC.includes('Andheri') &&
      !formattedC.includes('2.4')
    ) {
      console.log('  [PASS] empty org C: no stored memory; Kapoor/listings not invented');
      pass += 1;
    } else {
      console.log('  [FAIL] empty org C invented memory or returned rows');
      fail += 1;
    }
  } catch (err) {
    console.log(`  [FAIL] live retrieve probe — ${err.message}`);
    fail += 1;
  } finally {
    try {
      await resetRole(pgClient);
      const ids = [orgAId, orgBId, orgCId].filter(Boolean);
      if (ids.length > 0) {
        await pgClient.query(`DELETE FROM orgs WHERE id = ANY($1::uuid[])`, [ids]);
        console.log('  [INFO] cleaned up eval orgs');
      }
    } catch (err) {
      console.log(`  [INFO] cleanup warning: ${err.message}`);
    }
    await pgClient.end().catch(() => {});
  }

  console.log('\n--- Summary ---');
  const total = pass + fail + skip;
  if (fail === 0) {
    console.log(`  ALL CHECKS PASSED (${pass}/${total}) — retrieveMemory goldens green.\n`);
    process.exit(0);
  }
  console.log(`  ${fail}/${total} CHECKS FAILED — do not treat M3 retrieve as shipped.\n`);
  process.exit(1);
}

run().catch((err) => {
  console.error('retrieveMemory probe error:', err);
  process.exit(1);
});
