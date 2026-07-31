// PostgreSQL authentication: MD5 and SCRAM-SHA-256 (RFC 5802 / 7677), via
// node:crypto only. Pure functions — fully unit-testable without a server.

import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

// --- MD5 password auth -------------------------------------------------------

/**
 * PostgreSQL "md5" password auth: 'md5' + md5( md5(password+user) + salt ).
 * `salt` is the 4-byte challenge sent by the server in AuthenticationMD5Password.
 */
export function md5Password(user: string, password: string, salt: Buffer): string {
  const inner = md5Hex(`${password}${user}`);
  return 'md5' + md5Hex(Buffer.concat([Buffer.from(inner, 'utf8'), salt]));
}

function md5Hex(data: string | Uint8Array): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  return createHash('md5').update(buf).digest('hex');
}

// --- SCRAM-SHA-256 -----------------------------------------------------------

export interface ScramState {
  clientNonce: string;
  clientFirstBare: string; // n=user,r=<nonce>
  authMessage: string;
  saltedPassword: Buffer;
}

export const SCRAM_MECHANISM = 'SCRAM-SHA-256';

/** Build the client-first message: "n,,n=<attrs>,r=<nonce>". Returns [gs2Header, bare, full]. */
export function scramClientFirst(username: string, nonceBytes = 18): { full: Buffer; state: { clientNonce: string; clientFirstBare: string } } {
  // Postgres uses the username from the startup message; the SCRAM 'n=' is ignored
  // but we still send a (quoted-safe) value per the protocol.
  const clientNonce = randomBytes(nonceBytes).toString('base64');
  const clientFirstBare = `n=${scramEscape(username)},r=${clientNonce}`;
  const full = `n,,${clientFirstBare}`;
  return { full: Buffer.from(full, 'utf8'), state: { clientNonce, clientFirstBare } };
}

/** Parse a server-first message: "r=<nonce>,s=<saltB64>,i=<iterations>". */
export function parseServerFirst(data: Buffer | string): { nonce: string; salt: Buffer; iterations: number; raw: string } {
  const raw = typeof data === 'string' ? data : data.toString('utf8');
  const map = parseScramAttrs(raw);
  if (!map.r || !map.s || !map.i) throw new Error(`pg: malformed SCRAM server-first: ${raw}`);
  return { nonce: map.r, salt: Buffer.from(map.s, 'base64'), iterations: Number(map.i), raw };
}

/**
 * Compute the SCRAM-SHA-256 client-final message (with proof), given the password,
 * the client-first state, and the parsed server-first. Returns the full
 * client-final bytes ("c=biws,r=<nonce>,p=<proofB64>").
 */
export function scramClientFinal(password: string, clientFirstBare: string, serverFirstRaw: string): { message: Buffer; saltedPassword: Buffer; authMessage: string } {
  const { nonce, salt, iterations } = parseServerFirst(serverFirstRaw);
  const saltedPassword = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const channelBinding = 'biws'; // base64('n,,') == 'biws'
  const clientFinalNoProof = `c=${channelBinding},r=${nonce}`;
  const authMessage = `${clientFirstBare},${serverFirstRaw},${clientFinalNoProof}`;
  const clientSignature = createHmac('sha256', storedKey).update(authMessage).digest();
  const clientProof = xor(clientKey, clientSignature);
  return { message: Buffer.from(`${clientFinalNoProof},p=${clientProof.toString('base64')}`, 'utf8'), saltedPassword, authMessage };
}

/** Parse the server-final message ("v=<serverSignatureB64>"). */
export function parseServerFinal(data: Buffer | string): Buffer {
  const raw = typeof data === 'string' ? data : data.toString('utf8');
  const map = parseScramAttrs(raw);
  if (!map.v) throw new Error(`pg: malformed SCRAM server-final: ${raw}`);
  return Buffer.from(map.v, 'base64');
}

/** Compute the server signature the server SHOULD send (for optional client verification). */
export function scramServerSignature(saltedPassword: Buffer, authMessage: string): Buffer {
  const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest();
  return createHmac('sha256', serverKey).update(authMessage).digest();
}

// --- helpers -----------------------------------------------------------------

function parseScramAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part[0]!] = part.slice(eq + 1);
  }
  return out;
}

function scramEscape(s: string): string {
  // SCRAM username escapes ',' -> '=2C', '=' -> '=3D'.
  return s.replace(/=/g, '=3D').replace(/,/g, '=2C');
}

function xor(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! ^ b[i]!;
  return out;
}
