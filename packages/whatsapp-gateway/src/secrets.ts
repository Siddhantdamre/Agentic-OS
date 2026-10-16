import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encrypts channel tokens (the customer's Meta access token) before they are
 * stored in `channels.meta`. AES-256-GCM, format `enc:v1.<iv>.<tag>.<ciphertext>`
 * (base64url). Key: CHANNEL_SECRETS_KEY, 32 bytes as 64 hex chars or base64.
 * Values without the `enc:v1.` prefix are treated as legacy plaintext and pass
 * through `openSecret` unchanged, so old rows keep working until re-sealed.
 */

const PREFIX = 'enc:v1.';
const KEY_ENV = 'CHANNEL_SECRETS_KEY';

export class SecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretError';
  }
}

function loadKey(): Buffer {
  const raw = (process.env[KEY_ENV] || '').trim();
  if (!raw) throw new SecretError(`${KEY_ENV} is not set`);
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  const b = Buffer.from(raw, 'base64');
  if (b.length === 32) return b;
  throw new SecretError(`${KEY_ENV} must be 32 bytes as hex (64 chars) or base64`);
}

export function secretsKeyConfigured(): boolean {
  try {
    loadKey();
    return true;
  } catch {
    return false;
  }
}

export function isSealed(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function sealSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', loadKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX + [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
}

/** Plaintext for a stored value. Throws SecretError when a sealed value cannot be opened. */
export function openSecret(value: string): string {
  if (!isSealed(value)) return value;
  const parts = value.slice(PREFIX.length).split('.');
  if (parts.length !== 3) throw new SecretError('Stored secret is malformed');
  try {
    const decipher = createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(parts[0], 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[1], 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64url')), decipher.final()]).toString('utf8');
  } catch (err) {
    if (err instanceof SecretError) throw err;
    throw new SecretError(`Stored secret cannot be decrypted (wrong ${KEY_ENV}?)`);
  }
}

/** `EAAG…x9Zk`: enough to recognise a token, never enough to use it. */
export function secretHint(plain: string): string {
  return plain.length <= 8 ? '…' : `${plain.slice(0, 4)}…${plain.slice(-4)}`;
}
