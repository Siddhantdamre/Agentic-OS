/**
 * @jest-environment node
 *
 * Public sign-up and reset endpoints accept strings from anyone. Unbounded, a 10 KB e-mail reached the
 * identity layer and came back as HTTP 500 (a client mistake reported as a server failure), and a 100 KB
 * password was accepted and hashed. Both now stop at the door with a 400-class answer.
 */
import {
  MAX_EMAIL_LENGTH,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  isValidEmail,
  passwordLengthError,
} from '@/lib/password';

describe('isValidEmail', () => {
  it('accepts ordinary addresses', () => {
    expect(isValidEmail('owner@example.com')).toBe(true);
    expect(isValidEmail('  first.last+tag@sub.example.co.in ')).toBe(true);
  });

  it('rejects an address longer than 254 characters (RFC 5321) before any pattern runs', () => {
    const long = 'a'.repeat(10_000) + '@example.test';
    expect(isValidEmail(long)).toBe(false);
  });

  it('accepts exactly the limit and refuses one over', () => {
    const domain = '@example.test';
    const atLimit = 'a'.repeat(MAX_EMAIL_LENGTH - domain.length) + domain;
    expect(atLimit).toHaveLength(MAX_EMAIL_LENGTH);
    expect(isValidEmail(atLimit)).toBe(true);
    expect(isValidEmail('a' + atLimit)).toBe(false);
  });

  it('rejects malformed shapes', () => {
    for (const bad of ['', 'plain', '@x.co', 'a@', 'a@b', 'a b@c.co', 'a@@b.co']) {
      expect(isValidEmail(bad)).toBe(false);
    }
  });

  it('answers a pathological dotted string quickly (the pattern is quadratic without the length cap)', () => {
    const nasty = 'a@' + 'a.'.repeat(120) + '!';
    const t = Date.now();
    isValidEmail(nasty);
    expect(Date.now() - t).toBeLessThan(200);
  });
});

describe('passwordLengthError', () => {
  it('accepts a password inside the bounds', () => {
    expect(passwordLengthError('Aa1!aaaa')).toBeNull();
    expect(passwordLengthError('x'.repeat(MAX_PASSWORD_LENGTH))).toBeNull();
  });

  it('refuses one that is too short, naming the minimum', () => {
    expect(passwordLengthError('short')).toMatch(new RegExp(String(MIN_PASSWORD_LENGTH)));
    expect(passwordLengthError('')).not.toBeNull();
  });

  it('refuses one that is too long, naming the maximum', () => {
    expect(passwordLengthError('x'.repeat(MAX_PASSWORD_LENGTH + 1))).toMatch(new RegExp(String(MAX_PASSWORD_LENGTH)));
    expect(passwordLengthError('A1!a'.repeat(25_000))).not.toBeNull();
  });
});
