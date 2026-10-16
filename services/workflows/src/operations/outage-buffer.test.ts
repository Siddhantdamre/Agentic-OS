import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bufferKey, OUTAGE_BUFFER_EVENT } from './outage-buffer.js';

test('buffer keys are derived, not generated', () => {
  const effect = {
    orgId: 'org-1',
    channel: 'hubspot',
    action: 'create_contact',
    payload: { email: 'a@example.com' },
    workflowId: 'wf-1',
  };
  const a = bufferKey(effect);
  const b = bufferKey(effect);
  assert.equal(a, b);
  assert.equal(a.length, 64);
  assert.notEqual(bufferKey({ ...effect, workflowId: 'wf-2' }), a);
});

test('outage event name is stable for replay scans', () => {
  assert.equal(OUTAGE_BUFFER_EVENT, 'CONNECTOR_OUTAGE_BUFFER');
});
