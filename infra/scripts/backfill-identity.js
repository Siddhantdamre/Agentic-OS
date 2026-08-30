#!/usr/bin/env node
'use strict';
/**
 * BACKFILL IDENTITY — turn 710 strangers into the people they actually are.
 *
 * Every existing conversation carries a raw handle and no person. This reads
 * them, resolves each handle through the SAME tested normaliser the runtime
 * uses, and links the conversation to a human.
 *
 * ── PREVIEW BY DEFAULT ────────────────────────────────────────────────────
 * Without --write it reports what WOULD merge and changes nothing. Merging two
 * conversations into one person is not reversible by a second run of this
 * script — once they share a person, nothing records that they were once
 * separate — so the preview is where the decision is actually made.
 *
 * ── IT REPORTS THE MERGES, NOT JUST THE COUNT ─────────────────────────────
 * Any merge is a claim that two conversations belong to the same human, and a
 * wrong one shows a customer somebody else's history. So every group of two or
 * more is printed with the spellings that produced it. "1,400 conversations
 * resolved to 900 people" is unreadable as a safety check; "these five
 * spellings became one person" is checkable by eye.
 *
 * Usage:
 *   node infra/scripts/backfill-identity.js               preview, all orgs
 *   node infra/scripts/backfill-identity.js --org <uuid>  one workspace
 *   node infra/scripts/backfill-identity.js --write       apply
 */
const path = require('path');
require('./lib/env').loadRepoEnv();

let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client; }

// One implementation of the matching rules, shared with the 20 unit tests.
// A second copy here would drift, and the drift is silent until somebody reads
// a stranger's messages.
const { normaliseIdentity } =
  require(path.join(__dirname, '..', '..', 'services', 'workflows', 'dist', 'identity', 'identity.js'));

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const ORG = args.includes('--org') ? args[args.indexOf('--org') + 1] : null;

const db = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

(async () => {
  await db.connect();
  try {
    const orgs = ORG
      ? [{ id: ORG }]
      : (await db.query(
        `SELECT DISTINCT org_id::text AS id FROM conversations WHERE contact_id IS NOT NULL`)).rows;

    console.log(`\n=== IDENTITY BACKFILL === ${orgs.length} workspace(s)`
      + `${WRITE ? '  [WRITING]' : '  [preview — nothing will change]'}\n`);

    let totalConvs = 0;
    let totalPeople = 0;
    let totalMerges = 0;
    let totalUnplaceable = 0;

    for (const o of orgs) {
      const convs = (await db.query(
        `SELECT id::text, contact_id FROM conversations
          WHERE org_id = $1 AND contact_id IS NOT NULL AND person_id IS NULL`,
        [o.id])).rows;
      if (!convs.length) continue;

      // Group by canonical value. An unplaceable handle gets a unique key so it
      // is never collapsed with anything, including an identical unplaceable
      // handle — "two things I could not parse look alike" is not evidence
      // about a human being.
      const groups = new Map();
      let unplaceableSeq = 0;
      for (const c of convs) {
        const n = normaliseIdentity(String(c.contact_id));
        const key = n.confident ? `${n.kind}:${n.value}` : `unplaceable:${unplaceableSeq++}`;
        if (!groups.has(key)) {
          groups.set(key, { kind: n.kind, value: n.value, confident: n.confident, raws: new Set(), convIds: [] });
        }
        const g = groups.get(key);
        g.raws.add(n.raw);
        g.convIds.push(c.id);
      }

      const merges = [...groups.values()].filter((g) => g.raws.size > 1);
      const unplaceable = [...groups.values()].filter((g) => !g.confident).length;

      totalConvs += convs.length;
      totalPeople += groups.size;
      totalMerges += merges.length;
      totalUnplaceable += unplaceable;

      console.log(`  ${o.id.slice(0, 8)}…  ${convs.length} conversation(s) -> ${groups.size} person(s)`
        + `${merges.length ? `, ${merges.length} merge(s)` : ''}`
        + `${unplaceable ? `, ${unplaceable} handle(s) that could not be placed` : ''}`);

      // EVERY merge is printed. A wrong one is a privacy breach, and a summary
      // count cannot be checked by eye.
      for (const m of merges) {
        console.log(`      one person from ${m.raws.size} spellings: ${[...m.raws].join('  ')}`);
      }

      if (!WRITE) continue;

      for (const g of groups.values()) {
        const raw = [...g.raws][0];
        const personId = (await db.query(
          `SELECT resolve_contact_person($1::uuid,$2::text,$3::text,$4::text,$5::boolean,$6::text) AS id`,
          [o.id, g.kind, g.value, raw, g.confident, raw])).rows[0].id;

        // Record every other spelling against the same person, so a future
        // message in any of them resolves without re-deriving the group.
        for (const other of [...g.raws].slice(1)) {
          await db.query(
            `INSERT INTO contact_identities (org_id, person_id, kind, value_norm, value_raw, confident)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (org_id, kind, value_raw) WHERE confident DO UPDATE SET last_seen = NOW()`,
            [o.id, personId, g.kind, g.value, other, g.confident]);
        }

        await db.query(
          `UPDATE conversations SET person_id = $1 WHERE id = ANY($2::uuid[]) AND org_id = $3`,
          [personId, g.convIds, o.id]);
      }
    }

    console.log(`\n  ${totalConvs} conversation(s) -> ${totalPeople} person(s)`);
    console.log(`  ${totalMerges} group(s) where more than one spelling was the same human`);
    if (totalUnplaceable) {
      // Named rather than buried: these are the ones identity cannot help with,
      // and pretending otherwise would overstate what erasure can now reach.
      console.log(`  ${totalUnplaceable} handle(s) could not be placed and stay separate, deliberately`);
    }
    if (!WRITE) console.log('\n  Re-run with --write to apply. Read the merges above first.\n');
    else console.log('');
  } finally {
    await db.end().catch(() => {});
  }
})().catch((e) => {
  console.error(`\n  ERROR: ${e.message}\n`);
  process.exit(1);
});
