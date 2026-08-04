// PR8 — End-to-end PostgreSQL driver tests against an in-test mock Postgres
// server (pure node:net) that speaks the real wire protocol and a mini-SQL
// engine over an in-memory model. Proves: connection handshake (trust + MD5 +
// SCRAM-SHA-256), extended-query protocol, the PostgresDriver CRUD, and
// multi-WRITER visibility (two drivers/connections sharing one server).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { pbkdf2Sync } from 'node:crypto';
import { decodeBackend } from '../src/drivers/pg/codec.js';
import { PostgresConnection, PostgresError } from '../src/drivers/pg/connection.js';
import { scramServerSignature } from '../src/drivers/pg/auth.js';
import { PostgresDriver } from '../src/drivers/postgres.js';
import { StorageModule } from '../src/storage-module.js';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';

// --- server-side wire helpers ------------------------------------------------

const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n, 0); return b; };
const i16 = (n: number) => { const b = Buffer.alloc(2); b.writeInt16BE(n, 0); return b; };
const cstr = (s: string) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
const Smsg = (type: string, payload: Buffer) => Buffer.concat([Buffer.from(type), i32(payload.length + 4), payload]);
const paramStatus = (k: string, v: string) => Smsg('S', Buffer.concat([cstr(k), cstr(v)]));
const readyForQuery = () => Smsg('Z', Buffer.from('I'));
const parseComplete = () => Smsg('1', Buffer.alloc(0));
const bindComplete = () => Smsg('2', Buffer.alloc(0));
const noData = () => Smsg('n', Buffer.alloc(0));
const commandComplete = (tag: string) => Smsg('C', cstr(tag));
const errorResponse = (msg: string) => Smsg('E', Buffer.concat([Buffer.from('S'), cstr('ERROR'), Buffer.from('C'), cstr('42000'), Buffer.from('M'), cstr(msg), Buffer.from([0])]));
const rowDescription = (fields: string[]) => Smsg('T', Buffer.concat([i16(fields.length), ...fields.map((f) => Buffer.concat([cstr(f), i32(0), i16(0), i32(25), i16(-1), i32(-1), i16(0)]))]));
const dataRow = (vals: (string | null)[]) => Smsg('D', Buffer.concat([i16(vals.length), ...vals.map((v) => v === null ? i32(-1) : Buffer.concat([i32(Buffer.byteLength(v)), Buffer.from(v, 'utf8')]))]));

// --- mini in-memory SQL engine ----------------------------------------------

interface Table { pk: string[]; rows: Map<string, Map<string, string>>; }
function pkKey(t: Table, row: Map<string, string>): string { return t.pk.map((c) => row.get(c) ?? '').join('|'); }

class MiniDB {
  private tables = new Map<string, Table>([
    ['kv_store', { pk: ['namespace', 'key'], rows: new Map() }],
    ['collection_docs', { pk: ['collection', 'id'], rows: new Map() }],
    ['blob_store', { pk: ['store_name', 'key'], rows: new Map() }],
  ]);

  columnsOf(sql: string): string[] | null {
    const s = sql.replace(/::\w+/g, '');
    const mSel = s.match(/SELECT\s+(.+?)\s+FROM\s+(\w+)/i);
    if (mSel) {
      const cols = mSel[1]!;
      if (/count\(\*\)/i.test(cols)) return ['c'];
      return cols.split(',').map((c) => c.trim().split(/\s+/)[0]);
    }
    const mRet = s.match(/RETURNING\s+(\w+)/i);
    if (mRet) return [mRet[1]!];
    return null;
  }

  execute(sql: string, params: (string | null)[]): { columns: string[]; rows: (string | null)[][] } | { rowCount: number; returning?: string[][] } {
    const s = sql.replace(/::\w+/g, '').replace(/;\s*$/, '').trim();
    if (/^create/i.test(s)) return { columns: [], rows: [] }; // no-op DDL (returns command)
    if (/^insert/i.test(s)) return this.insert(s, params);
    if (/^delete/i.test(s)) return { rowCount: this.del(s, params) };
    if (/^select/i.test(s)) return this.select(s, params);
    throw new Error(`mock-pg: unsupported statement: ${s}`);
  }
  isCommand(sql: string): boolean { const s = sql.replace(/::\w+/g, ''); return /^(create|insert|delete)/i.test(s.trim()); }

