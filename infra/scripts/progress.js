#!/usr/bin/env node
'use strict';
/**
 * DID ANYTHING ACTUALLY GET BETTER SINCE YESTERDAY?
 *
 * A day of work always feels productive. Commits land, tests go green, the diff is
 * large. None of that is evidence that the software improved — this codebase has
 * shipped six features that were complete, tested, and unreachable, and every one of
 * those days felt productive too.
 *
 * So this measures two different things and refuses to add them together:
 *
 *   BUILT       suites, assertions, migrations, guards
 *               goes up whenever someone works. Cheap. Almost always improves.
 *
 *   EXERCISED   capabilities that have actually produced a row on this deployment,
 *               conversation depth, readable customer signal
 *               goes up only when the software met a real person. Expensive.
 *               Has barely moved in the lifetime of the project.
 *
 * The second list is the real one. A day where BUILT rose and EXERCISED did not is a
 * day of preparation, which is fine occasionally and fatal as a habit.
 *
 * ── IT MUST BE ABLE TO SAY NOTHING IMPROVED ───────────────────────────────
 * A progress tracker that only goes up is a vanity metric. This one reports
 * regressions, reports flat days as flat, and never counts activity as improvement.
 *
 * Snapshots are committed under docs/progress/ so the history is in git and nobody
 * can quietly re-baseline a bad week.
 *
 * Usage:
 *   node infra/scripts/progress.js            measure, compare, do not save
 *   node infra/scripts/progress.js --save     measure, compare, record today
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
require('./lib/env').loadRepoEnv();

let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client; }

const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, 'docs', 'progress');
const SAVE = process.argv.includes('--save');

const db = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

const n = async (sql) => Number((await db.query(sql)).rows[0].n);

/** Capabilities whose emptiness is the product's central problem. */
const EXERCISED_TABLES = [
  ['conversations answered', 'conversations'],
  ['people recognised', 'contact_persons'],
  ['tasks supervised', 'task_supervision'],
  ['facts a person typed', "org_memory WHERE source = 'operator'"],
  ['replies an operator fixed', 'reply_edits'],
  ['leads chased unprompted', 'lead_followups'],
  ['decisions handed to a human', 'approval_requests'],
  ['automations that fired', 'trigger_dispatches'],
  ['memory rows with embeddings', 'org_memory WHERE embedding IS NOT NULL'],
];

