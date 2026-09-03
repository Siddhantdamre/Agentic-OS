#!/usr/bin/env node
'use strict';
/**
 * EVERY ROLE THE PRODUCT CAN CREATE MUST RESOLVE TO A DUTY.
 *
 * A duty is what an employee does when nobody has asked it anything. Without
 * one, work only ever arrives as an inbound customer message, so an employee
 * with no traffic does nothing at all, forever, while the workspace looks fully
 * staffed. That is the defect the whole duties feature exists to end.
 *
 * It came back, because there are TWO role vocabularies in this product and
 * nothing made them meet:
 *
 *   pack manifests            "Sales / front-of-house"
 *   dashboard DEFAULT_ROSTER  "Sales & Lead Gen"
 *
 * `dutyForRole` is an exact string match. The duty table read as complete —
 * eight duties, six matching every pack role — while three of the five roles a
 * BRAND-NEW workspace is seeded with matched nothing in it. Sarah, Emma and
 * Marcus, the first three employees any new user ever sees, could never do
 * standing work.
 *
 * Reading the duty table cannot catch that. You have to start from the other
 * end: enumerate every role string the product is capable of writing into
 * `ai_employees`, and check each one resolves.
 *
 * ── WHY ALIASES AND NOT NORMALISATION ───────────────────────────────────────
 *
 * The tempting fix is to strip punctuation and compare loosely, so that
 * "Sales / front-of-house" and "Sales & Lead Gen" both reduce to "sales". A
 * duty is a standing instruction to act on a real business's data unattended;
 * a similarity test is how an employee ends up doing a job nobody assigned it.
 * Aliases are an explicit, reviewable list.
 *
 * Usage: node infra/scripts/check-duty-coverage.js
 * Exit:  0 = every creatable role has a duty, 1 = one does not.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const MANIFESTS = path.join(ROOT, 'services/workflows/src/packs/manifests.ts');
const ROSTER = path.join(ROOT, 'apps/dashboard/app/api/employees/route.ts');

let pass = 0;
const failures = [];
const ok = (m, d) => { pass += 1; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d) => { failures.push(`${m}${d ? ` — ${d}` : ''}`); console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };

(async () => {
  console.log('\n=== DUTY COVERAGE — can every employee this product creates do standing work? ===\n');

  const duties = await import(
    'file://' + path.join(ROOT, 'services/workflows/dist/duties.js').replace(/\\/g, '/')
  );

  // ── Source 1: role packs ──────────────────────────────────────────────────
  const manifestSrc = fs.readFileSync(MANIFESTS, 'utf8');
  const packRoles = [...manifestSrc.matchAll(/role:\s*'([^']+)'/g)].map((m) => m[1]);

  // ── Source 2: the dashboard's default roster ──────────────────────────────
  //
  // This is the one that was missed. It is not a fixture: `/api/employees`
  // inserts it whenever an org has no employees, so it is what every new
  // workspace in the product actually gets.
  const rosterSrc = fs.readFileSync(ROSTER, 'utf8');
  const rosterBlock = /const DEFAULT_ROSTER = \[([\s\S]*?)\n\];/.exec(rosterSrc);
  const rosterRoles = rosterBlock
    ? [...rosterBlock[1].matchAll(/^\s*role:\s*'([^']+)',/gm)].map((m) => m[1])
    : [];

  if (packRoles.length === 0) no('pack roles parsed', 'found none — manifests.ts shape changed');
  else ok(`${packRoles.length} pack roles found`);

  if (rosterRoles.length === 0) {
    no('the dashboard default roster parsed',
      'found no roles in DEFAULT_ROSTER — if that block moved, this check is blind to the '
      + 'exact source of the original defect');
  } else {
    ok(`${rosterRoles.length} default-roster roles found`, 'what a new workspace is seeded with');
  }

  // ── Every creatable role resolves ─────────────────────────────────────────
  const creatable = [
    ...packRoles.map((r) => ({ role: r, from: 'pack manifest' })),
    ...rosterRoles.map((r) => ({ role: r, from: 'default roster' })),
  ];

  const orphans = [];
  for (const c of creatable) {
    const duty = duties.dutyForRole(c.role);
    if (!duty) orphans.push(`"${c.role}" (${c.from})`);
  }

  orphans.length === 0
    ? ok(`all ${creatable.length} creatable roles resolve to a duty`)
    : no(`all ${creatable.length} creatable roles resolve to a duty`,
      `${orphans.join(', ')} — these employees will never do standing work; `
      + 'add the role to the matching duty\'s aliases in services/workflows/src/duties.ts');

  // ── No alias collides ─────────────────────────────────────────────────────
  //
  // Two duties claiming one role string means whichever is declared first wins
  // and the other silently never fires for it.
  const seen = new Map();
  const collisions = [];
  for (const d of duties.DUTIES) {
    for (const r of [d.role, ...(d.aliases || [])]) {
      const k = r.toLowerCase();
      if (seen.has(k) && seen.get(k) !== d.id) collisions.push(`"${r}" claimed by ${seen.get(k)} and ${d.id}`);
      else seen.set(k, d.id);
    }
  }
  collisions.length === 0
    ? ok(`${seen.size} role strings map to exactly one duty each`)
    : no('each role string maps to exactly one duty', collisions.join('; '));

  // ── Aliases are aliases, not a second job ─────────────────────────────────
  //
  // An alias says "this role string means the same job". If a duty's aliases
  // outnumber real vocabularies by a lot, someone is using the field to make
  // one duty cover unrelated work — which is how an ops duty starts firing for
  // a finance employee.
  const overloaded = duties.DUTIES.filter((d) => (d.aliases || []).length > 4);
  overloaded.length === 0
    ? ok('no duty is aliased so widely that it covers unrelated roles')
    : no('no duty is aliased so widely that it covers unrelated roles',
      overloaded.map((d) => `${d.id} has ${d.aliases.length} aliases`).join(', '));

  console.log(`\n  passed ${pass} / ${pass + failures.length}\n`);
  if (failures.length) {
    console.log('FAILED:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('  PASS — every employee this product can create has a job it does unprompted.\n');
})().catch((err) => {
  console.log(`ERROR: ${err && err.message}`);
  process.exit(1);
});
