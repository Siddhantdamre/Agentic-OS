/**
 * @jest-environment node
 *
 * The Ask AI route streams a turn's outcome to the browser. A failed turn's `error` is the internal reason
 * (a refused connection, a provider's response body); it is used for retry decisions and logs. Whatever the
 * route sends to the client in `error`, `result` or `observation` for a failure must pass through
 * publicErrorMessage first — otherwise the chat shows "connect ECONNREFUSED 10.0.0.5:8790".
 */
import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'api', 'ask-ai', 'route.ts'), 'utf8');

// every place the route reads a turn result's `.error` for the client
const READS = [...source.matchAll(/(?:spawn\.result|result)\.error\b[^;\n]*/g)].map((m) => m[0]);

describe('ask-ai route: failed-turn text sent to the browser', () => {
  it('finds the places where it forwards a turn error (the check is not empty)', () => {
    expect(READS.length).toBeGreaterThanOrEqual(4);
  });

  it('never forwards a turn error without publicErrorMessage', () => {
    // Allowed: the value is only tested for presence (`if (result.error)`, `!!result.error`) or used in publicErrorMessage(...).
    const forwarded = source
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /(?:spawn\.result|result)\.error\b/.test(line))
      .filter(({ line }) => !/publicErrorMessage\(/.test(line))
      .filter(({ line }) => !/^\s*(if|const failed|return)\b.*\.error\)?\s*[;{)]?\s*$/.test(line))
      .filter(({ line }) => !/\.error\s*[?]\s*true|!+\s*(?:spawn\.)?result\.error\b|\.retryable/.test(line));
    expect(forwarded.map(({ line, n }) => `${n}: ${line.trim()}`)).toEqual([]);
  });
});
