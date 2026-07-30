// JATA Qi MFA — TOTP (RFC 6238) crypto primitives. Uses Node's built-in
// createHmac for HMAC-SHA1, matching the TOTP standard. No external deps.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Decode a Base32 string (RFC 4648) to a Buffer. */
export function base32Decode(encoded: string): Buffer {
  const clean = encoded.replace(/=+$/, '').toUpperCase();
  const bytes: number[] = [];
  let buffer = 0;
  let bitsLeft = 0;
  for (const char of clean) {
    const val = BASE32_ALPHABET.indexOf(char);
    if (val === -1) continue;
    buffer = (buffer << 5) | val;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bytes.push((buffer >> (bitsLeft - 8)) & 0xff);
      bitsLeft -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Encode a Buffer to a Base32 string (RFC 4648). */
export function base32Encode(buf: Buffer): string {
  let result = '';
  let buffer = 0;
  let bitsLeft = 0;
  for (const byte of buf) {
    buffer = (buffer << 8) | byte;
    bitsLeft += 8;
    while (bitsLeft >= 5) {
      result += BASE32_ALPHABET[(buffer >> (bitsLeft - 5)) & 0x1f];
      bitsLeft -= 5;
    }
  }
  if (bitsLeft > 0) {
    result += BASE32_ALPHABET[(buffer << (5 - bitsLeft)) & 0x1f];
  }
  return result;
}

/** Generate a random TOTP secret (Base32-encoded, 20 bytes = 160 bits per RFC 6238). */
export function generateSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

const DEFAULT_PERIOD = 30; // seconds
const DEFAULT_DIGITS = 6;

/**
 * Compute a TOTP code for the given Unix timestamp using HOTP with the
 * time step as the counter (RFC 6238 §4.2).
 */
export function computeTOTP(secret: string, timestamp: number = Date.now(), period: number = DEFAULT_PERIOD, digits: number = DEFAULT_DIGITS): string {
  const counter = Math.floor(timestamp / 1000 / period);
  const buf = Buffer.alloc(8);
  // Write counter as big-endian 64-bit.
  buf.writeBigUInt64BE(BigInt(counter));
  const key = base32Decode(secret);
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code = ((hmac[offset]! & 0x7f) << 24) | ((hmac[offset + 1]! & 0xff) << 16) | ((hmac[offset + 2]! & 0xff) << 8) | (hmac[offset + 3]! & 0xff);
  return (code % 10 ** digits).toString().padStart(digits, '0');
}

/**
 * Verify a TOTP code against the secret. Allows ±1 time window (current,
 * previous, next) to tolerate clock drift. Constant-time comparison.
 */
export function verifyTOTP(secret: string, token: string, timestamp: number = Date.now(), period: number = DEFAULT_PERIOD, digits: number = DEFAULT_DIGITS): boolean {
  const cleaned = token.replace(/\s/g, '');
  for (let offset = -1; offset <= 1; offset++) {
    const ts = timestamp + offset * period * 1000;
    const expected = computeTOTP(secret, ts, period, digits);
    if (cleaned.length === expected.length) {
      const a = Buffer.from(cleaned);
      const b = Buffer.from(expected);
      if (timingSafeEqual(a, b)) return true;
    }
  }
  return false;
}

/** Generate a set of one-time backup/recovery codes (8-char alphanumeric). */
export function generateBackupCodes(count = 10): string[] {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const buf = randomBytes(8);
    let code = '';
    for (let j = 0; j < 8; j++) code += chars[buf[j]! % chars.length];
    codes.push(`${code.slice(0, 4)}-${code.slice(4)}`);
  }
  return codes;
}

/** Hash a backup code for storage (SHA-256). */
export function hashBackupCode(code: string): string {
  return createHmac('sha256', 'jataqi-mfa').update(code).digest('hex');
}