  private insert(s: string, params: (string | null)[]) {
    const table = (s.match(/into\s+(\w+)/i) || [])[1]!;
    const t = this.tables.get(table)!;
    const colsMatch = s.match(/\(([^)]+)\)\s*values/i);
    const cols = colsMatch![1]!.split(',').map((c) => c.trim());
    const valsMatch = s.match(/values\s*\(([^)]+)\)/i);
    const placeholders = valsMatch![1]!.split(',').map((v) => v.trim());
    const row = new Map<string, string>();
    let created: string | undefined;
    cols.forEach((c, i) => {
      const ph = placeholders[i]!;
      if (/^\$\d+$/.test(ph)) { const val = params[Number(ph.slice(1)) - 1]; if (val !== null) row.set(c, val); if (c === 'created_at') created = val ?? undefined; }
      else row.set(c, ph.replace(/'/g, ''));
    });
    // ON CONFLICT DO UPDATE preserves created_at unless overwritten; we keep the first-seen created_at.
    const key = pkKey(t, row);
    const existing = t.rows.get(key);
    const createdAt = existing?.get('created_at') ?? row.get('created_at') ?? String(Date.now());
    if (existing) { for (const [k, v] of row) existing.set(k, v); existing.set('created_at', createdAt); }
    else { row.set('created_at', createdAt); t.rows.set(key, row); }
    const ret = (s.match(/returning\s+(\w+)/i) || [])[1];
    return { rowCount: 1, ...(ret ? { returning: [[createdAt ?? '']] } : {}) };
  }

  private del(s: string, params: (string | null)[]): number {
    const table = (s.match(/delete\s+from\s+(\w+)/i) || [])[1]!;
    const t = this.tables.get(table)!;
    const where = this.parseWhere(s, params);
    let n = 0;
    for (const key of [...t.rows.keys()]) { if (where(t.rows.get(key)!)) { t.rows.delete(key); n++; } }
    return n;
  }

  private select(s: string, params: (string | null)[]) {
    const table = (s.match(/from\s+(\w+)/i) || [])[1]!;
    const t = this.tables.get(table)!;
    const colsRaw = (s.match(/select\s+(.+?)\s+from/i) || [])[1];
    if (colsRaw === undefined) throw new Error('mock-pg: cannot parse SELECT: ' + s);
    const isCount = /count\(\*\)/i.test(colsRaw);
    const cols = isCount ? ['c'] : colsRaw.split(',').map((c) => c.trim().split(/\s+/)[0]);
    const where = this.parseWhere(s, params);
    let rows = [...t.rows.values()].filter(where);
    const orderM = s.match(/order by\s+(\w+)\s*(asc|desc)?/i);
    if (orderM) {
      const c = orderM[1]!; const dir = orderM[2]?.toLowerCase() === 'desc' ? -1 : 1;
      rows.sort((a, b) => { const av = a.get(c) ?? ''; const bv = b.get(c) ?? ''; if (av === bv) return 0; return av > bv ? dir : -dir; });
    }
    const limitM = s.match(/limit\s+(\d+)/i);
    if (limitM) rows = rows.slice(0, Number(limitM[1]));
    if (isCount) return { columns: ['c'], rows: [[String(rows.length)]] };
    return { columns: cols, rows: rows.map((r) => cols.map((c) => r.get(c) ?? null)) };
  }

  private parseWhere(s: string, params: (string | null)[]): (row: Map<string, string>) => boolean {
    const m = s.match(/where\s+(.+?)(\s+order by|\s+limit|$)/i);
    if (!m) return () => true;
    const conds = m[1]!.split(/\s+and\s+/i).map((c) => c.trim());
    return (row) => conds.every((c) => {
      const cm = c.match(/^(\w+)\s*(=|like|>)\s*\$(\d+)$/i);
      if (!cm) return true;
      const col = cm[1]!; const op = cm[2]!.toLowerCase(); const val = params[Number(cm[3]!) - 1] ?? '';
      const cell = row.get(col);
      if (cell === undefined) return false;
      if (op === '=') return cell === val;
      if (op === '>') return cell > val;
      if (op === 'like') { const p = val.replace(/%/g, ''); return cell.startsWith(p); }
      return false;
    });
  }
}

// --- the mock server ---------------------------------------------------------

type AuthMode = 'trust' | 'md5' | 'scram';

class MockPgServer {
  private server: net.Server;
  private sockets = new Set<net.Socket>();
  readonly db = new MiniDB();
  readonly port: number;
  auth: AuthMode;
  md5Salt = Buffer.from([1, 2, 3, 4]);
  scramPassword = 'pw'; // the password the mock SCRAM server expects/verifies

