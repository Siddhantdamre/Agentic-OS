import { hashVisitorIp, isPricingPath } from '../visitor-enrich';

describe('visitor-enrich', () => {
  it('hashes IPs and never returns the raw address', () => {
    const hash = hashVisitorIp('203.0.113.10');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain('203.0.113');
    expect(hashVisitorIp('203.0.113.10')).toBe(hash);
  });

  it('detects pricing paths', () => {
    expect(isPricingPath('/pricing')).toBe(true);
    expect(isPricingPath('https://acme.test/plans?utm=1')).toBe(true);
    expect(isPricingPath('/about')).toBe(false);
  });
});
