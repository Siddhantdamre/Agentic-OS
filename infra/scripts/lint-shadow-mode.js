#!/usr/bin/env node
'use strict';
/**
 * THE SAFETY SWITCH MUST STAY LOAD-BEARING.
 *
 * Shadow mode promises one thing: "nothing is sent — every reply the agent would
 * have sent becomes a decision for a human." It has a table, an API, a migration
 * and 18 passing assertions.
 *
 * No runtime code read it -- while the agent WAS auto-replying to customers.
 *
 * The send lived in lib/inbound-agent.ts, one level below the webhooks, and
 * fireInboundAgent is called by the chatwoot, gmail, instagram and sms routes.
 * Grepping the webhook files for a send found nothing and looked reassuring;
 * this lint, which follows the call rather than the file, found it immediately.
 *
 * So the switch said "nothing is sent" and messages went out. A labelled safety
 * control that does not control is worse than no control, because a person reads
 * the label and relaxes.
 *
 * The send is now gated, and this lint fails the build if any future delivery
 * path skips the switch. The transport primitive is deliberately exempt: it
 * cannot tell an operator's own message from the agent's, and blocking a human
 * answering their own customer would turn a safety feature into an outage.
 *
 * Usage: node infra/scripts/lint-shadow-mode.js
 * Exit:  0 = every delivery path is gated (or none exists), 1 = one is not
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

/** Files that may legitimately put a message in front of a customer. */
const DELIVERY = [
  'apps/dashboard/app/api/webhooks/outbound/route.ts',
  'apps/dashboard/app/api/conversations/[id]/reply/route.ts',
  'apps/dashboard/app/api/conversations/[id]/messages/route.ts',
  // NOT channel-outbound.ts. That is the transport primitive, and it cannot tell
  // an operator's own message from the agent's — gating inside it would block a
  // human answering their own customer, turning a safety feature into an outage.
  // The callers decide, and check 2 below is what actually enforces that.
];

/**
 * A delivery path is EXEMPT when a human is unambiguously the sender. Shadow
 * mode withholds the AGENT's replies; it must never stop an operator from
 * answering their own customer, which would turn a safety feature into an
 * outage.
 */
const HUMAN_SENDER = /'human_agent'|"human_agent"/;

let pass = 0;
let fail = 0;
const ok = (m, d = '') => { pass++; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d = '') => { fail++; console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };

const read = (rel) => {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return null; }
};

console.log('\n=== SHADOW MODE — is the switch load-bearing? ===\n');

// ── 1. Nothing delivers an agent reply without consulting the switch ────────
console.log('1. Every path that could send an AGENT reply consults the switch');
let agentPaths = 0;
for (const rel of DELIVERY) {
  const src = read(rel);
  if (src === null) continue;
  if (HUMAN_SENDER.test(src)) continue;   // operator's own send, correctly exempt
  agentPaths += 1;
  /shadow/i.test(src)
    ? ok(`${rel} consults it`)
    : no(`${rel} can deliver without consulting shadow mode`,
      'a reply the agent wrote could reach a customer while the switch says it cannot');
}
agentPaths === 0
  ? ok('every agent delivery path consults the switch',
    'the agent does auto-reply — shadow mode is what stops it')
  : null;

// ── 2. The promise is not quietly broken elsewhere ─────────────────────────
// Any NEW file that both writes an assistant message and calls a channel sender
// is an auto-delivery path by definition, wherever it lives.
console.log('\n2. No new file auto-delivers an assistant message');
function walk(dir, acc = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (['node_modules', '.next', 'dist', '.git', 'coverage'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) acc.push(full);
  }
  return acc;
}

const offenders = [];
for (const file of [...walk(path.join(ROOT, 'apps')), ...walk(path.join(ROOT, 'services'))]) {
  const src = fs.readFileSync(file, 'utf8');
  const sends = /sendChannelReply\s*\(|\/api\/inbox\/send|webhooks\/outbound/.test(src);
  if (!sends) continue;
  const writesAgentReply = /'assistant'/.test(src) && !HUMAN_SENDER.test(src);
  if (writesAgentReply && !/shadow/i.test(src)) {
    offenders.push(path.relative(ROOT, file).replace(/\\/g, '/'));
  }
}
offenders.length === 0
  ? ok('nothing writes an assistant reply and sends it in the same file',
    'the agent drafts; a person delivers')
  : no(`${offenders.length} file(s) auto-deliver an agent reply`, offenders.join(', '));

// ── 3. The switch is still readable ────────────────────────────────────────
console.log('\n3. The switch itself still exists');
const api = read('apps/dashboard/app/api/shadow/route.ts');
api && /org_shadow_mode/.test(api)
  ? ok('the shadow mode switch is reachable and reads its own table')
  : no('the shadow mode switch is missing', 'the evidence-gathering promise is gone');

console.log(`\n  passed ${pass} / ${pass + fail}\n`);
process.exit(fail ? 1 : 0);
