import { canAdvanceStage, classifyActionSurface, gateEmployeeAction } from '../employee-rollout';
describe('employee-rollout', () => {
  it('treats send_email as external', () => { expect(classifyActionSurface('send_email')).toBe('external'); });
  it('keeps stage 0 in shadow', () => {
    expect(gateEmployeeAction({ killSwitch: false, rolloutStage: 0, employeeRole: 'customer', actionType: 'internal_update', reversibility: 'reversible' })).toBe('shadow');
  });
  it('blocks shadow exit without 50 reviews', () => {
    expect(canAdvanceStage({ from: 0, shadowReviewed: 10, shadowAgreed: 10, weeksInStage: 3, stateDivergences: 0, approvalRate: 0.8, decisionsInStage: 200 }).ok).toBe(false);
  });
});
