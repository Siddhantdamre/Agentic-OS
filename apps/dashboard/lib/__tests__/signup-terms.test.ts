import { isSignupTermsAccepted } from '../signup-terms';

describe('isSignupTermsAccepted', () => {
  it('accepts only boolean true', () => {
    expect(isSignupTermsAccepted(true)).toBe(true);
  });

  it('rejects missing, false, and stringly true', () => {
    expect(isSignupTermsAccepted(undefined)).toBe(false);
    expect(isSignupTermsAccepted(false)).toBe(false);
    expect(isSignupTermsAccepted('true')).toBe(false);
    expect(isSignupTermsAccepted(1)).toBe(false);
  });
});
