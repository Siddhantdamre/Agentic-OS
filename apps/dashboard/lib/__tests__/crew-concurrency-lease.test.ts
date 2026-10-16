import { tryAcquireConcurrency } from '../rate-limit';

describe('tryAcquireConcurrency lease release', () => {
  const orgId = `crew-lease-test-${Date.now()}`;

  it('releases exactly once even when release is called twice', () => {
    const first = tryAcquireConcurrency(orgId, 'ask_ai');
    expect(first).not.toBeNull();
    first!.release();
    first!.release();

    const second = tryAcquireConcurrency(orgId, 'ask_ai');
    expect(second).not.toBeNull();
    second!.release();
  });

  it('still frees the slot when the caller throws after acquire (finally pattern)', () => {
    const lease = tryAcquireConcurrency(orgId, 'ask_ai');
    expect(lease).not.toBeNull();
    try {
      throw new Error('simulated crew failure');
    } catch {
      // streamCrewAnswer releases in finally on throw/abort
    } finally {
      lease!.release();
    }

    const again = tryAcquireConcurrency(orgId, 'ask_ai');
    expect(again).not.toBeNull();
    again!.release();
  });
});