async function snapshot() {
  // ── BUILT ────────────────────────────────────────────────────────────────
  const countFiles = (dir, re) => {
    try { return fs.readdirSync(path.join(ROOT, dir)).filter((f) => re.test(f)).length; }
    catch { return 0; }
  };
  const grepCount = (file, re) => {
    try {
      return (fs.readFileSync(path.join(ROOT, file), 'utf8').match(re) || []).length;
    } catch { return 0; }
  };

  const built = {
    suites: grepCount('infra/scripts/verify.js', /^\s*name: '/gm),
    guards: countFiles('infra/scripts', /^(lint|check)-.*\.js$/),
    migrations: countFiles('infra/db/migrations', /\.sql$/),
    decisions: countFiles('docs/adr', /^\d{3}-.*\.md$/),
    unitTests: (() => {
      // The same glob package.json uses. Passing a bare directory silently
      // matches nothing and reports 0 passing tests, which reads as a
      // catastrophic regression rather than as a broken measurement.
      const r = spawnSync(process.execPath, ['--test', 'dist/**/*.test.js'], {
        cwd: path.join(ROOT, 'services', 'workflows'), encoding: 'utf8', timeout: 600000,
      });
      // Node's default reporter prints "pass N" prefixed with an info glyph;
      // the tap reporter prefixes it with #. Match either, because which one
      // you get depends on whether stdout is a TTY.
      const m = String(r.stdout || '').match(/(?:#|ℹ)\s*pass\s+(\d+)/);
      if (!m) throw new Error('could not read the unit test count — fix the measurement '
        + 'rather than recording a zero that looks like a regression');
      return Number(m[1]);
    })(),
  };

  // ── EXERCISED ────────────────────────────────────────────────────────────
  const exercised = {};
  for (const [label, table] of EXERCISED_TABLES) {
    try { exercised[label] = await n(`SELECT COUNT(*)::int AS n FROM ${table}`); }
    catch { exercised[label] = null; }
  }

  // Depth is the product question, not a vanity count: a two-message
  // conversation is a question and an answer with nobody coming back.
  exercised['conversations with a real exchange'] = await n(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT conversation_id FROM messages GROUP BY conversation_id HAVING COUNT(*) >= 3
     ) t`);

  exercised['replies we can read a verdict from'] = await n(
    `WITH o AS (
       SELECT m.role, LAG(m.role) OVER (PARTITION BY m.conversation_id ORDER BY m.created_at) AS prev
         FROM messages m
     ) SELECT COUNT(*)::int AS n FROM o WHERE role = 'user' AND prev = 'assistant'`);

  return { at: new Date().toISOString(), built, exercised };
}

function load() {
  try {
    return fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()
      .map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
  } catch { return []; }
}

function delta(now, before, key) {
  const a = before?.[key];
  const b = now[key];
  if (a === undefined || a === null || b === null) return null;
  return b - a;
}

function render(group, now, before, opts = {}) {
  const rows = Object.keys(now);
  let moved = 0;
  for (const k of rows) {
    const d = delta(now, before, k);
    const cur = now[k] === null ? '—' : String(now[k]);
    let mark = '        ';
    if (d === null) mark = '   new  ';
    else if (d > 0) { mark = `   +${String(d).padEnd(4)}`; moved += 1; }
    else if (d < 0) { mark = `   ${String(d).padEnd(5)}`; moved += 1; }
    console.log(`    ${cur.padStart(6)}  ${mark}  ${k}`);
  }
  if (opts.zeroIsTheStory) {
    const dead = rows.filter((k) => now[k] === 0);
    if (dead.length) {
      console.log(`\n    ${dead.length} of ${rows.length} have never happened once:`);
      console.log(`      ${dead.join(', ')}`);
    }
  }
  return moved;
}

(async () => {
  await db.connect();
  let now;
  try { now = await snapshot(); } finally { await db.end().catch(() => {}); }

  const history = load();
  const before = history[history.length - 1];

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  PROGRESS — what is better than last time, and what is not ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  if (!before) {
    console.log('  No earlier snapshot. This run is the baseline.\n');
  } else {
    const days = Math.max(0, Math.round(
      (Date.parse(now.at) - Date.parse(before.at)) / 86400000));
    console.log(`  Comparing against ${before.at.slice(0, 10)}`
      + `${days ? ` (${days} day${days === 1 ? '' : 's'} ago)` : ' (today)'}\n`);
  }

  console.log('  BUILT — goes up whenever someone works\n');
  const builtMoved = render('built', now.built, before?.built);

  console.log('\n  EXERCISED — goes up only when the software met a real person\n');
  const exMoved = render('exercised', now.exercised, before?.exercised,
    { zeroIsTheStory: true });

  // ── The verdict ──────────────────────────────────────────────────────────
  console.log('\n  ───\n');
  if (!before) {
    console.log('  Baseline recorded. Run this again tomorrow.\n');
  } else if (exMoved === 0 && builtMoved === 0) {
    console.log('  Nothing moved. Not a failure — but two of these in a row means\n'
      + '  the work is not reaching the product.\n');
  } else if (exMoved === 0) {
    console.log('  Preparation, not progress. The software gained capability and\n'
      + '  still has not met anyone. Fine occasionally. Fatal as a habit.\n');
  } else {
    console.log(`  ${exMoved} thing(s) the software actually did that it had not done before.\n`
      + '  That is the column that counts.\n');
  }

  if (SAVE) {
    fs.mkdirSync(DIR, { recursive: true });
    const file = path.join(DIR, `${now.at.slice(0, 10)}.json`);
    fs.writeFileSync(file, `${JSON.stringify(now, null, 2)}\n`);
    console.log(`  Recorded ${path.relative(ROOT, file)} — commit it, so a bad week\n`
      + '  cannot be quietly re-baselined.\n');
  } else {
    console.log('  Nothing recorded. Pass --save to keep this snapshot.\n');
  }
})().catch(async (e) => {
  console.log(`\n  ERROR: ${e.message}\n`);
  try { await db.end(); } catch { /* closed */ }
  process.exit(1);
});
