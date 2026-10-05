/**
 * @jest-environment node
 *
 * Contract: no API route reads its own request body with a bare `request.json()`.
 *
 * Why it is a rule and not a style preference: a fuzz run sent `null`, malformed JSON and NUL-bearing
 * strings to every route as a logged-in tenant. 53 routes answered HTTP 500 — a client mistake reported
 * as a server failure, which also buries real 500s in the alerts. The usual guard,
 * `request.json().catch(() => ({}))`, does not help: `null` parses successfully and the destructuring
 * that follows throws. Every route reads its body through `jsonBodyOrEmpty` (lib/safe-json.ts), so a
 * bad body reaches the route's own validation and gets a 400.
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

// `request.json()` / `req.json()` on the incoming request. Calls on other objects (a fetch Response named
// res/tokenRes/histRes ...) are upstream replies, not client bodies, and are not matched.
const BARE_BODY_READ = /\b(?:request|req)\s*\.\s*json\s*\(/;

describe('API routes read request bodies through jsonBodyOrEmpty', () => {
  const files = routeFiles(API_DIR);

  it('finds the routes it is meant to check', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('has no bare request.json() in any route', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
      lines.forEach((l, i) => {
        if (BARE_BODY_READ.test(l) && !/^\s*(\/\/|\*)/.test(l)) {
          offenders.push(`${path.relative(API_DIR, f)}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
