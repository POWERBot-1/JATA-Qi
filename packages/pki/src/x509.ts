// x509.ts — X.509 v3 certificate + CRL construction (RFC 5280) on top of the
// DER encoder, using real node:crypto keys (ECDSA P-256 or RSA). Produces
// standard DER certificates that node:crypto can parse and verify.

import { createHash, generateKeyPairSync, randomUUID, sign, createPublicKey, X509Certificate } from 'node:crypto';
import {
  derBitString, derBoolean, derContext, derContextPrimitive, derInteger, derNull,
  derOctetString, derOid, derPrintableString, derSequence, derSet, derUtcTime,
  derUtf8String, Oids, Tags, der,
} from './asn1.js';

// ---- key material ---------------------------------------------------------

export type KeyAlgorithm = 'ec-p256' | 'rsa-2048' | 'ed25519';

export interface KeyPair {
  algorithm: KeyAlgorithm;
  privateKey: string; // PEM PKCS8
  publicKey: string; // PEM SPKI
  /** JWK of the public key (for encoding + JWKS). */
  jwk: Record<string, string>;
}

/** Generate a key pair for CA or end-entity certificates. */
export function generateKeyPair(algorithm: KeyAlgorithm = 'ec-p256'): KeyPair {
  let privateKey: string;
  let publicKey: string;
  let jwk: Record<string, string>;
  if (algorithm === 'ec-p256') {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }) as string;
    jwk = pair.publicKey.export({ format: 'jwk' }) as Record<string, string>;
  } else if (algorithm === 'rsa-2048') {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }) as string;
    jwk = pair.publicKey.export({ format: 'jwk' }) as Record<string, string>;
  } else {
    const pair = generateKeyPairSync('ed25519');
    privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }) as string;
    jwk = pair.publicKey.export({ format: 'jwk' }) as Record<string, string>;
  }
  return { algorithm, privateKey, publicKey, jwk };
}

/** Encode a SubjectPublicKeyInfo from a public JWK (EC P-256 or RSA). */
export function encodeSpki(jwk: Record<string, string>): Buffer {
  if (jwk.kty === 'EC' && jwk.crv === 'P-256') {
    const x = Buffer.from(jwk.x ?? '', 'base64url');
    const y = Buffer.from(jwk.y ?? '', 'base64url');
    if (x.length !== 32 || y.length !== 32) throw new Error('invalid P-256 public key');
    const point = Buffer.concat([Buffer.from([0x04]), x, y]);
    const alg = derSequence(derOid(Oids.idEcPublicKey), derOid(Oids.prime256v1));
    return derSequence(alg, derBitString(point));
  }
  if (jwk.kty === 'RSA') {
    const n = Buffer.from(jwk.n ?? '', 'base64url');
    const e = Buffer.from(jwk.e ?? '', 'base64url');
    const alg = derSequence(derOid(Oids.rsaEncryption), derNull());
    const spki = derSequence(derInteger(BigInt('0x' + n.toString('hex'))), derInteger(BigInt('0x' + e.toString('hex'))));
    return derSequence(alg, derBitString(spki));
  }
  throw new Error(`unsupported key type ${jwk.kty}/${jwk.crv}`);
}

// ---- names ----------------------------------------------------------------

/** A single relative distinguished name attribute. */
export interface DnAttribute {
  oid: string;
  value: string;
}

/** Encode a Name (RDNSequence) from attributes; CN uses UTF8String. */
export function encodeName(attributes: DnAttribute[]): Buffer {
  const rdns = attributes.map((attr) => {
    const value = attr.oid === Oids.commonName || attr.oid === Oids.emailAddress
      ? derUtf8String(attr.value)
      : derPrintableString(attr.value);
    return derSet(derSequence(derOid(attr.oid), value));
  });
  return derSequence(...rdns);
}

// ---- extensions -----------------------------------------------------------

export interface CertExtensions {
  ca?: boolean;
  keyUsage?: string[]; // 'digitalSignature' | 'keyEncipherment' | 'keyCertSign' | 'cRLSign' | ...
  extendedKeyUsage?: string[]; // OIDs (serverAuth/clientAuth/codeSigning)
  sanDnsNames?: string[];
  sanIpAddresses?: string[];
  crlDistributionPoints?: string[];
  subjectKeyIdentifier?: Buffer;
  authorityKeyIdentifier?: Buffer;
}

const KEY_USAGE_BITS: Record<string, number> = {
  digitalSignature: 0,
  nonRepudiation: 1,
  keyEncipherment: 2,
  dataEncipherment: 3,
  keyAgreement: 4,
  keyCertSign: 5,
  cRLSign: 6,
  encipherOnly: 7,
  decipherOnly: 8,
};

