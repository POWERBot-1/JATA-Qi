// WebSocket frame codec — RFC 6455 Section 5.2. Pure Node (Buffer), zero deps.
// Encodes server→client frames (unmasked) and decodes client→server frames
// (masked, per spec) including 7/16/64-bit payload lengths and fragmentation.

export const Opcode = {
  CONTINUATION: 0,
  TEXT: 1,
  BINARY: 2,
  CLOSE: 8,
  PING: 9,
  PONG: 10,
} as const;

export interface WsFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

/** Encode a server→client frame (unmasked per RFC 6455 §5.1). */
export function encodeFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const len = payload.length;
  const firstByte = (fin ? 0x80 : 0) | (opcode & 0x0f);
  if (len < 126) {
    return Buffer.concat([Buffer.from([firstByte, len]), payload]);
  }
  if (len < 65536) {
    const hdr = Buffer.alloc(4);
    hdr[0] = firstByte; hdr[1] = 126; hdr.writeUInt16BE(len, 2);
    return Buffer.concat([hdr, payload]);
  }
  const hdr = Buffer.alloc(10);
  hdr[0] = firstByte; hdr[1] = 127; hdr.writeBigUInt64BE(BigInt(len), 2);
  return Buffer.concat([hdr, payload]);
}

/**
 * Decode zero-or-more complete frames from a buffer (streaming-safe: returns
 * leftover bytes for the next chunk). Unmasks masked client payloads.
 */
export function decodeFrames(buf: Buffer): { frames: WsFrame[]; rest: Buffer } {
  const frames: WsFrame[] = [];
  let pos = 0;
  while (pos + 2 <= buf.length) {
    const b0 = buf[pos]!;
    const b1 = buf[pos + 1]!;
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let payloadLen = b1 & 0x7f;
    let headerLen = 2;

    if (payloadLen === 126) {
      if (pos + 4 > buf.length) break;
      payloadLen = buf.readUInt16BE(pos + 2);
      headerLen = 4;
    } else if (payloadLen === 127) {
      if (pos + 10 > buf.length) break;
      payloadLen = Number(buf.readBigUInt64BE(pos + 2));
      headerLen = 10;
    }

    if (masked) {
      if (pos + headerLen + 4 > buf.length) break;
      headerLen += 4;
    }
    if (pos + headerLen + payloadLen > buf.length) break;

    let payload = Buffer.from(buf.subarray(pos + headerLen, pos + headerLen + payloadLen));
    if (masked) {
      const mask = buf.subarray(pos + headerLen - 4, pos + headerLen);
      for (let i = 0; i < payloadLen; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
    }

    frames.push({ fin, opcode, payload });
    pos += headerLen + payloadLen;
  }
  return { frames, rest: buf.subarray(pos) };
}

/** Mask a payload with a random key (client→server). */
export function encodeMaskedFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const mask = Buffer.from([rand(), rand(), rand(), rand()]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
  const len = masked.length;
  const firstByte = (fin ? 0x80 : 0) | (opcode & 0x0f);
  let hdr: Buffer;
  if (len < 126) hdr = Buffer.from([firstByte, 0x80 | len]);
  else if (len < 65536) { hdr = Buffer.alloc(4); hdr[0] = firstByte; hdr[1] = 0x80 | 126; hdr.writeUInt16BE(len, 2); }
  else { hdr = Buffer.alloc(10); hdr[0] = firstByte; hdr[1] = 0x80 | 127; hdr.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([hdr, mask, masked]);
}

function rand(): number { return Math.floor(Math.random() * 256); }
