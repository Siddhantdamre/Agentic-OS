#!/usr/bin/env node
'use strict';
/**
 * LINT: every $N in a SQL string must have exactly one matching argument.
 *
 * WHY THIS EXISTS
 * `retrieveMemory` bound $4 (the routed employee id) unconditionally, but only
 * referenced it inside a tier that was omitted whenever no employee was
 * assigned. Postgres refuses to plan a statement carrying a parameter that
 * appears nowhere in its own text:
 *
 *   could not determine data type of parameter $4
 *
 * The function catches every error and fails closed-empty by design — the
 * right call for a grounding system — so the whole thing surfaced as ZERO
 * memories behind one warn line. The agent answered "I don't have that
 * stored" with a full knowledge base behind it, on every turn where routing
 * did not assign an employee. It took a full debugging session to find, and
 * nothing in the test suite could have caught it, because the SQL is correct
 * in isolation and the parameters are correct in isolation. Only the pairing
 * is wrong, and only for some inputs.
 *
 * Two shapes are errors:
 *   GAP    SQL goes to $7 but never mentions $4  -> Postgres refuses to plan
 *   COUNT  SQL uses $1..$5 but 6 arguments given -> a silently ignored value
 *
 * Usage: node infra/scripts/lint-sql-params.js
 * Exit:  0 = clean, 1 = at least one mismatch
 */
const fs = require('fs');
const path = require('path');

