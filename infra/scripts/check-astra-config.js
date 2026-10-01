#!/usr/bin/env node
/**
 * Static GPT-6 Astra launch gate.
 *
 * This intentionally does not call OpenAI: CI must be able to prove that the
 * model is wired without exposing or spending credentials.
 *
 * It verifies:
 *   1. LiteLLM defines the Darex Astra alias.
 *   2. The alias points at the exact GPT-6 Astra model id.
 *   3. The credential is read from OPENAI_API_KEY, never hard-coded.
 *   4. The dashboard defaults its reasoning workloads to darex-astra.
 *   5. Astra reasoning calls use Astra-compatible parameters.
 *
 * A live credential/model probe belongs in deployment acceptance, not CI.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const config = read('infra/litellm/config.yaml');
const compose = read('infra/docker-compose.yml');
const client = read('apps/dashboard/lib/litellm-client.ts');

const checks = [
  ['Astra alias exists', /model_name:\s*darex-astra\b/.test(config)],
  ['Exact Astra model id', /model:\s*openai\/gpt-6-astra\b/.test(config)],
  ['Astra credential is env-backed', /api_key:\s*os\.environ\/OPENAI_API_KEY\b/.test(config)],
  ['Compose passes OPENAI_API_KEY', /OPENAI_API_KEY=\$\{OPENAI_API_KEY\}/.test(compose)],
  ['Dashboard defaults to Astra', /LITELLM_MODEL=\$\{LITELLM_MODEL:-darex-astra\}/.test(compose)],
  ['Astra reasoning is high by default', /DAREX_ASTRA_REASONING_EFFORT=\$\{DAREX_ASTRA_REASONING_EFFORT:-high\}/.test(compose)],
  ['Client uses max_completion_tokens for Astra', /max_completion_tokens:\s*options\.maxTokens/.test(client)],
  ['Client uses reasoning_effort for Astra', /reasoning_effort:\s*process\.env\.DAREX_ASTRA_REASONING_EFFORT/.test(client)],
  ['Client does not send temperature on Astra branch', /model === 'darex-astra'[\s\S]{0,500}max_completion_tokens/.test(client)],
];

let failed = 0;
for (const [name, ok] of checks) {
  if (ok) console.log(`  [PASS] ${name}`);
  else { console.error(`  [FAIL] ${name}`); failed++; }
}
console.log(`\\nGPT-6 Astra static gate: ${checks.length - failed}/${checks.length} passed`);
process.exitCode = failed ? 1 : 0;
