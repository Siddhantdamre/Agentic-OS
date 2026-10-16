import { listOAuthProviders } from '../oauth-providers';
import { isPublicApiPath, parseSessionCookie, signSessionValue } from '../session-cookie';
import { hashPassword, verifyPassword } from '../password';

describe('Auth & Login Core Logic', () => {
  describe('listOAuthProviders', () => {
    it('returns standard OAuth providers with configuration flags', () => {
      const providers = listOAuthProviders();
      expect(providers).toHaveLength(4);

      const ids = providers.map((p) => p.id);
      expect(ids).toContain('google');
      expect(ids).toContain('github');
      expect(ids).toContain('meta');
      expect(ids).toContain('microsoft');

      providers.forEach((p) => {
        expect(typeof p.name).toBe('string');
        expect(typeof p.configured).toBe('boolean');
      });
    });
  });

  describe('isPublicApiPath', () => {
    it('allows public auth paths including oauth discovery and logout', () => {
      expect(isPublicApiPath('/api/auth/login')).toBe(true);
      expect(isPublicApiPath('/api/auth/signin')).toBe(true);
      expect(isPublicApiPath('/api/auth/logout')).toBe(true);
      expect(isPublicApiPath('/api/auth/signout')).toBe(true);
      expect(isPublicApiPath('/api/auth/session')).toBe(true);
      expect(isPublicApiPath('/api/auth/oauth')).toBe(true);
      expect(isPublicApiPath('/api/auth/oauth/google')).toBe(true);
      expect(isPublicApiPath('/api/auth/sso')).toBe(true);
    });

    it('rejects protected routes and private APIs', () => {
      expect(isPublicApiPath('/api/conversations')).toBe(false);
      expect(isPublicApiPath('/api/employees')).toBe(false);
      expect(isPublicApiPath('/api/settings')).toBe(false);
    });
  });

  describe('Password Hashing & Verification', () => {
    it('correctly hashes and verifies scrypt passwords', () => {
      const plain = 'SecurePassword123!';
      const hash = hashPassword(plain);

      expect(hash).toMatch(/^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
      expect(verifyPassword(plain, hash)).toBe(true);
      expect(verifyPassword('WrongPassword123!', hash)).toBe(false);
      expect(verifyPassword(plain, 'invalid_hash')).toBe(false);
    });
  });

  describe('Session Cookie Signing and Verification', () => {
    it('signs and verifies session user id', async () => {
      const userId = '11111111-2222-3333-4444-555555555555';
      const signed = await signSessionValue(userId, 0, Math.floor(Date.now() / 1000) + 3600);

      expect(signed).toContain('.');
      const parsed = await parseSessionCookie(signed);
      expect(parsed).toBe(userId);
    });

    it('rejects tampered or malformed session cookies', async () => {
      const userId = '11111111-2222-3333-4444-555555555555';
      const signed = await signSessionValue(userId, 0, Math.floor(Date.now() / 1000) + 3600);
      const tampered = signed.slice(0, -4) + '0000';

      const parsed = await parseSessionCookie(tampered);
      expect(parsed).toBeNull();

      expect(await parseSessionCookie('not-a-uuid')).toBeNull();
      expect(await parseSessionCookie('')).toBeNull();
    });
  });

  describe('Redirect Sanitization Safety', () => {
    function sanitizeRedirect(raw: string | null | undefined): string {
      return raw &&
        raw.startsWith('/') &&
        !raw.startsWith('//') &&
        !raw.startsWith('/login') &&
        !raw.startsWith('/register') &&
        !raw.startsWith('/api/')
        ? raw
        : '/';
    }

    it('allows valid relative dashboard paths', () => {
      expect(sanitizeRedirect('/dashboard')).toBe('/dashboard');
      expect(sanitizeRedirect('/ask-ai?q=test')).toBe('/ask-ai?q=test');
      expect(sanitizeRedirect('/conversations/123')).toBe('/conversations/123');
    });

    it('blocks open redirects and protocol-relative URLs', () => {
      expect(sanitizeRedirect('//evil.com')).toBe('/');
      expect(sanitizeRedirect('https://evil.com')).toBe('/');
      expect(sanitizeRedirect('javascript:alert(1)')).toBe('/');
    });

    it('prevents redirect loops and API exposure', () => {
      expect(sanitizeRedirect('/login')).toBe('/');
      expect(sanitizeRedirect('/login?foo=bar')).toBe('/');
      expect(sanitizeRedirect('/register')).toBe('/');
      expect(sanitizeRedirect('/api/auth/logout')).toBe('/');
      expect(sanitizeRedirect(null)).toBe('/');
      expect(sanitizeRedirect('')).toBe('/');
    });
  });
});
