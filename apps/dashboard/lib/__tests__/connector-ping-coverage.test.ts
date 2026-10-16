import { INTEGRATION_CATALOG } from '@/lib/integrations-catalog';
import { NANGO_PING_SPECS } from '../../../../services/connectors/src/providers';

// quickbooks needs a per-company realmId in the URL, so it has no generic
// read-only ping; the runner reports "connection exists" for it instead.
const NO_GENERIC_PING = new Set(['quickbooks']);

describe('connector runner ping coverage', () => {
  it('every live OAuth connector has a real read-only ping spec or is explicitly exempt', () => {
    const missing = INTEGRATION_CATALOG.filter(
      (c) => c.authMode === 'oauth' && c.executorStatus === 'live' && !NO_GENERIC_PING.has(c.id)
    )
      .map((c) => c.id)
      .filter((id) => !NANGO_PING_SPECS[id]);
    expect(missing).toEqual([]);
  });

  it('ping specs never use a mutating HTTP method other than the Slack auth.test POST', () => {
    for (const [id, spec] of Object.entries(NANGO_PING_SPECS)) {
      if (spec.method === 'POST') expect(id).toBe('slack');
    }
  });
});
