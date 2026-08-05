// der-reader.ts — minimal DER (ASN.1) parser for PKCS#10 CSR processing and
// certificate inspection. Complements the encoder in asn1.ts with read-side
// helpers: TLV walking, OID decoding, INTEGER/BIT STRING/OCTET STRING reads.
// Strict about definite lengths (DER) and bounds.

export interface DerTlv {
  /** Universal/context tag byte. */
  tag: number;
  /** Content length in bytes. */
  length: number;
  /** Offset of the first content byte. */
  contentStart: number;
  /** Offset one past the last content byte. */
  contentEnd: number;
  /** True when the tag has the constructed bit set. */
  constructed: boolean;
}

export class DerReadError extends Error {
  constructor(message: string) {
    super(`DER read error: ${message}`);
    this.name = 'DerReadError';
  }
}

/** Read a single TLV at `offset`; throws when the buffer is exhausted. */
export function readTlv(buf: Buffer, offset: number): DerTlv {
  if (offset >= buf.length) throw new DerReadError(`offset ${offset} out of range`);
  const tag = buf[offset]!;
  if (offset + 1 >= buf.length) throw new DerReadError('truncated tag');
  let len = buf[offset + 1]!;
  let contentStart = offset + 2;
  if ((len & 0x80) !== 0) {
    const n = len & 0x7f;
    if (n === 0) throw new DerReadError('indefinite lengths are not DER');
    if (n > 4) throw new DerReadError(`length field too large (${n} bytes)`);
    if (contentStart + n > buf.length) throw new DerReadError('truncated length field');
    len = 0;
    for (let i = 0; i < n; i++) {
      len = len * 256 + buf[contentStart]!;
      contentStart++;
    }
  }
  const contentEnd = contentStart + len;
  if (contentEnd > buf.length) throw new DerReadError(`content exceeds buffer (${contentEnd} > ${buf.length})`);
  return {
    tag,
    length: len,
    contentStart,
    contentEnd,
    constructed: (tag & 0x20) !== 0,
  };
}

/** Read a SEQUENCE (or SET) and return its child TLVs. */
export function readChildren(buf: Buffer, tlv: DerTlv): DerTlv[] {
  if (!tlv.constructed) throw new DerReadError(`tag 0x${tlv.tag.toString(16)} is not constructed`);
  const children: DerTlv[] = [];
  let off = tlv.contentStart;
  while (off < tlv.contentEnd) {
    const child = readTlv(buf, off);
    children.push(child);
    off = child.contentEnd;
  }
  return children;
}

/** Decode an OBJECT IDENTIFIER content into dotted notation. */
export function decodeOid(buf: Buffer, tlv: DerTlv): string {
  const content = buf.subarray(tlv.contentStart, tlv.contentEnd);
  if (content.length === 0) throw new DerReadError('empty OID');
  const parts: number[] = [];
  const first = content[0]!;
  parts.push(Math.floor(first / 40), first % 40);
  let value = 0;
  for (let i = 1; i < content.length; i++) {
    const byte = content[i]!;
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      parts.push(value);
      value = 0;
    }
  }
  if (value !== 0) throw new DerReadError('truncated OID base-128 value');
  return parts.join('.');
}

/** Read the content of a BIT STRING (skipping the unused-bits octet). */
export function readBitStringContent(buf: Buffer, tlv: DerTlv): Buffer {
  if (tlv.length < 1) throw new DerReadError('empty BIT STRING');
  return buf.subarray(tlv.contentStart + 1, tlv.contentEnd);
}

/** Read the content of an OCTET STRING. */
export function readOctetStringContent(buf: Buffer, tlv: DerTlv): Buffer {
  return buf.subarray(tlv.contentStart, tlv.contentEnd);
}

/** Decode an INTEGER content into a bigint. */
export function readInteger(buf: Buffer, tlv: DerTlv): bigint {
  const content = buf.subarray(tlv.contentStart, tlv.contentEnd);
  if (content.length === 0) throw new DerReadError('empty INTEGER');
  let value = 0n;
  for (const byte of content) value = (value << 8n) | BigInt(byte);
  // Two's complement sign.
  if ((content[0]! & 0x80) !== 0) {
    const bitlen = BigInt(content.length * 8);
    value -= 1n << bitlen;
  }
  return value;
}

/** Read a UTF8String / PrintableString / IA5String content as text. */
export function readString(buf: Buffer, tlv: DerTlv): string {
  return buf.subarray(tlv.contentStart, tlv.contentEnd).toString('utf8');
}

/** OIDs used when parsing CSRs and certificates. */
export const ReadOids = Object.freeze({
  extensionRequest: '1.2.840.113549.1.9.14',
  subjectAltName: '2.5.29.17',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  idEcPublicKey: '1.2.840.10045.2.1',
  prime256v1: '1.2.840.10045.3.1.7',
  rsaEncryption: '1.2.840.113549.1.1.1',
  sha256WithRsa: '1.2.840.113549.1.1.11',
  commonName: '2.5.4.3',
} as const);
