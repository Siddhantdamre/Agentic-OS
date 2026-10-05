#!/usr/bin/env node
// CI dependency-audit gate. Fails on any high/critical production advisory
// that is not in ACCEPTED. pnpm 9.0.0 ignores pnpm.auditConfig.ignoreGhsas,
// so the allowlist lives here instead.
const { spawnSync } = require('node:child_process');

// Accepted, tracked debt. Remove entries as they are fixed.
const ACCEPTED = {
  // braces <=3.0.3 — no patched version exists upstream (via daytona sdk > fast-glob).
  'GHSA-vfj7-8cjw-p6xm': 'no upstream patch',
};

const r = spawnSync('pnpm', ['audit', '--prod', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
let report;
try {
  report = JSON.parse(r.stdout);
} catch (e) {
  console.error('audit-gate: could not parse pnpm audit output:', r.stderr || r.stdout);
  process.exit(2);
}

const blocking = Object.values(report.advisories || {}).filter(
  (a) => (a.severity === 'high' || a.severity === 'critical') && !ACCEPTED[a.github_advisory_id],
);
for (const a of blocking) {
  console.error(`${a.severity} ${a.module_name} ${a.github_advisory_id} ${a.title}\n  ${a.url}`);
}
if (blocking.length) {
  console.error(`audit-gate: ${blocking.length} un-accepted high/critical advisories`);
  process.exit(1);
}
console.log('audit-gate: no un-accepted high/critical production advisories');
