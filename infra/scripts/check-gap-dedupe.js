#!/usr/bin/env node
'use strict';
/**
 * ONE QUESTION THE AGENT COULD NOT ANSWER MUST APPEAR ON SCREEN ONCE.
 *
 * /brain headlines "N things it does not know, costing N customer questions".
 * Both halves of that sentence are counts over `knowledge_gaps`, so a duplicated
 * row does not merely look untidy — it inflates a number the operator is being
 * asked to act on, and it splits the "asked 4×" signal that decides which gap
 * to answer first into four rows each claiming "asked 1×".
 *
 * The product gets this right. `record_knowledge_gap()` (migration 025) derives
 *
 *     sha256(lower(regexp_replace(question, '[^a-zA-Z0-9 ]', '', 'g')))
 *
 * so "What are your hours?" and "what are your hours" are one gap, and
 * ON CONFLICT (org_id, question_hash) increments times_asked instead of
 * inserting again.
 *
 * The duplicates found on the demo workspace were written around that function:
 * rows inserted directly with hand-made hashes (`kg-demo-1`, `kg-d1-<ts>`), so
 * two rows for one question each satisfied the UNIQUE constraint. The same
 * mistake as a test that INSERTs into orgs instead of calling org_provision() —
 * the door exists, and something climbed through the window beside it.
 *
 * This checks the invariant the function would have enforced, and can repair
 * what bypassed it. Repair is idempotent: it merges each group into its earliest
 * row, sums times_asked, keeps the latest last_seen_at, and rewrites the hash to
 * the derived one so the next ON CONFLICT lands where it should.
 *
 * Usage: node infra/scripts/check-gap-dedupe.js          (check only, exit 1 if dirty)
 *        node infra/scripts/check-gap-dedupe.js --fix    (merge duplicates, then check)
 */
const path = require('path');
require('./lib/env').loadRepoEnv();

let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client; }

const FIX = process.argv.includes('--fix');

const db = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

let pass = 0;
let fail = 0;
const ok = (m, d = '') => { pass++; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d = '') => { fail++; console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };

// The exact normalisation record_knowledge_gap() uses, expressed in SQL so it is
// computed by the same engine rather than re-implemented in JS and left to drift.
const DERIVED_HASH = `encode(digest(lower(regexp_replace(question, '[^a-zA-Z0-9 ]', '', 'g')), 'sha256'), 'hex')`;

