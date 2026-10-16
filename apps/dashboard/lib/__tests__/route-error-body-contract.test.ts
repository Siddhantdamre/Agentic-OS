/**
 * @jest-environment node
 *
 * Contract: no API route copies a caught exception's `.message` into its response. Use
 * publicErrorMessage(err, fallback) (lib/public-error.ts), which keeps actionable text and hides
 * driver, host, table and setting names. The detail belongs in the server log, not in a customer's browser.
 */
import fs from 'fs';
import path from 'path';

const API_DIR = path.join(__dirname, '..', '..', 'app', 'api');

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) routeFiles(p, out);
    else if (/^route\.(ts|tsx|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

// `error: err.message`, `message: error.message`, `message: e instanceof Error ? e.message : '...'`
const RAW_MESSAGE_IN_BODY =
  /\b(?:error|message)\s*:\s*(?:err|error|e|inner|persistErr)\s*(?:\.message\b|instanceof\s+Error\s*\?)/;

describe('API routes never put raw exception text in a response', () => {
  it('has no `error:`/`message:` field built from err.message', () => {
    const offenders: string[] = [];
    for (const f of routeFiles(API_DIR)) {
      fs.readFileSync(f, 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*)/.test(line) || /console\.(error|warn|log)/.test(line)) return;
          if (RAW_MESSAGE_IN_BODY.test(line)) offenders.push(`${path.relative(API_DIR, f)}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
