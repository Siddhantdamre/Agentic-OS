#!/usr/bin/env node
'use strict';
/**
 * EVERY KEY THE ROUTER ASKS FOR MUST ACTUALLY REACH IT.
 *
 * `infra/litellm/config.yaml` names its credentials as `os.environ/NAME`. Those
 * are read inside the litellm CONTAINER, so each one has to be listed in that
 * service's `environment:` block in docker-compose. Nothing checked that, and
 * two were missing:
 *
 *   DEEPSEEK_API_KEY   tier 4 of the fallback chain
 *   GROQ_API_KEY       tier 5, the LAST link
 *
 * Both tiers resolved to an empty key, returned 401 after two retries, and
 * entered cooldown on every call that reached them. Because tier 5 is last, its
 * failure was the whole chain's failure — a chain documented as five deep, and
 * measurably three.
 *
 * The part that makes this worth a build check rather than a comment: supplying
 * the keys changed NOTHING. They went into infra/.env, the operator could see
 * them there, and the container still never received them. Diagnosing that from
 * the outside means reading a 401 from a vendor whose key you are holding in
 * your hand and know to be valid.
 *
 * A tier whose credential is not plumbed is worse than no tier: it costs
 * retries and cooldowns, and it makes the config claim redundancy it does not
 * have.
 *
 * Usage: node infra/scripts/check-router-credentials.js
 * Exit:  0 = every referenced key is passed through, 1 = one is not.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CONFIG = path.join(ROOT, 'infra', 'litellm', 'config.yaml');
const COMPOSE = path.join(ROOT, 'infra', 'docker-compose.yml');

let pass = 0;
const failures = [];
const ok = (m, d) => { pass += 1; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d) => { failures.push(`${m}${d ? ` — ${d}` : ''}`); console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };

console.log('\n=== ROUTER CREDENTIALS — does the container get the keys it asks for? ===\n');

const config = fs.readFileSync(CONFIG, 'utf8');
const compose = fs.readFileSync(COMPOSE, 'utf8');

// ── What the router asks for ────────────────────────────────────────────────
const wanted = [...new Set(
  [...config.matchAll(/os\.environ\/([A-Z0-9_]+)/g)].map((m) => m[1])
)].sort();

wanted.length > 0
  ? ok(`${wanted.length} credential(s) referenced by the router`, wanted.join(', '))
  : no('the router config references credentials', 'found none — did config.yaml move?');

// ── What the litellm service is actually given ──────────────────────────────
//
// Sliced to that one service, because a key passed to the worker or the
// dashboard does nothing for a value read inside the litellm process.
const svc = /(?:^|\n)  litellm:\n([\s\S]*?)(?=\n  [a-z0-9_-]+:\n|$)/.exec(compose);
if (!svc) {
  no('the litellm service block parsed',
    'could not find it in docker-compose.yml — this check is blind until fixed');
} else {
  ok('the litellm service block parsed');
  const block = svc[1];
  const passed = new Set(
    [...block.matchAll(/^\s*-\s*([A-Z0-9_]+)=/gm)].map((m) => m[1])
  );
  ok(`${passed.size} environment entries on that service`);

  const missing = wanted.filter((k) => !passed.has(k));
  missing.length === 0
    ? ok('every referenced credential is passed to the container')
    : no('every referenced credential is passed to the container',
      `${missing.join(', ')} — config.yaml reads these as os.environ/…, so the `
      + 'tier resolves to an empty key, 401s after retries, and cools down. Add '
      + `each as \`- ${missing[0]}=\${${missing[0]}}\` under the litellm service.`);
}

// ── A model group that names a dead model is not a tier either ──────────────
//
// Groq answered "llama-3.3-70b-versatile does not exist or you do not have
// access to it" for a valid key: the model had been retired upstream. A model
// id that is merely plausible fails at the exact moment failover is needed, so
// the ones verified against a live catalogue are pinned here by name.
const VERIFIED = ['openrouter/deepseek/deepseek-chat', 'openrouter/openai/gpt-4o-mini', 'groq/openai/gpt-oss-120b'];
const stale = VERIFIED.filter((m) => !config.includes(m));
stale.length === 0
  ? ok('the model ids verified against live catalogues are still the ones configured')
  : no('the model ids verified against live catalogues are still configured',
    `${stale.join(', ')} no longer appears. If a model was deliberately changed, `
    + 'verify the new id against the vendor\'s /models endpoint WITH a tool call '
    + 'in the request, then update this list.');

console.log(`\n  passed ${pass} / ${pass + failures.length}\n`);
if (failures.length) {
  console.log('FAILED:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('  PASS — the failover chain is as deep as it claims to be.\n');
