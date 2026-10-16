import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { TOOLS } from '../tool-definitions.js';
import { COVERAGE_PATH, parseStatuses, renderChatCoverage, scanTabActions } from './chat-coverage.js';

test('chat-coverage.md has exactly one row per chat tool and tab action', () => {
  const rows = parseStatuses(readFileSync(COVERAGE_PATH, 'utf8'));
  const expected = [...TOOLS.map((t) => t.name), ...scanTabActions().map((a) => `${a.method} ${a.path}`)];
  const missing = expected.filter((k) => !rows.has(k));
  const stale = [...rows.keys()].filter((k) => !expected.includes(k));
  const fix = 'run `pnpm --filter @darex/workflows build && pnpm --filter @darex/workflows chat-coverage`';
  assert.deepEqual(missing, [], `rows missing, ${fix}`);
  assert.deepEqual(stale, [], `stale rows, ${fix}`);
});

test('regeneration keeps a hand-set status', () => {
  const md = renderChatCoverage([{ method: 'POST', path: '/api/x' }], new Map([['POST /api/x', '🟢'], ['gmail_send', '🟡']]));
  const rows = parseStatuses(md);
  assert.equal(rows.get('POST /api/x'), '🟢');
  assert.equal(rows.get('gmail_send'), '🟡');
  assert.equal(rows.get('gmail_fetch'), '🔴');
});
