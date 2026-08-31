#!/usr/bin/env node
'use strict';
/**
 * AN ANSWER-SHAPED SILENCE IS THE ONE FAILURE MODE THAT LIES.
 *
 * A correct answer is best. A stated failure is fine — the agent says it could
 * not do the thing, and the reader knows where they stand. A zero-length
 * assistant message is worse than either, because it is rendered as a bubble
 * under the agent's name, with a timestamp, next to badges proving that tools
 * really ran. It reads as "the agent had nothing to say". What actually
 * happened was that the agent was never allowed to speak.
 *
 * Observed on the demo workspace: metrics_list and metrics_query executed, then
 * the model call was refused with HTTP 402 — exhausted credit — and the route
 * persisted a 0-length assistant message and streamed it as `answer`. The
 * provider's reason was captured into tool_calls metadata and shown to nobody.
 *
 * This is the check for "no silent unattributed failures" at the only place it
 * can be verified after the fact: the stored conversation. A failure that was
 * announced leaves text. A failure that was swallowed leaves an empty row.
 *
 * Usage: node infra/scripts/check-no-empty-answers.js         (check only)
 *        node infra/scripts/check-no-empty-answers.js --fix   (attribute existing blanks)
 */
const fs = require('fs');
const path = require('path');
require('./lib/env').loadRepoEnv();

let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client; }

const FIX = process.argv.includes('--fix');
const ROOT = path.join(__dirname, '..', '..');
const ROUTE = path.join(ROOT, 'apps/dashboard/app/api/ask-ai/route.ts');

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

(async () => {
  await db.connect();
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  NO SILENT ANSWERS — an empty reply must announce itself            ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

  try {
    if (FIX) {
      // Attribute rather than delete. The row is evidence that a question went
      // unanswered, which is worth keeping; what it must not do is masquerade
      // as a reply. The reason is taken from tool_calls when the run recorded
      // one, and otherwise stated as unknown — never guessed.
      const repaired = await db.query(`
        UPDATE messages
           SET content = 'I could not produce an answer, so I am not going to guess one.'
                      || E'\\n\\n**What happened:** '
                      || COALESCE(NULLIF(tool_calls->>'error', ''),
                                  'The model returned nothing and no reason was recorded at the time.')
         WHERE role = 'assistant' AND LENGTH(COALESCE(content, '')) = 0
        RETURNING id`);
      console.log(`  repaired: ${repaired.rowCount} blank assistant message(s) now state that they failed\n`);
    }

    // ── 1. No stored assistant message is empty ────────────────────────────
    const blanks = (await db.query(
      `SELECT COUNT(*)::int AS n FROM messages
        WHERE role = 'assistant' AND LENGTH(COALESCE(content, '')) = 0`)).rows[0].n;
    blanks === 0
      ? ok('no assistant message is blank', 'every reply either says something or says it failed')
      : no(`${blanks} blank assistant message(s)`, 'each renders as an answer-shaped silence — run with --fix');

    // ── 2. Nor is one whitespace-only, which renders identically ───────────
    const whitespace = (await db.query(
      `SELECT COUNT(*)::int AS n FROM messages
        WHERE role = 'assistant' AND LENGTH(COALESCE(content, '')) > 0
          AND LENGTH(TRIM(content)) = 0`)).rows[0].n;
    whitespace === 0
      ? ok('no assistant message is whitespace only', 'a space is as blank as a blank on screen')
      : no(`${whitespace} whitespace-only assistant message(s)`);

    // ── 3. The route cannot produce one again ──────────────────────────────
    // Structural, because the runtime check above only catches this once
    // somebody has already been shown a blank bubble.
    const route = fs.readFileSync(ROUTE, 'utf8');
    /const emptyReply = rawAnswer\.trim\(\)\.length === 0/.test(route)
      ? ok('the route detects an empty reply', 'before persisting or streaming it')
      : no('the route detects an empty reply', 'an empty model reply would be stored as an answer');

    /error: result\.error \|\| \(emptyReply \? failureReason : null\)/.test(route)
      ? ok('an empty reply is reported as an error to the client', 'so it renders as a failure, with Retry')
      : no('an empty reply is reported as an error to the client');

    // ── 4. What the operator would now see ────────────────────────────────
    const recent = (await db.query(`
      SELECT role, LEFT(content, 58) AS preview, LENGTH(content) AS len
        FROM messages ORDER BY created_at DESC LIMIT 4`)).rows;
    if (recent.length) {
      console.log('\n  most recent messages:');
      for (const r of recent) {
        console.log(`    ${String(r.role).padEnd(10)} ${String(r.len).padStart(4)}  ${String(r.preview).replace(/\s+/g, ' ')}`);
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
