import argon2 from 'argon2';

const OPTIONS = { type: argon2.argon2id } as const;

export function hashSecret(plain: string): Promise<string> {
  return argon2.hash(plain, OPTIONS);
}

export async function verifySecret(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/** Burns the same time as a real verify so unknown usernames aren't distinguishable by latency. */
export async function verifyAgainstDummy(plain: string): Promise<false> {
  dummyHash ??= argon2.hash('dummy-password-for-timing', OPTIONS);
  await verifySecret(await dummyHash, plain);
  return false;
}
