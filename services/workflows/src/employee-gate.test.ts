import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyActionSurface, evaluateEmployeeGate, missingMetaDefaults } from './employee-gate.js';
describe('employee gate', () => {
  it('treats missing meta as shadow with the switch off', () => {
    const def = missingMetaDefaults();
    assert.equal(def.killSwitch, false);
    assert.equal(evaluateEmployeeGate(def), 'shadow');
  });
  it('drops writes to shadow when the kill switch is on', () => {
    assert.equal(evaluateEmployeeGate({ killSwitch: true, rolloutStage: 3, employeeRole: 'operations', actionType: 'internal_update', reversibility: 'reversible' }), 'shadow');
  });
  it('never auto-approves irreversible actions at stage 3', () => {
    assert.equal(evaluateEmployeeGate({ killSwitch: false, rolloutStage: 3, employeeRole: 'operations', actionType: 'refund_payment', reversibility: 'irreversible' }), 'escalate');
  });
  it('still escalates visible actions at stage 3', () => {
    assert.equal(evaluateEmployeeGate({ killSwitch: false, rolloutStage: 3, employeeRole: 'operations', actionType: 'internal_update', reversibility: 'visible' }), 'escalate');
  });
  it('scopes growth off operations tools', () => {
    assert.equal(evaluateEmployeeGate({ killSwitch: false, rolloutStage: 3, employeeRole: 'growth', actionType: 'refund_payment', reversibility: 'reversible' }), 'deny_role');
  });
  it('splits send_email as external even with underscores', () => {
    assert.equal(classifyActionSurface('send_email'), 'external');
  });
});
