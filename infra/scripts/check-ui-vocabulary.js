#!/usr/bin/env node
'use strict';
/**
 * THE OWNER'S SCREEN IS NOT OUR ARCHITECTURE DIAGRAM.
 *
 * The reply gate already stops an agent telling a CUSTOMER about databases and
 * tools. Nothing applied the same rule to the dashboard, and it had drifted
 * further than the agent ever did. Fifteen places named our infrastructure to
 * the person paying for the software:
 *
 *   login page      "Phase 3 Ready • Postgres RLS • Self-Hosted Stack"
 *   integrations    "Nango Connector Execution Drawer"
 *                   "Execute `@darex/connectors` Proxy Function"
 *   connectors      "Nango Tenant Isolation Credentials"
 *                   "Idempotent Temporal Activity"
 *   insight         "From Langfuse traces for this org."
 *
 * "Nango" is our OAuth broker. A furniture retailer connecting Gmail has no
 * idea what that is, cannot act on it, and did not buy a tour of our vendors.
 * The login page announced our build phase and our database's row-level
 * security to a prospective customer before they had even signed in.
 *
 * The same page also printed `http://localhost:3000/api/integrations/webhooks`
 * as the URL to paste into a provider — a dead address on every deployment
 * that is not a developer's laptop, in the one field that exists to be copied.
 *
 * The test is WHO IS READING, not whether a word sounds technical. "Webhook
 * URL" stays: a developer wiring up their own channel provider needs exactly
 * that word, and it is their vocabulary rather than ours leaking.
 *
 * Usage: node infra/scripts/check-ui-vocabulary.js
 * Exit:  0 = no infrastructure vocabulary on screen, 1 = some appeared.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const APP = path.join(ROOT, 'apps', 'dashboard');

/** Words that name how the product is built rather than what it does. */
const TERMS = /\b(Nango|Temporal|LiteLLM|SuperTokens|Supertokens|pgbouncer|Postgres|Redis|tsvector|pgvector|Langfuse|atomic-agent|proxy|drawer|localhost:\d+|org_id|tenant isolation|idempotent|RLS)\b/i;

/**
 * Deliberate, reviewed exceptions. Each is vocabulary the READER owns.
 * Adding to this list is a decision to show a user one of our words, so it
 * needs a reason written beside it.
 */
const ALLOWED = [
  'Webhook URL',              // the field they paste into their own provider
  'Supported Webhook Events', // what that provider will send them
  'Webhook Endpoints',        // settings, for that same technical reader
  'org_id',                   // needed by anyone calling the API directly
];

const hits = [];
for (const rel of ['app', 'components']) {
  const root = path.join(APP, rel);
  if (!fs.existsSync(root)) continue;
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.tsx$/.test(e.name)) continue;
      const src = fs.readFileSync(p, 'utf8');
      src.split('\n').forEach((line, i) => {
        // Imports and comments describe the code, not the screen.
        if (/^\s*(import|\/\/|\*|\/\*)/.test(line)) return;
        // JSX text nodes only: what actually renders between tags.
        for (const m of line.matchAll(/>([^<>{}]{6,})</g)) {
          const text = m[1].trim();
          if (TERMS.test(text)) {
            hits.push(
              `${path.relative(ROOT, p).split(path.sep).join('/')}:${i + 1}  ${text.slice(0, 90)}`
            );
          }
        }
      });
    }
  })(root);
}

const leaks = hits.filter((h) => !ALLOWED.some((a) => h.includes(a)));

console.log("\n=== UI VOCABULARY — is our plumbing on the owner's screen? ===\n");
console.log('  scanned every page and component under apps/dashboard');

if (leaks.length === 0) {
  console.log('  [PASS] no infrastructure vocabulary on screen');
  console.log(`  [PASS] ${ALLOWED.length} reviewed exceptions, each owned by the reader\n`);
  console.log("  PASS — the dashboard speaks the business's language, not ours.\n");
  process.exit(0);
}

console.log(`  [FAIL] ${leaks.length} user-visible internal term(s):\n`);
for (const h of leaks) console.log(`    ${h}`);
console.log('\n  Rewrite these in words the reader can act on. If the reader genuinely');
console.log('  owns that vocabulary — a developer configuring their own webhook —');
console.log('  add it to ALLOWED above with the reason why.\n');
process.exit(1);