// ── Self-test ───────────────────────────────────────────────────────────────
// A lint that passes on a clean tree proves nothing. This feeds it the exact
// shape of the bug it exists to catch, plus the three shapes that fooled
// earlier versions of it, and asserts the verdict on each.
// Run: node infra/scripts/lint-sql-params.js --self-test
if (process.argv.includes('--self-test')) {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darex-sqllint-'));
  const cases = [
    // [filename, source, shouldFlag, label]
    ['gap.ts',
      'await c.query(`SELECT a FROM t WHERE org=$1 AND x=$2 AND y=$3 AND z=$5`, [o, x, y, z, w]);',
      true, 'the real bug: a $N referenced nowhere in the statement'],
    ['count.ts',
      'await c.query(`SELECT a FROM t WHERE org=$1 AND x=$2`, [o, x, extra]);',
      true, 'an argument the SQL never reads'],
    ['indexed.ts',
      'await c.query(`SELECT a FROM t WHERE org=$1 AND s=$2`, [orgId, rows[0].id]);',
      false, 'an indexed access inside the argument list is not a short array'],
    ['commented.ts',
      'await c.query(`SELECT a FROM t WHERE org=$1 AND s=$2`, [\n  orgId,\n  // one, two, three commas in prose\n  sourceId,\n]);',
      false, 'prose commas in a comment are not arguments'],
    ['trailing.ts',
      'await c.query(`SELECT a FROM t WHERE org=$1 AND s=$2`, [orgId, sourceId,]);',
      false, 'a trailing comma is legal and is not an argument'],
    ['clean.ts',
      'await c.query(`SELECT a FROM t WHERE org=$1 AND s=$2 AND k=$3`, [o, s, k]);',
      false, 'a correct statement'],
  ];

  let pass = 0;
  let fail = 0;
  console.log('\n### SQL PARAMETER LINT — SELF-TEST\n');
  for (const [name, src, shouldFlag, label] of cases) {
    const sub = path.join(dir, 'apps', 'dashboard');
    fs.mkdirSync(sub, { recursive: true });
    const file = path.join(sub, name);
    fs.writeFileSync(file, src);
    const r = require('child_process').spawnSync(
      process.execPath, [__filename, '--root', dir], { encoding: 'utf8' },
    );
    const flagged = r.status !== 0;
    fs.unlinkSync(file);
    if (flagged === shouldFlag) { pass++; console.log(`  [PASS] ${label}`); }
    else { fail++; console.log(`  [FAIL] ${label} — ${flagged ? 'flagged' : 'missed'}`); }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n  passed ${pass} / ${pass + fail}\n`);
  process.exit(fail ? 1 : 0);
}

const rootFlag = process.argv.indexOf('--root');
const ROOT = rootFlag > -1 ? process.argv[rootFlag + 1] : path.join(__dirname, '..', '..');
const SCAN = ['apps/dashboard', 'services', 'infra/scripts'];
// The lints skip THEMSELVES. Their self-test fixtures are deliberately broken
// SQL held in string literals, and scanning them makes the lint report its own
// examples as defects in the codebase.
const SKIP = /node_modules|[\\/]\.next|[\\/]dist|[\\/]\.git|\.harden-state|\.test\.|lint-sql-params\.js|lint-tenant-scope\.js/;

function collect(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (SKIP.test(p)) continue;
    if (e.isDirectory()) collect(p, out);
    else if (/\.(ts|tsx|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * Strip // and block comments before counting commas.
 *
 * Not optional. A comment inside an argument list — and the ones that matter
 * most are exactly the arguments that needed explaining — contains prose
 * commas, and every one of them counted as another argument. That produced
 * confident false positives on the best-documented call sites in the codebase.
 */
function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Count top-level commas; nested calls, objects and arrays do not add args. */
function countArgs(argsRaw) {
  const args = stripComments(argsRaw).replace(/,\s*$/, ''); // trailing comma is legal, not an arg
  if (!args.trim()) return 0;
  let depth = 0;
  let count = 1;
  let quote = null;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (quote) {
      if (ch === quote && args[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) count++;
  }
  return count;
}

const findings = [];
const skipped = [];
for (const rel of SCAN) {
  for (const file of collect(path.join(ROOT, rel))) {
    const src = fs.readFileSync(file, 'utf8');
    const shown = path.relative(ROOT, file).split(path.sep).join('/');

    for (const re of [
      /\.query(?:<[^>]*>)?\(\s*`([^`]*)`\s*,\s*\[/g,
      /\.query(?:<[^>]*>)?\(\s*'([^']*)'\s*,\s*\[/g,
    ]) {
      let m;
      while ((m = re.exec(src))) {
        const sql = m[1];

        // A template interpolation can itself contain placeholders — the
        // shared OR-tsquery fragment carries a $2 — so the highest $N cannot
        // be known from the source text. Counted and reported rather than
        // guessed at: a lint that quietly assumes is how the original bug
        // survived in the first place.
        if (/\$\{/.test(sql)) { skipped.push(`${shown}:${src.slice(0, m.index).split('\n').length}`); continue; }

        const nums = [...sql.matchAll(/\$(\d+)/g)].map((x) => Number(x[1]));
        if (!nums.length) continue;

        // Balanced scan for the argument array. A lazy [^\]]* stops at the
        // first `]`, so `[orgId, rows[0].id]` reads as two arguments and every
        // indexed access becomes a false positive.
        let depth = 1;
        let i = m.index + m[0].length;
        const start = i;
        while (i < src.length && depth > 0) {
          if (src[i] === '[') depth++;
          else if (src[i] === ']') depth--;
          if (depth === 0) break;
          i++;
        }
        const argsRaw = src.slice(start, i);
        const line = src.slice(0, m.index).split('\n').length;

        const max = Math.max(...nums);
        const used = new Set(nums);
        const gaps = [];
        for (let n = 1; n <= max; n++) if (!used.has(n)) gaps.push(n);

        if (gaps.length) {
          findings.push({
            file: shown,
            line,
            kind: 'GAP',
            msg: `SQL goes up to $${max} but never references $${gaps.join(', $')}`
              + ' — Postgres will refuse to plan this statement',
          });
        } else {
          const count = countArgs(argsRaw);
          if (count !== max) {
            findings.push({
              file: shown,
              line,
              kind: 'COUNT',
              msg: `SQL uses $1..$${max} but ${count} argument(s) supplied`,
            });
          }
        }
      }
    }
  }
}

console.log('\n### SQL PARAMETER LINT\n');
if (skipped.length) {
  // Named, not hidden. A lint that silently skips work reports a green it has
  // not earned, which is the same failure mode as the bug it is here to catch.
  console.log(`  [ -- ]  ${skipped.length} statement(s) build SQL by interpolation`);
  console.log('          and cannot be checked statically:');
  for (const s of skipped) console.log(`            ${s}`);
  console.log('');
}
if (!findings.length) {
  console.log('  [PASS] every $N has exactly one matching argument\n');
  process.exit(0);
}
for (const f of findings) {
  console.log(`  [${f.kind}]  ${f.file}:${f.line}`);
  console.log(`          ${f.msg}`);
}
console.log(`\n  ${findings.length} mismatch(es)\n`);
process.exit(1);
