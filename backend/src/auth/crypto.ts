import { createHash, randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';

/** 256-bit random secret, URL-safe. Used for session cookies and one-time links. */
export const newToken = (): string => randomBytes(32).toString('base64url');

/** High-entropy tokens only need a fast hash; only this hash is stored. */
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

// OWASP baseline for argon2id.
const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export const hashPassword = (password: string): Promise<string> => argon2.hash(password, ARGON2_OPTIONS);

export const verifyPassword = (hash: string, password: string): Promise<boolean> =>
  argon2.verify(hash, password).catch(() => false);

let dummyHash: Promise<string> | undefined;

/** Spend the same time as a real check when the account doesn't exist, so timing doesn't reveal it. */
export async function burnPasswordCheck(password: string): Promise<false> {
  dummyHash ??= hashPassword('placeholder-password-for-timing');
  await verifyPassword(await dummyHash, password);
  return false;
}
