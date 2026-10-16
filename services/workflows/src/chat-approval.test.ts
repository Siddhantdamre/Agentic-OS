import test from 'node:test';
import assert from 'node:assert/strict';
import { toolResultFromApproval, type ParkedApprovalOutcome } from './chat-approval.js';

function parsed(outcome: ParkedApprovalOutcome) {
  const r = toolResultFromApproval(outcome);
  return { ...r, json: JSON.parse(r.text) as { status: string; message: string; data?: unknown } };
}

test('an approval that ran is reported to the model as executed, with what the tool returned', () => {
  const r = parsed({ status: 'executed', message: 'Email sent', data: { id: 'm1' } });
  assert.equal(r.isError, false);
  assert.equal(r.json.status, 'executed');
  assert.equal(r.json.message, 'Email sent');
  assert.deepEqual(r.json.data, { id: 'm1' });
});

test('an approval that did not run is an error, never "executed"', () => {
  const r = parsed({ status: 'failed', message: 'The action did not run.' });
  assert.equal(r.isError, true);
  assert.equal(r.json.status, 'error');
});

test('an approval that still needs someone else is reported as waiting, not as done', () => {
  const r = parsed({ status: 'waiting', message: 'You approved it. It needs 1 more approval.' });
  assert.equal(r.isError, false);
  assert.equal(r.json.status, 'pending_approval');
  assert.match(r.json.message, /1 more approval/);
});
