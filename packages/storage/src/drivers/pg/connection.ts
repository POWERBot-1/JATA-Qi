// PostgresConnection — a minimal PostgreSQL frontend over node:net. Handles the
// startup/auth handshake (trust, cleartext, md5, SCRAM-SHA-256) and a serialized
// extended-query protocol (Parse/Bind/Describe/Execute/Sync). Zero deps.
//
// Queries are serialized over a single connection (a simple mutex) so concurrent
// callers cannot interleave wire messages. Multi-WRITER horizontal scaling comes
// from multiple gateway instances each holding their own connection(s) to the
// shared Postgres (MVCC handles concurrent writers).

import * as net from 'node:net';
import * as tls from 'node:tls';
import { decodeBackend, encodeStartup, enc, type BackendMessage } from './codec.js';
import { md5Password, scramClientFirst, scramClientFinal, parseServerFinal, scramServerSignature, SCRAM_MECHANISM } from './auth.js';

export interface PostgresConnectOptions {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  /** 'disable' (default) | 'prefer' | 'require'. When not 'disable', attempt SSL. */
  ssl?: 'disable' | 'prefer' | 'require';
  /** Connection/acquire timeout in ms. */
  connectTimeoutMs?: number;
  /** Application name reported to Postgres. */
  applicationName?: string;
}

export interface QueryResult {
  rows: Record<string, string | null>[];
  rowCount: number;
  fields: { name: string; typeOid: number }[];
}

/** A typed wrapper around a backend ErrorResponse. */
export class PostgresError extends Error {
  readonly severity: string;
  readonly pgCode: string;
  constructor(fields: Record<string, string>) {
    super(fields.M ?? 'postgres error');
    this.name = 'PostgresError';
    this.severity = fields.S ?? '';
    this.pgCode = fields.C ?? '';
  }
}

export class PostgresConnection {
  private socket!: net.Socket;
  private inbox: BackendMessage[] = [];
  private waiter: ((m: BackendMessage) => void) | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private connected = false;
  private locked = false;
  private readonly unlockQueue: Array<() => void> = [];

  constructor(private readonly opts: PostgresConnectOptions = {}) {}

  async connect(): Promise<void> {
    const host = this.opts.host ?? '127.0.0.1';
    const port = this.opts.port ?? 5432;
    await new Promise<void>((resolve, reject) => {
      const sock = net.createConnection({ host, port });
      const timer = setTimeout(() => { sock.destroy(); reject(new Error(`pg: connect timeout to ${host}:${port}`)); }, this.opts.connectTimeoutMs ?? 5000);
      sock.once('connect', () => { clearTimeout(timer); resolve(); });
      sock.once('error', (err) => { clearTimeout(timer); reject(err); });
      this.socket = sock;
    });
    this.socket.on('data', (chunk: Buffer) => this.onData(chunk));
    this.socket.on('error', (err) => { if (!this.connected) return; /* surface on next op */ this.inbox.push({ type: 'E', severity: 'ERROR', code: '08006', message: err.message, fields: { M: err.message } }); this.drain(); });
    await this.handshake();
    this.connected = true;
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    const { messages, rest } = decodeBackend(this.buf);
    this.buf = rest;
    for (const m of messages) {
      this.inbox.push(m);
    }
    this.drain();
  }

  private drain(): void {
    while (this.waiter && this.inbox.length > 0) {
      const w = this.waiter;
      this.waiter = null;
      w(this.inbox.shift()!);
    }
  }

  private readOne(): Promise<BackendMessage> {
    if (this.inbox.length > 0) return Promise.resolve(this.inbox.shift()!);
    return new Promise<BackendMessage>((resolve) => { this.waiter = resolve; });
  }

  private write(b: Buffer): void { this.socket.write(b); }

  private async handshake(): Promise<void> {
    const user = this.opts.user ?? 'postgres';
    const password = this.opts.password ?? '';
    const database = this.opts.database ?? user;
    // Optional SSL negotiation.
    if (this.opts.ssl && this.opts.ssl !== 'disable') {
      this.write(enc.sslRequest());
      const resp = await this.readRawByte();
      if (resp === 83 /* 'S' */) {
        this.upgradeTls();
      } else if (this.opts.ssl === 'require') {
        throw new Error('pg: SSL required but the server does not support it');
      }
    }
    this.write(encodeStartup({ user, database, application_name: this.opts.applicationName ?? 'jataqi' }));

    // SCRAM state (if needed).
    let scramBare = '';
    let scramSalted: Buffer | null = null;
    let scramAuthMessage = '';

    for (;;) {
      const m = await this.readOne();
      if (m.type === 'E') throw new PostgresError((m as BackendMessage & { fields: Record<string, string> }).fields);
      if (m.type === 'R') {
        const r = m as Extract<BackendMessage, { type: 'R' }>;
        if (r.code === 0) continue; // AuthenticationOk -> fall through to params/Z
        if (r.code === 3) { this.write(enc.password(password)); continue; }
        if (r.code === 5) { this.write(enc.password(md5Password(user, password, r.salt!))); continue; }
        if (r.code === 10) {
          if (!(r.mechanisms ?? []).includes(SCRAM_MECHANISM)) throw new Error(`pg: server requires an unsupported SASL mechanism: ${(r.mechanisms ?? []).join(', ')}`);
          const first = scramClientFirst(user);
          scramBare = first.state.clientFirstBare;
          this.write(enc.saslInitialResponse(SCRAM_MECHANISM, first.full));
          continue;
        }
        if (r.code === 11) {
          const serverFirstRaw = r.saslData!.toString('utf8');
          const fin = scramClientFinal(password, scramBare, serverFirstRaw);
          scramSalted = fin.saltedPassword;
          scramAuthMessage = fin.authMessage;
          this.write(enc.saslResponse(fin.message));
          continue;
        }
        if (r.code === 12) {
          // Optional server-signature verification.
          if (scramSalted) {
            const expected = scramServerSignature(scramSalted, scramAuthMessage);
            const got = parseServerFinal(r.saslData!);
            if (!expected.equals(got)) throw new Error('pg: SCRAM server signature mismatch');
          }
          continue;
        }
        throw new Error(`pg: unsupported auth code ${r.code}`);
      }
      if (m.type === 'S' || m.type === 'K') continue; // ParameterStatus / BackendKeyData
      if (m.type === 'Z') return; // ReadyForQuery -> connected
    }
  }