/** Build the Extensions SEQUENCE for a certificate. */
export function encodeExtensions(ext: CertExtensions): Buffer {
  const list: Buffer[] = [];

  // basicConstraints (CA true/false + optional pathLen).
  if (ext.ca !== undefined) {
    const content = ext.ca
      ? derSequence(derBoolean(true))
      : derSequence();
    const fields = [derOid(Oids.basicConstraints)];
    if (ext.ca) fields.push(derBoolean(true)); // critical for CA certs
    fields.push(derOctetString(content));
    list.push(derSequence(...fields));
  }

  // keyUsage bit string (9 bits max). The BIT STRING content carries the
  // unused-bits count as its first octet.
  if (ext.keyUsage?.length) {
    const bits = new Array<number>(9).fill(0);
    let maxBit = 0;
    for (const name of ext.keyUsage) {
      const bit = KEY_USAGE_BITS[name];
      if (bit === undefined) throw new Error(`unknown key usage ${name}`);
      bits[bit] = 1;
      maxBit = Math.max(maxBit, bit);
    }
    const byteLen = Math.floor(maxBit / 8) + 1;
    const bytes = Buffer.alloc(byteLen);
    for (let b = 0; b <= maxBit; b++) {
      if (bits[b] === 1) bytes[Math.floor(b / 8)]! |= 0x80 >> (b % 8);
    }
    const unused = 8 - ((maxBit + 1) % 8 || 8);
    list.push(derSequence(
      derOid(Oids.keyUsage),
      derOctetString(der(Tags.BitString, Buffer.concat([Buffer.from([unused]), bytes]))),
    ));
  }

  // extendedKeyUsage OIDs.
  if (ext.extendedKeyUsage?.length) {
    list.push(derSequence(
      derOid(Oids.extKeyUsage),
      derOctetString(derSequence(...ext.extendedKeyUsage.map((oid) => derOid(oid)))),
    ));
  }

  // subjectAltName: dNSName [2] IMPLICIT IA5String, iPAddress [7] IMPLICIT.
  if (ext.sanDnsNames?.length || ext.sanIpAddresses?.length) {
    const general = [
      ...(ext.sanDnsNames ?? []).map((d) => derContextPrimitive(2, Buffer.from(d, 'ascii'))),
      ...(ext.sanIpAddresses ?? []).map((ip) => derContextPrimitive(7, ipv4ToBuffer(ip))),
    ];
    list.push(derSequence(derOid(Oids.subjectAltName), derOctetString(derSequence(...general))));
  }

  // subjectKeyIdentifier (SHA-1 of the subject public key BIT STRING content).
  // KeyIdentifier ::= OCTET STRING, so the extnValue (DER of the value) is an
  // OCTET STRING whose content is itself an OCTET STRING (matches OpenSSL).
  if (ext.subjectKeyIdentifier) {
    list.push(derSequence(derOid(Oids.subjectKeyIdentifier), derOctetString(derOctetString(ext.subjectKeyIdentifier))));
  }

  // authorityKeyIdentifier [0] IMPLICIT OCTET STRING (issuer SKI).
  if (ext.authorityKeyIdentifier) {
    const inner = derSequence(derContextPrimitive(0, ext.authorityKeyIdentifier));
    list.push(derSequence(derOid(Oids.authorityKeyIdentifier), derOctetString(inner)));
  }

  // crlDistributionPoints: [0] EXPLICIT DistributionPoint { [0] EXPLICIT fullName [0] uniformResourceIdentifier }.
  if (ext.crlDistributionPoints?.length) {
    const points = ext.crlDistributionPoints.map((uri) => {
      const fullName = derContext(0, derSequence(derContextPrimitive(6, Buffer.from(uri, 'ascii'))));
      return derContext(0, fullName);
    });
    list.push(derSequence(derOid(Oids.crlDistributionPoints), derOctetString(derSequence(...points))));
  }

  if (list.length === 0) return Buffer.alloc(0);
  return derContext(3, derSequence(...list));
}

/** SHA-1 of a public-key BIT STRING → SubjectKeyIdentifier value. */
export function computeSubjectKeyId(jwk: Record<string, string>): Buffer {
  const spki = encodeSpki(jwk);
  // spki = SEQUENCE(alg, BIT STRING(0x00 || point)) — SKI is SHA-1 of the
  // BIT STRING value (including the unused-bits octet).
  const bitString = spki.subarray(spki.length - 65);
  return createHash('sha1').update(bitString).digest();
}

// ---- certificate ----------------------------------------------------------

export interface CertificateOptions {
  serialNumber?: bigint;
  subject: DnAttribute[];
  issuer: DnAttribute[];
  notBefore: Date;
  notAfter: Date;
  subjectPublicKeyJwk: Record<string, string>;
  /** Algorithm identifier matching the issuer key. */
  signatureOid: string;
  extensions?: CertExtensions;
}

