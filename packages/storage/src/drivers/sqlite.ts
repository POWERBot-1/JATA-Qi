// SQLite storage driver — production-grade persistent storage using Node.js
// built-in `node:sqlite` (zero external dependencies). Data survives restarts.
// ACID transactions via SQLite's WAL mode. Schema is auto-created + versioned.

import {
  Entry, EntryMeta, IBlobStore, ICollection, INamespace, IStorageDriver,
  ListOptions, ListResult, QueryOptions,
} from '../types.js';

// Use dynamic require to avoid TypeScript errors with experimental module.
type DatabaseSync = {
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
  close(): void;
  pragma(pragma: string): unknown;
};
type StatementSync = {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
};

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

function loadSqlite(): { DatabaseSync: new (path: string) => DatabaseSync } {
  return require('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSync };
}

function estimateSize(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return value.length;
  if (value instanceof Uint8Array) return value.byteLength;
  try { return JSON.stringify(value).length; } catch { return 0; }
}

function encodeToBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? new TextEncoder().encode(data) : data;
}

// --- Schema management -------------------------------------------------------

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS _schema_version (version INTEGER NOT NULL);
  INSERT INTO _schema_version (version) SELECT ${SCHEMA_VERSION} WHERE NOT EXISTS (SELECT 1 FROM _schema_version);

  CREATE TABLE IF NOT EXISTS kv_store (
    namespace TEXT NOT NULL,
    key       TEXT NOT NULL,
    value     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    size      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (namespace, key)
  );
  CREATE INDEX IF NOT EXISTS idx_kv_namespace ON kv_store(namespace);

  CREATE TABLE IF NOT EXISTS collection_docs (
    collection TEXT NOT NULL,
    id         TEXT NOT NULL,
    doc        TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (collection, id)
  );
  CREATE INDEX IF NOT EXISTS idx_collection ON collection_docs(collection);

  CREATE TABLE IF NOT EXISTS blob_store (
    store_name   TEXT NOT NULL,
    key          TEXT NOT NULL,
    data         BLOB NOT NULL,
    content_type TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    size         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (store_name, key)
  );
  CREATE INDEX IF NOT EXISTS idx_blob_store ON blob_store(store_name);
