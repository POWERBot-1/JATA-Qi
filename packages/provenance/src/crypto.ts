// Cryptographic primitives for JQ-CIP. Real public-key signatures (Ed25519)
// via Node's built-in crypto, plus deterministic canonicalization and SHA-256
// fingerprinting. The algorithm is pluggable (SIGNATURE_ALG) to allow future
// post-quantum migration.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

export const SIGNATURE_ALG = 'ed25519';
export const HASH_ALG = 'sha256';

/** Deterministic canonical JSON (sorted keys, recursively) so signatures are stable. */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJSON(obj[k])).join(',') + '}';
}

/** SHA-256 fingerprint, returned as lowercase hex. */
export function fingerprint(value: unknown | string): string {
  const data = typeof value === 'string' ? value : canonicalJSON(value);
  return createHash(HASH_ALG).update(data, 'utf8').digest('hex');
}

export interface KeyPair {
  publicKeyDer: Buffer; // SPKI DER
  privateKeyDer: Buffer; // PKCS#8 DER
}

/** Generate a fresh Ed25519 key pair. */
export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync(SIGNATURE_ALG);
  return {
    publicKeyDer: publicKey.export({ format: 'der', type: 'spki' }),
    privateKeyDer: privateKey.export({ format: 'der', type: 'pkcs8' }),
  };
}

export function toBase64(buf: Buffer): string {
  return buf.toString('base64');
}
export function fromBase64(b64: string): Buffer {
  return Buffer.from(b64, 'base64');
}

/** Sign data (string or object) with an Ed25519 private key (DER, base64). */
export function signData(data: unknown | string, privateKeyDerB64: string): string {
  const key = createPrivateKey({ key: fromBase64(privateKeyDerB64), format: 'der', type: 'pkcs8' });
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(canonicalJSON(data), 'utf8');
  return toBase64(sign(null, bytes, key));
}

/** Verify a signature against data using a public key (DER, base64). */
export function verifyData(data: unknown | string, signatureB64: string, publicKeyDerB64: string): boolean {
  try {
    const key = createPublicKey({ key: fromBase64(publicKeyDerB64), format: 'der', type: 'spki' });
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(canonicalJSON(data), 'utf8');
    return verify(null, bytes, key, fromBase64(signatureB64));
  } catch {
    return false;
  }
}

/** Derive the public key (base64 SPKI DER) from a private key (base64 PKCS#8 DER). */
export function publicKeyFromPrivate(privateKeyDerB64: string): string {
  const key = createPrivateKey({ key: fromBase64(privateKeyDerB64), format: 'der', type: 'pkcs8' });
  const pub = createPublicKey(key);
  return toBase64(pub.export({ format: 'der', type: 'spki' }));
}
