#!/usr/bin/env node
'use strict';
/**
 * A CUSTOMER MUST NEVER BE LEFT WITH SILENCE.
 *
 * WorkItemWorkflow can tell a customer "Just checking that for you — I will
 * have an answer shortly" while the agent is still working. That interim ack is
 * a PROMISE. Every path out of the workflow after it has to end in something
 * being said, even when the answer never arrived.
 *
 * There are two ways an agent turn fails, and they had two different endings:
 *
 *   child THROWS            -> catch block saves SERVICE_FALLBACK_REPLY
 *   child RETURNS a failure -> marked needs_attention, saved NOTHING
 *
 * The second one returned `savedByWorkflow: true` — telling the caller the
 * reply had been handled — with `replyMessage: reply || undefined`. So the
 * workflow saved no message, the caller trusted the flag and saved no message,
 * and nobody noticed. Measured, conversation 28f8fa06:
 *
 *   23:18:16  customer   What was your total revenue last financial year?
 *   23:18:47  assistant  Just checking that for you - I will have an answer
 *                        shortly.
 *             (nothing, ever)
 *
 * Triggered by a real upstream outage: OpenRouter returned 502 "Upstream error
 * from Nvidia: Service temporarily overloaded" MID-STREAM, which LiteLLM cannot
 * fail over because bytes had already been sent. Three of the four router tiers
 * are OpenRouter, so depth did not help.
 *
 * The invariant this pins is narrow and mechanical, which is why it is worth
 * automating: `savedByWorkflow: true` is a CLAIM that a reply was saved. A
 * return that makes the claim while leaving `replyMessage` undefined is lying,
 * and the customer is the one who finds out.
 *
 * Usage: node infra/scripts/check-never-silent.js
 * Exit:  0 = every return that claims to have saved a reply carries one.
 *        1 = at least one path can go silent.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const TARGET = path.join(ROOT, 'services', 'workflows', 'src', 'workflows', 'WorkItemWorkflow.ts');

let pass = 0;
const failures = [];
const ok = (m, d) => { pass += 1; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d) => { failures.push(`${m}${d ? ` — ${d}` : ''}`); console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };

console.log('\n=== NEVER SILENT — can any failure path leave the customer with nothing? ===\n');

if (!fs.existsSync(TARGET)) {
  console.log('  [FAIL] WorkItemWorkflow.ts not found — this check is blind until the path is fixed.');
  process.exit(1);
}
const src = fs.readFileSync(TARGET, 'utf8');
const lines = src.split('\n');

// ── Every `return { ... }` object literal in the file ───────────────────────
//
// Brace-matched rather than regex-matched: a return block spans many lines and
// contains nested objects, and a non-greedy regex would stop at the first `}`.
const returns = [];
for (let i = 0; i < lines.length; i += 1) {
  if (!/^\s*return\s*\{\s*$/.test(lines[i])) continue;
  let depth = 1;
  const start = i;
  let j = i;
  while (depth > 0 && j < lines.length - 1) {
    j += 1;
    for (const ch of lines[j]) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
  }
  returns.push({ line: start + 1, body: lines.slice(start, j + 1).join('\n') });
}

returns.length > 0
  ? ok(`${returns.length} return blocks parsed`)
  : no('return blocks parsed', 'found none — did the file change shape?');

// ── The invariant ──────────────────────────────────────────────────────────
const claiming = returns.filter((r) => /savedByWorkflow:\s*true/.test(r.body));
claiming.length > 0
  ? ok(`${claiming.length} of them claim savedByWorkflow: true`)
  : no('some return claims savedByWorkflow: true', 'none found — the flag may have been renamed');

/**
 * SILENCE IS ALLOWED IN EXACTLY ONE CASE: A HUMAN DELIBERATELY TOOK THE ITEM.
 *
 * The first draft of this check flagged every silent return and caught three
 * that are correct, which is worth recording because the distinction is the
 * whole point:
 *
 *   human_dispatch  routing sent the item to a person before the agent ever
 *                   ran. Nothing failed, no ack was promised, and an automated
 *                   "we're having trouble" would be a lie.
 *   hitl_rejected   the OWNER read the draft and declined to send it. Firing a
 *                   service apology here would overrule the human who just
 *                   made a decision, on their own customer.
 *
 * What separates those from the real bug is not the shape of the return - all
 * four called markNeedsAttentionActivity and all four set savedByWorkflow:true.
 * It is WHY. A human choosing to handle something is not the agent failing to.
 * So the rule keys on the error value, and anything not on this list that goes
 * silent is a defect until someone justifies it here by name.
 */
const HUMAN_HANDOFF_ERRORS = ['human_dispatch', 'hitl_rejected'];

const silent = claiming.filter((r) => {
  const m = /replyMessage:\s*([^,\n]+)/.exec(r.body);
  // No replyMessage at all, or one that can evaluate to undefined.
  const goesSilent = !m || /\bundefined\b/.test(m[1]);
  if (!goesSilent) return false;
  return !HUMAN_HANDOFF_ERRORS.some((e) => r.body.includes(`'${e}'`));
});

silent.length === 0
  ? ok('every silent return is a deliberate human handoff',
    `agent failures always speak; ${HUMAN_HANDOFF_ERRORS.join(' / ')} deliberately do not`)
  : no('every silent return is a deliberate human handoff',
    `line(s) ${silent.map((r) => r.line).join(', ')} set savedByWorkflow: true with a `
    + 'replyMessage that can be undefined, and the error is not a human handoff. The '
    + 'caller trusts that flag and will not save a reply either, so the customer gets '
    + 'nothing — after the interim ack has already promised them an answer. Save '
    + 'SERVICE_FALLBACK_REPLY on this path, reusing the idempotency key '
    + '`${businessKey}:save-service-fallback` so a workflow retry that takes the other '
    + `branch cannot apologise twice. If the path is genuinely a human handoff, add its `
    + 'error value to HUMAN_HANDOFF_ERRORS above with a line saying who picks it up.');

// ── Both failure paths must actually send the fallback ─────────────────────
//
// The invariant above is structural. This one is concrete: a throw and a
// returned failure are the same event to a customer, so both endings must
// reach for the same constant.
const fallbackSaves = (src.match(/save-service-fallback/g) || []).length;
fallbackSaves >= 2
  ? ok(`the service fallback is saved on ${fallbackSaves} paths`, 'thrown and returned failures both covered')
  : no('the service fallback is saved on both failure paths',
    `found ${fallbackSaves} — a child that THROWS and a child that RETURNS success:false `
    + 'are indistinguishable to the customer. Both need the fallback.');

const gapRecords = (src.match(/detectedVia:\s*'no_reply'/g) || []).length;
gapRecords >= 2
  ? ok(`the unanswered question is recorded as a knowledge gap on ${gapRecords} paths`)
  : no('the unanswered question is recorded on both failure paths',
    `found ${gapRecords} — without this an outage silently erases the questions it `
    + 'swallowed, and nobody learns what customers were asking.');

console.log(`\n  passed ${pass} / ${pass + failures.length}\n`);
if (failures.length) {
  console.log('FAILED:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('  PASS — no failure path leaves the customer with silence.\n');
