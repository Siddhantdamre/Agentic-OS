'use strict';
/**
 * Load the same environment the containers get, and report the traps.
 *
 * WHY THIS EXISTS
 * preflight.js — the script whose whole job is to be trusted about GO/NO-GO —
 * read process.env.OPENROUTER_API_KEY and never loaded infra/.env. Run from a
 * plain shell it reported:
 *
 *   [STOP]  no LLM provider key configured at all
 *   [STOP]  NO LLM tier is answering
 *
 * while the live system was answering fine. A gate that cries wolf is worse
 * than no gate: the operator learns to override it, and then it cannot warn
 * about anything. latency-probe.js, harden-suite.js and check-reply-gate-live.js
 * had the same hole.
 *
 * DUPLICATE-KEY SEMANTICS — the subtle part
 * Docker Compose's env_file applies LAST occurrence wins. infra/.env currently
 * holds OPENROUTER_API_KEY twice: line 6 is empty, line 9 is the real key. So
 * the containers get the real one purely because of line order. A loader that
 * took FIRST wins — the obvious way to write it, and what the copy of this
 * logic in e2e-live-llm.js does — would read the EMPTY value and disagree with
 * production about the single most important credential in the system.
 *
 * So: last wins within a file, matching compose. And every duplicate is
 * reported, because a credential whose value depends on line order is a
 * landmine whether or not it happens to be pointing the right way today.
 *
 * ACROSS files, earlier files win — with one exception that is not optional:
 * an EMPTY value never shadows a non-empty one. Every consumer treats "" and
 * unset identically ("no key configured"), so letting "" win means a bare
 * placeholder silently disables a credential that is correctly set elsewhere.
 * That is not hypothetical here: OPENROUTER_API_KEY is declared empty in both
 * the root .env (line 5) and apps/dashboard/.env.local (line 41), and the real
 * key lives in infra/.env. First-wins made this script report
 * "no LLM provider key configured at all" one line after successfully calling
 * the provider with that key.
 *
 * A variable the operator exported on the command line always wins, empty or
 * not — that is an explicit instruction, not a leftover placeholder.
 */
const fs = require('fs');
const path = require('path');

/** Parse one env file. Returns { values, duplicates } with compose semantics. */
function parseEnvFile(file) {
  const values = new Map();
  const duplicates = [];
  if (!fs.existsSync(file)) return { values, duplicates };

  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) return;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (values.has(key)) {
      duplicates.push({
        key,
        file,
        firstLine: values.get(key).line,
        line: i + 1,
        // Which value actually reaches the container. Never the value itself:
        // these files hold live credentials and this output gets pasted into
        // issues and chat windows.
        winnerWasEmpty: value.length === 0,
        loserWasEmpty: values.get(key).value.length === 0,
      });
    }
    values.set(key, { value, line: i + 1 }); // last wins, like compose
  });
  return { values, duplicates };
}

/**
 * Load the repo's env files into process.env without overriding anything
 * already exported. Returns findings the caller can print.
 *
 * @returns {{loaded: string[], duplicates: Array<object>, empty: string[]}}
 */
function loadRepoEnv(repoRoot) {
  const root = repoRoot || path.join(__dirname, '..', '..', '..');
  const files = [
    path.join(root, '.env'),
    path.join(root, 'apps', 'dashboard', '.env.local'),
    path.join(root, 'infra', '.env'),
  ];

  // Anything already exported is the operator speaking directly. Record it so
  // a later file never overwrites it, even when it is deliberately empty.
  const exported = new Set(Object.keys(process.env));

  const loaded = [];
  const duplicates = [];
  const shadowed = [];
  const empty = new Set();
  /** key -> relative path of the file whose value is currently in effect. */
  const source = new Map();

  for (const file of files) {
    const { values, duplicates: dups } = parseEnvFile(file);
    if (values.size === 0) continue;
    const rel = path.relative(root, file).replace(/\\/g, '/');
    loaded.push(rel);
    duplicates.push(...dups);

    for (const [key, entry] of values) {
      if (exported.has(key)) continue;

      const current = process.env[key];
      const haveReal = typeof current === 'string' && current !== '';
      const isReal = entry.value !== '';

      // First wins, except that a real value rescues an empty placeholder.
      if (current === undefined || (!haveReal && isReal)) {
        if (!haveReal && isReal && source.has(key)) {
          shadowed.push({ key, placeholder: source.get(key), real: rel });
        }
        process.env[key] = entry.value;
        source.set(key, rel);
      }
      if (entry.value === '') empty.add(key);
    }
  }

  return {
    loaded,
    duplicates,
    shadowed,
    // Only keys that ended up with no usable value at all — a key declared
    // empty in one file and set in another is configured, not missing.
    empty: [...empty].filter((k) => !process.env[k]).sort(),
  };
}

module.exports = { loadRepoEnv, parseEnvFile };

// ── Self-test ───────────────────────────────────────────────────────────────
// The precedence rules here are small, subtle and already got written wrong
// once — first-wins looked obviously right and made preflight declare NO-GO
// over a working system. Run: node infra/scripts/lib/env.js --self-test
if (require.main === module && process.argv.includes('--self-test')) {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'darex-env-'));
  const write = (rel, body) => {
    const f = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
    return f;
  };

  let pass = 0;
  let fail = 0;
  const check = (label, actual, expected) => {
    if (actual === expected) { pass++; console.log(`  [PASS] ${label}`); }
    else { fail++; console.log(`  [FAIL] ${label} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`); }
  };

  write('.env', 'SHADOWED=\nROOT_ONLY=from-root\nEXPORTED=from-file\n');
  write('apps/dashboard/.env.local', 'SHADOWED=\nDASH=from-dash\n');
  write('infra/.env', [
    'DUP=',            // line 1 — the placeholder
    'SHADOWED=real-value',
    'DUP=winner',      // line 3 — compose takes this one
    'NEVER_SET=',
  ].join('\n') + '\n');

  // A value the operator exported must survive untouched.
  process.env.EXPORTED = 'from-shell';
  for (const k of ['SHADOWED', 'ROOT_ONLY', 'DASH', 'DUP', 'NEVER_SET']) delete process.env[k];

  const r = loadRepoEnv(tmp);

  console.log('\n### ENV LOADER SELF-TEST\n');
  check('a real value rescues an empty placeholder', process.env.SHADOWED, 'real-value');
  check('the shadowing is reported', r.shadowed.some((s) => s.key === 'SHADOWED'), true);
  check('within a file the LAST duplicate wins, like compose', process.env.DUP, 'winner');
  check('the duplicate is reported', r.duplicates.some((d) => d.key === 'DUP'), true);
  check('an exported value is never overwritten', process.env.EXPORTED, 'from-shell');
  check('a key set in only one file loads', process.env.ROOT_ONLY, 'from-root');
  check('a key empty everywhere is reported missing', r.empty.includes('NEVER_SET'), true);
  check('a key set somewhere is NOT reported missing', r.empty.includes('SHADOWED'), false);
  check('every file is reported as loaded', r.loaded.length, 3);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n  passed ${pass} / ${pass + fail}\n`);
  process.exit(fail ? 1 : 0);
}
