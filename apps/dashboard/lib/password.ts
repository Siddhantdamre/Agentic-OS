import crypto from 'crypto';

/**
 * Hash a password with a random salt using scrypt (Node built-in).
 * Format: scrypt$<saltHex>$<hashHex>
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

/**
 * Verify a password against a stored scrypt hash.
 */
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, salt, hash] = stored.split('$');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
    const a = Buffer.from(candidate, 'hex');
    const b = Buffer.from(hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function randomToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** RFC 5321: a mailbox address is at most 254 characters. */
export const MAX_EMAIL_LENGTH = 254;
export const MIN_PASSWORD_LENGTH = 8;
/** Far above any real passphrase; stops a megabyte body being hashed on a public endpoint. */
export const MAX_PASSWORD_LENGTH = 1024;

export function isValidEmail(email: string): boolean {
  const trimmed = email.trim();
  // Length first: it bounds the pattern below (quadratic on long dotted input) and keeps oversized
  // strings away from the identity layer, where they used to surface as HTTP 500.
  return trimmed.length <= MAX_EMAIL_LENGTH && EMAIL_RE.test(trimmed);
}

/** A user-facing reason the password is refused, or null when its length is acceptable. */
export function passwordLengthError(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  return null;
}
