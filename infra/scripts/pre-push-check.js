#!/usr/bin/env node
'use strict';
/**
 * PRE-PUSH GATE — you may not push code that does not load.
 *
 * WHY THIS EXISTS
 * Two files were pushed to main in one session that could not run at all:
 *
 *   1. verify.js, with an unescaped apostrophe inside a single-quoted string.
 *      It failed to parse, so every invocation exited immediately having run
 *      nothing. The one command in this repository whose job is to say whether
 *      the system is sound was itself broken, on main, and said nothing.
 *
 *   2. verify.js again, with a top-level `await`. Node then reparses a .js
 *      file as an ES module, and every require() in it throws
 *      "Cannot determine intended module format".
 *
 * Both were pushed because the file was edited and committed without being
 * run. Documenting that as a lesson is worthless; the point of this file is to
 * make it impossible.
 *
 * WHY `node --check` IS NOT ENOUGH
 * It caught case 1 and PASSED case 2. `--check` parses; it does not decide
 * module format, which is what actually broke. So this gate also detects the
 * specific ambiguity: a file that uses require() AND has a top-level await is
 * unloadable no matter how well it parses.
 *
 * WHAT IT DOES NOT DO
 * It does not require() the changed files. Most scripts here are CLIs that
 * execute on load, so requiring them would run migrations and e2e suites as a
 * side effect of a push. Loading is approximated by parse + the ambiguity
 * check, and any script exposing --self-test is actually executed.
 *
 * Usage:
 *   node infra/scripts/pre-push-check.js              vs origin/main
 *   node infra/scripts/pre-push-check.js --staged     staged changes only
 *   node infra/scripts/pre-push-check.js --self-test
 *
 * Exit: 0 = safe to push, 1 = do not push.
 */
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

/**
 * Does this source use require() and also await at the top level?
 *
 * Node decides module format by detection, so the combination is fatal
 * regardless of syntax validity. Comments and strings are stripped first so a
 * `// await` in prose cannot fail a good file — a gate with false positives
 * gets disabled within a week, which is worse than no gate.
 */
function hasModuleFormatAmbiguity(src) {
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')     // block comments
    .replace(/^\s*\/\/.*$/gm, ' ')          // line comments
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, '`` ')
    .replace(/'(?:\\[\s\S]|[^\\'])*'/g, "'' ")
    .replace(/"(?:\\[\s\S]|[^\\"])*"/g, '"" ');

  if (!/\brequire\s*\(/.test(code)) return false;

  // Top level = column zero, or one indent inside a plain block — anything not
  // lexically inside `async function` / `async (` / `async () =>`. Rather than
  // parse, take the conservative reading: an `await` that is not preceded on
  // the same logical block by `async` is suspect. Line-oriented and imperfect,
  // but it catches the real shape (a bare `const x = await f()` at column 0).
  const lines = code.split('\n');
  for (const line of lines) {
    if (/^(?:const|let|var|)\s*[\w{}\[\],\s]*=?\s*await\s/.test(line.trimEnd()) &&
        /^\S/.test(line)) {
      return true;
    }
    if (/^\s{0,2}await\s/.test(line) && !/async/.test(line)) {
      // Indented up to one level and not itself declaring async: only flag when
      // the file has no async wrapper at all, otherwise this is a normal body.
      if (!/\basync\b/.test(code)) return true;
    }
  }
  return false;
}

