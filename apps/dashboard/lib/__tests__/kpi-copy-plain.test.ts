/**
 * @jest-environment node
 *
 * The Insight page prints each metric's description, insight copy and recommended action as written in the
 * metric registry. They must read as business language, not as notes about how the number is computed.
 */
import fs from 'fs';
import path from 'path';

const FILE = path.join(__dirname, '..', '..', '..', '..', 'services', 'workflows', 'src', 'metrics', 'core-kpis.yaml');
const SHOWN = /^\s*(description|insightCopy|recommendedAction):\s*(.+)$/;
const DEV_WORDS = /\bSQL\b|[a-z]+_[a-z_]+|\bchannel_logs\b|\bstripe\.\w+|\bwork_items\b|\bDecisions\b|\bprompts?\b/i;

describe('metric registry copy', () => {
  const lines = fs.readFileSync(FILE, 'utf8').split('\n').map((l, i) => ({ n: i + 1, m: l.match(SHOWN) })).filter((x) => x.m);

  it('has copy to check', () => {
    expect(lines.length).toBeGreaterThan(15);
  });

  it('shows no internal names or build notes to a customer', () => {
    const bad = lines.filter((x) => DEV_WORDS.test(x.m![2])).map((x) => `${x.n}: ${x.m![2]}`);
    expect(bad).toEqual([]);
  });
});