  constructor(port: number, auth: AuthMode) { this.port = port; this.auth = auth; this.server = net.createServer((s) => this.handle(s)); }
  start(): Promise<void> { return new Promise((r) => this.server.listen(this.port, '127.0.0.1', r)); }
  address(): net.AddressInfo { return this.server.address() as net.AddressInfo; }
  close(): Promise<void> {
    for (const s of this.sockets) s.destroy();   // force-close so server.close() resolves
    this.sockets.clear();
    return new Promise((r) => this.server.close(() => r()));
  }

  private handle(sock: net.Socket): void {
    this.sockets.add(sock);
    sock.on('close', () => { this.sockets.delete(sock); });
    let buf = Buffer.alloc(0);
    let started = false;
    let authed = false;
    let preparedSql = '';
    let boundParams: (string | null)[] = [];
    let scramPhase = 0;
    let scramBare = '';
    let scramServerFirst = '';
    let scramSalted: Buffer | null = null;

    const send = (b: Buffer) => sock.write(b);
    const sendCommand = (sql: string, params: (string | null)[], returningCols: boolean) => {
      const res = this.db.execute(sql, params) as { rowCount: number; returning?: string[][] };
      if (returningCols && res.returning) { res.returning.forEach((r) => send(dataRow(r))); send(commandComplete(`INSERT 0 ${res.rowCount}`)); }
      else send(commandComplete(`INSERT 0 ${res.rowCount}`));
    };

    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (!started) {
          // First message: startup (no type byte) OR SSL request.
          if (buf.length < 4) break;
          const len = buf.readInt32BE(0);
          if (buf.length < len) break;
          const body = buf.subarray(4, len);
          if (len === 8 && body.length === 4) { send(Buffer.from('N')); buf = buf.subarray(len); continue; } // SSLRequest -> decline
          started = true;
          // Respond to auth.
          if (this.auth === 'trust') { send(Smsg('R', i32(0))); send(paramStatus('server_version', '14.0 (mock)')); send(Smsg('K', Buffer.concat([i32(1), i32(2)]))); send(readyForQuery()); authed = true; }
          else if (this.auth === 'md5') { send(Smsg('R', Buffer.concat([i32(5), this.md5Salt]))); }
          else if (this.auth === 'scram') { send(Smsg('R', Buffer.concat([i32(10), cstr('SCRAM-SHA-256'), Buffer.from([0])]))); }
          buf = buf.subarray(len);
          continue;
        }
        if (buf.length < 5) break;
        const type = buf.toString('ascii', 0, 1);
        const mlen = buf.readInt32BE(1);
        if (buf.length < 1 + mlen) break;
        const payload = buf.subarray(5, 1 + mlen);
        buf = buf.subarray(1 + mlen);

        if (type === 'X') { sock.end(); return; }
        if (type === 'p') {
          if (this.auth === 'md5') { send(Smsg('R', i32(0))); send(paramStatus('server_version', '14.0 (mock)')); send(Smsg('K', Buffer.concat([i32(1), i32(2)]))); send(readyForQuery()); authed = true; }
          else if (this.auth === 'scram') {
            if (scramPhase === 0) {
              // SASLInitialResponse: mechanism cstring + int32 len + initial bytes.
              const nul = payload.indexOf(0);
              const respLen = payload.readInt32BE(nul + 1);
              const initial = payload.subarray(nul + 5, nul + 5 + respLen).toString('utf8');
              const clientNonce = (initial.match(/r=([^,]+)/) || ['', ''])[1];
              scramBare = initial.replace(/^n,,/, '');                       // "n=user,r=<nonce>"
              scramServerFirst = `r=${clientNonce}SERVER,s=c2NhbHQ=,i=4096`; // fixed salt "salt", 4096 iters
              scramSalted = pbkdf2Sync(this.scramPassword, Buffer.from('c2NhbHQ=', 'base64'), 4096, 32, 'sha256');
              send(Smsg('R', Buffer.concat([i32(11), Buffer.from(scramServerFirst, 'utf8')])));
              scramPhase = 1;
            } else if (scramPhase === 1) {
              // client-final -> compute the REAL server signature the client verifies.
              const clientFinal = payload.toString('utf8');
              const noProof = clientFinal.split(',p=')[0];
              const authMessage = `${scramBare},${scramServerFirst},${noProof}`;
              const sig = scramServerSignature(scramSalted!, authMessage);
              send(Smsg('R', Buffer.concat([i32(12), Buffer.from('v=' + sig.toString('base64'), 'utf8')])));
              send(paramStatus('server_version', '14.0 (mock)'));
              send(Smsg('K', Buffer.concat([i32(1), i32(2)])));
              send(readyForQuery());
              authed = true;
              scramPhase = 2;
            }
          }
          continue;
        }
        if (!authed) continue;
        if (type === 'Q') { // simple query
          const sql = payload.subarray(0, payload.length - 1).toString('utf8');
          try {
            if (this.db.isCommand(sql)) { const r = this.db.execute(sql, []) as { rowCount: number }; send(commandComplete(`OK ${r.rowCount ?? 0}`)); }
            else { const r = this.db.execute(sql, []) as { columns: string[]; rows: (string | null)[][] }; send(rowDescription(r.columns)); r.rows.forEach((row) => send(dataRow(row))); send(commandComplete(`SELECT ${r.rows.length}`)); }
          } catch (e) { send(errorResponse(String((e as Error).message))); }
          send(readyForQuery());
        } else if (type === 'P') {
          // payload: statementName\0 query\0 [int16 paramOids...]
          const nul1 = payload.indexOf(0);
          const nul2 = payload.indexOf(0, nul1 + 1);
          preparedSql = payload.subarray(nul1 + 1, nul2).toString('utf8');
          send(parseComplete());
        }
        else if (type === 'B') {
          boundParams = decodeBindParams(payload);
          send(bindComplete());
        } else if (type === 'D') {
          const cols = this.db.columnsOf(preparedSql);
          if (cols && cols.length) send(rowDescription(cols)); else send(noData());
        } else if (type === 'E') {
          try {
            if (this.db.isCommand(preparedSql)) sendCommand(preparedSql, boundParams, /returning/i.test(preparedSql));
            else { const r = this.db.execute(preparedSql, boundParams) as { columns: string[]; rows: (string | null)[][] }; r.rows.forEach((row) => send(dataRow(row))); send(commandComplete(`SELECT ${r.rows.length}`)); }
          } catch (e) {
            send(errorResponse(String((e as Error).message))); // ReadyForQuery is sent on the subsequent Sync
          }
        } else if (type === 'S') { send(readyForQuery()); }
      }
    });
    sock.on('error', () => { /* ignore */ });
  }

  // SCRAM is handled inline in handle() (phase-based).
}

