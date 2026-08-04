// PostgreSQL v3 wire-protocol codec — pure Node (node:buffer), zero deps.
// Encodes frontend messages and decodes backend messages per the Frontend/Backend
// protocol (https://www.postgresql.org/docs/current/protocol-message-formats.html).
//
// This module is pure (encode -> Buffer, decode -> messages) so it is fully
// unit-testable without a live server.

// --- low-level buffer helpers ------------------------------------------------

export class BufReader {
  private pos = 0;
  constructor(private buf: Buffer) {}
  get remaining(): number { return this.buf.length - this.pos; }
  byte(): number { return this.buf[this.pos++]!; }
  int16(): number { const v = this.buf.readInt16BE(this.pos); this.pos += 2; return v; }
  int32(): number { const v = this.buf.readInt32BE(this.pos); this.pos += 4; return v; }
  uint32(): number { const v = this.buf.readUInt32BE(this.pos); this.pos += 4; return v; }
  bytes(n: number): Buffer { const b = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return b; }
  /** Read a NUL-terminated string. */
  cstring(): string {
    const end = this.buf.indexOf(0, this.pos);
    if (end < 0) throw new Error('pg: unterminated cstring');
    const s = this.buf.subarray(this.pos, end).toString('utf8');
    this.pos = end + 1;
    return s;
  }
  /** Read the rest of the current message as a string. */
  restString(): string { const s = this.buf.subarray(this.pos).toString('utf8'); this.pos = this.buf.length; return s; }
  restBytes(): Buffer { const b = this.buf.subarray(this.pos); this.pos = this.buf.length; return b; }
}

function concat(parts: Buffer[]): Buffer { return Buffer.concat(parts); }
function cstr(s: string): Buffer { return Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]); }
function i32(n: number): Buffer { const b = Buffer.alloc(4); b.writeInt32BE(n, 0); return b; }
function i16(n: number): Buffer { const b = Buffer.alloc(2); b.writeInt16BE(n, 0); return b; }
function u32(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); return b; }

// --- frontend message encoders ----------------------------------------------

const PROTOCOL_VERSION = 196608; // 3.0

/** The special startup message (no type byte). */
export function encodeStartup(params: Record<string, string>): Buffer {
  const body = concat([u32(PROTOCOL_VERSION), ...Object.entries(params).map(([k, v]) => cstr(`${k}=${v}`)), Buffer.from([0])]);
  return concat([i32(body.length + 4), body]);
}

/** Wrap a payload as a typed frontend message: <type><length><payload>. */
export function encodeMessage(type: string, payload: Buffer): Buffer {
  return concat([Buffer.from(type, 'ascii'), i32(payload.length + 4), payload]);
}

export const enc = {
  /** SSLRequest (int8 80887703, then int32 0) — we always answer "no SSL". */
  sslRequest(): Buffer { const b = Buffer.alloc(8); b.writeUInt32BE(80887703, 0); b.writeUInt32BE(0, 4); return b; },
  /** Cleartext / MD5 password message. */
  password(text: string): Buffer { return encodeMessage('p', cstr(text)); },
  /** SASL initial response: mechanism (cstring) + int32 response-length + response bytes. */
  saslInitialResponse(mechanism: string, initialResponse: Buffer): Buffer {
    return encodeMessage('p', concat([cstr(mechanism), i32(initialResponse.length), initialResponse]));
  },
  /** SASL response (subsequent). */
  saslResponse(response: Buffer): Buffer { return encodeMessage('p', response); },
  /** Simple query (Q). */
  query(sql: string): Buffer { return encodeMessage('Q', cstr(sql)); },
  /** Parse (P): name, query, param OIDs (0 = let server infer). */
  parse(name: string, sql: string, paramOids: number[] = []): Buffer {
    return encodeMessage('P', concat([cstr(name), cstr(sql), i16(paramOids.length), ...paramOids.map(u32)]));
  },
  /** Bind (B): portal, statement, text params. */
  bind(portal: string, statement: string, params: (string | null)[]): Buffer {
    const paramParts: Buffer[] = [];
    for (const p of params) {
      if (p === null) paramParts.push(i32(-1));
      else { const b = Buffer.from(p, 'utf8'); paramParts.push(i32(b.length), b); }
    }
    return encodeMessage('B', concat([
      cstr(portal), cstr(statement),
      i16(0),                 // 0 param-format codes => all params in TEXT format
      i16(params.length),
      ...paramParts,
      i16(0),                 // 0 result-format codes => all results in TEXT format
    ]));
  },
  /** Describe (D): 'P' portal or 'S' statement. */
  describe(which: 'P' | 'S', name: string): Buffer {
    return encodeMessage('D', concat([Buffer.from(which, 'ascii'), cstr(name)]));
  },
  /** Execute (E): portal, max rows (0 = all). */
  execute(portal: string, maxRows = 0): Buffer {
    return encodeMessage('E', concat([cstr(portal), i32(maxRows)]));
  },
  /** Sync (S) — flush extended-query cycle. */
  sync(): Buffer { return encodeMessage('S', Buffer.alloc(0)); },
  /** Terminate (X). */
  terminate(): Buffer { return encodeMessage('X', Buffer.alloc(0)); },
};

