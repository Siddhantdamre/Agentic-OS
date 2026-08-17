'use strict';

/**
 * Darex eval-runner (A2). Loads Promptfoo-shaped YAML goldens and asserts them.
 * Never calls Ask AI or any product request path.
 *
 * Usage: node infra/evals/runner.js
 *        node infra/evals/runner.js re-brokerage.yaml
 */

const fs = require('fs');
const path = require('path');
const { parseYaml } = require('./lib/parse-yaml');
const { runAsserts } = require('./lib/assert');
const { resolveScenarioOutput, allowMissingMemory } = require('./lib/scenarios');

const EVAL_ROOT = __dirname;

const CASE_FILES = [
  'empty-org.yaml',
  'phase6-returning-contact.yaml',
  'disconnected-sheets-mls.yaml',
  'honesty-connectors.yaml',
  'skill-playbook.yaml',
  're-brokerage.yaml',
];

function requestedFiles() {
  const extra = process.argv.slice(2).filter((arg) => arg.endsWith('.yaml') || arg.endsWith('.yml'));
  if (extra.length === 0) return CASE_FILES;
  return extra.map((arg) => path.basename(arg));
}

function loadTests(relPath) {
  const abs = path.join(EVAL_ROOT, relPath);
  const parsed = parseYaml(fs.readFileSync(abs, 'utf8'));
  let tests;
  if (Array.isArray(parsed)) tests = parsed;
  else if (parsed && Array.isArray(parsed.tests)) tests = parsed.tests;
  else throw new Error(`${relPath}: expected a YAML list or a document with tests:`);

  return tests.map((test, idx) => ({
    ...test,
    vars: test.vars || {},
    assert: test.assert || [],
    metadata: test.metadata || {},
    _file: relPath,
    _index: idx,
  }));
}

function testName(test) {
  return test.description || test.vars.scenario || `${test._file}#${test._index}`;
}

function isXfail(test, resolved) {
  if (test.metadata.xfail === true || test.vars.xfail === true) return true;
  if (resolved && resolved.xfail) return true;
  return false;
}

function skipIsAllowed(resolved) {
  if (!resolved || !resolved.skip) return false;
  if (resolved.reason && /database unreachable/.test(resolved.reason)) return true;
  if (allowMissingMemory()) return true;
  if (resolved.reason && /no recorded provider fixture|providerRecorded/.test(resolved.reason)) {
    return true;
  }
  return false;
}

async function runOne(test) {
  const name = testName(test);

  const negative = test.metadata.negativeOutput;
  if (negative != null && String(negative).length > 0) {
    const neg = runAsserts(test.assert, String(negative));
    if (neg.pass) {
      return {
        name,
        file: test._file,
        status: 'fail',
        reason: 'harness integrity: invented/negative output would PASS this golden — eval cannot catch a lie',
      };
    }
  }

  const resolved = await resolveScenarioOutput(test.vars);

  if (resolved.error) {
    return { name, file: test._file, status: 'fail', reason: resolved.error };
  }

  if (resolved.skip) {
    const xfail = isXfail(test, resolved);
    if (xfail || skipIsAllowed(resolved)) {
      return {
        name,
        file: test._file,
        status: xfail ? 'xfail' : 'skip',
        reason: resolved.reason,
      };
    }
    return {
      name,
      file: test._file,
      status: 'fail',
      reason: `${resolved.reason} (fail-closed; set EVAL_ALLOW_MISSING_MEMORY=1 for an honest skip)`,
    };
  }

  const live = runAsserts(test.assert, resolved.output);
  if (!live.pass) {
    const detail = live.failed.map((f) => f.reason).join('; ');
    return { name, file: test._file, status: 'fail', reason: detail, output: resolved.output };
  }

  return { name, file: test._file, status: 'pass' };
}

async function main() {
  console.log('\n=== Darex evals (A2 / M6 / R4 / P3) ===');
  console.log('  Provider: offline fixtures + DB probes. Ask AI path is not called.\n');

  let pass = 0;
  let fail = 0;
  let skip = 0;
  let xfail = 0;

  for (const file of requestedFiles()) {
    const abs = path.join(EVAL_ROOT, file);
    if (!fs.existsSync(abs)) {
      console.log(`  [FAIL] missing golden file ${file}`);
      fail += 1;
      continue;
    }
    console.log(`--- ${file} ---`);
    const tests = loadTests(file);
    for (const test of tests) {
      const result = await runOne(test);
      if (result.status === 'pass') {
        console.log(`  [PASS] ${result.name}`);
        pass += 1;
      } else if (result.status === 'skip') {
        console.log(`  [SKIP] ${result.name} — ${result.reason}`);
        skip += 1;
      } else if (result.status === 'xfail') {
        console.log(`  [XFAIL] ${result.name} — ${result.reason}`);
        xfail += 1;
      } else {
        console.log(`  [FAIL] ${result.name} — ${result.reason}`);
        fail += 1;
      }
    }
    console.log('');
  }

  const total = pass + fail + skip + xfail;
  console.log('--- Summary ---');
  console.log(`  pass=${pass} fail=${fail} skip=${skip} xfail=${xfail} total=${total}`);
  if (fail > 0) {
    console.log('  EVALS FAILED — invented facts, dishonest tools, or harness integrity.\n');
    process.exit(1);
  }
  console.log('  EVALS PASSED (skips are DB-unreachable or recorded-fixture honesty, not green memory).\n');
}

main().catch((err) => {
  console.error('eval-runner error:', err);
  process.exit(1);
});