  private async readRawByte(): Promise<number> {
    // The SSL response is a single byte outside the normal framed protocol.
    return new Promise<number>((resolve, reject) => {
      const handler = (chunk: Buffer): void => {
        if (chunk.length > 0) { this.socket.removeListener('data', handler); resolve(chunk[0]!); }
      };
      this.socket.once('data', handler);
      this.socket.once('error', reject);
    });
  }

  private upgradeTls(): void {
    const host = this.opts.host ?? '127.0.0.1';
    const tlsSock = tls.connect({
      socket: this.socket,
      servername: host,
      rejectUnauthorized: this.opts.ssl === 'require',
    });
    // Swap the underlying socket; subsequent reads/writes go through TLS.
    this.socket.removeAllListeners('data');
    this.socket = tlsSock as unknown as net.Socket;
    tlsSock.on('data', (chunk: Buffer) => this.onData(chunk));
  }

  /** Execute a parameterized query (extended protocol). Returns rows + count. */
  async query(sql: string, params: (string | null)[] = []): Promise<QueryResult> {
    await this.acquire();
    try {
      this.write(enc.parse('', sql));
      this.write(enc.bind('', '', params));
      this.write(enc.describe('P', ''));
      this.write(enc.execute('', 0));
      this.write(enc.sync());

      const rows: Record<string, string | null>[] = [];
      let fields: { name: string; typeOid: number }[] = [];
      let rowCount = 0;
      let errored: PostgresError | null = null;
      for (;;) {
        const m = await this.readOne();
        if (m.type === '1' || m.type === '2' || m.type === 'n' || m.type === 't') continue;
        if (m.type === 'T') {
          fields = (m as Extract<BackendMessage, { type: 'T' }>).fields.map((f) => ({ name: f.name, typeOid: f.typeOid }));
          continue;
        }
        if (m.type === 'D') {
          const vals = (m as Extract<BackendMessage, { type: 'D' }>).values;
          const row: Record<string, string | null> = {};
          fields.forEach((f, i) => { row[f.name] = vals[i] ?? null; });
          rows.push(row);
          continue;
        }
        if (m.type === 'C') { rowCount = parseRowCount((m as Extract<BackendMessage, { type: 'C' }>).tag); continue; }
        if (m.type === 'I') continue;
        if (m.type === 'E') { errored = new PostgresError((m as Extract<BackendMessage, { type: 'E' }>).fields); continue; }
        if (m.type === 'Z') break;
      }
      if (errored) throw errored;
      return { rows, rowCount, fields };
    } finally {
      this.release();
    }
  }

  /** Execute one or more statements with no parameters (e.g. DDL/setup). */
  async simpleQuery(sql: string): Promise<void> {
    await this.acquire();
    try {
      this.write(enc.query(sql));
      let errored: PostgresError | null = null;
      for (;;) {
        const m = await this.readOne();
        if (m.type === 'E') errored = new PostgresError((m as Extract<BackendMessage, { type: 'E' }>).fields);
        if (m.type === 'Z') break;
      }
      if (errored) throw errored;
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (!this.locked) { this.locked = true; return; }
    // Awaits ownership; when resolved we own the lock (handed off without a gap).
    await new Promise<void>((resolve) => this.unlockQueue.push(resolve));
  }

  private release(): void {
    const next = this.unlockQueue.shift();
    if (next) next();   // hand off ownership; the lock stays "held"
    else this.locked = false;
  }

  async close(): Promise<void> {
    if (this.connected) { try { this.write(enc.terminate()); } catch { /* */ } }
    this.connected = false;
    // Flush the Terminate, then destroy so no socket handle keeps the event loop alive.
    if (this.socket && !this.socket.destroyed) {
      await new Promise<void>((resolve) => {
        const done = (): void => { this.socket.destroy(); resolve(); };
        this.socket.end(done);
        this.socket.once('close', done);
        setTimeout(done, 200).unref?.();
      });
    }
  }
}

function parseRowCount(tag: string): number {
  // Tags: "INSERT 0 5", "UPDATE 3", "DELETE 1", "SELECT 7", "COPY 100".
  const parts = tag.split(' ');
  const n = Number(parts[parts.length - 1]);
  return Number.isFinite(n) ? n : 0;
}