// --- backend message decoding -----------------------------------------------

export type BackendMessage =
  | { type: 'R'; code: number; salt?: Buffer; mechanisms?: string[]; saslData?: Buffer }
  | { type: 'S'; key: string; value: string }
  | { type: 'K'; pid: number; secret: number }
  | { type: 'Z'; status: string }
  | { type: 'T'; fields: { name: string; tableOid: number; typeOid: number; format: number }[] }
  | { type: 'D'; values: (string | null)[] }
  | { type: 'C'; tag: string }
  | { type: 'E'; severity: string; code: string; message: string; fields: Record<string, string> }
  | { type: 'N'; severity: string; code: string; message: string }
  | { type: 'I' }
  | { type: '1' }
  | { type: '2' }
  | { type: 'n' }
  | { type: 't'; paramOids: number[] }
  | { type: 's' }
  | { type: 'A' | 'G' | 'H' | 'W' | string; raw: string };

/**
 * Decode zero-or-more complete backend messages from an incoming buffer.
 * Returns the parsed messages and any leftover (partial) bytes to keep for the
 * next chunk.
 */
export function decodeBackend(buf: Buffer): { messages: BackendMessage[]; rest: Buffer } {
  const messages: BackendMessage[] = [];
  let pos = 0;
  while (pos + 5 <= buf.length) {
    const type = buf.toString('ascii', pos, pos + 1);
    const len = buf.readInt32BE(pos + 1); // includes the 4 length bytes
    if (pos + 1 + len > buf.length) break; // incomplete message — wait for more
    const payload = buf.subarray(pos + 1 + 4, pos + 1 + len);
    messages.push(parseMessage(type, payload));
    pos += 1 + len;
  }
  return { messages, rest: buf.subarray(pos) };
}

function parseFields(payload: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  const r = new BufReader(payload);
  while (r.remaining > 0) {
    const tag = String.fromCharCode(r.byte());
    if (tag === '\u0000') break; // safety
    const val = r.cstring();
    out[tag] = val;
    if (tag === 'M' /* message is last in practice */ && r.remaining === 0) break;
  }
  return out;
}

function parseMessage(type: string, payload: Buffer): BackendMessage {
  const r = new BufReader(payload);
  switch (type) {
    case 'R': {
      const code = r.int32();
      if (code === 0) return { type: 'R', code };
      if (code === 3) return { type: 'R', code }; // cleartext password
      if (code === 5) return { type: 'R', code, salt: r.bytes(4) }; // md5
      if (code === 10) { // SASL (SCRAM) — list of mechanism names
        const mechanisms: string[] = [];
        while (r.remaining > 1) mechanisms.push(r.cstring());
        return { type: 'R', code, mechanisms };
      }
      if (code === 11 || code === 12) return { type: 'R', code, saslData: r.restBytes() }; // SASLContinue / SASLFinal
      return { type: 'R', code };
    }
    case 'S': return { type: 'S', key: r.cstring(), value: r.cstring() };
    case 'K': return { type: 'K', pid: r.int32(), secret: r.int32() };
    case 'Z': return { type: 'Z', status: String.fromCharCode(r.byte()) };
    case 'T': {
      const count = r.int16();
      const fields: { name: string; tableOid: number; typeOid: number; format: number }[] = [];
      for (let i = 0; i < count; i++) {
        const name = r.cstring();
        const tableOid = r.int32();
        const _colAttr = r.int16();
        const typeOid = r.int32();
        const _typeSize = r.int16();
        const _typeMod = r.int32();
        const format = r.int16();
        fields.push({ name, tableOid, typeOid, format });
      }
      return { type: 'T', fields };
    }
    case 'D': {
      const count = r.int16();
      const values: (string | null)[] = [];
      for (let i = 0; i < count; i++) {
        const l = r.int32();
        values.push(l === -1 ? null : r.bytes(l).toString('utf8'));
      }
      return { type: 'D', values };
    }
    case 'C': return { type: 'C', tag: r.cstring() };
    case 'E': {
      const f = parseFields(payload);
      return { type: 'E', severity: f.S ?? '', code: f.C ?? '', message: f.M ?? '', fields: f };
    }
    case 'N': {
      const f = parseFields(payload);
      return { type: 'N', severity: f.S ?? '', code: f.C ?? '', message: f.M ?? '' };
    }
    case 'I': return { type: 'I' };
    case '1': return { type: '1' };
    case '2': return { type: '2' };
    case 'n': return { type: 'n' };
    case 's': return { type: 's' };
    case 't': {
      const n = r.int16();
      const paramOids: number[] = [];
      for (let i = 0; i < n; i++) paramOids.push(r.int32());
      return { type: 't', paramOids };
    }
    default:
      return { type, raw: payload.toString('utf8') };
  }
}
