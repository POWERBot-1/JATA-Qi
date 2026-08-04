// Password hashing & token generation using Node's built-in crypto (no deps).
//
// We use scrypt (memory-hard, salted) for passwords and crypto.randomBytes for
// opaque bearer tokens and API keys.

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LEN = 32;

export interface HashedSecret {
  hash: string;
  salt: string;
}

export function hashSecret(secret: string, saltLen = 16): HashedSecret {
  const salt = randomBytes(saltLen);
  const hash = scryptSync(secret, salt, KEY_LEN);
  return { hash: hash.toString('base64'), salt: salt.toString('base64') };
}

export function verifySecret(secret: string, stored: HashedSecret): boolean {
  const salt = Buffer.from(stored.salt, 'base64');
  const expected = Buffer.from(stored.hash, 'base64');
  const actual = scryptSync(secret, salt, KEY_LEN);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** Generate a cryptographically-random opaque token (default 256 bits, hex). */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

/** Format a bearer token, accepting "Bearer <token>" or a raw token. */
export function extractBearer(header: string | undefined | null): string | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^bearer\s+/i.test(trimmed)) return trimmed.replace(/^bearer\s+/i, '').trim();
  return trimmed || undefined;
}
