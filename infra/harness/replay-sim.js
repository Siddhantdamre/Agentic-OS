'use strict';
// Simulation of "Replay your week": does the grader catch the ways an AI reply goes wrong, without crying wolf?
//   node infra/harness/replay-sim.js            (needs `pnpm --filter @darex/workflows build` first)
// 1. Detection: 40 made-up customer messages, each with one right draft and one wrong draft (see replay/cases.js).
//    Prints how many wrong drafts of each kind are caught and how many right drafts are wrongly flagged.
// 2. Five stand-in "AI employees" (careful, hallucinating, over-promising, eager, English-only) replay the same 40
//    messages; prints the report an owner would read, and what each would be allowed to do alone.
// 3. How little history is too little.
// No model and no database: the drafts are written down, so only the grading is on trial.
const path = require('path');
const fs = require('fs');
const { gradeCase, summarize } = require(path.join(__dirname, '../../services/workflows/dist/replay/grade.js'));
// REPLAY_SETS=/path/to/file.js runs the same checks on another file shaped { SETS: [{ name, facts, cases }] }, for example
// cases written by someone who never saw the grader. Without it the built-in development set (replay/cases.js) is used.
function loadCases() {
  if (process.env.REPLAY_SETS) {
    const { SETS } = require(path.resolve(process.env.REPLAY_SETS));
    return SETS.flatMap((s) => s.cases.map((c) => ({ ...c, _facts: s.facts, _set: s.name })));
  }
  const { CASES, FACTS } = require('./replay/cases.js');
  return CASES.map((c) => ({ ...c, _facts: FACTS, _set: 'real estate (development set)' }));
}
const CASES = loadCases();

const asCase = (c, draft) => ({ id: c.id, customerText: c.c, ownerReply: c.o, draft, facts: c._facts });
const has = (r, code) => r.findings.some((f) => f.code === code);
const caught = (kind, r) => {
  if (kind === 'invented_number') return r.verdict === 'unsafe' && has(r, 'invented_number');
  if (kind === 'overpromise') return r.verdict === 'unsafe' && has(r, 'overpromise');
  if (kind === 'hand_off_missed') return has(r, 'hand_off_missed') || r.verdict === 'hand_off_missed';
  if (kind === 'wrong_language') return has(r, 'wrong_language');
  return r.verdict !== 'same' && r.verdict !== 'fine_different'; // wrong_fact: nothing in it for the rules to see
};
const pct = (a, b) => (b ? Math.round((100 * a) / b) + '%' : 'n/a');
const out = { detection: {}, falseAlarms: [], misses: [], behaviours: {} };
let failures = 0;

// ---- 1. detection -----------------------------------------------------------------------------------------------
console.log(`\n1. DETECTION: ${CASES.length} right drafts and ${CASES.length} wrong ones`);
const kinds = {};
for (const c of CASES) {
  const bad = gradeCase(asCase(c, c.bad));
  const k = (kinds[c.kind] = kinds[c.kind] || { n: 0, caught: 0 });
  k.n++;
  if (caught(c.kind, bad)) k.caught++;
  else out.misses.push({ id: c.id, kind: c.kind, draft: c.bad, got: bad.verdict, findings: bad.findings });
}
for (const [kind, k] of Object.entries(kinds)) {
  out.detection[kind] = k;
  const blind = kind === 'wrong_fact';
  console.log(`  ${kind.padEnd(16)} caught ${String(k.caught).padStart(2)} of ${String(k.n).padStart(2)}  ${pct(k.caught, k.n).padStart(5)}${blind ? '   (nothing for the rules to see: a known blind spot)' : ''}`);
  if (!blind && k.caught < k.n) failures++;
}
let falseAlarms = 0;
let traps = 0;
let trapsOk = 0;
for (const c of CASES) {
  const good = gradeCase(asCase(c, c.good));
  const flagged = good.findings.length > 0 || !['same', 'fine_different'].includes(good.verdict);
  if (c.trap) { traps++; if (!flagged) trapsOk++; }
  if (flagged) { falseAlarms++; out.falseAlarms.push({ id: c.id, draft: c.good, verdict: good.verdict, findings: good.findings }); }
}
console.log(`  right drafts wrongly flagged: ${falseAlarms} of ${CASES.length}   (look-alike traps passed: ${trapsOk} of ${traps})`);
if (falseAlarms) failures++;
for (const m of out.misses.filter((x) => x.kind !== 'wrong_fact')) console.log(`  MISSED  ${m.id} [${m.kind}] "${m.draft}" -> ${m.got}`);
for (const f of out.falseAlarms) console.log(`  FALSE ALARM  ${f.id} "${f.draft}" -> ${f.verdict} ${JSON.stringify(f.findings)}`);

// ---- 2. five stand-in AI employees ------------------------------------------------------------------------------
const BEHAVIOURS = {
  careful: () => false,
  hallucinating: (c) => c.kind === 'invented_number',
  'over-promising': (c) => c.kind === 'overpromise',
  eager: (c) => c.kind === 'hand_off_missed',
  'English-only': (c) => c.kind === 'wrong_language',
};
const TOPIC_NAME = { price: 'Prices', availability: 'Availability', viewing: 'Viewings', payment: 'Payments', complaint: 'Complaints', other: 'Everything else' };
const SAY = { ready: 'could answer alone', ask_first: 'keep asking you first', too_few: 'too few cases to say' };
console.log('\n2. FIVE STAND-IN AI EMPLOYEES replay the same messages');
for (const [name, goesWrong] of Object.entries(BEHAVIOURS)) {
  const results = CASES.map((c) => gradeCase(asCase(c, goesWrong(c) ? c.bad : c.good)));
  const s = summarize(results);
  out.behaviours[name] = s;
  console.log(`\n  ${name.toUpperCase()}: ${s.headline}`);
  console.log(`  overall: ${s.overall}`);
  for (const [t, ts] of Object.entries(s.topics)) {
    if (!ts.n) continue;
    console.log(`    ${TOPIC_NAME[t].padEnd(16)} ${String(ts.same + ts.fine).padStart(2)}/${ts.n}  ${SAY[ts.readiness]}`);
  }
}
// The careful one must come out ready, each flawed one must not be handed the topic it fails.
const careful = out.behaviours.careful;
if (careful.overall === 'not_yet' || careful.invented || careful.overpromised || careful.handOffMissed) failures++;
if (out.behaviours.hallucinating.topics.price.readiness === 'ready') failures++;
if (out.behaviours['over-promising'].invented === 0 && out.behaviours['over-promising'].overpromised === 0) failures++;

// ---- 3. how little is too little --------------------------------------------------------------------------------
console.log('\n3. HOW MUCH HISTORY IS ENOUGH');
for (const n of [5, 9, 10, 20, 40]) {
  const s = summarize(CASES.slice(0, n).map((c) => gradeCase(asCase(c, c.good))));
  console.log(`  ${String(n).padStart(2)} messages: ${s.overall.padEnd(12)} ${s.headline}`);
}
if (summarize(CASES.slice(0, 9).map((c) => gradeCase(asCase(c, c.good)))).overall !== 'too_few') failures++;

if (process.env.REPLAY_OUT) fs.writeFileSync(process.env.REPLAY_OUT, JSON.stringify(out, null, 1));
console.log(failures === 0 ? '\n==== replay simulation: every expectation met ====' : `\n==== replay simulation: ${failures} expectation(s) NOT met ====`);
process.exit(failures === 0 ? 0 : 1);
