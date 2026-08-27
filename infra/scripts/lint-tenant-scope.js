#!/usr/bin/env node
'use strict';
/**
 * LINT: no tenant table is read or written without an org filter.
 *
 * WHY THIS EXISTS
 * `orgs` shipped with no RLS and no policy while every other tenant table had
 * both. As darex_app, with no session and no org context, `SELECT COUNT(*)
 * FROM orgs` returned 58 — every customer on the deployment. It was found by
 * hand, in passing, after months. RLS is now the enforcement, and this is the
 * second line: a query that forgets its org filter should be visible in review
 * rather than depending on a policy nobody re-checks.
 *
 * WHAT IT FLAGS
 * A statement touching a tenant table that carries no `org_id` reference and
 * no explicit exemption. Two legitimate exemptions exist and must be written
 * down at the call site, not inferred:
 *
 *   -- lint-tenant-scope: resolver
 *       a pre-context resolver, e.g. mapping a webhook secret to an org id.
 *       These go through SECURITY DEFINER functions and return one id.
 *
 *   -- lint-tenant-scope: rls-enforced
 *       relies on the row-level policy for the current session's org. Fine
 *       for a scoped client; never fine on the raw pool.
 *
 * The exemption comment is the point. It makes "this is deliberate" a thing
 * someone typed, and turns the next reviewer's question from "is this a bug?"
 * into "is this reason still true?".
 *
 * Usage: node infra/scripts/lint-tenant-scope.js [--verbose]
 * Exit:  0 = clean, 1 = at least one unscoped statement
 */
const fs = require('fs');
const path = require('path');

// Tables that hold one tenant's data. A query against any of these without an
// org filter is either a resolver or a bug.
const TENANT_TABLES = [
  'orgs', 'conversations', 'messages', 'org_memory', 'work_items', 'work_events',
  'channels', 'channel_logs', 'org_connectors', 'agent_plans', 'agent_actions',
  'ai_employees', 'audit_events', 'billing_invoices', 'billing_meters',
  'billing_subscriptions', 'chatwoot_inbox_map', 'conversation_memory',
  'dsr_requests', 'employee_memory', 'entity_memory', 'ingestion_jobs',
  'knowledge_gaps', 'knowledge_sources', 'memory_edges', 'org_invites',
  'org_onboarding', 'org_packs', 'org_sql_connections', 'outcome_events',
  'action_outcomes', 'reply_edits', 'ask_ai_feedback',
];

// ── Self-test ───────────────────────────────────────────────────────────────
// A clean tree proves nothing on its own. This feeds the lint the shape of the
// bug it exists for, plus the shapes that made earlier versions cry wolf.
// Run: node infra/scripts/lint-tenant-scope.js --self-test
if (process.argv.includes('--self-test')) {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'darex-scopelint-'));
  const cases = [
    ['leak.ts',
      'const r = await pool.query(`SELECT id, name FROM orgs WHERE status = $1`, [s]);',
      true, 'the real bug: reading every tenant with no org filter'],
    ['leak2.ts',
      'const r = await client.query(`SELECT * FROM conversations ORDER BY created_at DESC`);',
      true, 'an unscoped read of another tenant table'],
    ['scoped.ts',
      'const r = await client.query(`SELECT id FROM conversations WHERE org_id = $1`, [orgId]);',
      false, 'a plainly scoped query'],
    ['dynamic.ts',
      'const conditions = [`org_id = $1`];\nconst r = await client.query(`SELECT id FROM work_items WHERE ${conditions.join(" AND ")}`, params);',
      false, 'a WHERE clause assembled above the query'],
    ['exempt.ts',
      'const r = await pool.query(`-- lint-tenant-scope: resolver\nSELECT id FROM orgs WHERE meta->>$1 = $2`, [k, v]);',
      false, 'an exemption the author wrote down'],
  ];

  let pass = 0;
  let fail = 0;
  console.log('\n### TENANT SCOPE LINT — SELF-TEST\n');
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
const SCAN = ['apps/dashboard', 'services'];
// The lints skip THEMSELVES: their self-test fixtures are deliberately
// unscoped SQL held in string literals, and scanning them makes the lint
// report its own examples as defects in the codebase.
const SKIP = /node_modules|[\\/]\.next|[\\/]dist|[\\/]\.git|\.test\.|lint-sql-params\.js|lint-tenant-scope\.js/;
const VERBOSE = process.argv.includes('--verbose');

