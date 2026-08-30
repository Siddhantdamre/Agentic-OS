#!/usr/bin/env node
'use strict';
/**
 * EVERY CONVERSATION KNOWS WHO IT IS WITH.
 *
 * THE INVARIANT
 *
 *     A conversation cannot be created without resolving the person it is
 *     with, or explicitly recording that it could not be resolved.
 *
 * A conversation with a NULL person_id is one that cannot be joined to
 * anything that human said before — so the agent re-asks what it was told last
 * week — cannot be fully erased, because erase_person walks the identities and
 * finds none, and counts as its own quiet lead, so one customer is followed up
 * several times.
 *
 * There are five places that create a conversation: the shared inbound
 * normaliser, the WhatsApp webhook, the Chatwoot webhook, manual creation from
 * the dashboard, and Ask AI. Wiring resolution into each of them fixes today
 * and guarantees the sixth — which is precisely how attribution missed three
 * call sites, how the budget missed five, and how tenant isolation missed a
 * table. Every one of those was correct at each link and broken as a chain.
 *
 * So the rule is mechanical: an INSERT INTO conversations must name person_id.
 * A new call site cannot be written without either resolving the person or
 * deliberately deleting this check, and deleting a check is a reviewable act
 * in a way that forgetting a column is not.
 *
 * Usage: node infra/scripts/lint-conversation-person.js
 * Exit:  0 = every creation path resolves a person, 1 = one does not
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

/**
 * Files allowed to create a conversation without resolving a person.
 *
 * Test fixtures and seeds only. Kept short: every entry is a path where the
 * invariant does not hold, and a list long enough to be convenient is a rule
 * that has stopped meaning anything.
 */
const ALLOWED = new Set([
  'infra/scripts/seed-quiet-leads-demo.js',
  'infra/scripts/check-erasure.js',
  'infra/scripts/check-identity.js',
  'infra/scripts/check-learning-e2e.js',
  'infra/scripts/check-quiet-leads.js',
  'infra/scripts/check-leaks-panel.js',
  // Suites that seed conversations to test something else entirely — the
  // commitment ledger, the digest, money metrics, tenant isolation. They
  // create a row and assert on a different table; resolving a person would add
  // nothing and would couple every suite to the identity schema.
  'infra/scripts/check-commitments.js',
  'infra/scripts/check-digest.js',
  'infra/scripts/check-impact-e2e.js',
  'infra/scripts/check-money-metrics.js',
  'infra/scripts/check-outcome-ledger.js',
  'tests/e2e-tenant-isolation.test.js',
]);

const tracked = execFileSync('git', ['ls-files', '*.ts', '*.tsx', '*.js'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').map((s) => s.trim()).filter(Boolean)
  .filter((f) => !f.includes('/dist/') && !f.includes('/.next/') && !f.includes('node_modules'));

const offenders = [];
let creators = 0;

for (const rel of tracked) {
  if (rel === 'infra/scripts/lint-conversation-person.js') continue;
  let src;
  try { src = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }

  // Every INSERT into conversations, however it is formatted.
  const inserts = src.match(/INSERT\s+INTO\s+conversations\s*\(([^)]*)\)/gi);
  if (!inserts) continue;
  creators++;
  if (ALLOWED.has(rel.replace(/\\/g, '/'))) continue;

  for (const stmt of inserts) {
    if (!/person_id/i.test(stmt)) {
      offenders.push({ rel, stmt: stmt.replace(/\s+/g, ' ').slice(0, 110) });
    }
  }
}

if (offenders.length) {
  console.log('\n  [FAIL] these create a conversation without resolving who it is with:\n');
  for (const o of offenders) {
    console.log(`    ${o.rel}`);
    console.log(`      ${o.stmt}…`);
  }
  console.log(
    '\n  A conversation with no person cannot be joined to that customer\'s\n'
    + '  history and CANNOT BE FULLY ERASED — erase_person walks the identities\n'
    + '  and finds none.\n'
    + '\n  Use resolvePersonId(client, orgId, handle, channelType) from\n'
    + '  apps/dashboard/lib/resolve-person.ts and pass the result as person_id.\n'
    + '  It never throws: an unresolvable handle returns null and the\n'
    + '  conversation is created without a person, which is honest.\n',
  );
  process.exit(1);
}

console.log(`  [PASS] all ${creators} file(s) that create conversations resolve a person`);
console.log('  passed 1 / 1');
process.exit(0);
