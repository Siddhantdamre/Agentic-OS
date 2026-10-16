import assert from 'node:assert/strict';
import test from 'node:test';
import { buildConnectorStatuses, connectors, type ConnectorRow, type ProbeFn } from './connectors.js';
import { CORE_READ_TOOLS } from '../tool-gate.js';
import { isToolAllowed } from '../tool-executor.js';

const row = (over: Partial<ConnectorRow>): ConnectorRow => ({
  key: 'slack',
  nangoKey: null,
  name: 'Slack',
  category: 'Communication',
  authMode: 'oauth',
  cachedStatus: 'connected',
  lastOkAt: null,
  lastError: null,
  ...over,
});

const ORG = '00000000-0000-4000-8000-000000000001';

test('connectors status is read-only and needs no confirmation', () => {
  for (const a of ['status', 'ping', 'list']) {
    assert.equal(connectors.risk(a), 'read');
    assert.equal(connectors.confirm(a), false);
  }
  assert.equal(connectors.actions.includes('connect' as never), false);
  assert.equal(connectors.actions.includes('disconnect' as never), false);
});

test('cached "connected" is not trusted: a failed live probe reports not connected with a connect link', async () => {
  const probe: ProbeFn = async () => 'never-configured';
  const [s] = await buildConnectorStatuses(ORG, [row({})], probe, true);
  assert.equal(s.connected, false);
  assert.equal(s.state, 'not_connected');
  assert.equal(s.cachedStatus, 'connected');
  assert.match(s.connectUrl, /^\/connectors/);
});

test('live probe success and revoked states are reported distinctly', async () => {
  const probe: ProbeFn = async (_o, keys) => (keys.includes('slack') ? 'connected' : 'revoked');
  const [ok, revoked] = await buildConnectorStatuses(
    ORG,
    [row({}), row({ key: 'notion', name: 'Notion' })],
    probe,
    true,
  );
  assert.equal(ok.connected, true);
  assert.equal(ok.verifiedBy, 'live');
  assert.equal(revoked.connected, false);
  assert.equal(revoked.state, 'revoked');
});

test('BYOK connectors and an unconfigured Nango are never claimed connected', async () => {
  let probed = 0;
  const probe: ProbeFn = async () => {
    probed += 1;
    return 'connected';
  };
  const byok = await buildConnectorStatuses(ORG, [row({ key: 'razorpay', authMode: 'byok' })], probe, true);
  assert.equal(byok[0].connected, false);
  assert.equal(byok[0].state, 'unverified');
  const noNango = await buildConnectorStatuses(ORG, [row({})], probe, false);
  assert.equal(noNango[0].connected, false);
  assert.equal(noNango[0].state, 'unverified');
  assert.equal(probed, 0);
});

test('connectors_status is a core read tool so every employee can answer "is X connected"', () => {
  assert.ok(CORE_READ_TOOLS.includes('connectors_status'));
  assert.equal(isToolAllowed('connectors_status', CORE_READ_TOOLS), true);
});

test('probe passes connectorKey and never-configured state reports not_connected instead of revoked', async () => {
  const probedKeys: Array<{ orgId: string; keys: string[]; connectorKey?: string }> = [];
  const probe: ProbeFn = async (orgId, keys, connectorKey) => {
    probedKeys.push({ orgId, keys, connectorKey });
    return 'never-configured';
  };
  const [res] = await buildConnectorStatuses(
    ORG,
    [row({ key: 'google-calendar', nangoKey: 'google' })],
    probe,
    true,
  );
  assert.equal(probedKeys.length, 1);
  assert.equal(probedKeys[0].connectorKey, 'google-calendar');
  assert.deepEqual(probedKeys[0].keys, ['google-calendar', 'google']);
  assert.equal(res.connected, false);
  assert.equal(res.state, 'not_connected');
});