function collect(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (SKIP.test(p)) continue;
    if (e.isDirectory()) collect(p, out);
    // .tsx excluded: JSX template literals routinely contain the words
    // SELECT/conversations/messages as UI copy and every one of them is a
    // false positive. Data access lives in .ts route handlers and lib files.
    else if (/\.(ts|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

const TABLE_RE = new RegExp(
  `\\b(?:FROM|JOIN|INTO|UPDATE)\\s+(${TENANT_TABLES.join('|')})\\b`,
  'gi',
);

const findings = [];
const exempted = [];

for (const rel of SCAN) {
  for (const file of collect(path.join(ROOT, rel))) {
    const src = fs.readFileSync(file, 'utf8');
    const shown = path.relative(ROOT, file).split(path.sep).join('/');

    // Every SQL-looking template literal in the file.
    for (const m of src.matchAll(/`([^`]*(?:SELECT|INSERT|UPDATE|DELETE)[^`]*)`/gis)) {
      const sql = m[1];
      TABLE_RE.lastIndex = 0;
      const tables = [...sql.matchAll(TABLE_RE)].map((x) => x[1].toLowerCase());
      if (!tables.length) continue;

      // An org filter in any form: a bound org_id, a set_config context
      // comparison, or an id equality on `orgs` itself.
      //
      // The WHERE clause is often assembled above the query — work-items
      // starts with `const conditions = ['org_id = $1']` and interpolates —
      // so the preceding source counts too. Looking only inside the template
      // flagged a correctly scoped handler, and a lint that cries wolf on
      // correct code gets muted, which costs more than it saves.
      const preamble = src.slice(Math.max(0, m.index - 800), m.index);
      const scoped = /org_id/i.test(sql)
        || /current_setting\(\s*'app\.current_org_id'/i.test(sql)
        || /\borgs\b[\s\S]*\bid\s*=\s*\$\d/i.test(sql)
        || (/\$\{/.test(sql) && /org_id/i.test(preamble));

      const exemption = /--\s*lint-tenant-scope:\s*(resolver|rls-enforced)/i.exec(sql);
      const line = src.slice(0, m.index).split('\n').length;

      if (exemption) {
        exempted.push({ file: shown, line, why: exemption[1].toLowerCase(), tables: [...new Set(tables)] });
        continue;
      }
      if (scoped) continue;

      // Raw `pool` has no org context at all, so an unscoped statement there
      // is strictly worse than the same statement on a scoped client.
      const before = src.slice(Math.max(0, m.index - 200), m.index);
      const onRawPool = /\bpool\.query/.test(before);

      findings.push({
        file: shown,
        line,
        tables: [...new Set(tables)],
        onRawPool,
        snippet: sql.replace(/\s+/g, ' ').trim().slice(0, 90),
      });
    }
  }
}

console.log('\n### TENANT SCOPE LINT\n');

if (VERBOSE && exempted.length) {
  console.log(`  ${exempted.length} statement(s) exempted by comment:`);
  for (const e of exempted) console.log(`    ${e.file}:${e.line}  (${e.why})  ${e.tables.join(', ')}`);
  console.log('');
}

if (!findings.length) {
  console.log(`  [PASS] every tenant-table statement is org-scoped or explicitly exempted`);
  console.log(`         ${exempted.length} documented exemption(s)\n`);
  process.exit(0);
}

// Raw-pool findings first: those cannot even fall back to a session policy.
findings.sort((a, b) => Number(b.onRawPool) - Number(a.onRawPool));
for (const f of findings) {
  console.log(`  [${f.onRawPool ? 'RAW POOL' : ' SCOPED '}]  ${f.file}:${f.line}  — ${f.tables.join(', ')}`);
  console.log(`              ${f.snippet}`);
}
console.log(`\n  ${findings.length} unscoped statement(s). Add an org filter, or an explicit`);
console.log('  `-- lint-tenant-scope: resolver` / `rls-enforced` comment saying why not.\n');
process.exit(1);