/** Build the TBSCertificate SEQUENCE. */
export function buildTbsCertificate(opts: CertificateOptions): Buffer {
  const signatureAlg = derSequence(derOid(opts.signatureOid));
  const extensions = encodeExtensions(opts.extensions ?? {});
  return derSequence(
    derContext(0, derInteger(2)), // version v3
    derInteger(opts.serialNumber ?? randomSerial()),
    signatureAlg,
    encodeName(opts.issuer),
    derSequence(derUtcTime(opts.notBefore), derUtcTime(opts.notAfter)),
    encodeName(opts.subject),
    encodeSpki(opts.subjectPublicKeyJwk),
    ...(extensions.length > 0 ? [extensions] : []),
  );
}

/**
 * RFC 5480 §2.2: the signatureValue BIT STRING of an ECDSA certificate MUST
 * contain the DER encoding of the ECDSA-Sig-Value (SEQUENCE { r, s }), not
 * the raw r||s form used by the EVP APIs.
 */
export function ecdsaDerSignature(raw: Buffer): Buffer {
  if (raw.length !== 64) throw new Error(`unexpected raw ECDSA signature length ${raw.length}`);
  const r = derInteger(BigInt('0x' + raw.subarray(0, 32).toString('hex')));
  const s = derInteger(BigInt('0x' + raw.subarray(32, 64).toString('hex')));
  return derSequence(r, s);
}

/** Build a full DER certificate (TBS + signature). */
export function signCertificate(opts: CertificateOptions & { issuerPrivateKey: string | Buffer }): Buffer {
  const tbs = buildTbsCertificate(opts);
  const raw = sign('sha256', tbs, {
    key: opts.issuerPrivateKey,
    dsaEncoding: opts.signatureOid === Oids.ecdsaWithSha256 ? 'ieee-p1363' : undefined,
  });
  const signature = opts.signatureOid === Oids.ecdsaWithSha256 ? ecdsaDerSignature(raw) : raw;
  const signatureAlg = derSequence(derOid(opts.signatureOid));
  return derSequence(tbs, signatureAlg, derBitString(signature));
}

/** Parse a DER certificate with node:crypto (throws on invalid DER). */
export function parseCertificate(derBuffer: Buffer): X509Certificate {
  return new X509Certificate(derBuffer);
}

// ---- CRL (RFC 5280 §5.1) --------------------------------------------------

export interface RevokedCert {
  serialNumber: bigint;
  revocationDate: Date;
  reason?: 'keyCompromise' | 'cACompromise' | 'affiliationChanged' | 'superseded' | 'cessationOfOperation' | 'certificateHold' | 'removeFromCRL';
}

/** Build a signed CRL (v2 with CRL number extension). */
export function signCrl(opts: {
  issuer: DnAttribute[];
  thisUpdate: Date;
  nextUpdate: Date;
  revoked: RevokedCert[];
  issuerPrivateKey: string | Buffer;
  signatureOid: string;
  crlNumber: bigint;
}): Buffer {
  const signatureAlg = derSequence(derOid(opts.signatureOid));
  const revokedSeq = opts.revoked.length > 0
    ? derSequence(...opts.revoked.map((r) => derSequence(
        derInteger(r.serialNumber),
        derUtcTime(r.revocationDate),
      )))
    : Buffer.alloc(0);
  const crlNumberExt = derSequence(derOid(Oids.crlNumber), derOctetString(derInteger(opts.crlNumber)));
  const tbs = derSequence(
    derInteger(1), // v2
    signatureAlg,
    encodeName(opts.issuer),
    derUtcTime(opts.thisUpdate),
    derUtcTime(opts.nextUpdate),
    ...(opts.revoked.length > 0 ? [revokedSeq] : []),
    derContext(0, derSequence(crlNumberExt)),
  );
  const raw = sign('sha256', tbs, {
    key: opts.issuerPrivateKey,
    dsaEncoding: opts.signatureOid === Oids.ecdsaWithSha256 ? 'ieee-p1363' : undefined,
  });
  const signature = opts.signatureOid === Oids.ecdsaWithSha256 ? ecdsaDerSignature(raw) : raw;
  return derSequence(tbs, signatureAlg, derBitString(signature));
}

// ---- helpers --------------------------------------------------------------

function randomSerial(): bigint {
  return BigInt('0x' + randomUUID().replace(/-/g, '').slice(0, 16));
}

function ipv4ToBuffer(ip: string): Buffer {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`invalid IPv4 address ${ip}`);
  }
  return Buffer.from(parts);
}

/** Public key object from a JWK (for node:crypto verification). */
export function publicKeyFromJwk(jwk: Record<string, string>) {
  return createPublicKey({ key: jwk, format: 'jwk' });
}

/** Tags re-export for advanced use. */
export { Tags };
