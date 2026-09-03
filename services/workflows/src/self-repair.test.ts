import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFailure,
  triage,
  buildRepairPrompt,
  proposalIsUseful,
} from './self-repair.js';
import * as selfRepair from './self-repair.js';

// ── The safety rule ─────────────────────────────────────────────────────────
// It diagnoses and proposes. It never edits, commits, pushes or migrates. This
// is asserted rather than intended, because it is exactly the kind of boundary
// that erodes the first time somebody wants the loop to "just apply it".

test('the module exports nothing that can change anything', () => {
  const exported = Object.keys(selfRepair).sort();
  assert.deepEqual(exported, [
    'buildRepairPrompt',
    'classifyFailure',
    'proposalIsUseful',
    'triage',
  ]);
  for (const name of exported) {
    assert.ok(
      !/apply|write|commit|push|patch|migrat|exec|fix[A-Z]/i.test(name),
      `${name} sounds like it changes something`
    );
  }
});

test('the repair prompt forbids the one answer that would be worst', () => {
  // A patch that makes the check pass by removing the invariant it protects is
  // unreviewable by construction: the thing that would catch it is what was
  // changed.
  const p = buildRepairPrompt(
    { suite: 's', detail: 'd', kind: 'code', because: 'b', actionable: true },
    'header'
  );
  assert.match(p, /without restoring the invariant is the/i);
  assert.match(p, /INVARIANT/);
  assert.match(p, /CANNOT DIAGNOSE FROM THIS EVIDENCE/);
});

// ── Classification: the failures actually seen in this repo ─────────────────

test('the Windows quoting failure is the machine, not the code', () => {
  const f = classifyFailure(
    'check coverage',
    "'C:\\Program' is not recognized as an internal or external command"
  );
  assert.equal(f.kind, 'environment');
  assert.equal(f.actionable, true);
});

test('a package manager that cannot find itself is the machine', () => {
  const f = classifyFailure(
    'workflow unit tests',
    "Error: Cannot find module 'C:\\Users\\x\\node_modules\\npm\\bin\\node_modules\\npm\\bin\\npm-cli.js'"
  );
  assert.equal(f.kind, 'environment');
});

test('a refused connection is the machine even when it mentions a type', () => {
  // The expensive mistake in both directions is the same: sending someone to
  // read code when the stack is down.
  const f = classifyFailure('memory retrieval', 'TypeError: connect ECONNREFUSED 127.0.0.1:5432');
  assert.equal(f.kind, 'environment');
});

test('a missing credential is the machine, and named', () => {
  assert.equal(classifyFailure('x', 'web_search requires JINA_API_KEY').kind, 'environment');
  assert.equal(classifyFailure('x', 'GROQ_API_KEY is unset').kind, 'environment');
  assert.equal(classifyFailure('x', 'HTTP 401 AuthenticationRequiredError').kind, 'environment');
});

test('a provider failing is upstream, and NOT actionable', () => {
  const f = classifyFailure('shift', 'Upstream error from Nvidia: Service temporarily overloaded');
  assert.equal(f.kind, 'upstream');
  // Waking a person for another company's server is how an alarm stops being
  // believed. This was 18 real events in one measured run.
  assert.equal(f.actionable, false);
});

test('a type error is the code', () => {
  const f = classifyFailure('typecheck', "src/a.ts(12,3): error TS2554: Expected 3-4 arguments, but got 2.");
  assert.equal(f.kind, 'code');
});

test('a failed assertion is the code', () => {
  assert.equal(classifyFailure('unit', 'AssertionError: Expected values to be strictly equal').kind, 'code');
  assert.equal(classifyFailure('checker', '  [FAIL] tenant scope — unscoped query').kind, 'code');
});

test('a stale parser is the code, and it is the loud one', () => {
  const f = classifyFailure('web search', 'PARSER STALE: result markup present but nothing extracted');
  assert.equal(f.kind, 'code');
});

test('a verification gap is the code', () => {
  const f = classifyFailure('check coverage', 'check-foo.js is not in the gate');
  assert.equal(f.kind, 'code');
});