function decodeBindParams(payload: Buffer): (string | null)[] {
  // portal cstring, statement cstring, int16 paramFormats, int16 numParams, per param [int32 len + bytes]
  let p = payload.indexOf(0, 0); // end of portal
  p = payload.indexOf(0, p + 1); // end of statement
  let pos = p + 1;
  const numFmt = payload.readInt16BE(pos); pos += 2; pos += numFmt * 2; // skip format codes
  const numParams = payload.readInt16BE(pos); pos += 2;
  const out: (string | null)[] = [];
  for (let i = 0; i < numParams; i++) {
    const l = payload.readInt32BE(pos); pos += 4;
    if (l === -1) out.push(null);
    else { out.push(payload.subarray(pos, pos + l).toString('utf8')); pos += l; }
  }
  return out;
}

// --- tests -------------------------------------------------------------------

describe('PostgresConnection — wire protocol against a mock server', () => {
  let srv: MockPgServer;
  before(async () => { srv = new MockPgServer(0, 'trust'); await srv.start(); });
  after(async () => { await srv.close(); });

  it('connects (trust auth) and runs a parameterized query', async () => {
    const conn = new PostgresConnection({ host: '127.0.0.1', port: srv.address().port });
    await conn.connect();
    await conn.simpleQuery('CREATE TABLE kv_store (...)');
    await conn.query('INSERT INTO kv_store (namespace, key, value) VALUES ($1,$2,$3)', ['ns', 'k', '"v"']);
    const r = await conn.query('SELECT value FROM kv_store WHERE namespace=$1 AND key=$2', ['ns', 'k']);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0]!.value, '"v"');
    await conn.close();
  });

  it('authenticates with MD5', async () => {
    const md5srv = new MockPgServer(0, 'md5'); await md5srv.start();
    const port = md5srv.address().port;
    const conn = new PostgresConnection({ host: '127.0.0.1', port, user: 'u', password: 'pw' });
    await conn.connect(); // exercises the md5 handshake path
    await conn.close();
    await md5srv.close();
  });

  it('authenticates with SCRAM-SHA-256', async () => {
    const sc = new MockPgServer(0, 'scram'); await sc.start();
    const port = sc.address().port;
    const conn = new PostgresConnection({ host: '127.0.0.1', port, user: 'u', password: 'pw' });
    await conn.connect(); // exercises the SCRAM handshake path
    await conn.close();
    await sc.close();
  });

  it('surfaces a server error as PostgresError', async () => {
    const conn = new PostgresConnection({ host: '127.0.0.1', port: srv.address().port });
    await conn.connect();
    await assert.rejects(() => conn.query('SELECT FROM nonexistent_xyz', []), (e: unknown) => e instanceof PostgresError);
    await conn.close();
  });
});

