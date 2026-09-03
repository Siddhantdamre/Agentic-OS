#!/usr/bin/env node
'use strict';
/**
 * WHAT THE MODEL IS TOLD IT HAS MUST BE WHAT IT ACTUALLY HAS.
 *
 * 95 tools are declared to the agent in `mcp-bridge.ts`. Each declaration names
 * a provider key and an action. Both have to be real, and neither is checked by
 * the compiler: `tool` and `action` are plain strings, so a typo, a renamed
 * action or a deleted module all typecheck cleanly and fail only when an agent
 * actually reaches for that tool — in front of a customer, once, with no
 * pattern to notice.
 *
 * This found `file_ops` declared with `action: 'auto_execute'`, which the
 * module has never implemented (it has `read_file` and `write_file`). That one
 * survived because the bridge special-cases `file_ops` and reads the action
 * from the caller instead — so the declared action was simply dead, and a dead
 * declaration is indistinguishable from a working one until the special case is
 * removed by somebody who does not know it is load-bearing.
 *
 * ── WHY THE ACTION MATTERS AS MUCH AS THE TOOL ──────────────────────────────
 *
 * `mod.risk(action)` decides whether a call is a read, a draft or a send, and
 * `planRequiresDurableExecute` decides from the same action whether the step
 * must run on Temporal so a dashboard restart cannot drop a live send. An
 * action string nothing recognises falls to the safest-looking branch — `read`
 * — which is precisely the wrong direction to fail in.
 *
 * Usage: node infra/scripts/check-tool-declarations.js
 * Exit:  0 = every declaration resolves, 1 = one does not.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'services', 'workflows', 'src');
const BRIDGE = path.join(SRC, 'mcp-bridge.ts');
const INDEX = path.join(SRC, 'tools', 'index.ts');

let pass = 0;
const failures = [];
const ok = (m, d) => { pass += 1; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d) => { failures.push(`${m}${d ? ` — ${d}` : ''}`); console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };

console.log('\n=== TOOL DECLARATIONS — does every promised tool exist? ===\n');

const bridge = fs.readFileSync(BRIDGE, 'utf8');
const index = fs.readFileSync(INDEX, 'utf8');

// Each declaration is {name, ..., tool, action}. Bounded spans so one entry's
// regex cannot run into the next entry's fields and report a false pairing.
const declarations = [...bridge.matchAll(
  /name:\s*'([a-z0-9_]+)'[\s\S]{0,1200}?tool:\s*'([a-z0-9_.-]+)'[\s\S]{0,400}?action:\s*'([a-z0-9_]+)'/g
)].map((m) => ({ name: m[1], tool: m[2], action: m[3] }));

if (declarations.length < 50) {
  no('the declarations parsed', `only ${declarations.length} found — the file shape changed, re-read this script`);
} else {
  ok(`${declarations.length} tool declarations parsed`);
}

// provider key -> module variable, from the switch in tools/index.ts
const key2mod = {};
for (const block of index.matchAll(/((?:\s*case '[a-z0-9_.-]+':\r?\n)+)\s*return (\w+);/g)) {
  for (const k of block[1].matchAll(/case '([a-z0-9_.-]+)':/g)) key2mod[k[1]] = block[2];
}
// module variable -> source path, from every relative import in the registry.
//
// Handles both `import { gmail } from './gmail.js'` and a multi-name import from
// a subdirectory: `import { mls, realestate } from './realestate/index.js'`. The
// first version required the braces to hold exactly one name, so both modules in
// that line resolved to nothing and their declarations went unchecked.
const mod2path = {};
for (const m of index.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/([a-z0-9/-]+)\.js'/g)) {
  for (const raw of m[1].split(',')) {
    const nameOnly = raw.trim().split(/\s+as\s+/).pop().trim();
    if (nameOnly) mod2path[nameOnly] = m[2];
  }
}

if (Object.keys(key2mod).length < 40) {
  no('the tool registry parsed', `only ${Object.keys(key2mod).length} provider keys found`);
} else {
  ok(`${Object.keys(key2mod).length} provider keys route to a module`);
}

/**
 * The actions a module implements.
 *
 * Read from its `const ACTIONS = [...] as const`, which is the same list the
 * module's own `execute` switches on. A module with no ACTIONS block is
 * reported rather than skipped — silently skipping is how a whole module's
 * declarations would stop being checked.
 */
