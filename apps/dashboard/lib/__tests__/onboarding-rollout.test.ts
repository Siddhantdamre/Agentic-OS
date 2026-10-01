import { buildTrajectory, clampBackfillWindow, observationHeadline } from '../onboarding-rollout';
import { seedColdStart, DEFAULT_AUTONOMY_SEED } from '@darex/workflows/dist/cold-start';

describe('onboarding-rollout', () => {
  it('caps backfill at 30 days', () => { expect(clampBackfillWindow(90)).toBe(30); });
  it('names unanswered threads without inventing them', () => {
    expect(observationHeadline(3, 'Tuesday')).toBe('3 enquiries from Tuesday have had no reply.');
  });
  it('makes the 12 of 14 trajectory explicit', () => {
    const t = buildTrajectory(12, 14, ['rescheduling']);
    expect(t.message).toContain('12 of my last 14');
    expect(t.neverGraduate).toContain('refunds');
  });
  it('seeds initial cold-start policy with 17 canonical autonomy rules', () => {
    const policy = seedColdStart(0);
    expect(policy.phase).toBe('notice');
    expect(policy.autonomyEnabled).toBe(false);
    expect(policy.externalSendsEnabled).toBe(false);
    expect(DEFAULT_AUTONOMY_SEED.length).toBe(17);
    expect(DEFAULT_AUTONOMY_SEED.some((r) => r.action_type === 'refund_payment')).toBe(true);
  });
});
