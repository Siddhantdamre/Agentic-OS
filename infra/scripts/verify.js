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
 * Is pnpm on PATH?
 *
 * Two suites here run exactly what CI runs, and CI runs it through pnpm. When
 * pnpm is not installed both reported `'pnpm' is not recognized` and the gate
 * announced "NOT SOUND", accusing the code of a failure that belonged to the
 * machine.
 *
 * Routing around it does not work and was tried: `typecheck:ci` invokes
 * `pnpm --filter` internally for each workspace, and turbo shells out to the
 * package manager itself ("Unable to find package manager binary"). Driving the
 * outer command through corepack leaves every nested call still broken, so the
 * only honest options are "pnpm is here" or "pnpm is not here".
 *
 * Checked once, at startup, so the answer is one clear line with the fix rather
 * than the same cryptic cmd.exe message twice.
 */
const PNPM_AVAILABLE = spawnSync('pnpm', ['--version'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
}).status === 0;

const PNPM_MISSING_WHY =
  'pnpm is not installed on this machine. Install it and re-run: '
  + '`corepack enable pnpm` (ships with node), or `npm i -g pnpm`. '
  + 'Nothing about the code is implicated.';

function pnpmCmd(args, cwd) {
  return ['pnpm', args, { cwd }];
}

/**
 * needsDocker: the suite talks to Postgres/Temporal/LiteLLM containers.
 * A pure-logic suite runs anywhere, which is what --fast keeps.
 */
