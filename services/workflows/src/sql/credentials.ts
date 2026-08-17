import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const PREFIX = 'v1';
const KEY_ENV = 'ORG_SQL_ENCRYPTION_KEY';

export class SqlCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqlCredentialError';
  }
}

export function encryptionKeyConfigured(): boolean {
  return Boolean(process.env[KEY_ENV]?.trim());
}

export function loadOrgSqlEncryptionKey(): Buffer {
  const raw = (process.env[KEY_ENV] || '').trim();
  if (!raw) {
    throw new SqlCredentialError(
      `${KEY_ENV} is not set. Org SQL passwords cannot be stored or decrypted.`,
    );
  }
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  const fromB64 = Buffer.from(raw, 'base64');
  if (fromB64.length === 32) return fromB64;
  throw new SqlCredentialError(
    `${KEY_ENV} must be 32 bytes as hex (64 chars) or standard base64.`,
  );
}

/** AES-256-GCM. Format: v1.<iv_b64url>.<tag_b64url>.<ct_b64url> */
export function encryptSecret(plaintext: string): string {
  const key = loadOrgSqlEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join('.');
}

export function decryptSecret(packed: string): string {
  const key = loadOrgSqlEncryptionKey();
  const parts = String(packed || '').split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new SqlCredentialError('SQL password ciphertext is not a recognized v1 payload');
  }
  const iv = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[2], 'base64url');
  const data = Buffer.from(parts[3], 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