test('an unrecognised line is unknown, never quietly code', () => {
  // "unknown" and "code" must be different buckets. Calling an unrecognised
  // line a code defect sends an agent to investigate a phantom.
  const f = classifyFailure('mystery', 'the flux capacitor disagreed');
  assert.equal(f.kind, 'unknown');
  assert.equal(f.actionable, true);
  assert.match(f.because, /classify it before acting/);
});

test('the failure text is never paraphrased — it is the evidence', () => {
  const raw = "  [FAIL] something — with 'quotes' and \\backslashes\\  ";
  assert.equal(classifyFailure('s', raw).detail, raw);
});

// ── Triage: ordering, verdicts, and what may be repaired ───────────────────

test('code defects sort first, unknowns before environment noise', () => {
  const t = triage([
    { suite: 'a', detail: 'Upstream error from Nvidia' },
    { suite: 'b', detail: 'ECONNREFUSED' },
    { suite: 'c', detail: 'the flux capacitor disagreed' },
    { suite: 'd', detail: 'error TS2554: bad' },
  ]);
  assert.deepEqual(t.findings.map((f) => f.kind), ['code', 'unknown', 'environment', 'upstream']);
});

test('only code findings are offered for repair', () => {
  const t = triage([
    { suite: 'a', detail: 'ECONNREFUSED' },
    { suite: 'b', detail: 'the flux capacitor disagreed' },
    { suite: 'c', detail: 'AssertionError: nope' },
  ]);
  assert.equal(t.repairable.length, 1);
  assert.equal(t.repairable[0].suite, 'c');
});

test('environment-only failures say the product is fine', () => {
  const t = triage([
    { suite: 'a', detail: "'pnpm' is not recognized as an internal or external command" },
    { suite: 'b', detail: 'pnpm is not installed on this machine' },
  ]);
  assert.equal(t.counts.environment, 2);
  assert.equal(t.counts.code, 0);
  assert.match(t.verdict, /Nothing is wrong with the product/);
});

test('an unknown failure is never reported as clear', () => {
  const t = triage([{ suite: 'a', detail: 'the flux capacitor disagreed' }]);
  assert.match(t.verdict, /Not clear/);
});

test('upstream-only failures say retry, not fix', () => {
  const t = triage([{ suite: 'a', detail: 'Upstream error from Nvidia: overloaded' }]);
  assert.match(t.verdict, /nothing here to fix/i);
});

test('a code defect names the product, not the machine', () => {
  const t = triage([
    { suite: 'a', detail: 'error TS1005: bad' },
    { suite: 'b', detail: 'ECONNREFUSED' },
  ]);
  assert.match(t.verdict, /this is the product, not the machine/);
});

test('blank lines are dropped, not classified as unknown', () => {
  const t = triage([{ suite: 'a', detail: '   ' }, { suite: 'b', detail: '' }]);
  assert.equal(t.findings.length, 0);
  assert.match(t.verdict, /No failures/);
});

test('an empty gate triages to nothing at all', () => {
  const t = triage([]);
  assert.equal(t.findings.length, 0);
  assert.equal(t.repairable.length, 0);
});

// ── Proposal filtering ─────────────────────────────────────────────────────

test('a model admitting it cannot diagnose is not forwarded as a fix', () => {
  const r = proposalIsUseful('CANNOT DIAGNOSE FROM THIS EVIDENCE — need the failing input');
  assert.equal(r.useful, false);
  assert.match(r.reason, /insufficient/);
});

test('a proposal missing the invariant is rejected', () => {
  // A patch written without knowing what the check protects will satisfy the
  // assertion by deleting it.
  const r = proposalIsUseful('CAUSE: probably a typo. FIX: change the line.');
  assert.equal(r.useful, false);
});

test('a proposal naming both an invariant and a fix is forwarded', () => {
  const r = proposalIsUseful(
    '1. INVARIANT — search must work with no credential.\n'
    + '2. CAUSE — the parser class name changed.\n'
    + '3. FIX — update parseDuckDuckGoLite in tools/search-providers.ts.\n'
    + '4. CONFIDENCE — high.'
  );
  assert.equal(r.useful, true);
});

test('an empty proposal is never forwarded', () => {
  assert.equal(proposalIsUseful('').useful, false);
  assert.equal(proposalIsUseful('   ').useful, false);
});