const SUITES = [
  {
    name: 'workflow unit tests',
    what: 'reply gates, grounding, claim extraction, tenant helpers',
    // Runs the test runner directly rather than through `npm test`.
    //
    // `npm test` here maps to exactly this command, so the package manager was
    // a hop that added nothing and could fail on its own. It did: npm's
    // launcher on this machine resolves a doubled path and dies with
    // "Cannot find module .../npm/bin/node_modules/npm/bin/npm-cli.js", so the
    // unit tests were reported as a product failure when they had never
    // started. One fewer moving part, and it is faster.
    cmd: [process.execPath, ['--test', 'dist/**/*.test.js'],
      { cwd: path.join(ROOT, 'services', 'workflows') }],
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
    name: 'teach a fact',
    what: 'a person can tell it something without producing a file, and what they '
      + 'say outranks a document that contradicts it',
    cmd: [process.execPath, [path.join(__dirname, 'check-teach-fact.js')]],
    needsDocker: true,
  },
  {
    name: 'satisfaction signal',
    what: 'the agent is judged on evidence, and silence is never counted as success',
    cmd: [process.execPath, [path.join(__dirname, 'check-satisfaction.js')]],
    needsDocker: true,
  },
  {
    name: 'shadow mode is load-bearing',
    what: 'the switch that promises nothing is sent actually governs the send',
    cmd: [process.execPath, [path.join(__dirname, 'lint-shadow-mode.js')]],
    needsDocker: false,
  },
  {
    name: 'supervision coverage',
    what: 'no path can finish a task without the trio reporting — checked '
      + 'structurally, because the runtime check only catches this once traffic exists',
    cmd: [process.execPath, [path.join(__dirname, 'lint-supervision-coverage.js')]],
    needsDocker: false,
  },
  {
    name: 'config drift',
    what: 'what is running matches what is declared — a stale root .env made every compose command declare an empty model key',
    cmd: [process.execPath, [path.join(__dirname, 'check-config-drift.js')]],
    needsDocker: true,
  },
  {
    name: 'outcome ledger',
    what: 'an outcome is arithmetic over recorded actions, never a feeling',
    cmd: [process.execPath, [path.join(__dirname, 'check-outcome-ledger.js')]],
    needsDocker: true,
  },
  {
    name: 'agent reply end-to-end',
    what: 'a message through the real agent path comes back answered and attributed',
    cmd: [process.execPath, [path.join(__dirname, 'check-e2e-agent-reply.js')]],
    needsDocker: true,
  },
  {
    name: 'reply gate live',
    what: 'the gate that strips mechanism talk and refuses disclosure, against the running stack',
    cmd: [process.execPath, [path.join(__dirname, 'check-reply-gate-live.js')]],
    needsDocker: true,
  },
  {
    name: 'connector auth honesty',
    what: 'a never-configured connector reports notConnected instead of guessing',
    cmd: [process.execPath, [path.join(__dirname, 'check-auth-nango.js')]],
    needsDocker: true,
  },
  {
    name: 'memory phase 6',
    what: 'retrieval returns only the facts belonging to this tenant',
    cmd: [process.execPath, [path.join(__dirname, 'check-phase6-memory.js')]],
    needsDocker: true,
  },
  {
    name: 'document upload',
    what: 'a real file becomes retrievable knowledge for its own org only',
    cmd: [process.execPath, [path.join(__dirname, 'check-upload-e2e.js')]],
    needsDocker: true,
  },
  {
    name: 'upload formats',
    what: 'each accepted file type parses, and an unsupported one is refused honestly',
    cmd: [process.execPath, [path.join(__dirname, 'check-upload-formats.js')]],
    needsDocker: true,
  },
  {
    name: 'two-replica SSE',
    what: 'two dashboard replicas both receive one publish — the Redis contract a scaled deploy needs',
    cmd: [process.execPath, [path.join(__dirname, 'check-two-replica-sse.js')]],
    needsDocker: true,
  },
  {
    name: 'realtime bus',
    what: 'the publisher can reach the subscriber — only the dashboard had '
      + 'REDIS_URL, so every event the worker emitted was silently dropped',
    cmd: [process.execPath, [path.join(__dirname, 'check-realtime-bus.js')]],
    needsDocker: false,
  },
  {
    name: 'web search',
    what: 'an agent can find a page with no credential — search was one call to '
      + 's.jina.ai, copied into three files, and that key was never set here',
    cmd: [process.execPath, [path.join(__dirname, 'check-web-search.js')]],
    needsDocker: true,
  },
  {
    name: 'duty visibility',
    what: 'work an employee did reaches that employee page — eighteen duty runs '
      + 'were logged and none reached the ledger',
    cmd: [process.execPath, [path.join(__dirname, 'check-duty-visible.js')]],
    needsDocker: true,
  },
  {
    name: 'connector wiring',
    what: 'catalogue, broker and compose agree — Gmail looked for a key Nango '
      + 'had registered under a different name, and the browser was never '
      + 'passed the public key its OAuth popup needs',
    cmd: [process.execPath, [path.join(__dirname, 'check-connector-wiring.js')]],
    needsDocker: true,
  },
  {
    name: 'router credentials',
    what: 'the container gets the keys the router asks for — two tiers of the '
      + 'failover chain were never passed their credentials, so supplying them '
      + 'changed nothing and the chain ended in a 401',
    cmd: [process.execPath, [path.join(__dirname, 'check-router-credentials.js')]],
    needsDocker: false,
  },
  {
    name: 'migrations applied',
    what: 'the ledger matches the files — 044 and 045 were applied by hand and '
      + 'never recorded, so the record a deploy reads said they had never run',
    cmd: [process.execPath, [path.join(__dirname, 'check-migrations-applied.js')]],
    needsDocker: true,
  },
  {
    name: 'duty allowlist enforced',
    what: 'a duty is confined to the tool it was granted — the allowlist was '
      + 'computed, asserted, and then discarded at the process boundary, so a '
      + 'duty granted one tool reached three',
    cmd: [process.execPath, [path.join(__dirname, 'check-duty-allowlist.js')]],
    needsDocker: true,
  },
  {
    name: 'duty coverage',
    what: 'every role this product can create has a job it does unprompted — '
      + 'three of the five roles a new workspace is seeded with matched no duty '
      + 'at all, because packs and the dashboard speak different vocabularies',
    cmd: [process.execPath, [path.join(__dirname, 'check-duty-coverage.js')]],
    needsDocker: false,
  },
  {
    name: 'tool declarations',
    what: 'the agent is told about nothing it cannot actually call — tool and '
      + 'action are plain strings, so a wrong one typechecks and fails only in '
      + 'front of a customer',
    cmd: [process.execPath, [path.join(__dirname, 'check-tool-declarations.js')]],
    needsDocker: false,
  },
  {
    name: 'bug triage',
    what: 'a red gate is read correctly — a missing tool is never reported as a '
      + 'code defect, and an unrecognised failure is never reported as clear. '
      + 'Only --self-test runs here: the full script invokes this gate.',
    cmd: [process.execPath, [path.join(__dirname, 'self-repair.js'), '--self-test']],
    needsDocker: false,
  },
  {
    name: 'check coverage',
    what: 'every checker is in this list or carries a written reason it is not — '
      + 'three real defects hid behind checks nobody was running',
    cmd: [process.execPath, [path.join(__dirname, 'lint-check-coverage.js')]],
    needsDocker: false,
  },
  {
    name: 'model fallbacks',
    what: 'no model group is a dead end, and a zero-cost tier never fails over '
      + 'onto a paid one — the gap that made four agents run their tools and report nothing',
    cmd: [process.execPath, [path.join(__dirname, 'check-model-fallbacks.js')]],
    needsDocker: false,
  },
  {
    name: 'inbound routing',
    what: 'a message reaches an employee that can work the channel it arrived on '
      + '— a roster of specialists is decorative if one arbitrary employee gets everything',
    cmd: [process.execPath, [path.join(__dirname, 'check-inbound-routing.js')]],
    needsDocker: true,
  },
  {
    // Was not in this list, and went red unnoticed the first time the Ask AI
    // console was used — verify reported SOUND while the demo everyone is told
    // to run was failing. A check nothing runs is not a check.
    name: 'an AI employee at work',
    what: 'an employee does real work through the production path, is refused a '
      + 'payout it does not hold, waits for a person on a customer email — and '
      + 'no recorded action names nobody',
    cmd: [process.execPath, [path.join(__dirname, 'demo-ai-employee.js')]],
    needsDocker: true,
  },
  {
    name: 'no silent answers',
    what: 'a reply either says something or says it failed — a blank bubble under '
      + 'the agent\'s name is the one failure mode that misleads',
    cmd: [process.execPath, [path.join(__dirname, 'check-no-empty-answers.js')]],
    needsDocker: true,
  },
  {
    name: 'gap dedupe',
    what: 'one unanswered question is one row — /brain headlines a count, and a '
      + 'duplicate inflates the number an operator is asked to act on',
    cmd: [process.execPath, [path.join(__dirname, 'check-gap-dedupe.js')]],
    needsDocker: true,
  },
  {
    name: 'nango browser host',
    what: 'the OAuth popup opens on an address the browser can resolve — this '
      + 'fails silently, and only at the moment someone first connects for real',
    cmd: [process.execPath, [path.join(__dirname, 'check-nango-browser-host.js')]],
    needsDocker: false,
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
    needsPnpm: true,
    what: 'what CI typechecks — shared-types, connectors, workflows, dashboard',
    cmd: pnpmCmd(['-s', 'run', 'typecheck:ci'], ROOT),
    needsDocker: false,
  },
  {
    name: 'lint',
    needsPnpm: true,
    what: 'what CI lints',
    cmd: pnpmCmd(['-s', 'lint'], ROOT),
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
    // stderr as well as stdout. This probe exists to tell a dead machine apart
    // from broken code; when the probe ITSELF fails it writes to stderr, and
    // printing only stdout produced `ENVIRONMENT UNAVAILABLE — ` with no reason
    // at all — the exact ambiguity the whole mechanism was built to remove.
    const why = [probe.stdout, probe.stderr]
      .map((x) => String(x || '').trim()).filter(Boolean).join(' | ')
      || `the probe exited ${probe.status} without saying why`;
    console.log(`\n  ENVIRONMENT UNAVAILABLE — ${why}\n`);
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
  if (suite.needsPnpm && !PNPM_AVAILABLE) {
    console.log(`  [ ????? ]  ${suite.name}  — COULD NOT RUN`);
    console.log(`            ${PNPM_MISSING_WHY}`);
    results.push({ ...suite, passed: false, couldNotRun: true, out: '', why: PNPM_MISSING_WHY });
    continue;
  }
  process.stdout.write(`  running   ${suite.name} ...`);
  const [bin, args, opts] = suite.cmd;
  const r = spawnSync(bin, args, {
    encoding: 'utf8',
    // Shell ONLY for a bare command name that needs PATH resolution — on
    // Windows `npm` and `pnpm` are .cmd files and cannot be executed directly.
    //
    // It must NOT be used for an absolute path. With shell:true, Node joins the
    // binary and its arguments into a single string for cmd.exe with no
    // quoting, so node's default Windows install location — the "Program Files"
    // path, which contains a space — arrives as the command "C:/Program" and
    // cmd.exe answers "is not recognized as an internal or external command".
    //
    // Every suite in this file is launched with process.execPath. So on any
    // Windows machine with node installed in its default location THE ENTIRE
    // GATE FAILED: 23 of 23 suites, not one of them for a code reason, all of
    // them passing when run by hand. The verdict it printed was
    // "NOT SOUND — 23 of 23 suites failed".
    shell: process.platform === 'win32' && !path.isAbsolute(bin),
    env: process.env,
    ...(opts || {}),
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const passed = r.status === 0;

  /**
   * Did this suite fail, or did it never run?
   *
   * Different findings needing opposite responses — fix the code versus fix the
   * machine — and reporting them identically is how the quoting bug above
   * survived. A broken toolchain presented as a broken product, in the loudest
   * possible terms, on every single suite.
   */
  const couldNotRun = !passed && (
    Boolean(r.error)
    || /is not recognized as an internal or external command/i.test(out)
    || /command not found/i.test(out)
    || /ENOENT/.test(String(r.error && r.error.code))
    // A package manager whose own launcher cannot find itself. Measured here:
    // "Cannot find module '...\npm\bin\node_modules\npm\bin\npm-cli.js'" — a
    // doubled path segment, from a machine with two node installations. The
    // suite never started, so it must never be reported as a code failure.
    || /Cannot find module '[^']*[\\/](?:npm|pnpm|yarn)[\\/]/i.test(out)
    // Exit 3 is a suite saying "the model tier ran out of capacity, not the
    // code". Measured: check-e2e-agent-reply passes in 59s on its own, and
    // times out at 180s inside the full gate because sixty other suites are
    // drawing on the same free tier — which answers a twenty-token request in
    // 28-38s, against 2s on the paid tier. Insufficient capacity is a
    // credential problem, and calling the product unsound for it is the same
    // conflation as blaming the code for a missing PATH entry.
    || r.status === 3
  );
  if (couldNotRun) {
    const why = r.error
      ? r.error.message
      : r.status === 3
        // The suite already explained itself; quote its own line rather than
        // the first line of its output, which is a banner.
        ? (out.split('\n').map((l) => l.trim())
            .find((l) => /BLOCKED ON MODEL CAPACITY|this is LATENCY/.test(l))
            || 'blocked on model capacity')
        : (out.split('\n').map((l) => l.trim()).find(Boolean) || `exit ${r.status}`);
    console.log(`\r  [ ????? ]  ${suite.name}  — COULD NOT RUN      `);
    console.log(`            ${why.slice(0, 140)}`);
    results.push({ ...suite, passed: false, couldNotRun: true, out, why });
    continue;
  }

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
/**
 * A suite that never ran is not a suite that failed.
 *
 * Kept out of `hardFailures` so the verdict cannot say the product is unsound
 * because a tool is missing from someone's PATH. It is still reported, still
 * exits non-zero, and is still nobody's excuse — but it names the machine, not
 * the code. Conflating the two printed "NOT SOUND — 23 of 23 suites failed" for
 * a repo in which every one of those suites passed when run by hand.
 */
const blocked = ran.filter((r) => r.couldNotRun);
const hardFailures = ran.filter((r) => !r.passed && !r.advisory && !r.couldNotRun);
const advisoryFailures = ran.filter((r) => !r.passed && r.advisory && !r.couldNotRun);

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

if (blocked.length) {
  console.log('\n  COULD NOT RUN — this is the machine, not the code. Each of these');
  console.log('  passes when its command is available:\n');
  for (const b of blocked) {
    console.log(`    ${b.name}`);
    console.log(`      ${String(b.why).slice(0, 120)}`);
  }
}

const skipped = results.filter((r) => r.skipped).length;
console.log('\n' + '─'.repeat(64));
if (hardFailures.length) {
  console.log(`\n  NOT SOUND — ${hardFailures.length} of ${ran.length} suites failed.\n`);
  process.exit(1);
}
if (blocked.length) {
  // Non-zero, because an unrun suite proves nothing. But the wording must not
  // accuse the code of a failure that belongs to the toolchain.
  console.log(`\n  INCOMPLETE — ${ran.length - blocked.length} of ${ran.length} suites passed;`
    + ` ${blocked.length} could not run (see above). Nothing failed.\n`);
  process.exit(1);
}
// Count only what actually passed. Reporting all nine as "passed" alongside
// "1 advisory" credited a suite that failed.
const passedCount = ran.filter((r) => r.passed).length;
console.log(`\n  SOUND — ${passedCount} of ${ran.length} suites passed`
  + `${advisoryFailures.length ? `, ${advisoryFailures.length} advisory (see above)` : ''}`
  + `${skipped ? `, ${skipped} skipped` : ''}.\n`);
process.exit(0);
