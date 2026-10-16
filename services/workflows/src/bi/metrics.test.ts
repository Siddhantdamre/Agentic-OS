import { test } from 'node:test';
import assert from 'node:assert/strict';
import { METRICS, renderQuery, MetricDef } from './metrics.js';

const ORG = '11111111-2222-3333-4444-555555555555';
const sample: Record<string, Record<string, unknown>> = {
  overdue_total: { as_of: '2026-10-16' }, overdue_count: { as_of: '2026-10-16' }, overdue_share: { as_of: '2026-10-16' },
  paid_in_range: { from: '2026-10-01', to: '2026-10-16' }, inquiries_in_range: { from: '2026-10-01', to: '2026-10-16' },
  inquiries_closed: { from: '2026-10-01', to: '2026-10-16' }, active_listings: {},
};

test('every sample metric renders, scoped by $1, with no raw values inlined', () => {
  for (const m of METRICS) {
    const r = renderQuery(m, sample[m.id], ORG);
    assert.match(r.text, /org_id = \$1/);
    assert.equal(r.values[0], ORG);
    assert.equal(r.values.length, 1 + m.params.length);
    assert.ok(!r.text.includes('2026-10') && !r.text.includes(ORG));
    assert.ok(!r.text.includes('@'));
  }
});

const bad = (sql: string, params: MetricDef['params'] = []): MetricDef => ({ id: 'bad', label: 'b', unit: 'count', sql, params });
test('rejects defs that are not one scoped SELECT', () => {
  const cases = [
    'DELETE FROM org_dues WHERE org_id = @org',
    'SELECT 1; DROP TABLE org_dues',
    `WITH d AS (DELETE FROM org_dues WHERE org_id = @org RETURNING 1) SELECT COUNT(*) FROM d`,
    'SELECT COUNT(*) FROM org_dues',
    'SELECT COUNT(*) FROM org_dues WHERE org_id = $1',
    'SELECT COUNT(*) FROM org_dues a JOIN org_dues b ON true WHERE a.org_id = @org',
    `SELECT set_config('app.current_org_id', 'x', false) FROM org_dues WHERE org_id = @org`,
    'SELECT COUNT(*) FROM org_dues WHERE org_id = @org -- hi',
    'SELECT COUNT(*) FROM org_dues WHERE org_id = @org AND x = @ghost',
  ];
  for (const sql of cases) assert.throws(() => renderQuery(bad(sql), {}, ORG), undefined, sql);
});

test('rejects bad params and bad org id', () => {
  const m = METRICS[0];
  assert.throws(() => renderQuery(m, { as_of: '16/10/2026' }, ORG));
  assert.throws(() => renderQuery(m, { as_of: '2026-02-30' }, ORG));
  assert.throws(() => renderQuery(m, {}, ORG));
  assert.throws(() => renderQuery(m, { as_of: '2026-10-16', extra: 1 }, ORG));
  assert.throws(() => renderQuery(m, { as_of: '2026-10-16' }, "x' OR 1=1"));
});
