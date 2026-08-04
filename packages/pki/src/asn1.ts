// asn1.ts — minimal DER (ASN.1) encoder for X.509 certificate construction.
// Implements exactly the subset of DER needed by RFC 5280: universal types,
// context-specific constructed tags, and OIDs. Encoding is strict DER
// (minimal-length INTEGERs, definite lengths) so node:crypto can parse and
// verify the produced certificates.

/** Universal ASN.1 tags used by X.509. */
export const Tags = Object.freeze({
  Boolean: 0x01,
  Integer: 0x02,
  BitString: 0x03,
  OctetString: 0x04,
  Null: 0x05,
  Oid: 0x06,
  Utf8String: 0x0c,
  PrintableString: 0x13,
  UtcTime: 0x17,
  GeneralizedTime: 0x18,
  Sequence: 0x30,
  Set: 0x31,
} as const);

export type DerNode = Buffer | DerNode[];

/** Encode a definite length (short or long form). */
export function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let n = length;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** Wrap content with a tag + length header. */
export function der(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

/** DER SEQUENCE of child elements. */
export function derSequence(...children: Buffer[]): Buffer {
  return der(Tags.Sequence, Buffer.concat(children));
}

/** DER SET of child elements. */
export function derSet(...children: Buffer[]): Buffer {
  return der(Tags.Set, Buffer.concat(children));
}

/** Context-specific constructed tag [n] EXPLICIT wrapping content. */
export function derContext(n: number, content: Buffer): Buffer {
  return der(0xa0 | n, content);
}

/** Context-specific primitive tag [n] with raw content. */
export function derContextPrimitive(n: number, content: Buffer): Buffer {
  return der(0x80 | n, content);
}

/** DER INTEGER with minimal (two's-complement) encoding. */
export function derInteger(value: bigint | number): Buffer {
  let hex = BigInt(value).toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let bytes = Buffer.from(hex, 'hex');
  // Strip leading zero bytes.
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0x00) start++;
  bytes = bytes.subarray(start);
  // Prepend 0x00 when the high bit is set (positive INTEGER).
  if (bytes.length === 0 || (bytes[0]! & 0x80) !== 0) {
    bytes = Buffer.concat([Buffer.from([0x00]), bytes]);
  }
  return der(Tags.Integer, bytes);
}

/** DER OBJECT IDENTIFIER (base-128 encoding). */
export function derOid(oid: string): Buffer {
  const parts = oid.split('.').map(Number);
  if (parts.length < 2) throw new Error(`invalid OID: ${oid}`);
  const first = parts[0]! * 40 + parts[1]!;
  const body: number[] = [first];
  for (const part of parts.slice(2)) {
    if (part < 128) {
      body.push(part);
    } else {
      const chunks = [part & 0x7f];
      let n = Math.floor(part / 128);
      while (n > 0) {
        chunks.unshift((n & 0x7f) | 0x80);
        n = Math.floor(n / 128);
      }
      body.push(...chunks);
    }
  }
  return der(Tags.Oid, Buffer.from(body));
}

/** DER OCTET STRING. */
export function derOctetString(content: Buffer): Buffer {
  return der(Tags.OctetString, content);
}

/** DER BIT STRING (0 unused bits, then content). */
export function derBitString(content: Buffer): Buffer {
  return der(Tags.BitString, Buffer.concat([Buffer.from([0x00]), content]));
}

/** DER NULL. */
export function derNull(): Buffer {
  return der(Tags.Null, Buffer.alloc(0));
}

/** DER UTF8String. */
export function derUtf8String(text: string): Buffer {
  return der(Tags.Utf8String, Buffer.from(text, 'utf8'));
}

/** DER PrintableString (ASCII subset). */
export function derPrintableString(text: string): Buffer {
  return der(Tags.PrintableString, Buffer.from(text, 'ascii'));
}

/** DER UTCTime (YYMMDDHHMMSSZ, years < 2050). */
export function derUtcTime(date: Date): Buffer {
  const y = date.getUTCFullYear();
  // toISOString() → "2026-08-04T13:46:03.123Z"; strip separators AND the ISO
  // 'T' so the encoded form is exactly YYMMDDHHMMSSZ (12 digits + Z).
  const s = date.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z';
  if (y >= 1950 && y < 2050) return der(Tags.UtcTime, Buffer.from(s, 'ascii'));
  return derGeneralizedTime(date);
}

/** DER GeneralizedTime (YYYYMMDDHHMMSSZ, years >= 2050). */
export function derGeneralizedTime(date: Date): Buffer {
  const s = date.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  return der(Tags.GeneralizedTime, Buffer.from(s, 'ascii'));
}

/** DER BOOLEAN. */
export function derBoolean(value: boolean): Buffer {
  return der(Tags.Boolean, Buffer.from([value ? 0xff : 0x00]));
}

/** OIDs used across the PKI package. */
export const Oids = Object.freeze({
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  idEcPublicKey: '1.2.840.10045.2.1',
  prime256v1: '1.2.840.10045.3.1.7',
  rsaEncryption: '1.2.840.113549.1.1.1',
  sha256WithRsa: '1.2.840.113549.1.1.11',
  commonName: '2.5.4.3',
  countryName: '2.5.4.6',
  localityName: '2.5.4.7',
  stateOrProvinceName: '2.5.4.8',
  organizationName: '2.5.4.10',
  organizationalUnitName: '2.5.4.11',
  emailAddress: '1.2.840.113549.1.9.1',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  subjectKeyIdentifier: '2.5.29.14',
  authorityKeyIdentifier: '2.5.29.35',
  crlDistributionPoints: '2.5.29.31',
  crlNumber: '2.5.29.20',
  serverAuth: '1.3.6.1.5.5.7.3.1',
  clientAuth: '1.3.6.1.5.5.7.3.2',
  codeSigning: '1.3.6.1.5.5.7.3.3',
} as const);
