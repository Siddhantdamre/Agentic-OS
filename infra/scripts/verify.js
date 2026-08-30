#!/usr/bin/env node
'use strict';
/**
 * VERIFY — everything that can be proven without spending a cent.
 *
 * One command, one verdict, no LLM tokens. Written because the OpenRouter
 * balance reached zero and the honest answer to "is the system sound?" became
 * "I can't check" — when in fact almost all of it can be checked: tenant
 * isolation, retrieval, the reply gates, the learning loop, the webhook path,
 * the infrastructure probes. Only the parts that literally require a model to
 * answer need credit, and those are named at the end rather than skipped in
 * silence.
 *
 * This is also the script to hand a company that wants to validate the
 * deployment themselves. It reads its own results out loud and returns
 * non-zero if anything is wrong.
 *
 * Usage:
 *   node infra/scripts/verify.js            everything below
 *   node infra/scripts/verify.js --fast     skip the suites that need Docker
 *
 * Exit: 0 = everything checked passed, 1 = something failed.
 */
const { spawnSync } = require('child_process');
const path = require('path');

// Deliberately does NOT load infra/.env. This is a runner, and every suite
// below already resolves its own environment exactly as it does when run by
// hand. Injecting credentials here changed what the children saw and broke two
// suites that pass on their own: the connector-honesty unit tests assert
// "never configured" and started seeing real keys, and check-retrieve-memory
// connects as `darex` but inherited the app role's DB_PASSWORD. A verifier
// that alters the thing it verifies is worse than no verifier.

const ROOT = path.join(__dirname, '..', '..');
const FAST = process.argv.includes('--fast');

/**
 * needsDocker: the suite talks to Postgres/Temporal/LiteLLM containers.
 * A pure-logic suite runs anywhere, which is what --fast keeps.
 */
