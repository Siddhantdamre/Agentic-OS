'use strict';

/**
 * Synthetic returning-contact fixture (M6).
 * Known WhatsApp +14155550100 → Priya Kapoor + last issue / 3BHK Andheri.
 * Used by phase6-returning-contact.yaml via retrieveMemory — not Ask AI.
 *
 *   node infra/evals/seed-returning-contact.js
 *   EVAL_KEEP_FIXTURE=1 node infra/evals/seed-returning-contact.js
 */

const {
  loadPg,
  superuserConfig,
  tableColumns,
  vectorDims,
  zeroVectorLiteral,
  setOrg,
  resetRole,
  setAppRole,
} = require('./lib/db');

const KAPOOR = {
  whatsapp: '+14155550100',
  entityType: 'contact',
  entityId: 'wa:+14155550100',
  title: 'Priya Kapoor',
  body: 'Contact Priya Kapoor budget 2.4–2.8 Cr, wants 3BHK Andheri West, last issue=leaky kitchen tap',
  query: 'What did we last show the Kapoors?',
  source: 'whatsapp',
  kind: 'fact',
};

async function insertEntityMemory(client, orgId, body) {
  const cols = await tableColumns(client, 'entity_memory');
  const names = new Set(cols.map((c) => c.column_name));
  if (!names.has('org_id')) {
    throw new Error('M1 schema mismatch: entity_memory missing column org_id');
  }

  const fields = ['org_id'];
  const values = [orgId];
  const add = (col, value) => {
    if (names.has(col)) {
      fields.push(col);
      values.push(value);
    }
  };

  add('entity_type', KAPOOR.entityType);
  add('entity_id', KAPOOR.entityId);
  if (names.has('body')) add('body', body);
  else if (names.has('content')) add('content', body);
  else throw new Error('M1 schema mismatch: entity_memory has neither body nor content');
  add('kind', KAPOOR.kind);
  add('title', KAPOOR.title);
  add('source', KAPOOR.source);
  add('source_ref', KAPOOR.entityId);
  add('content_hash', `eval-returning-contact-${orgId}`);

  if (names.has('embedding')) {
    const dims = await vectorDims(client, 'entity_memory', 'embedding');
    if (dims && dims > 0) {
      fields.push('embedding');
      values.push(zeroVectorLiteral(dims));
    }
  }

  const placeholders = fields.map((name, i) => (name === 'embedding' ? `$${i + 1}::vector` : `$${i + 1}`));
  const sql = `INSERT INTO entity_memory (${fields.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`;
  const res = await client.query(sql, values);
  return res.rows[0];
}

async function seedReturningContact(client, stamp) {
  const slug = `eval-return-${stamp || Date.now()}`;
  const orgRes = await client.query(
    `INSERT INTO orgs (name, slug, plan, status) VALUES ($1, $2, 'enterprise', 'active') RETURNING id`,
    ['Eval Returning Contact', slug],
  );
  const orgId = orgRes.rows[0].id;
  await resetRole(client);
  await setOrg(client, orgId);
  await setAppRole(client);
  const row = await insertEntityMemory(client, orgId, KAPOOR.body);
  await resetRole(client);
  return { orgId, slug, row };
}

async function cleanupEvalOrg(client, orgId) {
  await resetRole(client).catch(() => {});
  if (!orgId) return;
  await client.query(`DELETE FROM orgs WHERE id = $1`, [orgId]);
}

async function main() {
  const { Client } = loadPg();
  const client = new Client(superuserConfig());
  await client.connect();
  let orgId;
  try {
    const seeded = await seedReturningContact(client);
    orgId = seeded.orgId;
    const payload = {
      orgId: seeded.orgId,
      slug: seeded.slug,
      whatsapp: KAPOOR.whatsapp,
      entityType: KAPOOR.entityType,
      entityId: KAPOOR.entityId,
      query: KAPOOR.query,
      keep: process.env.EVAL_KEEP_FIXTURE === '1',
    };
    console.log(JSON.stringify(payload, null, 2));
    if (process.env.EVAL_KEEP_FIXTURE === '1') {
      console.error('[seed-returning-contact] kept fixture org (EVAL_KEEP_FIXTURE=1). Delete the org when done.');
      orgId = null;
    } else {
      await cleanupEvalOrg(client, seeded.orgId);
      orgId = null;
      console.error('[seed-returning-contact] cleaned up (set EVAL_KEEP_FIXTURE=1 to keep).');
    }
  } finally {
    if (orgId) await cleanupEvalOrg(client, orgId).catch(() => {});
    await client.end().catch(() => {});
  }
}

module.exports = {
  KAPOOR,
  insertEntityMemory,
  seedReturningContact,
  cleanupEvalOrg,
};

if (require.main === module) {
  main().catch((err) => {
    console.error('seed-returning-contact failed:', err.message);
    process.exit(1);
  });
}
