// csr.ts — PKCS#10 (RFC 2986) certification request parsing + signature
// verification. Extracts the subject CN, subjectAltName DNS names, and the
// subject public key (EC P-256 or RSA) from a DER CSR, and verifies the
// request signature against that key. Used by the ACME finalize flow.

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import {
  DerReadError, ReadOids, decodeOid, readBitStringContent, readChildren,
  readInteger, readOctetStringContent, readString, readTlv,
} from './der-reader.js';
import type { KeyAlgorithm } from './x509.js';

export interface ParsedCsr {
  /** Common Name from the subject (when present). */
  commonName?: string;
  /** DNS names from the subjectAltName extension. */
  dnsNames: string[];
  /** Subject public key as a JWK. */
  publicKeyJwk: Record<string, string>;
  /** Key algorithm of the subject key. */
  algorithm: KeyAlgorithm;
  /** True when the CSR signature verifies against the subject key. */
  signatureValid: boolean;
}

/**
 * Parse a DER-encoded PKCS#10 certification request and verify its
 * self-signature. Throws DerReadError on malformed structure.
 */
export function parseCsr(der: Buffer): ParsedCsr {
  const root = readTlv(der, 0);
  if (root.tag !== 0x30) throw new DerReadError('CSR must be a SEQUENCE');
  const children = readChildren(der, root);
  const cri = children[0]!;
  const sigAlg = children[1]!;
  const sig = children[2]!;
  if (!cri || !sigAlg || !sig) throw new DerReadError('CSR missing certificationRequestInfo/signature');
  /** Byte offset of the certificationRequestInfo SEQUENCE tag. */
  const criOffset = root.contentStart;

  // CertificationRequestInfo ::= SEQUENCE { version, subject, subjectPKInfo, attributes [0] }
  const criChildren = readChildren(der, cri);
  if (criChildren.length < 3) throw new DerReadError('CSR info missing fields');
  const version = criChildren[0]!;
  const subject = criChildren[1]!;
  const spki = criChildren[2]!;
  if (version.tag !== 0x02) throw new DerReadError('CSR version must be INTEGER');
  if (readInteger(der, version) !== 0n) throw new DerReadError('unsupported CSR version');

  // Subject Name → commonName.
  const commonName = extractCommonName(der, subject);

  // SubjectPublicKeyInfo → JWK.
  const publicKeyJwk = parseSpkiJwk(der, spki);
  const algorithm: KeyAlgorithm = publicKeyJwk.kty === 'RSA' ? 'rsa-2048' : publicKeyJwk.crv === 'Ed25519' ? 'ed25519' : 'ec-p256';

  // Attributes [0] IMPLICIT → extensionRequest → subjectAltName.
  const dnsNames: string[] = [];
  const attrs = criChildren[3];
  if (attrs && attrs.tag === 0xa0) {
    dnsNames.push(...extractSanDns(der, attrs));
  }

  // Verify the signature over the certificationRequestInfo. There are two
  // conventions in the wild for the signed bytes (both in active use):
  //   1. The DER-encoded certificationRequestInfo TLV including its SEQUENCE
  //      header — what OpenSSL's `req -new` signs and `req -verify` checks
  //      (and what Go's crypto/x509 produces for ACME clients).
  //   2. The certificationRequestInfo VALUE (content without the header) —
  //      the literal RFC 2986 §4.2 reading, used by some strict encoders.
  // Accept either so CSRs from every mainstream client validate.
  const signature = readBitStringContent(der, sig);
  let signatureValid = false;
  try {
    const key = createPublicKey({ key: publicKeyJwk as never, format: 'jwk' });
    const tbsTlv = der.subarray(criOffset, cri.contentEnd);
    const tbsContent = der.subarray(cri.contentStart, cri.contentEnd);
    // RFC 2986: ECDSA CSR signatures are DER-encoded ECDSA-Sig-Value.
    signatureValid = cryptoVerify('sha256', tbsTlv, key, signature)
      || cryptoVerify('sha256', tbsContent, key, signature);
  } catch {
    signatureValid = false;
  }

  return { commonName, dnsNames, publicKeyJwk, algorithm, signatureValid };
}