const SUITES = [
  {
    name: 'workflow unit tests',
    what: 'reply gates, grounding, claim extraction, tenant helpers',
    cmd: ['npm', ['test', '--silent'], { cwd: path.join(ROOT, 'services', 'workflows') }],
    needsDocker: false,
  },
  {
    name: 'env loader',
    what: 'duplicate and empty-placeholder credentials resolve like compose',
    cmd: [process.execPath, [path.join(__dirname, 'lib', 'env.js'), '--self-test']],
    needsDocker: false,
  },
  {
    name: 'spend guard maths',
    what: 'burn rate refuses to extrapolate from too little history',
    cmd: [process.execPath, [path.join(__dirname, 'spend-guard.js'), '--self-test']],
    needsDocker: false,
  },
  {
    name: 'sql parameter lint',
    what: 'every $N has exactly one argument — the bug that silently emptied retrieval',
    cmd: [process.execPath, [path.join(__dirname, 'lint-sql-params.js')]],
    needsDocker: false,
  },
  {
    name: 'pre-push gate',
    what: 'the check that refuses to push code which cannot load',
    cmd: [process.execPath, [path.join(__dirname, 'pre-push-check.js'), '--self-test']],
    needsDocker: false,
  },
  {
    name: 'environment probe',
    what: 'the runner can tell a dead machine from broken code',
    cmd: [process.execPath, [path.join(__dirname, 'lib', 'env-reachable.js'), '--self-test']],
    needsDocker: false,
  },
  {
    name: 'executable bit lint',
    what: 'the scripts the install guide tells people to run can actually be run',
    cmd: [process.execPath, [path.join(__dirname, 'lint-exec-bit.js')]],
    needsDocker: false,
  },
  {
    name: 'one door (llm gateway)',
    what: 'no paid model call can bypass the budget and the attribution',
    cmd: [process.execPath, [path.join(__dirname, 'lint-llm-gateway.js')]],
    needsDocker: false,
  },
  {
    name: 'startup coupling',
    what: 'no auxiliary service can block the product from starting or being rolled back',
    cmd: [process.execPath, [path.join(__dirname, 'lint-startup-coupling.js')]],
    needsDocker: false,
  },
  {
    name: 'production port bindings',
    what: 'the prod overlay replaces the kernel ports instead of appending to them',
    cmd: [process.execPath, [path.join(__dirname, 'lint-compose-ports.js')]],
    needsDocker: true,
  },
  {
    name: 'conversation identity lint',
    what: 'no conversation is created without resolving who it is with',
    cmd: [process.execPath, [path.join(__dirname, 'lint-conversation-person.js')]],
    needsDocker: false,
  },
  {
    name: 'tenant scope lint',
    what: 'no tenant table is read without an org filter or a written-down reason',
    cmd: [process.execPath, [path.join(__dirname, 'lint-tenant-scope.js')]],
    needsDocker: false,
  },
  {
    name: 'quality rules',
    what: 'the reply scorer agrees with hand-labelled examples',
    cmd: [process.execPath, [path.join(__dirname, 'quality-rules.js'), '--self-test']],
    needsDocker: false,
  },
  {
    name: 'tenant registry isolation',
    what: 'one tenant cannot see, name or write another — and signup still works',
    cmd: [process.execPath, [path.join(__dirname, 'check-orgs-rls.js')]],
    needsDocker: true,
  },
  {
    name: 'memory retrieval',
    what: 'two orgs retrieve their own facts and nothing of each other\'s',
    cmd: [process.execPath, [path.join(__dirname, 'check-retrieve-memory.js')]],
    needsDocker: true,
  },
  {
    name: 'operator edit learning',
    what: 'a correction outranks the document it corrects; a refusal is never learned',
    cmd: [process.execPath, [path.join(__dirname, 'check-edit-learning.js')]],
    needsDocker: true,
  },
  {
    name: 'learning loop end-to-end',
    what: 'a correction sent through the real HTTP route becomes retrievable knowledge',
    cmd: [process.execPath, [path.join(__dirname, 'check-learning-e2e.js')]],
    needsDocker: true,
  },
  {
    name: 'trigger scheduling maths',
    what: 'when something fires — the part that fails quietly',
    cmd: [process.execPath, [path.join(__dirname, 'trigger-engine.js'), '--self-test']],
    needsDocker: false,
  },
  {
    name: 'trigger engine safety',
    what: 'nothing fires unopted, nothing fires twice, a bad query cannot flood customers',
    cmd: [process.execPath, [path.join(__dirname, 'check-trigger-engine.js')]],
    needsDocker: true,
  },
  {
    name: 'digest gating',
    what: 'preview is the default and only owners or admins are recipients',
    cmd: [process.execPath, [path.join(__dirname, 'weekly-digest.js'), '--self-test']],
    needsDocker: false,
  },
  {
    name: 'weekly digest',
    what: 'the right business gets its own numbers, and a quiet week sends nothing',
    cmd: [process.execPath, [path.join(__dirname, 'check-digest.js')]],
    needsDocker: true,
  },
  {
    name: 'commitment ledger',
    what: 'a promise survives the end of the turn, and cannot keep itself',
    cmd: [process.execPath, [path.join(__dirname, 'check-commitments.js')]],
    needsDocker: true,
  },
  {
    name: 'shadow mode',
    what: 'the agreement number cannot flatter — and never claims accuracy',
    cmd: [process.execPath, [path.join(__dirname, 'check-shadow-mode.js')]],
    needsDocker: true,
  },
  {
    name: 'earned autonomy',
    what: 'the agent can be answered, earns trust slowly, and money never stops asking',
    cmd: [process.execPath, [path.join(__dirname, 'check-approvals.js')]],
    needsDocker: true,
  },
  {
    name: 'budget maths',
    what: 'a bad read never becomes a ceiling of zero, and an absent limit never throttles',
    cmd: [process.execPath, [path.join(__dirname, 'rollup-llm-usage.js'), '--self-test']],
    needsDocker: false,
  },
  {
    name: 'per-tenant budget',
    what: 'the meter cannot be inflated, cannot leak, and the cap never causes silence',
    cmd: [process.execPath, [path.join(__dirname, 'check-llm-budget.js')]],
    needsDocker: true,
  },
  {
    name: 'budget gate wired',
    what: 'an over-budget workspace still answers, on the free tier, still attributed',
    cmd: [process.execPath, [path.join(__dirname, 'check-budget-e2e.js')]],
    needsDocker: true,
  },
  {
    name: 'identity and erasure by person',
    what: 'one human across every spelling, and erasing them reaches all of it',
    cmd: [process.execPath, [path.join(__dirname, 'check-identity.js')]],
    needsDocker: true,
  },
  {
    name: 'retention and erasure',
    what: 'a person asking to be forgotten is, including what the agent learned about them',
    cmd: [process.execPath, [path.join(__dirname, 'check-erasure.js')]],
    needsDocker: true,
  },
  {
    name: 'real hands',
    what: 'each role can do its own job and not another’s, and no default role holds money',
    cmd: [process.execPath, [path.join(__dirname, 'check-tool-capability.js')]],
    needsDocker: true,
  },
  {
    name: 'task supervision (the trio)',
    what: 'every task reports what the doer, the monitor and the learner did',
    cmd: [process.execPath, [path.join(__dirname, 'check-supervision.js')]],
    needsDocker: true,
  },
  {
    name: 'quiet leads',
    what: 'the agent acts first — and leaves alone the six it must never contact',
    cmd: [process.execPath, [path.join(__dirname, 'check-quiet-leads.js')]],
    needsDocker: true,
  },
  {
    name: 'leak report reachable',
    what: 'an owner can see the follow-up agent, and who it refused to contact',
    cmd: [process.execPath, [path.join(__dirname, 'check-leaks-panel.js')]],
    needsDocker: true,
  },
  {
    name: 'money metrics',
    what: 'revenue is traceable, split by who handled it, and currencies are never added',
    cmd: [process.execPath, [path.join(__dirname, 'check-money-metrics.js')]],
    needsDocker: true,
  },
  {
    name: 'impact / outcome ledger',
    what: 'the renewal number is arithmetic, not a feeling — and it never counts an escalation as a win',
    cmd: [process.execPath, [path.join(__dirname, 'check-impact-e2e.js')]],
    needsDocker: true,
  },
  {
    name: 'inbound end-to-end',
    what: 'signed webhook to stored conversation, and unsigned is rejected',
    cmd: [process.execPath, [path.join(__dirname, 'check-e2e-inbound.js')]],
    needsDocker: true,
  },
  {
    name: 'dormant capability',
    what: 'every shipped feature has actually produced a row — the check that '
      + 'catches complete-but-unreachable',
    cmd: [process.execPath, [path.join(__dirname, 'check-dormant-capability.js')]],
    needsDocker: true,
  },
  // ── CI PARITY ───────────────────────────────────────────────────────────
  // These three are what GitHub Actions runs. They were NOT here, so CI went
  // red on four consecutive pushes while this suite reported 36/37 green: the
  // isolation test had been asserting a raw `INSERT INTO orgs`, which
  // migration 028 deliberately made impossible. Nothing local ever ran it.
  //
  // A verification suite that does not run what the gate runs is not a
  // verification suite; it is a second opinion nobody asked for.
  {
    name: 'typecheck (all workspaces)',
    what: 'what CI typechecks — shared-types, connectors, workflows, dashboard',
    cmd: ['pnpm', ['-s', 'run', 'typecheck:ci'], { cwd: ROOT }],
    needsDocker: false,
  },
  {
    name: 'lint',
    what: 'what CI lints',
    cmd: ['pnpm', ['-s', 'lint'], { cwd: ROOT }],
    needsDocker: false,
  },
  {
    name: 'tenant isolation (CI parity)',
    what: 'the suite CI runs against a fresh database, as darex_app',
    cmd: [process.execPath, [path.join(ROOT, 'tests', 'e2e-tenant-isolation.test.js')]],
    needsDocker: true,
  },
  {
    name: 'infrastructure alarms',
    what: 'queue lag, connector auth, RLS job, Langfuse ingest, LLM budget',
    cmd: [process.execPath, [path.join(__dirname, 'alerting-run.js')]],
    needsDocker: true,
    // The budget probe fails on an empty wallet, which is a true alert about
    // the account rather than a defect in the build. Reported, not counted.
    advisory: true,
  },
];

