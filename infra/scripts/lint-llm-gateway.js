#!/usr/bin/env node
'use strict';
/**
 * ONE DOOR — no paid model call may bypass the budget and the attribution.
 *
 * THE INVARIANT
 *
 *     A paid model call cannot execute unless it is attributed to an org
 *     AND that org's budget permits the tier it is about to use.
 *
 * That was true of exactly one call site and false of five others, and the
 * difference was invisible: the budget gate fired correctly, recorded
 * `budget_exceeded`, chose the free tier — and the turn then spent paid tokens
 * anyway, because the critic, the reviser, memory write-back, the crew planner
 * and market research each read `process.env.LITELLM_MODEL` directly and had
 * never heard of a budget.
 *
 *     [PASS] the gate chose a replacement model — atomic-agent-deepseek
 *     [FAIL] every call ran on the zero-cost tier
 *            openrouter/deepseek/deepseek-chat, atomic-agent, atomic-agent
 *
 * Rewiring those five fixes today's symptom. It does nothing about the sixth,
 * which somebody will write next month by copying one of the five. This is the
 * same defect this repository keeps producing — tenant isolation that missed a
 * table, attribution that missed three call sites, authorization that could
 * not tell two employees apart — and every one of them was a chain that was
 * correct at every link.
 *
 * So the rule is enforced mechanically rather than remembered: exactly one
 * file may reach the chat completions endpoint. Anything else fails the build.
 * A new call site cannot be written without either going through the door or
 * deliberately deleting the lock, and deleting a lock is a reviewable act in a
 * way that forgetting a line is not.
 *
 * Usage: node infra/scripts/lint-llm-gateway.js
 * Exit:  0 = one door, 1 = a bypass exists
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

/**
 * The door itself, and the places a direct call is legitimate.
 *
 * Kept SHORT on purpose. Every entry is a hole, and a list of holes long
 * enough to be convenient is a rule that no longer means anything.
 */
const ALLOWED = new Set([
  // The one door.
  'services/workflows/src/llm/gateway.ts',
  // The vendored agent's own client: it talks to the proxy through the
  // atomic-agent container, which is attributed by the Docker build patch in
  // infra/docker/atomic-agent/patches, and whose model is chosen by the budget
  // gate in the workflow before the turn starts.
  'services/workflows/src/atomic-agent-client.ts',
  // Reads the spend log and probes the proxy; never asks a model anything.
  'infra/scripts/spend-guard.js',

  // The dashboard's own client. It resolves the model through
  // checkLlmBudgetActivity and sends `user: orgId`, so it satisfies the
  // invariant by the same means as the gateway. It is a separate Next.js app
  // and importing the worker's fetch path into a server component pulls the
  // Temporal client with it; this is the seam where that is not worth it.
  // ChatOptions.orgId is REQUIRED, so the compiler enforces attribution at
  // every caller.
  'apps/dashboard/lib/litellm-client.ts',

  // DIAGNOSTICS. These exist to test the proxy itself — its failover chain,
  // its latency, whether it is configured at all — so routing them through the
  // budget would measure the budget rather than the thing under test. None of
  // them runs in the product; all are operator-invoked.
  'infra/scripts/preflight.js',
  'infra/scripts/latency-probe.js',
  'infra/scripts/harden-suite.js',
  'infra/scripts/check-reply-gate-live.js',

  // The bug triage loop. It diagnoses THIS REPO's own failing checks, so there
  // is no tenant and no workspace budget to consult — and routing it through
  // llmChat would mean inventing an orgId, which charges repo maintenance to a
  // customer and pollutes that customer's usage record. The invariant this lint
  // protects is attribution to the workspace that caused the spend; a call with
  // no workspace behind it cannot satisfy that and must not pretend to.
  //
  // Bounded instead: operator-invoked only, `--triage-only` skips the model
  // entirely, and it asks a model ONLY about failures that deterministic triage
  // has already classified as code defects — which across every measured run so
  // far has been none, because every red line was the machine.
  'infra/scripts/self-repair.js',
]);

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

// Only files git tracks — build output under dist/ and .next/ contains
// compiled copies of the legitimate ones and would produce pure noise.
const tracked = git(['ls-files', '*.ts', '*.js', '*.mjs', '*.cjs'])
  .split('\n').map((s) => s.trim()).filter(Boolean)
  .filter((f) => !f.includes('/dist/') && !f.includes('/.next/') && !f.includes('node_modules'));

const offenders = [];
let scanned = 0;

for (const rel of tracked) {
  const abs = path.join(ROOT, rel);
  let src;
  try { src = fs.readFileSync(abs, 'utf8'); } catch { continue; }
  scanned++;

  // The endpoint, however it is spelled or assembled.
  if (!/chat\/completions/.test(src)) continue;

  // This file names the endpoint in its own documentation.
  if (rel === 'infra/scripts/lint-llm-gateway.js') continue;
  if (ALLOWED.has(rel.replace(/\\/g, '/'))) continue;

  // A comment or a doc string mentioning the path is not a call. Require some
  // evidence of an actual request, so prose does not fail the build.
  const looksLikeACall = /fetch\s*\(|axios|request\s*\(|\.post\s*\(/.test(src);
  if (!looksLikeACall) continue;

  offenders.push(rel);
}

if (offenders.length) {
  console.log('\n  [FAIL] these reach the model endpoint without going through the gateway:\n');
  for (const f of offenders) console.log(`    ${f}`);
  console.log(
    '\n  A paid call made outside services/workflows/src/llm/gateway.ts is a call\n'
    + '  that does not consult the workspace\'s budget and may not be attributed to\n'
    + '  anyone. That is exactly how an over-budget tenant kept spending after the\n'
    + '  gate had already decided to degrade it.\n'
    + '\n  Use llmChat({ orgId, purpose, messages }) instead. If a direct call is\n'
    + '  genuinely correct, add the path to ALLOWED in this file with a reason —\n'
    + '  so the exception is reviewed rather than assumed.\n',
  );
  process.exit(1);
}

console.log(`  [PASS] one door — ${scanned} tracked source files, ${ALLOWED.size} declared exceptions`);
console.log('  passed 1 / 1');
process.exit(0);