(async () => {
  await db.connect();
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  KNOWLEDGE GAPS — one question, one row, one honest count            ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

  try {
    if (FIX) {
      // Delete the extras before touching hashes: rewriting a survivor's hash
      // while a duplicate still holds the target value would trip the UNIQUE
      // constraint on (org_id, question_hash) mid-repair.
      const merged = await db.query(`
        WITH grouped AS (
          SELECT id, org_id, ${DERIVED_HASH} AS derived,
                 ROW_NUMBER() OVER (PARTITION BY org_id, ${DERIVED_HASH} ORDER BY first_seen_at, id) AS rn,
                 SUM(times_asked)  OVER (PARTITION BY org_id, ${DERIVED_HASH}) AS total_asked,
                 MAX(last_seen_at) OVER (PARTITION BY org_id, ${DERIVED_HASH}) AS latest_seen
            FROM knowledge_gaps
        ),
        keepers AS (
          UPDATE knowledge_gaps g
             SET times_asked  = grouped.total_asked,
                 last_seen_at = grouped.latest_seen
            FROM grouped
           WHERE g.id = grouped.id AND grouped.rn = 1
             AND (g.times_asked <> grouped.total_asked OR g.last_seen_at <> grouped.latest_seen)
          RETURNING g.id
        ),
        dropped AS (
          DELETE FROM knowledge_gaps g
           USING grouped
           WHERE g.id = grouped.id AND grouped.rn > 1
          RETURNING g.id
        )
        SELECT (SELECT COUNT(*) FROM keepers)::int AS kept,
               (SELECT COUNT(*) FROM dropped)::int AS removed`);
      const { kept, removed } = merged.rows[0];

      // Now the surviving rows can safely take the derived hash.
      const rehashed = await db.query(
        `UPDATE knowledge_gaps SET question_hash = ${DERIVED_HASH}
          WHERE question_hash <> ${DERIVED_HASH} RETURNING id`);

      console.log(`  repaired: ${removed} duplicate row(s) merged away, ${kept} survivor(s) recounted, `
        + `${rehashed.rowCount} hash(es) rewritten to the derived value\n`);
    }

    // ── 1. No org shows the same question twice ─────────────────────────────
    // Grouped by org_id, never by org name. Names are labels, not identities:
    // this database holds 52 distinct tenants all called "Bright Leaf
    // Interiors", and grouping by name reported six of them — one gap each,
    // exactly as intended — as a single six-fold duplicate. The UNIQUE
    // constraint on (org_id, question_hash) makes a real intra-org duplicate
    // impossible once hashes are derived, so a check that groups by name is
    // reporting on a table it has just merged across tenants.
    const dupes = (await db.query(`
      SELECT o.name AS org, g.org_id, LEFT(g.question, 44) AS question, COUNT(*)::int AS n
        FROM knowledge_gaps g JOIN orgs o ON o.id = g.org_id
       GROUP BY g.org_id, o.name, ${DERIVED_HASH.replace(/question/g, 'g.question')}, LEFT(g.question, 44)
      HAVING COUNT(*) > 1
       ORDER BY n DESC`)).rows;

    if (dupes.length === 0) {
      ok('no question appears twice in one workspace', 'the /brain counts mean what they say');
    } else {
      no(`${dupes.length} duplicated question(s)`, 'run with --fix to merge');
      for (const d of dupes.slice(0, 6)) {
        console.log(`         ${d.org}: "${d.question}" x${d.n}`);
      }
    }

    // ── 2. Every hash is the one the function would have derived ────────────
    // A hand-made hash is how a duplicate gets past the UNIQUE constraint, so
    // this is the upstream condition, not a cosmetic tidy.
    const wrong = (await db.query(
      `SELECT COUNT(*)::int AS n FROM knowledge_gaps WHERE question_hash <> ${DERIVED_HASH}`)).rows[0].n;
    wrong === 0
      ? ok('every question_hash is derived from its question', 'so ON CONFLICT can find the existing row')
      : no(`${wrong} row(s) carry a hand-made question_hash`, 'the next asking will insert a second row');

    // ── 3. times_asked stays meaningful ────────────────────────────────────
    const zero = (await db.query(
      `SELECT COUNT(*)::int AS n FROM knowledge_gaps WHERE times_asked < 1`)).rows[0].n;
    zero === 0
      ? ok('every gap was asked at least once', 'a gap nobody asked is not a gap')
      : no(`${zero} row(s) claim to have been asked less than once`);

    // ── 4. What the operator now sees ──────────────────────────────────────
    // Per tenant, again by org_id — a per-name roll-up would add 52 separate
    // businesses together and print a number no single operator ever sees.
    const shown = (await db.query(`
      SELECT o.name AS org, g.org_id, COUNT(*)::int AS gaps, SUM(g.times_asked)::int AS asks
        FROM knowledge_gaps g JOIN orgs o ON o.id = g.org_id
       WHERE g.status = 'open'
       GROUP BY g.org_id, o.name ORDER BY asks DESC, gaps DESC LIMIT 5`)).rows;
    if (shown.length) {
      console.log('\n  open gaps per workspace (what /brain headlines):');
      for (const r of shown) {
        console.log(`    ${String(r.org).padEnd(30)} ${r.gaps} thing(s) unknown, ${r.asks} customer question(s)`);
      }
    }
  } finally {
    await db.end().catch(() => {});
  }

  console.log(`\n  passed ${pass} / ${pass + fail}\n`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.log(`\n  ERROR: ${e.message}\n`);
  try { await db.end(); } catch { /* closed */ }
  process.exit(1);
});
