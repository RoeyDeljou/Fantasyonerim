import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretsError, decryptSecret, encryptSecret, parseSecretsKey } from './secrets.js';

const key = randomBytes(32);

describe('AES-256-GCM secrets helper', () => {
  it('roundtrips, with a fresh IV each time', () => {
    const a = encryptSecret(key, 'ABCD-EFGH');
    const b = encryptSecret(key, 'ABCD-EFGH');
    expect(a).not.toBe(b);
    expect(a).not.toContain('ABCD');
    expect(decryptSecret(key, a)).toBe('ABCD-EFGH');
    expect(decryptSecret(key, encryptSecret(key, 'שלום 🔐'))).toBe('שלום 🔐');
  });

  it('detects tampering with ciphertext, tag or iv', () => {
    const payload = encryptSecret(key, 'secret-token');
    const parts = payload.split('.');
    for (const index of [1, 2, 3]) {
      const tampered = [...parts];
      const buf = Buffer.from(tampered[index] ?? '', 'base64url');
      buf[0] = (buf[0] ?? 0) ^ 0xff;
      tampered[index] = buf.toString('base64url');
      expect(() => decryptSecret(key, tampered.join('.'))).toThrow(SecretsError);
    }
  });

  it('rejects the wrong key and malformed payloads', () => {
    const payload = encryptSecret(key, 'secret-token');
    expect(() => decryptSecret(randomBytes(32), payload)).toThrow(SecretsError);
    expect(() => decryptSecret(key, 'garbage')).toThrow(SecretsError);
    expect(() => decryptSecret(key, payload.replace(/^v1/, 'v2'))).toThrow(SecretsError);
  });

  it('parses a 32-byte base64 key only', () => {
    expect(parseSecretsKey(key.toString('base64')).equals(key)).toBe(true);
    expect(() => parseSecretsKey(randomBytes(16).toString('base64'))).toThrow(SecretsError);
  });
});