const actionsFor = {};
const unreadable = {};

/** Resolve a module variable to the file that declares its ACTIONS. */
function sourceFor(mod) {
  const rel = mod2path[mod];
  if (!rel) return null;
  const p = path.join(SRC, 'tools', `${rel}.ts`);
  return fs.existsSync(p) ? p : null;
}

for (const mod of new Set(Object.values(key2mod))) {
  const p = sourceFor(mod);
  if (!p) { unreadable[mod] = 'source file not found from its import'; continue; }
  const src = fs.readFileSync(p, 'utf8');
  const block = /const ACTIONS\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(src);
  if (!block) { unreadable[mod] = `${path.basename(p)} has no ACTIONS block`; continue; }
  actionsFor[mod] = [...block[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]);
}

// ── 1. Every declared tool routes somewhere ─────────────────────────────────
const unroutable = declarations.filter((d) => !key2mod[d.tool]);
unroutable.length === 0
  ? ok('every declared tool routes to a real module')
  : no('every declared tool routes to a real module',
    unroutable.map((d) => `${d.name} -> '${d.tool}'`).join(', '));

// ── 2. Every declared action is implemented by that module ──────────────────
const mismatched = [];
let verified = 0;
for (const d of declarations) {
  const mod = key2mod[d.tool];
  if (!mod) continue;
  const acts = actionsFor[mod];
  if (!acts) continue;
  verified += 1;
  if (!acts.includes(d.action)) {
    mismatched.push(`${d.name}: declares '${d.action}', ${mod} implements [${acts.join(', ')}]`);
  }
}
mismatched.length === 0
  ? ok(`every declared action is implemented`, `${verified} checked against their module`)
  : no('every declared action is implemented', mismatched.join(' | '));

// ── 3. Nothing is silently unverifiable ─────────────────────────────────────
//
// A declaration whose module could not be read is NOT a pass. It means that
// declaration went unchecked, which is the state this whole script exists to
// end — and the first version of this check had exactly that hole: it only
// looked at modules imported from a flat file, so the ones living in a
// subdirectory were neither checked nor counted. It reported 6/6 while
// verifying 90 of 95.
//
// So the arithmetic is asserted directly: every declaration is either verified
// against a real ACTIONS list, or named here as unverified.
const usedMods = new Set(declarations.map((d) => key2mod[d.tool]).filter(Boolean));
const blind = [...usedMods].filter((m) => !actionsFor[m]);
if (verified === declarations.length && blind.length === 0) {
  ok('every declaration was actually verified', `${verified} of ${declarations.length}`);
} else {
  no('every declaration was actually verified',
    `${verified} of ${declarations.length} checked; unreadable modules: `
    + (blind.map((m) => `${m} (${unreadable[m] || 'unknown'})`).join(', ') || 'none')
    + ' — an unchecked declaration is the defect this script exists to catch');
}

// ── 4. The dead risk fields stay gone ───────────────────────────────────────
//
// `toolDef.risk` and `toolDef.confirm` were assigned at registration and read
// by nothing. Dead fields that look like a permission control are worse than no
// fields: a reader assumes the bridge classifies risk and stops looking for
// where it really happens.
/(?:toolDef\.risk|toolDef\.confirm)\s*=/.test(bridge)
  ? no('the bridge does not fake a risk classification',
    'toolDef.risk/confirm is assigned again — it is read by nothing; risk is '
    + 'enforced in tools/index.ts and plan-steps.ts, both of which see the real action')
  : ok('the bridge does not fake a risk classification',
    'risk lives in tools/index.ts and plan-steps.ts, where the real action is known');

console.log(`\n  passed ${pass} / ${pass + failures.length}\n`);
if (failures.length) {
  console.log('FAILED:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('  PASS — the agent is told about nothing it cannot actually call.\n');