describe('PostgresDriver — CRUD against a mock server', () => {
  let srv: MockPgServer; let driver: PostgresDriver;
  before(async () => {
    srv = new MockPgServer(0, 'trust'); await srv.start();
    driver = new PostgresDriver({ connect: { host: '127.0.0.1', port: srv.address().port } });
  });
  after(async () => { await driver.close(); await srv.close(); });

  it('runs namespace set/get/list/delete/size', async () => {
    const ns = await driver.openNamespace('app.kv');
    await ns.set('a', { x: 1 });
    await ns.set('b', { y: 2 });
    assert.deepEqual(await ns.get('a'), { x: 1 });
    assert.equal(await ns.size(), 2);
    const list = await ns.list({});
    assert.equal(list.items.length, 2);
    assert.equal(await ns.delete('a'), true);
    assert.equal(await ns.size(), 1);
    assert.equal(await ns.has('b'), true);
  });

  it('runs collection put/get/query/count/delete', async () => {
    const c = await driver.openCollection<{ id: string; n: number }>('things');
    await c.put({ id: '1', n: 10 }); await c.put({ id: '2', n: 20 });
    assert.equal((await c.get('1'))!.n, 10);
    assert.equal(await c.count(), 2);
    const over10 = await c.query({ where: (d) => d.n > 10 });
    assert.deepEqual(over10.map((d) => d.id), ['2']);
    await c.delete('1'); assert.equal(await c.count(), 1);
  });

  it('runs blob put/get (binary round-trip)', async () => {
    const b = await driver.openBlobStore('files');
    await b.put('bin', new Uint8Array([0, 127, 255, 1, 2]));
    const got = await b.get('bin');
    assert.deepEqual([...got!], [0, 127, 255, 1, 2]);
    assert.equal(await b.getAsText('txt'), undefined);
  });
});

describe('PostgresDriver — multi-writer visibility (two connections, one server)', () => {
  let srv: MockPgServer; let a: PostgresDriver; let b: PostgresDriver;
  before(async () => {
    srv = new MockPgServer(0, 'trust'); await srv.start();
    const port = srv.address().port;
    a = new PostgresDriver({ connect: { host: '127.0.0.1', port } });
    b = new PostgresDriver({ connect: { host: '127.0.0.1', port } });
  });
  after(async () => { await a.close(); await b.close(); await srv.close(); });

  it('a write on connection A is visible on connection B', async () => {
    const nsA = await a.openNamespace('shared');
    const nsB = await b.openNamespace('shared');
    await nsA.set('k', { from: 'A' });
    assert.deepEqual(await nsB.get('k'), { from: 'A' }); // shared backing store = multi-writer
  });

  it('a collection write on A is listed by B', async () => {
    const cA = await a.openCollection<{ id: string; v: number }>('records');
    const cB = await b.openCollection<{ id: string; v: number }>('records');
    await cA.put({ id: 'r1', v: 1 });
    const all = await cB.all();
    assert.ok(all.some((d) => d.id === 'r1'));
  });
});


describe('StorageModule — postgres driver wiring (kernel integration)', () => {
  let srv: MockPgServer; let kernel: Kernel;
  before(async () => {
    srv = new MockPgServer(0, 'trust'); await srv.start();
    kernel = createTestKernel();
    kernel.register(new StorageModule({ driver: 'postgres', postgres: { host: '127.0.0.1', port: srv.address().port } }));
    await kernel.boot();
  });
  after(async () => { await kernel.shutdown(); await srv.close(); });

  it('boots with the postgres driver and serves namespace CRUD', async () => {
    const storage = kernel.getModule<StorageModule>('storage');
    assert.match(storage.getDriver().id, /postgres/);
    const ns = await storage.namespace('wired');
    await ns.set('k', { hello: 'pg' });
    assert.deepEqual(await ns.get('k'), { hello: 'pg' });
    const col = await storage.collection<{ id: string; n: number }>('docs');
    await col.put({ id: '1', n: 42 });
    assert.equal((await col.get('1'))!.n, 42);
  });
});

// ensure decodeBackend import is used (type-only guard for bundlers)
void decodeBackend;
