import { canAdvanceStage, stageRequirements, type RolloutStage } from '../employee-rollout';

const base = {
  shadowReviewed: 0,
  shadowAgreed: 0,
  weeksInStage: 0,
  stateDivergences: 0,
  approvalRate: null as number | null,
  decisionsInStage: 0,
};

const ids = (from: RolloutStage, over: Partial<typeof base> = {}) =>
  stageRequirements({ from, ...base, ...over }).map((r) => r.id);

describe('stageRequirements', () => {
  it('lists what each stage still needs, in the order a person would work through it', () => {
    expect(ids(0)).toEqual(['shadow_reviewed', 'shadow_agreement']);
    expect(ids(1)).toEqual(['weeks_in_stage', 'no_divergences', 'approval_band']);
    expect(ids(2)).toEqual(['gated_decisions', 'approval_floor']);
    expect(ids(3)).toEqual([]);
  });

  it('reports have and need for the shadow review so the page can show 32 of 50', () => {
    const [reviewed, agreement] = stageRequirements({ from: 0, ...base, shadowReviewed: 32, shadowAgreed: 27 });
    expect(reviewed).toMatchObject({ have: 32, need: 50, met: false });
    expect(agreement).toMatchObject({ need: 0.9, met: false });
    expect(agreement.have).toBeCloseTo(27 / 32);
  });

  it('does not invent an agreement figure before anything has been reviewed', () => {
    const [, agreement] = stageRequirements({ from: 0, ...base });
    expect(agreement.have).toBeNull();
    expect(agreement.met).toBe(false);
  });

  it('treats an approval rate above 90% as not met, because rubber-stamping proves nothing', () => {
    const band = (rate: number | null) =>
      stageRequirements({ from: 1, ...base, weeksInStage: 3, approvalRate: rate }).find((r) => r.id === 'approval_band')!;
    expect(band(0.75).met).toBe(true);
    expect(band(0.95).met).toBe(false);
    expect(band(0.5).met).toBe(false);
    expect(band(null).met).toBe(false);
    expect(band(null).have).toBeNull();
  });

  it('needs zero divergences, not "few"', () => {
    const r = (n: number) => stageRequirements({ from: 1, ...base, stateDivergences: n }).find((x) => x.id === 'no_divergences')!;
    expect(r(0).met).toBe(true);
    expect(r(1).met).toBe(false);
  });

  it('agrees with canAdvanceStage on every input: every requirement met <=> may advance', () => {
    const stages: RolloutStage[] = [0, 1, 2];
    const rates = [null, 0.5, 0.6, 0.75, 0.9, 0.95];
    for (const from of stages) {
      for (const approvalRate of rates) {
        for (const shadowReviewed of [0, 49, 50, 80]) {
          for (const shadowAgreed of [0, 40, 45, 50]) {
            for (const weeksInStage of [0, 1, 2, 5]) {
              for (const stateDivergences of [0, 2]) {
                for (const decisionsInStage of [0, 99, 100]) {
                  const input = { from, shadowReviewed, shadowAgreed: Math.min(shadowAgreed, shadowReviewed), weeksInStage, stateDivergences, approvalRate, decisionsInStage };
                  const allMet = stageRequirements(input).every((r) => r.met);
                  expect({ input, ok: canAdvanceStage(input).ok }).toEqual({ input, ok: allMet });
                }
              }
            }
          }
        }
      }
    }
  });

  it('never lets anyone advance out of the last stage', () => {
    expect(canAdvanceStage({ from: 3, ...base }).ok).toBe(false);
  });
});