function extractCommonName(buf: Buffer, subject: ReturnType<typeof readTlv>): string | undefined {
  if (subject.tag !== 0x30) return undefined;
  let cn: string | undefined;
  for (const rdn of readChildren(buf, subject)) {
    if (rdn.tag !== 0x31) continue;
    for (const attr of readChildren(buf, rdn)) {
      if (attr.tag !== 0x30) continue;
      const [oid, value] = readChildren(buf, attr);
      if (!oid || !value) continue;
      try {
        if (decodeOid(buf, oid) === ReadOids.commonName) {
          cn = readString(buf, value);
        }
      } catch { /* skip unreadable attributes */ }
    }
  }
  return cn;
}

/** Parse a SubjectPublicKeyInfo into a JWK (EC P-256 / RSA / Ed25519). */
export function parseSpkiJwk(buf: Buffer, spki: ReturnType<typeof readTlv>): Record<string, string> {
  const [alg, bitString] = readChildren(buf, spki);
  if (!alg || !bitString) throw new DerReadError('SPKI missing algorithm or key');
  const algChildren = readChildren(buf, alg);
  const oid = decodeOid(buf, algChildren[0]!);
  const keyBits = readBitStringContent(buf, bitString);

  if (oid === ReadOids.idEcPublicKey) {
    const crvOid = decodeOid(buf, algChildren[1]!);
    if (crvOid !== ReadOids.prime256v1) throw new DerReadError(`unsupported EC curve ${crvOid}`);
    if (keyBits.length !== 65 || keyBits[0] !== 0x04) throw new DerReadError('expected uncompressed P-256 point');
    return {
      kty: 'EC',
      crv: 'P-256',
      x: keyBits.subarray(1, 33).toString('base64url'),
      y: keyBits.subarray(33, 65).toString('base64url'),
    };
  }
  if (oid === ReadOids.rsaEncryption) {
    const rsa = readTlv(keyBits, 0);
    const rsaChildren = readChildren(keyBits, rsa);
    const n = rsaChildren[0]!;
    const e = rsaChildren[1]!;
    return {
      kty: 'RSA',
      n: bigintToBase64Url(readInteger(keyBits, n)),
      e: bigintToBase64Url(readInteger(keyBits, e)),
    };
  }
  throw new DerReadError(`unsupported SPKI algorithm ${oid}`);
}

function extractSanDns(buf: Buffer, attrs: ReturnType<typeof readTlv>): string[] {
  const out: string[] = [];
  for (const attr of readChildren(buf, attrs)) {
    if (attr.tag !== 0x30) continue;
    const [oid, value] = readChildren(buf, attr);
    if (!oid || !value) continue;
    if (decodeOid(buf, oid) !== ReadOids.extensionRequest) continue;
    // value is a SET containing Extensions.
    for (const setEl of readChildren(buf, value)) {
      for (const ext of readChildren(buf, setEl)) {
        const [extOid, extValue] = readChildren(buf, ext);
        if (!extOid || !extValue) continue;
        if (decodeOid(buf, extOid) !== ReadOids.subjectAltName) continue;
        // extValue is an OCTET STRING containing GeneralNames.
        const generalNames = readOctetStringContent(buf, extValue);
        const gnRoot = readTlv(generalNames, 0);
        for (const gn of readChildren(generalNames, gnRoot)) {
          if (gn.tag === 0x82) out.push(generalNames.subarray(gn.contentStart, gn.contentEnd).toString('utf8'));
        }
      }
    }
  }
  return out;
}

function bigintToBase64Url(v: bigint): string {
  let hex = v.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return Buffer.from(hex, 'hex').toString('base64url');
}
