#!/usr/bin/env node
'use strict';
/**
 * EXECUTABLE BIT — can the scripts we tell people to run actually be run?
 *
 * DEPLOY.md's Quick Start is:
 *
 *     cd /opt/darex && ./deploy/deploy.sh
 *
 * On a clean Ubuntu machine that returned:
 *
 *     ./deploy/deploy.sh: Permission denied      (exit 126)
 *
 * Every shell script in the repository was committed as mode 100644. The
 * cause is `core.filemode=false`, which is the default on Windows: git does
 * not track the executable bit there, so a script authored on this laptop is
 * never marked executable and nothing on this laptop ever notices — bash
 * invoked as `bash x.sh` does not care. The first machine to care is the
 * customer's server, at the first line of the install guide.
 *
 * That included restore-drill.sh, so the backup restore drill was also
 * unrunnable, and entrypoint.sh, which a Dockerfile invokes.
 *
 * This lint asserts the mode in the INDEX (what a clone receives), not on
 * disk, because on Windows the on-disk bit is meaningless and would make this
 * check pass while the committed mode stayed wrong.
 *
 * Usage: node infra/scripts/lint-exec-bit.js
 * Exit:  0 = every tracked script is executable, 1 = one is not
 */
const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

// Anything a human or a Dockerfile is told to execute directly.
const PATTERNS = ['*.sh'];

let bad = [];
let checked = 0;

for (const pattern of PATTERNS) {
  const out = git(['ls-files', '-s', pattern]).trim();
  if (!out) continue;
  for (const line of out.split('\n')) {
    // "100755 <sha> 0\t<path>"
    const m = /^(\d{6})\s+\S+\s+\d+\t(.+)$/.exec(line);
    if (!m) continue;
    checked++;
    const [, mode, file] = m;
    if (mode !== '100755') bad.push({ file, mode });
  }
}

if (bad.length) {
  console.log('\n  [FAIL] tracked scripts are not executable in the git index:\n');
  for (const b of bad) console.log(`    ${b.mode}  ${b.file}`);
  console.log(
    '\n  A clone receives these without the executable bit, so the documented\n' +
    '  command fails with "Permission denied" on the first machine that is not\n' +
    '  Windows. Fix with:\n\n' +
    '    git update-index --chmod=+x <file>\n',
  );
  process.exit(1);
}

console.log(`  [PASS] all ${checked} tracked shell scripts are mode 100755`);
console.log(`  passed 1 / 1`);
process.exit(0);