// ── Self-test ───────────────────────────────────────────────────────────────
if (process.argv.includes('--self-test')) {
  const assert = require('assert');
  let pass = 0;
  let fail = 0;
  const t = (name, fn) => {
    try { fn(); pass++; console.log(`  [PASS] ${name}`); }
    catch (e) { fail++; console.log(`  [FAIL] ${name} — ${e.message}`); }
  };

  console.log('\n=== PRE-PUSH GATE — SELF TEST ===\n');

  t('THE REAL BUG: require + top-level await is caught', () => {
    assert.equal(hasModuleFormatAmbiguity(
      "const { spawnSync } = require('child_process');\n" +
      'const env = await environmentReachable();\n',
    ), true);
  });

  t('an ordinary CommonJS script is not flagged', () => {
    assert.equal(hasModuleFormatAmbiguity(
      "const fs = require('fs');\nfunction main() { return 1; }\nmain();\n",
    ), false);
  });

  t('await inside an async function is fine', () => {
    assert.equal(hasModuleFormatAmbiguity(
      "const fs = require('fs');\n" +
      'async function main() {\n  const x = await go();\n  return x;\n}\nmain();\n',
    ), false);
  });

  t('await inside an async IIFE is fine — the pattern every check-*.js uses', () => {
    assert.equal(hasModuleFormatAmbiguity(
      "const path = require('path');\n" +
      '(async () => {\n  await db.connect();\n  await run();\n})();\n',
    ), false);
  });

  t('NO FALSE POSITIVE: the word await in a comment', () => {
    assert.equal(hasModuleFormatAmbiguity(
      "const fs = require('fs');\n// we await nothing here\nmain();\n",
    ), false);
  });

  t('NO FALSE POSITIVE: the word await in a string', () => {
    assert.equal(hasModuleFormatAmbiguity(
      "const fs = require('fs');\nconst msg = 'await the result';\n",
    ), false);
  });

  t('an ES module with top-level await and no require is fine', () => {
    assert.equal(hasModuleFormatAmbiguity(
      "import fs from 'fs';\nconst x = await go();\n",
    ), false);
  });

  console.log(`\n  passed ${pass} / ${pass + fail}\n`);
  process.exit(fail ? 1 : 0);
}

// ── The gate ────────────────────────────────────────────────────────────────
const STAGED = process.argv.includes('--staged');

// The UNION of what is committed-but-unpushed and what is merely edited.
//
// The first version looked only at `origin/main...HEAD`. Run by hand against
// uncommitted work it therefore examined nothing and printed "safe to push",
// which is precisely the false green this file exists to prevent — the gate
// reproduced the bug it was written to stop. As a hook the commits exist by
// then, so it happened to be right in the one case that was tested and wrong
// in the case a person actually types.
const changedSet = new Set();
const collect = (args) => {
  try {
    for (const f of git(args).split('\n')) {
      const t = f.trim();
      if (t) changedSet.add(t);
    }
  } catch {
    // A missing origin/main (fresh clone, detached CI) is not a reason to
    // check less — the other sources still apply.
  }
};

if (STAGED) {
  collect(['diff', '--cached', '--name-only']);
} else {
  collect(['diff', '--name-only', 'origin/main...HEAD']);  // committed, unpushed
  collect(['diff', '--name-only', 'HEAD']);                // edited, uncommitted
  collect(['diff', '--cached', '--name-only']);            // staged
  collect(['ls-files', '--others', '--exclude-standard']); // new, untracked
}
const changed = [...changedSet];

const js = changed.filter((f) => /\.(js|cjs|mjs)$/.test(f) && fs.existsSync(path.join(ROOT, f)));
const ts = changed.filter((f) => /\.(ts|tsx)$/.test(f) && fs.existsSync(path.join(ROOT, f)));

const problems = [];

console.log(`\n=== PRE-PUSH GATE — ${changed.length} changed file(s), ${js.length} JS, ${ts.length} TS ===\n`);

for (const f of js) {
  const abs = path.join(ROOT, f);
  const chk = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' });
  if (chk.status !== 0) {
    problems.push({ f, why: 'does not parse', detail: String(chk.stderr).split('\n').slice(0, 3).join(' ') });
    continue;
  }
  const src = fs.readFileSync(abs, 'utf8');
  if (hasModuleFormatAmbiguity(src)) {
    problems.push({
      f,
      why: 'uses require() AND a top-level await — Node cannot determine the module format',
      detail: 'wrap the await in an async function, or spawn it as a child process',
    });
    continue;
  }
  console.log(`  [ok]  ${f}`);
}