const results = [];
console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║  DAREX VERIFY — what can be proven without spending money    ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

// ── Is the machine even up? ─────────────────────────────────────
// Checked BEFORE anything is judged. Spawned as a child rather than awaited
// inline, because a top-level await turns this CommonJS file into an ES
// module and every require() above stops working -- and `node --check` does
// not catch it. Exit 2 means 'I could not check', which is a different fact
// from 'something failed'. See lib/env-reachable.js for what that cost.
if (!FAST && SUITES.some((s) => s.needsDocker)) {
  const probe = spawnSync(process.execPath,
    [path.join(__dirname, 'lib', 'env-reachable.js'), '--check'],
    { encoding: 'utf8', env: process.env });
  if (probe.status !== 0) {
    console.log(`\n  ENVIRONMENT UNAVAILABLE — ${String(probe.stdout || '').trim()}\n`);
    console.log('  NOTHING WAS VERIFIED. This is not a code failure: the suites below');
    console.log('  never ran. Bring the stack up and run this again.\n');
    console.log('    docker compose -f infra/docker-compose.yml up -d\n');
    process.exit(2);
  }
}

for (const suite of SUITES) {
  if (FAST && suite.needsDocker) {
    console.log(`  [ skip ]  ${suite.name}  — needs the containers (--fast)`);
    results.push({ ...suite, skipped: true });
    continue;
  }
  process.stdout.write(`  running   ${suite.name} ...`);
  const [bin, args, opts] = suite.cmd;
  const r = spawnSync(bin, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: process.env,
    ...(opts || {}),
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const passed = r.status === 0;

  // Pull the suite's own count out of its output rather than inventing one, so
  // the summary can never claim more than a suite actually ran. Each pattern
  // is anchored to one script's real output format — a loose regex here
  // reported "7 passed, 7 failed" for a suite that passed 7 of 7.
  const detail = (() => {
    let m = /passed (\d+) \/ (\d+)/.exec(out);              // check-*.js, self-tests
    if (m) return `${m[1]}/${m[2]}`;
    m = /ALL CHECKS PASSED \((\d+)\/(\d+)\)/.exec(out);      // e2e scripts, all green
    if (m) return `${m[1]}/${m[2]}`;
    m = /(\d+)\/(\d+) CHECKS FAILED/.exec(out);              // e2e scripts, some red
    if (m) return `${Number(m[2]) - Number(m[1])}/${m[2]}`;
    m = /self-test: (\d+) passed, (\d+) failed/.exec(out);   // quality-rules
    if (m) return `${m[1]}/${Number(m[1]) + Number(m[2])}`;
    const p = /^\D*pass (\d+)$/m.exec(out);                  // node:test summary
    const f = /^\D*fail (\d+)$/m.exec(out);
    if (p && f) return `${p[1]}/${Number(p[1]) + Number(f[1])}`;
    return '';
  })();

  console.log(`\r  [${passed ? ' PASS ' : ' FAIL '}]  ${suite.name}${detail ? `  — ${detail}` : ''}      `);
  console.log(`            ${suite.what}`);
  results.push({ ...suite, passed, out });
}

// ── Verdict ────────────────────────────────────────────────────────────────
const ran = results.filter((r) => !r.skipped);
const hardFailures = ran.filter((r) => !r.passed && !r.advisory);
const advisoryFailures = ran.filter((r) => !r.passed && r.advisory);

console.log('\n' + '─'.repeat(64));

if (advisoryFailures.length) {
  console.log('\n  ADVISORY');
  for (const a of advisoryFailures) {
    // Surface the actual failing lines — an advisory that hides its reason is
    // just a warning nobody reads.
    const lines = String(a.out).split('\n').filter((l) => /\[(FAIL|CRITICAL)/.test(l));
    console.log(`\n    ${a.name}:`);
    for (const l of lines.slice(0, 4)) console.log(`      ${l.trim()}`);
  }
}

for (const f of hardFailures) {
  console.log(`\n  FAILED — ${f.name}\n`);
  // Case-INSENSITIVE, and with a fallback. The original pattern was /Error/,
  // which does not match "ERROR:" -- the exact prefix every check-*.js uses
  // for a fatal error. So a suite that died on "ERROR: connect ECONNREFUSED"
  // printed its heading and not one line of reason, and the failure looked
  // like an unexplained flake. A reporter that can print nothing is worse
  // than no reporter, because it is trusted.
  let lines = String(f.out).split('\n').filter((l) => /\[FAIL\]|not ok|error/i.test(l));
  if (!lines.length) {
    lines = String(f.out).split('\n').filter((l) => l.trim()).slice(-8);
    console.log('    (no recognised failure line - last output follows)');
  }
  for (const l of lines.slice(0, 12)) console.log(`    ${l.trim()}`);
}

console.log('\n  NOT CHECKED HERE — these need live model calls, and therefore credit:');
console.log('    • answer quality on real questions   node infra/scripts/completion-suite.js');
console.log('    • multi-turn conversations           node infra/scripts/multiturn-suite.js');
console.log('    • reliability over repeated runs     node infra/scripts/reliability-completion.js');
console.log('    • latency under load                 node infra/scripts/latency-probe.js');

const skipped = results.filter((r) => r.skipped).length;
console.log('\n' + '─'.repeat(64));
if (hardFailures.length) {
  console.log(`\n  NOT SOUND — ${hardFailures.length} of ${ran.length} suites failed.\n`);
  process.exit(1);
}
// Count only what actually passed. Reporting all nine as "passed" alongside
// "1 advisory" credited a suite that failed.
const passedCount = ran.filter((r) => r.passed).length;
console.log(`\n  SOUND — ${passedCount} of ${ran.length} suites passed`
  + `${advisoryFailures.length ? `, ${advisoryFailures.length} advisory (see above)` : ''}`
  + `${skipped ? `, ${skipped} skipped` : ''}.\n`);
process.exit(0);