`;

// --- SqliteNamespace ---------------------------------------------------------

export class SqliteNamespace implements INamespace {
  constructor(
    readonly name: string,
    private db: DatabaseSync,
  ) {}

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const row = this.db.prepare('SELECT value FROM kv_store WHERE namespace = ? AND key = ?').get(this.name, key) as { value?: string } | undefined;
    return row ? JSON.parse(row.value!) as T : undefined;
  }

  async getEntry<T = unknown>(key: string): Promise<Entry<T> | undefined> {
    const row = this.db.prepare('SELECT value, created_at, updated_at, size FROM kv_store WHERE namespace = ? AND key = ?').get(this.name, key) as { value?: string; created_at?: number; updated_at?: number; size?: number } | undefined;
    if (!row) return undefined;
    return { value: JSON.parse(row.value!) as T, meta: { key, createdAt: row.created_at!, updatedAt: row.updated_at!, size: row.size } };
  }

  async set<T = unknown>(key: string, value: T): Promise<EntryMeta> {
    const json = JSON.stringify(value);
    const size = json.length;
    const now = Date.now();
    const existing = this.db.prepare('SELECT created_at FROM kv_store WHERE namespace = ? AND key = ?').get(this.name, key);
    const createdAt = existing?.created_at as number ?? now;
    this.db.prepare(
      'INSERT INTO kv_store (namespace, key, value, created_at, updated_at, size) VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, size = excluded.size',
    ).run(this.name, key, json, createdAt, now, size);
    return { key, createdAt, updatedAt: now, size };
  }

  async delete(key: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM kv_store WHERE namespace = ? AND key = ?').run(this.name, key);
    return result.changes > 0;
  }

  async has(key: string): Promise<boolean> {
    const row = this.db.prepare('SELECT 1 FROM kv_store WHERE namespace = ? AND key = ?').get(this.name, key);
    return !!row;
  }

  async list<T = unknown>(opts: ListOptions = {}): Promise<ListResult<T>> {
    const limit = opts.limit ?? 10_000;
    let sql = 'SELECT key, value, created_at, updated_at, size FROM kv_store WHERE namespace = ?';
    const params: unknown[] = [this.name];
    if (opts.prefix) { sql += ' AND key LIKE ?'; params.push(opts.prefix + '%'); }
    if (opts.cursor) { sql += ' AND key > ?'; params.push(opts.cursor); }
    sql += ' ORDER BY key ASC LIMIT ?';
    params.push(limit + 1); // +1 to check for next cursor
    const rows = this.db.prepare(sql).all(...params);
    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    const items: Entry<T>[] = slice.map((r) => ({
      value: JSON.parse(r.value as string) as T,
      meta: { key: r.key as string, createdAt: r.created_at as number, updatedAt: r.updated_at as number, size: r.size as number },
    }));
    const lastKey = slice.length > 0 ? (slice[slice.length - 1]!.key as string) : undefined;
    return { items, nextCursor: hasMore ? lastKey : undefined } as ListResult<T>;
  }

  async clear(): Promise<void> {
    this.db.prepare('DELETE FROM kv_store WHERE namespace = ?').run(this.name);
  }

  async size(): Promise<number> {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM kv_store WHERE namespace = ?').get(this.name);
    return row?.cnt as number ?? 0;
  }
}

// --- SqliteCollection --------------------------------------------------------

export class SqliteCollection<T extends { id: string }> implements ICollection<T> {
  constructor(
    readonly name: string,
    private db: DatabaseSync,
  ) {}

  async put(doc: T): Promise<T> {
    if (!doc?.id) throw new Error(`Collection "${this.name}": document must have an id`);
    const json = JSON.stringify(doc);
    const now = Date.now();
    const existing = this.db.prepare('SELECT created_at FROM collection_docs WHERE collection = ? AND id = ?').get(this.name, doc.id);
    const createdAt = existing?.created_at as number ?? now;
    this.db.prepare(
      'INSERT INTO collection_docs (collection, id, doc, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(collection, id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at',
    ).run(this.name, doc.id, json, createdAt, now);
    return doc;
  }

  async get(id: string): Promise<T | undefined> {
    const row = this.db.prepare('SELECT doc FROM collection_docs WHERE collection = ? AND id = ?').get(this.name, id);
    return row ? JSON.parse(row.doc as string) as T : undefined;
  }

  async delete(id: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM collection_docs WHERE collection = ? AND id = ?').run(this.name, id);
    return result.changes > 0;
  }

  async has(id: string): Promise<boolean> {
    const row = this.db.prepare('SELECT 1 FROM collection_docs WHERE collection = ? AND id = ?').get(this.name, id);
    return !!row;
  }

  async query(opts: QueryOptions<T> = {}): Promise<T[]> {
    let items = await this.all();
    if (opts.where) items = items.filter(opts.where);
    if (opts.orderBy) {
      const k = opts.orderBy;
      const dir = opts.order === 'desc' ? -1 : 1;
      items.sort((a, b) => {
        const av = (a as Record<string, unknown>)[k] as unknown;
        const bv = (b as Record<string, unknown>)[k] as unknown;
        if (av === bv) return 0;
        return (av as Record<string, unknown>) > (bv as Record<string, unknown>) ? dir : -dir;
      });
    }
    if (opts.offset) items = items.slice(opts.offset);
    if (opts.limit) items = items.slice(0, opts.limit);
    return items;
  }

  async all(): Promise<T[]> {
    const rows = this.db.prepare('SELECT doc FROM collection_docs WHERE collection = ? ORDER BY id').all(this.name);
    return rows.map((r) => JSON.parse(r.doc as string) as T);
  }

  async count(): Promise<number> {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM collection_docs WHERE collection = ?').get(this.name);
    return row?.cnt as number ?? 0;
  }

  async clear(): Promise<void> {
    this.db.prepare('DELETE FROM collection_docs WHERE collection = ?').run(this.name);
  }
}

// --- SqliteBlobStore ---------------------------------------------------------

export class SqliteBlobStore implements IBlobStore {
  constructor(
    readonly name: string,
    private db: DatabaseSync,
  ) {}

  async put(key: string, data: Uint8Array | string, contentType?: string): Promise<EntryMeta> {
    const bytes = encodeToBytes(data);
    const size = bytes.byteLength;
    const now = Date.now();
    const existing = this.db.prepare('SELECT created_at FROM blob_store WHERE store_name = ? AND key = ?').get(this.name, key);
    const createdAt = existing?.created_at as number ?? now;
    this.db.prepare(
      'INSERT INTO blob_store (store_name, key, data, content_type, created_at, updated_at, size) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(store_name, key) DO UPDATE SET data = excluded.data, content_type = excluded.content_type, updated_at = excluded.updated_at, size = excluded.size',
    ).run(this.name, key, Buffer.from(bytes), contentType ?? null, createdAt, now, size);
    return { key, createdAt, updatedAt: now, size };
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const row = this.db.prepare('SELECT data FROM blob_store WHERE store_name = ? AND key = ?').get(this.name, key);
    return row ? new Uint8Array(row.data as Uint8Array) : undefined;
  }

  async getAsText(key: string): Promise<string | undefined> {
    const bytes = await this.get(key);
    return bytes ? new TextDecoder().decode(bytes) : undefined;
  }

  async getMeta(key: string): Promise<EntryMeta | undefined> {
    const row = this.db.prepare('SELECT created_at, updated_at, size FROM blob_store WHERE store_name = ? AND key = ?').get(this.name, key);
    return row ? { key, createdAt: row.created_at as number, updatedAt: row.updated_at as number, size: row.size as number } : undefined;
  }

  async delete(key: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM blob_store WHERE store_name = ? AND key = ?').run(this.name, key);
    return result.changes > 0;
  }

  async has(key: string): Promise<boolean> {
    const row = this.db.prepare('SELECT 1 FROM blob_store WHERE store_name = ? AND key = ?').get(this.name, key);
    return !!row;
  }

  async list(opts: ListOptions = {}): Promise<ListResult<Uint8Array>> {
    const limit = opts.limit ?? 10_000;
    let sql = 'SELECT key, data, created_at, updated_at, size FROM blob_store WHERE store_name = ?';
    const params: unknown[] = [this.name];
    if (opts.prefix) { sql += ' AND key LIKE ?'; params.push(opts.prefix + '%'); }
    sql += ' ORDER BY key ASC LIMIT ?';
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params);
    return {
      items: rows.map((r) => ({
        value: new Uint8Array(r.data as Uint8Array),
        meta: { key: r.key as string, createdAt: r.created_at as number, updatedAt: r.updated_at as number, size: r.size as number },
      })),
    };
  }

  async clear(): Promise<void> {
    this.db.prepare('DELETE FROM blob_store WHERE store_name = ?').run(this.name);
  }
}

// --- SqliteDriver ------------------------------------------------------------

export interface SqliteDriverOptions {
  /** Path to the SQLite database file. Use ':memory:' for in-memory. */
  path?: string;
  /** Enable WAL mode (default: true for file, false for :memory:). */
  wal?: boolean;
}

export class SqliteDriver implements IStorageDriver {
  readonly id = 'sqlite';
  private db: DatabaseSync;
  private readonly path: string;
  private namespaces = new Map<string, SqliteNamespace>();
  private collections = new Map<string, SqliteCollection<{ id: string }>>();
  private blobs = new Map<string, SqliteBlobStore>();

  constructor(opts: SqliteDriverOptions = {}) {
    this.path = opts.path ?? ':memory:';
    const { DatabaseSync } = loadSqlite();
    this.db = new DatabaseSync(this.path);
    // Performance pragmas.
    const isFile = this.path !== ':memory:';
    if (opts.wal ?? isFile) {
      try { this.db.pragma('journal_mode = WAL'); } catch { /* WAL may not be available */ }
    }
    try { this.db.pragma('synchronous = NORMAL'); } catch { /* */ }
    try { this.db.pragma('foreign_keys = ON'); } catch { /* */ }
    // Auto-create schema.
    this.db.exec(SCHEMA_SQL);
  }

  /** Get the underlying database path. */
  get path_(): string { return this.path; }

  async openNamespace(name: string): Promise<INamespace> {
    let ns = this.namespaces.get(name);
    if (!ns) { ns = new SqliteNamespace(name, this.db); this.namespaces.set(name, ns); }
    return ns;
  }

  async openCollection<T extends { id: string }>(name: string): Promise<ICollection<T>> {
    let c = this.collections.get(name);
    if (!c) { c = new SqliteCollection(name, this.db); this.collections.set(name, c as SqliteCollection<{ id: string }>); }
    return c as unknown as SqliteCollection<T>;
  }

  async openBlobStore(name: string): Promise<IBlobStore> {
    let b = this.blobs.get(name);
    if (!b) { b = new SqliteBlobStore(name, this.db); this.blobs.set(name, b); }
    return b;
  }

  async close(): Promise<void> {
    this.namespaces.clear();
    this.collections.clear();
    this.blobs.clear();
    try { this.db.close(); } catch { /* already closed */ }
  }

  /** Run a function within a transaction. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}
