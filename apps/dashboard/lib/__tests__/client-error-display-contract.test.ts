/**
 * @jest-environment node
 *
 * What a person reads when something fails.
 *
 * A browser reports a dropped connection as `TypeError: Failed to fetch` (Safari: "Load failed", Firefox:
 * "NetworkError when attempting to fetch resource."). Passing `err.message` straight into an on-screen error puts
 * that sentence in front of the customer. Likewise "Failed to load audit logs (500)": the code means nothing to
 * them. Customer-facing errors go through `networkErrorMessage(err, plainFallback)` and never carry a status code.
 *
 * Measured before the fix: 32 on-screen errors passed `err.message` through, and 12 appended an HTTP status.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const SCANNED = ['app/(auth)', 'app/(dashboard)', 'app/(onboarding)', 'components'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (/\.tsx$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const RAW_MESSAGE = /instanceof Error \? (?:err|e|error)\.message\b/;
// any template literal that prints a status in parentheses, e.g. `Could not load billing (${res.status})`
const STATUS_IN_MESSAGE = /`[^`]*\(\$\{[^}]*status[^}]*\}\)[^`]*`/i;

function offenders(re: RegExp) {
  const out: string[] = [];
  for (const dir of SCANNED) {
    for (const abs of walk(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, abs).split(path.sep).join('/');
      fs.readFileSync(abs, 'utf8').split('\n').forEach((line, i) => {
        if (re.test(line) && !/console\.(error|warn|log)/.test(line)) out.push(`${rel}:${i + 1}  ${line.trim().slice(0, 100)}`);
      });
    }
  }
  return out;
}

describe('errors shown to people', () => {
  it('never puts a raw err.message on screen (a dropped connection would read "Failed to fetch")', () => {
    expect(offenders(RAW_MESSAGE)).toEqual([]);
  });

  it('never shows an HTTP status code in a message', () => {
    expect(offenders(STATUS_IN_MESSAGE)).toEqual([]);
  });
});