// Any script advertising a self-test gets it run. This is the closest thing to
// "does it actually work" that is safe to run on every push.
for (const f of js) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  // It must HANDLE the flag, not merely mention it. verify.js passes
  // '--self-test' to its child suites, and matching the bare string made this
  // gate run the entire verification suite as if it were verify.js's own
  // self-test — then block the push when that behaved unexpectedly. A gate
  // that cries wolf gets bypassed, which costs more than it ever saved.
  if (!/argv\s*(?:\.includes\s*\(\s*|\.indexOf\s*\(\s*)['"]--self-test['"]/.test(src)) continue;
  const r = spawnSync(process.execPath, [path.join(ROOT, f), '--self-test'],
    { encoding: 'utf8', env: process.env, timeout: 120000 });
  if (r.status !== 0) {
    problems.push({ f, why: 'its own --self-test fails', detail: String(r.stdout || r.stderr).split('\n').filter((l) => /FAIL/.test(l)).slice(0, 3).join(' ') });
  } else {
    console.log(`  [ok]  ${f} --self-test`);
  }
}

if (ts.length) {
  /**
   * Run the compiler directly, never through `npx`.
   *
   * This blocked a push with the message "typecheck fails" and an EMPTY detail
   * while `tsc --noEmit` passed cleanly by hand. The cause was not the code:
   * `npx` is broken in this environment — npm's own launcher resolves a doubled
   * path and dies with "Cannot find module ...\npm\bin\node_modules\npm\bin\
   * npm-prefix.js" on stderr, exit 1, and NOTHING on stdout. The old code read
   * only stdout, so the gate failed closed with no reason anyone could act on.
   *
   * A gate that blocks for an unexplainable reason gets routed around with
   * --no-verify, which is strictly worse than no gate at all.
   *
   * Two changes, both about being able to act on a failure:
   *   1. Invoke node_modules/typescript/bin/tsc with this same node binary.
   *      No npm launcher, no shell, no PATH lookup — and it is faster.
   *   2. Separate "the compiler ran and found errors" from "the compiler could
   *      not be run". They need opposite responses and read identically before.
   */
  const WF = path.join(ROOT, 'services', 'workflows');
  const tscBin = [
    path.join(WF, 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
  ].find((candidate) => fs.existsSync(candidate));

  if (!tscBin) {
    problems.push({
      f: 'services/workflows',
      why: 'typecheck could not run',
      detail: 'no local typescript found — run pnpm install; this is not a code failure',
    });
  } else {
    const r = spawnSync(process.execPath, [tscBin, '--noEmit'], {
      cwd: WF,
      encoding: 'utf8',
      timeout: 600000,
      // The headroom this repo needs elsewhere. Without it tsc can exit with
      // "FATAL ERROR: Zone Allocation failed", which is not a type error.
      env: Object.assign({}, process.env, { NODE_OPTIONS: '--max-old-space-size=4096' }),
    });
    const out = String(r.stdout || '') + String(r.stderr || '');
    const lines = out.split('\n').filter(Boolean);

    if (r.error || r.signal) {
      problems.push({
        f: 'services/workflows',
        why: 'typecheck could not run',
        detail: (r.error ? r.error.message : 'killed by ' + r.signal) + ' — not a code failure',
      });
    } else if (r.status !== 0) {
      problems.push({
        f: 'services/workflows',
        why: lines.some((l) => /error TS\d+/.test(l)) ? 'typecheck fails' : 'typecheck could not run',
        detail: lines.slice(0, 3).join(' ') || ('exit ' + r.status + ' with no output'),
      });
    } else {
      console.log('  [ok]  services/workflows tsc --noEmit');
    }
  }
}

if (problems.length) {
  console.log('\n  DO NOT PUSH — these would land broken on main:\n');
  for (const p of problems) {
    console.log(`    ${p.f}`);
    console.log(`      ${p.why}`);
    if (p.detail) console.log(`      ${p.detail}`);
  }
  console.log('');
  process.exit(1);
}

console.log(`\n  safe to push — ${js.length + ts.length} executable file(s) checked\n`);
process.exit(0);
