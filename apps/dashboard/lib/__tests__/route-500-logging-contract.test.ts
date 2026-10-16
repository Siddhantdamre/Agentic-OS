/**
 * @jest-environment node
 *
 * Contract: a route that answers HTTP 500 from a catch block logs the error first.
 *
 * Why: 54 of 194 such blocks answered 500 and wrote nothing anywhere. When one of them failed under load
 * (12 parallel backfills, one 500) the cause could not be read from the server log and had to be
 * reconstructed from the database's own log. A 500 with no log line is an outage nobody can diagnose.
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

/** Each `catch { ... }` body with the 1-based line it starts on; skips strings, templates and comments. */
export function catchBlocks(src: string): Array<{ line: number; body: string }> {
  const out: Array<{ line: number; body: string }> = [];
  const n = src.length;
  const re = /\bcatch\s*(?:\(([^)]*)\))?\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let j = m.index + m[0].length;
    let depth = 1;
    while (j < n && depth > 0) {
      const c = src[j];
      if (c === "'" || c === '"' || c === '`') {
        j++;
        while (j < n && src[j] !== c) {
          if (src[j] === '\\') j++;
          j++;
        }
      } else if (src.startsWith('//', j)) {
        while (j < n && src[j] !== '\n') j++;
      } else if (src.startsWith('/*', j)) {
        j = src.indexOf('*/', j) + 1;
      } else if (c === '{') depth++;
      else if (c === '}') depth--;
      j++;
    }
    out.push({ line: src.slice(0, m.index).split('\n').length, body: src.slice(m.index + m[0].length, j - 1) });
  }
  return out;
}

const ANSWERS_500 = /status:\s*500\b/;
const LOGS = /console\.(error|warn)|logger\.|reportError|Sentry/;

describe('catch blocks that answer 500 log the error', () => {
  it('finds the blocks it is meant to check', () => {
    let total = 0;
    for (const f of routeFiles(API_DIR)) total += catchBlocks(fs.readFileSync(f, 'utf8')).filter((b) => ANSWERS_500.test(b.body)).length;
    expect(total).toBeGreaterThan(100);
  });

  it('has none that answer 500 silently', () => {
    const silent: string[] = [];
    for (const f of routeFiles(API_DIR)) {
      for (const b of catchBlocks(fs.readFileSync(f, 'utf8'))) {
        if (ANSWERS_500.test(b.body) && !LOGS.test(b.body)) silent.push(`${path.relative(API_DIR, f)}:${b.line}`);
      }
    }
    expect(silent).toEqual([]);
  });
});
