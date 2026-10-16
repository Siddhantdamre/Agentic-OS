/** Email signup must send an explicit true. Missing or false is not consent. */
export function isSignupTermsAccepted(value: unknown): boolean {
  return value === true;
}
