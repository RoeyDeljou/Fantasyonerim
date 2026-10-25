import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM encryption for secrets at rest (recovery codes now; social tokens and WhatsApp auth
 * state later). Payload format: `v1.<iv>.<tag>.<ciphertext>` (base64url parts).
 */
const VERSION = 'v1';
const IV_BYTES = 12;

export class SecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretsError';
  }
}

export function parseSecretsKey(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) throw new SecretsError('SECRETS_KEY must be 32 bytes (base64)');
  return key;
}

/** Deterministic key for local dev/tests only. Production refuses to start without SECRETS_KEY. */
export function devSecretsKey(): Buffer {
  return createHash('sha256').update('fantasyonerim-insecure-dev-key').digest();
}

export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/** Throws SecretsError when the payload is malformed, tampered with, or encrypted with another key. */
export function decryptSecret(key: Buffer, payload: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new SecretsError('Malformed secret payload');
  const [, ivPart, tagPart, ctPart] = parts as [string, string, string, string];
  const iv = Buffer.from(ivPart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== 16) throw new SecretsError('Malformed secret payload');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(ctPart, 'base64url')), decipher.final()]).toString(
      'utf8',
    );
  } catch {
    throw new SecretsError('Secret failed authentication (tampered or wrong key)');
  }
}
