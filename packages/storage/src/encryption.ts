// Encryption at rest — AES-256-GCM authenticated encryption for storage values,
// using only Node.js built-in crypto (zero external dependencies).
//
// Two payloads:
//  - seal/open:    text payloads (namespaces, collection docs) -> "v1:b64" token.
//  - sealBytes/openBytes: binary payloads (blobs) -> nonce(12)|tag(16)|ct bytes.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual, type CipherGCM, type DecipherGCM } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32;       // AES-256
const NONCE_LEN = 12;     // GCM standard nonce
const TAG_LEN = 16;
const VERSION = 'v1';
const PREFIX = `${VERSION}:`;

/** Normalize a key from a 44-char base64 string, 64-char hex string, Buffer,
 *  or arbitrary passphrase (derived via scrypt) to a 32-byte Buffer. */
export function normalizeKey(key: string | Buffer): Buffer {
  if (Buffer.isBuffer(key)) {
    if (key.length !== KEY_LEN) throw new Error(`storage: encryption key must be ${KEY_LEN} bytes (got ${key.length})`);
    return key;
  }
  const trimmed = key.trim();
  if (/^[A-Za-z0-9+/]{43}=$/.test(trimmed)) {        // base64 of 32 bytes
    return Buffer.from(trimmed, 'base64');
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {            // hex of 32 bytes
    return Buffer.from(trimmed, 'hex');
  }
  return deriveKey(trimmed);                           // passphrase -> scrypt
}

/** Derive a 32-byte key from arbitrary passphrase material via scrypt. */
function deriveKey(material: string): Buffer {
  return scryptSync(material, 'jataqi-storage-salt', KEY_LEN);
}
export class Cipher {
  private readonly key: Buffer;
  constructor(key: string | Buffer) {
    this.key = normalizeKey(key);
  }

  /** Encrypt a UTF-8 string -> "v1:<nonceB64>:<tagB64>:<ctB64>". */
  seal(plaintext: string): string {
    const nonce = randomBytes(NONCE_LEN);
    const cipher = createCipheriv(ALGO, this.key, nonce) as CipherGCM;
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${nonce.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
  }

  /** Decrypt a seal() token. Throws on tamper or wrong key (GCM auth failure). */
  open(token: string): string {
    if (typeof token !== 'string' || !token.startsWith(PREFIX)) throw new Error('storage: invalid ciphertext token');
    const parts = token.slice(PREFIX.length).split('.');
    if (parts.length !== 3) throw new Error('storage: malformed ciphertext token');
    const nonce = Buffer.from(parts[0]!, 'base64');
    const tag = Buffer.from(parts[1]!, 'base64');
    const ct = Buffer.from(parts[2]!, 'base64');
    const decipher = createDecipheriv(ALGO, this.key, nonce) as DecipherGCM;
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }

  /** Encrypt raw bytes -> nonce(12)|tag(16)|ct (single Buffer). */
  sealBytes(plain: Uint8Array): Uint8Array {
    const nonce = randomBytes(NONCE_LEN);
    const cipher = createCipheriv(ALGO, this.key, nonce) as CipherGCM;
    const ct = Buffer.concat([cipher.update(Buffer.from(plain)), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([nonce, tag, ct]);
  }

  /** Decrypt sealBytes() output. Throws on tamper or wrong key. */
  openBytes(sealed: Uint8Array): Uint8Array {
    const buf = Buffer.from(sealed);
    if (buf.length < NONCE_LEN + TAG_LEN) throw new Error('storage: ciphertext too short');
    const nonce = buf.subarray(0, NONCE_LEN);
    const tag = buf.subarray(NONCE_LEN, NONCE_LEN + TAG_LEN);
    const ct = buf.subarray(NONCE_LEN + TAG_LEN);
    const decipher = createDecipheriv(ALGO, this.key, nonce) as DecipherGCM;
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }
}

/** Generate a fresh 32-byte key, base64-encoded (for operators / tests). */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_LEN).toString('base64');
}

/** Constant-time string equality (for key comparison). */
export function keysEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
