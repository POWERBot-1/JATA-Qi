// PostgresDriver — IStorageDriver backed by a shared PostgreSQL instance via the
// pure-Node wire client (./pg/). Same schema shape as the SQLite driver, so the
// storage abstraction works identically. Because many gateway instances connect
// to ONE Postgres, this enables true multi-WRITER horizontal scaling (MVCC).
//
// Zero external runtime dependencies (node:net + node:crypto only).

import type {
  IBlobStore, ICollection, INamespace, IStorageDriver,
  Entry, EntryMeta, ListOptions, ListResult, QueryOptions,
} from '../types.js';
import { PostgresConnection, type PostgresConnectOptions } from './pg/connection.js';

/** Minimal executor interface (the real connection or a test mock). */
export interface PgExecutor {
  query(sql: string, params?: (string | null)[]): Promise<{ rows: Record<string, string | null>[]; rowCount: number }>;
  simpleQuery(sql: string): Promise<void>;
  close(): Promise<void>;
}

export interface PostgresDriverOptions {
  /** Connection options (used when no `connection` is injected). */
  connect?: PostgresConnectOptions;
  /** Inject a custom executor (e.g. a mock for tests). */
  connection?: PgExecutor;
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS kv_store (
    namespace text NOT NULL,
    key       text NOT NULL,
    value     text NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    size      bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (namespace, key)
  );
  CREATE INDEX IF NOT EXISTS idx_kv_namespace ON kv_store(namespace);
  CREATE TABLE IF NOT EXISTS collection_docs (
    collection text NOT NULL,
    id         text NOT NULL,
    doc        text NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (collection, id)
  );
  CREATE INDEX IF NOT EXISTS idx_collection ON collection_docs(collection);
  CREATE TABLE IF NOT EXISTS blob_store (
    store_name   text NOT NULL,
    key          text NOT NULL,
    data         text NOT NULL,
    content_type text,
    created_at   bigint NOT NULL,
    updated_at   bigint NOT NULL,
    size         bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (store_name, key)
  );
  CREATE INDEX IF NOT EXISTS idx_blob_store ON blob_store(store_name);
`;

export class PostgresDriver implements IStorageDriver {
  readonly id = 'postgres';
  private readonly exec: PgExecutor;
  private ready?: Promise<void>;

  constructor(opts: PostgresDriverOptions = {}) {
    if (opts.connection) {
      this.exec = opts.connection;
    } else {
      this.exec = new PostgresConnection(opts.connect ?? {});
    }
  }

  /** Connect (if using a real connection) and ensure the schema exists. */
  private ensure(): Promise<void> {
    if (!this.ready) this.ready = this.init();
    return this.ready;
  }

  private async init(): Promise<void> {
    if (this.exec instanceof PostgresConnection) await this.exec.connect();
    await this.exec.simpleQuery(SCHEMA_SQL);
  }

  async openNamespace(name: string): Promise<INamespace> {
    await this.ensure();
    return new PostgresNamespace(name, this.exec);
  }
  async openCollection<T extends { id: string }>(name: string): Promise<ICollection<T>> {
    await this.ensure();
    return new PostgresCollection<T>(name, this.exec);
  }
  async openBlobStore(name: string): Promise<IBlobStore> {
    await this.ensure();
    return new PostgresBlobStore(name, this.exec);
  }
  async close(): Promise<void> { await this.exec.close(); }
}

function toHex(bytes: Uint8Array): string { return Buffer.from(bytes).toString('hex'); }
function fromHex(hex: string): Uint8Array { return new Uint8Array(Buffer.from(hex, 'hex')); }

// --- PostgresNamespace -------------------------------------------------------

class PostgresNamespace implements INamespace {
  constructor(readonly name: string, private db: PgExecutor) {}
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const r = await this.db.query('SELECT value FROM kv_store WHERE namespace=$1 AND key=$2', [this.name, key]);
    return r.rows[0] ? (JSON.parse(r.rows[0].value!) as T) : undefined;
  }
  async getEntry<T = unknown>(key: string): Promise<Entry<T> | undefined> {
    const r = await this.db.query('SELECT value, created_at, updated_at, size FROM kv_store WHERE namespace=$1 AND key=$2', [this.name, key]);
    if (!r.rows[0]) return undefined;
    const row = r.rows[0];
    return { value: JSON.parse(row.value!) as T, meta: { key, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), size: Number(row.size) } };
  }
  async set<T = unknown>(key: string, value: T): Promise<EntryMeta> {
    const json = JSON.stringify(value);
    const size = json.length;
    const now = Date.now();
    const r = await this.db.query(
      `INSERT INTO kv_store (namespace, key, value, created_at, updated_at, size) VALUES ($1,$2,$3,$4::bigint,$4::bigint,$5::bigint)
       ON CONFLICT (namespace, key) DO UPDATE SET value=$3, updated_at=$4::bigint, size=$5::bigint
       RETURNING created_at`,
      [this.name, key, json, String(now), String(size)],
    );
    const createdAt = Number(r.rows[0]?.created_at ?? now);
    return { key, createdAt, updatedAt: now, size };
  }
  async delete(key: string): Promise<boolean> { const r = await this.db.query('DELETE FROM kv_store WHERE namespace=$1 AND key=$2', [this.name, key]); return r.rowCount > 0; }
  async has(key: string): Promise<boolean> { const r = await this.db.query('SELECT 1 FROM kv_store WHERE namespace=$1 AND key=$2', [this.name, key]); return r.rows.length > 0; }
  async list<T = unknown>(opts: ListOptions = {}): Promise<ListResult<T>> {
    const limit = opts.limit ?? 10_000;
    const where = ['namespace=$1']; const params: (string | null)[] = [this.name];
    if (opts.prefix) { params.push(opts.prefix + '%'); where.push(`key LIKE $${params.length}`); }
    if (opts.cursor) { params.push(opts.cursor); where.push(`key > $${params.length}`); }
    params.push(String(limit + 1));
    const r = await this.db.query(`SELECT key, value, created_at, updated_at, size FROM kv_store WHERE ${where.join(' AND ')} ORDER BY key ASC LIMIT $${params.length}`, params);
    const hasMore = r.rows.length > limit;
    const slice = hasMore ? r.rows.slice(0, limit) : r.rows;
    const items: Entry<T>[] = slice.map((row) => ({ value: JSON.parse(row.value!) as T, meta: { key: row.key!, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), size: Number(row.size) } }));
    const lastKey = slice.length > 0 ? slice[slice.length - 1]!.key : undefined;
    return { items, ...(hasMore && lastKey ? { nextCursor: lastKey } : {}) };
  }
  async clear(): Promise<void> { await this.db.query('DELETE FROM kv_store WHERE namespace=$1', [this.name]); }
  async size(): Promise<number> { const r = await this.db.query('SELECT COUNT(*)::int AS c FROM kv_store WHERE namespace=$1', [this.name]); return Number(r.rows[0]?.c ?? 0); }
}

// --- PostgresCollection ------------------------------------------------------

class PostgresCollection<T extends { id: string }> implements ICollection<T> {
  constructor(readonly name: string, private db: PgExecutor) {}
  async put(doc: T): Promise<T> {
    if (!doc?.id) throw new Error(`Collection "${this.name}": document must have an id`);
    const json = JSON.stringify(doc);
    const now = Date.now();
    await this.db.query(
      `INSERT INTO collection_docs (collection, id, doc, created_at, updated_at) VALUES ($1,$2,$3,$4::bigint,$4::bigint)
       ON CONFLICT (collection, id) DO UPDATE SET doc=$3, updated_at=$4::bigint`,
      [this.name, doc.id, json, String(now)],
    );
    return doc;
  }
  async get(id: string): Promise<T | undefined> {
    const r = await this.db.query('SELECT doc FROM collection_docs WHERE collection=$1 AND id=$2', [this.name, id]);
    return r.rows[0] ? (JSON.parse(r.rows[0].doc!) as T) : undefined;
  }
  async delete(id: string): Promise<boolean> { const r = await this.db.query('DELETE FROM collection_docs WHERE collection=$1 AND id=$2', [this.name, id]); return r.rowCount > 0; }
  async has(id: string): Promise<boolean> { const r = await this.db.query('SELECT 1 FROM collection_docs WHERE collection=$1 AND id=$2', [this.name, id]); return r.rows.length > 0; }
  async query(opts: QueryOptions<T> = {}): Promise<T[]> {
    let items = await this.all();
    if (opts.where) items = items.filter(opts.where);
    if (opts.orderBy) {
      const k = opts.orderBy; const dir = opts.order === 'desc' ? -1 : 1;
      items.sort((a, b) => {
        const av = (a as Record<string, unknown>)[k] as unknown; const bv = (b as Record<string, unknown>)[k] as unknown;
        if (av === bv) return 0; return (av as Record<string, unknown>) > (bv as Record<string, unknown>) ? dir : -dir;
      });
    }
    if (opts.offset) items = items.slice(opts.offset);
    if (opts.limit) items = items.slice(0, opts.limit);
    return items;
  }
  async all(): Promise<T[]> {
    const r = await this.db.query('SELECT doc FROM collection_docs WHERE collection=$1 ORDER BY id', [this.name]);
    return r.rows.map((row) => JSON.parse(row.doc!) as T);
  }
  async count(): Promise<number> { const r = await this.db.query('SELECT COUNT(*)::int AS c FROM collection_docs WHERE collection=$1', [this.name]); return Number(r.rows[0]?.c ?? 0); }
  async clear(): Promise<void> { await this.db.query('DELETE FROM collection_docs WHERE collection=$1', [this.name]); }
}

// --- PostgresBlobStore -------------------------------------------------------

class PostgresBlobStore implements IBlobStore {
  constructor(readonly name: string, private db: PgExecutor) {}
  async put(key: string, data: Uint8Array | string, contentType?: string): Promise<EntryMeta> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const hex = toHex(bytes); const size = bytes.byteLength; const now = Date.now();
    const r = await this.db.query(
      `INSERT INTO blob_store (store_name, key, data, content_type, created_at, updated_at, size) VALUES ($1,$2,$3,$4,$5::bigint,$5::bigint,$6::bigint)
       ON CONFLICT (store_name, key) DO UPDATE SET data=$3, content_type=$4, updated_at=$5::bigint, size=$6::bigint
       RETURNING created_at`,
      [this.name, key, hex, contentType ?? null, String(now), String(size)],
    );
    return { key, createdAt: Number(r.rows[0]?.created_at ?? now), updatedAt: now, size };
  }
  async get(key: string): Promise<Uint8Array | undefined> {
    const r = await this.db.query('SELECT data FROM blob_store WHERE store_name=$1 AND key=$2', [this.name, key]);
    return r.rows[0] ? fromHex(r.rows[0].data!) : undefined;
  }
  async getAsText(key: string): Promise<string | undefined> { const b = await this.get(key); return b ? new TextDecoder().decode(b) : undefined; }
  async getMeta(key: string): Promise<EntryMeta | undefined> {
    const r = await this.db.query('SELECT created_at, updated_at, size FROM blob_store WHERE store_name=$1 AND key=$2', [this.name, key]);
    if (!r.rows[0]) return undefined;
    const row = r.rows[0];
    return { key, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), size: Number(row.size) };
  }
  async delete(key: string): Promise<boolean> { const r = await this.db.query('DELETE FROM blob_store WHERE store_name=$1 AND key=$2', [this.name, key]); return r.rowCount > 0; }
  async has(key: string): Promise<boolean> { const r = await this.db.query('SELECT 1 FROM blob_store WHERE store_name=$1 AND key=$2', [this.name, key]); return r.rows.length > 0; }
  async list(opts: ListOptions = {}): Promise<ListResult<Uint8Array>> {
    const limit = opts.limit ?? 10_000;
    const where = ['store_name=$1']; const params: (string | null)[] = [this.name];
    if (opts.prefix) { params.push(opts.prefix + '%'); where.push(`key LIKE $${params.length}`); }
    params.push(String(limit));
    const r = await this.db.query(`SELECT key, data, created_at, updated_at, size FROM blob_store WHERE ${where.join(' AND ')} ORDER BY key ASC LIMIT $${params.length}`, params);
    return {
      items: r.rows.map((row) => ({ value: fromHex(row.data!), meta: { key: row.key!, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), size: Number(row.size) } })),
    };
  }
  async clear(): Promise<void> { await this.db.query('DELETE FROM blob_store WHERE store_name=$1', [this.name]); }
}
