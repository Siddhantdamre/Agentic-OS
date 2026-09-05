#!/usr/bin/env node
'use strict';
/**
 * THE AGENT MUST BE TAUGHT THE STANDARD IT IS MARKED AGAINST.
 *
 * `quality-rules.js` scores every reply against ten mechanical rules — money
 * symbols, thousands separators, answer-first, no hedging, no markdown, length.
 * The system prompt's entire guidance on quality used to be one line:
 *
 *   "Keep replies professional, warm and natural."
 *
 * So the standard existed only in the marking scheme. The agent was graded on
 * rules it had never been shown, and corrected after the fact by a gate that
 * strips and rewrites its output. The model will write "₹2,500" instead of
 * "2500 rupees" if told once — it was never told.
 *
 * That gap is the kind that reopens quietly: someone adds an eleventh rule to
 * quality-rules.js, the suite starts marking a behaviour down, and nothing
 * anywhere tells the agent about it. The scores drop and the prompt looks
 * innocent. So this check pins the two together — every rule the harness scores
 * must be taught in the prompt's output standard, by name.
 *
 * Deliberately a coverage check, not a wording check. It asserts each rule is
 * ADDRESSED, via a keyword its instruction must contain, so the prompt can be
 * rewritten freely as long as it still teaches the thing.
 *
 * Usage: node infra/scripts/check-output-standard.js
 * Exit:  0 = every scored rule is taught, 1 = at least one is marked but untaught.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const RULES_FILE = path.join(__dirname, 'quality-rules.js');
const PROMPT_FILE = path.join(ROOT, 'services', 'workflows', 'src', 'atomic-agent-client.ts');
const MANIFEST_FILE = path.join(ROOT, 'services', 'workflows', 'src', 'packs', 'manifests.ts');

let pass = 0;
const failures = [];
const ok = (m, d) => { pass += 1; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d) => { failures.push(`${m}${d ? ` — ${d}` : ''}`); console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };

console.log('\n=== OUTPUT STANDARD — is the agent taught what it is marked on? ===\n');

for (const f of [RULES_FILE, PROMPT_FILE, MANIFEST_FILE]) {
  if (!fs.existsSync(f)) {
    console.log(`  [FAIL] ${path.basename(f)} not found — this check is blind until the path is fixed.`);
    process.exit(1);
  }
}

const rulesSrc = fs.readFileSync(RULES_FILE, 'utf8');
const promptSrc = fs.readFileSync(PROMPT_FILE, 'utf8');
const manifestSrc = fs.readFileSync(MANIFEST_FILE, 'utf8');

// ── What the harness scores ────────────────────────────────────────────────
const scored = [...rulesSrc.matchAll(/name:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]);
scored.length > 0
  ? ok(`${scored.length} quality rules found in the marking scheme`, scored.join(', '))
  : no('quality rules found', 'none parsed — did RULES change shape?');

/**
 * How each rule shows up in an instruction.
 *
 * A rule is "taught" when the standard contains the evidence below. Keyed by
 * rule name so an unmapped rule fails loudly rather than passing by default —
 * the whole point is to catch a rule nobody propagated.
 */
const TAUGHT_BY = {
  answer_first: /lead with the answer/i,
  money_symbol: /₹2,500.*never.*2500 rupees|money always carries its symbol/i,
  money_separators: /thousands separators/i,
  plain_text: /no markdown|no bullet/i,
  concise: /two or three sentences/i,
  not_truncated: /finish your sentences/i,
  no_internal_terms: /never mention tools, permissions or systems|do NOT mention tools/i,
  no_internal_ids: /never mention tools, permissions or systems|do NOT mention tools/i,
  no_placeholder_text: /placeholder|never.*\[.*\]/i,
  no_hedging: /never hedge|approximately/i,
};

const standard = promptSrc;
const untaught = [];
const unmapped = [];
for (const rule of scored) {
  const probe = TAUGHT_BY[rule];
  if (!probe) { unmapped.push(rule); continue; }
  if (!probe.test(standard)) untaught.push(rule);
}

unmapped.length === 0
  ? ok('every scored rule has a known place in the standard')
  : no('every scored rule has a known place in the standard',
    `${unmapped.join(', ')} — a rule was added to quality-rules.js and nothing teaches it. `
    + 'Add the instruction to buildOutputStandard() in atomic-agent-client.ts, then map it '
    + 'in TAUGHT_BY here so it stays pinned.');

untaught.length === 0
  ? ok('every scored rule is taught in the system prompt')
  : no('every scored rule is taught in the system prompt',
    `${untaught.join(', ')} — the harness marks these down but the agent is never told. `
    + 'Either teach it in buildOutputStandard(), or stop scoring it.');

// ── The other half: a persona must say what good looks like ────────────────
//
// Six roles were six prohibitions and nothing else. An agent told only what NOT
// to say optimises toward saying little, which is the GAVE UP column.
const personas = [...manifestSrc.matchAll(/personaTemplate:\s*([\s\S]*?),\n\s{4}toolAllowlist/g)]
  .map((m) => m[1]);

personas.length >= 6
  ? ok(`${personas.length} personas parsed`)
  : no('personas parsed', `found ${personas.length}, expected at least 6`);

const prohibitionOnly = personas.filter((p) => /never/i.test(p) && !/outstanding work from you/i.test(p));
prohibitionOnly.length === 0
  ? ok('every persona states what outstanding looks like, not only what is forbidden')
  : no('every persona states what outstanding looks like',
    `${prohibitionOnly.length} persona(s) carry a "never …" prohibition with no positive `
    + 'standard. Prohibitions define the floor; without a ceiling the agent optimises '
    + 'toward saying as little as possible, which the completion suite counts as GAVE UP. '
    + 'Add an "Outstanding work from you: …" clause naming what a good answer from that '
    + 'role contains.');

console.log(`\n  passed ${pass} / ${pass + failures.length}\n`);
if (failures.length) {
  console.log('FAILED:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('  PASS — the agent is taught the standard it is marked against.\n');
