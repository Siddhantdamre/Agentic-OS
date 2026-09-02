#!/usr/bin/env node
'use strict';
/**
 * NO MODEL GROUP MAY BE A DEAD END.
 *
 * The fallback chain covered `atomic-agent` and nothing else, on the assumption
 * written at the top of the config: "the atomic-agent always calls model
 * atomic-agent". That assumption is false. The per-tenant budget gate pins an
 * over-budget workspace directly to a zero-cost tier via modelOverride, so the
 * request arrives as `atomic-agent-deepseek` and never passes the front door.
 *
 * The failure was silent in the worst way. On the first real shift run Nvidia
 * returned "Service temporarily overloaded", LiteLLM logged
 *
 *     No fallback model group found for original model_group=atomic-agent-deepseek
 *
 * and four of six agents executed their tools correctly — metrics_query,
 * database_query, intercom_fetch_conversations — then returned an EMPTY reply.
 * The work happened. The report vanished. Nothing errored.
 *
 * Two rules, both checked here:
 *
 *   1. Every agent model group has somewhere to fall to.
 *   2. A ZERO-COST group never falls onto a PAID one. The budget gate pins a
 *      workspace to a free tier precisely to stop it billing the account;
 *      failing over to a paid model would bill exactly the workspace that was
 *      being protected, which is worse than the outage it fixes.
 *
 * Usage: node infra/scripts/check-model-fallbacks.js
 */
const fs = require('fs');
const path = require('path');

const CONFIG = path.join(__dirname, '..', 'litellm', 'config.yaml');

let pass = 0;
let fail = 0;
const ok = (m, d = '') => { pass++; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d = '') => { fail++; console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };

console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
console.log('║  MODEL FALLBACKS — no group may be a dead end                        ║');
console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

const src = fs.readFileSync(CONFIG, 'utf8');

/**
 * Deliberately parsed with regex rather than a YAML dependency.
 *
 * This file is read by LiteLLM, not by us, so the only thing worth asserting is
 * the shape a human maintains: which groups exist, which are free, and what
 * each falls to. A parser would let this check drift into validating YAML
 * instead of validating the routing decision.
 */
const groups = [...src.matchAll(/^\s*-\s*model_name:\s*([a-z0-9._-]+)\s*$/gim)].map((m) => m[1]);
const agentGroups = groups.filter((g) => g.startsWith('atomic-agent'));

agentGroups.length >= 4
  ? ok(`${agentGroups.length} agent model groups defined`, agentGroups.join(', '))
  : no('agent model groups found', `only ${agentGroups.length}`);

// Which groups cost nothing. A ":free" suffix on the upstream model id, or a
// provider whose tier here is documented as free.
const FREE_MARKERS = [/:free\b/i, /\bgroq\//i];
const isFree = (group) => {
  // Anchored to end-of-line, not \b. Group names share prefixes —
  // "atomic-agent" is a prefix of "atomic-agent-fallback" — and \b matches
  // between "t" and "-", so a boundary match grabbed the wrong block and
  // reported the PAID tier 1 as free. That produced two confident failures
  // about a config that was correct.
  const block = src.split(new RegExp(`-\\s*model_name:\\s*${group}\\s*$`, 'm'))[1];
  if (!block) return false;
  const body = block.split(/-\s*model_name:/)[0];

  // Only the model id decides, never the prose around it. The comment above
  // tier 2 reads "Both fallbacks were :free models until reliability run 17",
  // and matching the whole block classified the PAID tier 1 as free — then
  // reported two confident failures about a correct config. A checker that
  // reads commentary is reading opinion, not configuration.
  const modelLines = body
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .filter((l) => /^\s*model:\s*/.test(l));

  return modelLines.some((l) => FREE_MARKERS.some((re) => re.test(l)));
};

const freeGroups = agentGroups.filter(isFree);
freeGroups.length >= 2
  ? ok(`${freeGroups.length} zero-cost tiers exist`, `${freeGroups.join(', ')} — a free tier can fail over and stay free`)
  : no('at least two zero-cost tiers exist', `found ${freeGroups.length}; a pinned free tier would have nowhere to go`);

// Parse the fallbacks map: "- <group>:" followed by indented "- <target>" lines.
const fbSection = src.split(/^\s*fallbacks:\s*$/m)[1] || '';
const fbBody = fbSection.split(/^\s*retry_policy:/m)[0] || '';
const chains = new Map();
let current = null;
for (const raw of fbBody.split('\n')) {
  const head = raw.match(/^\s*-\s*([a-z0-9._-]+):\s*$/i);
  if (head) { current = head[1]; chains.set(current, []); continue; }
  const item = raw.match(/^\s*-\s*([a-z0-9._-]+)\s*$/i);
  if (item && current) chains.get(current).push(item[1]);
}

chains.size > 0
  ? ok(`${chains.size} fallback chain(s) declared`, [...chains.keys()].join(', '))
  : no('fallback chains are declared');

// ── Rule 1: nothing is a dead end ──────────────────────────────────────────
// The last tier is allowed to be terminal — something has to be last.
const terminal = agentGroups[agentGroups.length - 1];
const deadEnds = agentGroups.filter((g) => g !== terminal && !(chains.get(g) || []).length);

deadEnds.length === 0
  ? ok('every agent group has somewhere to fall to', `${terminal} is terminal, which is correct`)
  : no('a model group is a dead end',
    `${deadEnds.join(', ')} — a provider outage there returns an empty reply with no error`);

// ── Rule 2: free never falls onto paid ─────────────────────────────────────
let budgetLeaks = 0;
for (const [group, targets] of chains) {
  if (!isFree(group)) continue;
  for (const t of targets) {
    if (!isFree(t)) {
      budgetLeaks += 1;
      no('a zero-cost tier falls onto a paid one',
        `${group} -> ${t}, which bills the workspace the budget gate was protecting`);
    }
  }
}
if (budgetLeaks === 0) {
  ok('no zero-cost tier falls onto a paid one', 'an over-budget workspace stays free even during failover');
}

// ── The specific group the budget gate pins ────────────────────────────────
// Named explicitly because this is the one that actually broke.
const PINNED = 'atomic-agent-deepseek';
if (agentGroups.includes(PINNED)) {
  (chains.get(PINNED) || []).length > 0
    ? ok(`${PINNED} has a fallback`, 'the tier the budget gate pins is no longer a dead end')
    : no(`${PINNED} has a fallback`,
      'this is the group modelOverride pins; without a chain an outage here is a silent empty reply');
}

console.log(`\n  passed ${pass} / ${pass + fail}\n`);
process.exit(fail ? 1 : 0);
