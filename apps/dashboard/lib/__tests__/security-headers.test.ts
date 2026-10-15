/**
 * Every response from the dashboard carries the browser protections a launch needs. They are built in
 * security-headers.js (plain CommonJS, because next.config.js is) and applied to every path.
 */
const { securityHeaders } = require('../../security-headers');
const nextConfig = require('../../next.config.js');

const asMap = (list: { key: string; value: string }[]) =>
  Object.fromEntries(list.map((h) => [h.key.toLowerCase(), h.value]));

describe('security headers', () => {
  it('stops the app being framed, sniffed or leaking full URLs', () => {
    const h = asMap(securityHeaders({ production: true }));
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(h['content-security-policy']).toContain("object-src 'none'");
    expect(h['content-security-policy']).toContain("base-uri 'self'");
  });

  it('does not restrict scripts or forms, so the app and its sign-in redirects keep working', () => {
    const csp = asMap(securityHeaders({ production: true }))['content-security-policy'];
    expect(csp).not.toMatch(/script-src|default-src|form-action|style-src|connect-src/);
  });

  it('turns off camera, microphone and location, which the app never uses', () => {
    const p = asMap(securityHeaders({ production: true }))['permissions-policy'];
    expect(p).toContain('camera=()');
    expect(p).toContain('microphone=()');
    expect(p).toContain('geolocation=()');
  });

  it('asks browsers to use HTTPS only in production, so a local http start is not locked out', () => {
    expect(asMap(securityHeaders({ production: true }))['strict-transport-security']).toMatch(/max-age=\d{7,}/);
    expect(asMap(securityHeaders({ production: false }))['strict-transport-security']).toBeUndefined();
  });

  it('is applied to every path and hides the framework banner', async () => {
    expect(nextConfig.poweredByHeader).toBe(false);
    const rules = await nextConfig.headers();
    expect(rules).toHaveLength(1);
    expect(rules[0].source).toBe('/:path*');
    expect(rules[0].headers.length).toBeGreaterThanOrEqual(5);
  });
});
