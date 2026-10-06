/**
 * @jest-environment node
 *
 * Contract: a streamed error event never carries a raw caught error's text.
 *
 * Found by approving a held send in chat after the server restarted: the card was dead, nothing ran, and the person
 * was shown `fetch failed` (Node's own network error message), because the approve route streamed `err.message` as is.
 * Every other route already passes caught errors through publicErrorMessage; these streamed events were the gap.
 * A string literal is fine (it is our own sentence). Anything else must go through publicErrorMessage(...).
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

// send('error', { error: <expr> ...   and   { type: 'error', error: <expr> ...
const EVENTS = [/send\(\s*'error'\s*,\s*\{\s*error:\s*([^,}]+)/g, /type:\s*'error'\s*,\s*error:\s*([^,}]+)/g];

function isSafe(expr: string): boolean {
  const e = expr.trim();
  if (/^(['"`])[\s\S]*\1$/.test(e)) return true; // our own sentence
  if (/^publicErrorMessage\(/.test(e)) return true;
  return false;
}

describe('streamed error events', () => {
  const files = routeFiles(API_DIR);

  it('finds the routes it is meant to check', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('never stream a raw caught error to the browser', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      for (const re of EVENTS) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(src))) {
          if (!isSafe(m[1])) offenders.push(`${path.relative(API_DIR, f)}: error: ${m[1].trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
