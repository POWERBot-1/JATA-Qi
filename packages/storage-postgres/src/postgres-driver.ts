// P-01 PostgreSQL storage driver implementing @jataqi/storage's IStorageDriver.
//
// It provides authoritative, transactional, database-backed persistence for
// collections (used by loop-host work items, leases, and checkpoints), plus
// namespaces and blobs. This driver is persistence infrastructure only: it
// contains no reasoning, planning, policy, authorization, capability granting,
// human-approval, regulatory, or execution logic. Higher layers route through
// @jataqi/storage's interfaces and never depend on PostgreSQL APIs directly.

import { createHash } from 'node:crypto';
import pg from 'pg';
import type {
  CollectionIndexDef,
  Entry,
  IBlobStore,
  ICollection,
  INamespace,
  IStorageDriver,
  IStorageTransaction,
  ListOptions,
  ListResult,
} from '@jataqi/storage';
import { StorageModule } from '@jataqi/storage';
import { PostgresDriverConfig, resolvePoolConfig, STORAGE_POSTGRES_SCHEMA_VERSION, R2_DEFAULT_LOCK_TIMEOUT_MS, R2_DEFAULT_STATEMENT_TIMEOUT_MS } from './config.js';
import { IncompatibleStorageSchemaError, PostgresConfigError } from './errors.js';
import {
  ensureTenantIsolation,
  setSystemTenantContext,
  setTenantContext,
  TENANT_ID_COLUMN,
  TENANT_RLS_SETTING,
  TENANT_SYSTEM_SCOPE,
} from './tenant-isolation.js';
import { deriveTableName } from './naming.js';
import { PostgresCollection } from './postgres-collection.js';

const { Pool } = pg;

const SCHEMA_TABLE = 'jata_qi_schema';

/**
 * F1 (post-verification remediation): observable pool-degradation state.
 * `degraded` is set when the pool reports an 'error' (e.g. backends dying
 * mid-outage) and clears when an operation next completes a live database
 * round-trip. `poolErrors` is monotonic (a counter, not a latch).
 */
export interface PostgresPoolHealth {
  readonly degraded: boolean;
  readonly poolErrors: number;
  readonly lastPoolErrorAt?: number;
  readonly lastPoolErrorMessage?: string;
}

function escapeId(identifier: string): string {
  return '"' + identifier.replace(/"/g, '""') + '"';
}

interface EntryMeta {
  key: string;
  createdAt: number;
  updatedAt: number;
  size?: number;
  etag?: string;
  contentType?: string;
}

function nowEpoch(): number {
  return Date.now();
}

export class PostgresNamespace implements INamespace {
  constructor(
    public readonly name: string,
    private readonly table: string,
    private readonly pool: pg.Pool,
    private readonly client?: pg.PoolClient,
  ) {}

  private get exec(): pg.Pool | pg.PoolClient {
    return (this.client ?? this.pool) as pg.Pool | pg.PoolClient;
  }

  private async q(text: string, values?: unknown[]) {
    return this.exec.query(text, values);
  }

  private decode(row: { value?: unknown; meta?: unknown } | undefined): { value?: unknown; meta?: EntryMeta } {
    if (!row) return {};
    return { value: row.value, meta: (row.meta as EntryMeta) ?? undefined };
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const t = escapeId(this.table);
    const res = await this.q(`SELECT value FROM ${t} WHERE k = $1`, [key]);
    return res.rows[0]?.value as T | undefined;
  }

  async getEntry<T = unknown>(key: string): Promise<Entry<T> | undefined> {
    const t = escapeId(this.table);
    const res = await this.q(`SELECT value, meta FROM ${t} WHERE k = $1`, [key]);
    const row = res.rows[0];
    if (!row) return undefined;
    return { value: row.value as T, meta: row.meta as EntryMeta };
  }

  async set<T = unknown>(key: string, value: T): Promise<EntryMeta> {
    const t = escapeId(this.table);
    const prior = await this.getEntry<unknown>(key);
    const at = nowEpoch();
    const meta: EntryMeta = {
      key,
      createdAt: prior?.meta.createdAt ?? at,
      updatedAt: at,
      size: estimateSize(value),
      etag: `${at.toString(36)}-${randomSuffix()}`,
    };
    await this.q(
      `INSERT INTO ${t} (k, value, meta, updated_at) VALUES ($1, $2::jsonb, $3::jsonb, now())
       ON CONFLICT (k) DO UPDATE SET value = EXCLUDED.value, meta = EXCLUDED.meta, updated_at = now()`,
      [key, JSON.stringify(value), JSON.stringify(meta)],
    );
    return meta;
  }

  async delete(key: string): Promise<boolean> {
    const t = escapeId(this.table);
    const res = await this.q(`DELETE FROM ${t} WHERE k = $1`, [key]);
    return (res.rowCount ?? 0) > 0;
  }

  async has(key: string): Promise<boolean> {
    const t = escapeId(this.table);
    const res = await this.q(`SELECT 1 FROM ${t} WHERE k = $1`, [key]);
    return res.rows.length > 0;
  }

  async list<T = unknown>(opts: ListOptions = {}): Promise<ListResult<T>> {
    const t = escapeId(this.table);
    const res = await this.q(`SELECT value, meta FROM ${t}`);
    let entries = res.rows.map((row) => ({ value: row.value as T, meta: row.meta as EntryMeta }));
    if (opts.prefix) entries = entries.filter((e) => e.meta.key.startsWith(opts.prefix!));
    entries.sort((a, b) => (a.meta.key < b.meta.key ? -1 : a.meta.key > b.meta.key ? 1 : 0));
    const limit = opts.limit ?? entries.length;
    const start = opts.cursor ? entries.findIndex((e) => e.meta.key === opts.cursor) + 1 : 0;
    const slice = entries.slice(start, start + limit);
    const nextCursor = start + limit < entries.length ? slice[slice.length - 1]!.meta.key : undefined;
    return { items: slice, nextCursor };
  }

  async clear(): Promise<void> {
    const t = escapeId(this.table);
    await this.q(`TRUNCATE ${t}`);
  }

  async size(): Promise<number> {
    const t = escapeId(this.table);
    const res = await this.q(`SELECT count(*)::int AS n FROM ${t}`);
    return res.rows[0]?.n ?? 0;
  }
}

export class PostgresBlobStore implements IBlobStore {
  constructor(
    public readonly name: string,
    private readonly table: string,
    private readonly pool: pg.Pool,
    private readonly client?: pg.PoolClient,
  ) {}

  private get exec(): pg.Pool | pg.PoolClient {
    return (this.client ?? this.pool) as pg.Pool | pg.PoolClient;
  }

  private async q(text: string, values?: unknown[]) {
    return this.exec.query(text, values);
  }

  private encode(data: Uint8Array | string): Buffer {
    return Buffer.from(data instanceof Uint8Array ? data : new TextEncoder().encode(data));
  }

  private decodeBytes(value: unknown): Uint8Array {
    // pg returns bytea as a Buffer, which is a Uint8Array.
    return value instanceof Uint8Array ? value : new Uint8Array(0);
  }

  async put(key: string, data: Uint8Array | string, contentType?: string): Promise<EntryMeta> {
    const t = escapeId(this.table);
    const bytes = this.encode(data);
    const prior = await this.getMeta(key);
    const at = nowEpoch();
    const meta: EntryMeta = {
      key,
      createdAt: prior?.createdAt ?? at,
      updatedAt: at,
      size: bytes.byteLength,
      etag: `${at.toString(36)}-${randomSuffix()}`,
      contentType,
    };
    await this.q(
      `INSERT INTO ${t} (k, data, meta, updated_at) VALUES ($1, $2::bytea, $3::jsonb, now())
       ON CONFLICT (k) DO UPDATE SET data = EXCLUDED.data, meta = EXCLUDED.meta, updated_at = now()`,
      [key, bytes, JSON.stringify(meta)],
    );
    return meta;
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const t = escapeId(this.table);
    const res = await this.q(`SELECT data FROM ${t} WHERE k = $1`, [key]);
    if (!res.rows[0]) return undefined;
    return this.decodeBytes(res.rows[0].data);
  }

  async getAsText(key: string): Promise<string | undefined> {
    const bytes = await this.get(key);
    return bytes ? new TextDecoder().decode(bytes) : undefined;
  }

  async getMeta(key: string): Promise<EntryMeta | undefined> {
    const t = escapeId(this.table);
    const res = await this.q(`SELECT meta FROM ${t} WHERE k = $1`, [key]);
    return res.rows[0]?.meta as EntryMeta | undefined;
  }

  async delete(key: string): Promise<boolean> {
    const t = escapeId(this.table);
    const res = await this.q(`DELETE FROM ${t} WHERE k = $1`, [key]);
    return (res.rowCount ?? 0) > 0;
  }

  async has(key: string): Promise<boolean> {
    const t = escapeId(this.table);
    const res = await this.q(`SELECT 1 FROM ${t} WHERE k = $1`, [key]);
    return res.rows.length > 0;
  }

  async list(opts: ListOptions = {}): Promise<ListResult<Uint8Array>> {
    const t = escapeId(this.table);
    const res = await this.q(`SELECT data, meta FROM ${t}`);
    let items = res.rows.map((row) => ({ value: this.decodeBytes(row.data), meta: row.meta as EntryMeta }));
    if (opts.prefix) items = items.filter((e) => e.meta.key.startsWith(opts.prefix!));
    items.sort((a, b) => (a.meta.key < b.meta.key ? -1 : 1));
    const limit = opts.limit ?? items.length;
    const start = opts.cursor ? items.findIndex((e) => e.meta.key === opts.cursor) + 1 : 0;
    const slice = items.slice(start, start + limit);
    const nextCursor = start + limit < items.length ? slice[slice.length - 1]!.meta.key : undefined;
    return { items: slice, nextCursor };
  }

  async clear(): Promise<void> {
    const t = escapeId(this.table);
    await this.q(`TRUNCATE ${t}`);
  }
}

export class PostgresDriver implements IStorageDriver {
  readonly id = 'postgres';
  readonly schemaVersion = STORAGE_POSTGRES_SCHEMA_VERSION;
  private readonly opts: PostgresDriverConfig;
  private _pool: pg.Pool | undefined;
  private readyPromise: Promise<void> | undefined;
  private closed = false;
  // F1 (post-verification remediation): pool-level degradation state. A
  // pool 'error' (idle-client death during a live PostgreSQL
  // outage/restart) sets `poolDegraded`; the next operation that completes
  // a live database round-trip clears it. `poolErrorCount` is monotonic.
  private poolDegraded = false;
  private poolErrorCount = 0;
  private lastPoolErrorAt: number | undefined;
  private lastPoolErrorMessage: string | undefined;
  private readonly tables = new Map<string, string>();

  constructor(opts: PostgresDriverConfig = {}) {
    this.opts = opts;
  }

  get pool(): pg.Pool {
    if (!this._pool) throw new Error('Postgres driver is not ready; open a resource or call init() first.');
    return this._pool;
  }

  /** F1: record a pool-level 'error' (never throws; observability only). */
  private notePoolError(error: unknown): void {
    this.poolErrorCount += 1;
    this.poolDegraded = true;
    this.lastPoolErrorAt = Date.now();
    this.lastPoolErrorMessage = error instanceof Error ? error.message : String(error);
  }

  /** F1: a live database round-trip completed — the pool is healthy again. */
  private notePoolHealthy(): void {
    this.poolDegraded = false;
  }

  /**
   * F1: current pool-degradation state. Operators and tests use this to
   * observe outage impact; it never gates authorization by itself —
   * fail-closed behavior comes from operations failing against the
   * unreachable database (mapped to SECURITY_STATE_UNAVAILABLE above).
   */
  getPoolHealth(): PostgresPoolHealth {
    return {
      degraded: this.poolDegraded,
      poolErrors: this.poolErrorCount,
      ...(this.lastPoolErrorAt !== undefined ? { lastPoolErrorAt: this.lastPoolErrorAt } : {}),
      ...(this.lastPoolErrorMessage !== undefined ? { lastPoolErrorMessage: this.lastPoolErrorMessage } : {}),
    };
  }

  /** Prepare the connection pool and base schema. Safe to call repeatedly. */
  async init(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.doInit().catch((error) => {
      this.readyPromise = undefined;
      throw error;
    });
    return this.readyPromise;
  }

  private async doInit(): Promise<void> {
    if (this.closed) throw new Error('Postgres storage driver is closed.');
    this._pool = this.opts.pool ?? new Pool(resolvePoolConfig(this.opts));
    // T-06: every pooled session starts in the explicit SYSTEM scope ('*') so
    // unscoped (system) reads/writes behave exactly like the pre-RLS driver.
    // Tenant-scoped transactions override the GUC per-transaction with
    // `SET LOCAL` (see beginTransaction), so the two scopes never bleed into
    // each other. Sessions without ANY scope (unset GUC) fail closed — they
    // can see and write no tenant-scoped rows.
    this._pool.on('connect', (client: pg.PoolClient) => {
      client
        .query(`SET ${TENANT_RLS_SETTING} = '${TENANT_SYSTEM_SCOPE}'`)
        .catch(() => undefined);
    });
    // F1 (post-verification remediation): a pool-level 'error'
    // (idle-client death during a live PostgreSQL outage/restart) MUST be
    // handled — an unhandled pool 'error' event throws and terminates the
    // host. Recording the degradation (observable via getPoolHealth())
    // keeps the host alive; operations attempted while the database is
    // unreachable fail closed through the normal query-error path (mapped
    // to SECURITY_STATE_UNAVAILABLE by the security layers — never ALLOW,
    // never a memory/process-local fallback). The degraded flag clears on
    // the next operation that completes a live round-trip, so recovery
    // needs no restart and no permissive retry.
    this._pool.on('error', (error: Error) => {
      this.notePoolError(error);
    });
    const schema = escapeId(SCHEMA_TABLE);
    try {
      await this._pool.query(
        `CREATE TABLE IF NOT EXISTS ${schema} (
          resource_key text PRIMARY KEY,
          kind text NOT NULL,
          logical text NOT NULL,
          version integer NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )`,
      );
    } catch (error) {
      // Multi-process first boot (T-06 evidence): simultaneous driver init in
      // several fresh processes can lose the catalog race creating the shared
      // schema-registry table (23505 / 42P07 / 42710). One retry is exact.
      const code = (error as { code?: string })?.code;
      if (code !== '23505' && code !== '42P07' && code !== '42710') throw error;
      try {
        await this._pool.query(
          `CREATE TABLE IF NOT EXISTS ${schema} (
            resource_key text PRIMARY KEY,
            kind text NOT NULL,
            logical text NOT NULL,
            version integer NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now()
          )`,
        );
      } catch {
        throw error;
      }
    }
  }

  private async ensureReady(): Promise<void> {
    if (!this._pool) await this.init();
    if (!this._pool) throw new Error('Postgres driver failed to initialize.');
  }

  private resourceTable(exec: pg.Pool | pg.PoolClient, kind: 'collection' | 'namespace' | 'blob', logical: string): Promise<string> {
    return this.ensureResource(exec, kind, logical);
  }

  private async ensureResource(exec: pg.Pool | pg.PoolClient, kind: 'collection' | 'namespace' | 'blob', logical: string): Promise<string> {
    const table = deriveTableName(kind, logical);
    const t = escapeId(table);
    const ddl =
      kind === 'collection'
        ? `CREATE TABLE IF NOT EXISTS ${t} (
             id text PRIMARY KEY,
             body jsonb NOT NULL,
             ${TENANT_ID_COLUMN} text,
             updated_at timestamptz NOT NULL DEFAULT now()
           )`
        : kind === 'namespace'
          ? `CREATE TABLE IF NOT EXISTS ${t} (
               k text PRIMARY KEY,
               value jsonb,
               meta jsonb,
               updated_at timestamptz NOT NULL DEFAULT now()
             )`
          : `CREATE TABLE IF NOT EXISTS ${t} (
               k text PRIMARY KEY,
               data bytea,
               meta jsonb,
               updated_at timestamptz NOT NULL DEFAULT now()
             )`;
    try {
      await exec.query(ddl);
    } catch (error) {
      // Concurrent first boot (T-05/T-06 multi-process evidence): two sessions
      // racing `CREATE TABLE IF NOT EXISTS` for the same new table can lose
      // the catalog race with a unique violation (23505 on pg_type), a
      // duplicate-table error (42P07), or a duplicate-object error (42710 —
      // the implicit array type of the concurrently-created table). The table
      // now exists, so one retry is exact; any other failure (or a failure of
      // the retry) surfaces the ORIGINAL error unchanged (fail-closed, no
      // silent fallback).
      const code = (error as { code?: string })?.code;
      if (code !== '23505' && code !== '42P07' && code !== '42710') throw error;
      try {
        await exec.query(ddl);
      } catch {
        throw error;
      }
    }
    const schema = escapeId(SCHEMA_TABLE);
    await exec.query(
      `INSERT INTO ${schema} (resource_key, kind, logical, version) VALUES ($1, $2, $3, $4)
       ON CONFLICT (resource_key) DO NOTHING`,
      [table, kind, logical, STORAGE_POSTGRES_SCHEMA_VERSION],
    );
    const res = await exec.query(`SELECT version FROM ${schema} WHERE resource_key = $1`, [table]);
    const version = res.rows[0]?.version as number | undefined;
    if (version !== undefined && version !== STORAGE_POSTGRES_SCHEMA_VERSION) {
      throw new IncompatibleStorageSchemaError(
        `Postgres resource "${logical}" (${table}) has schema version ${version}, expected ${STORAGE_POSTGRES_SCHEMA_VERSION}. Failing closed.`,
      );
    }
    if (kind === 'collection') {
      // T-06 production wiring: every collection table carries the tenant_id
      // column and an RLS policy BEFORE any handle is handed out. The
      // operation is idempotent and cheap when already applied (single
      // catalog probe). Both the column and the policy are DDL persisted in
      // the database, so enforcement survives driver/process restarts.
      const guard = await exec.query(
        `SELECT c.relrowsecurity,
                EXISTS(SELECT 1 FROM pg_attribute a
                        WHERE a.attrelid = c.oid AND a.attname = $2) AS has_col,
                EXISTS(SELECT 1 FROM pg_policy p
                        WHERE p.polrelid = c.oid AND p.polname = $3) AS has_pol
         FROM pg_class c WHERE c.relname = $1`,
        [table, TENANT_ID_COLUMN, `${table}_tenant_isolation`],
      );
      const g = guard.rows[0] as { relrowsecurity?: boolean; has_col?: boolean; has_pol?: boolean } | undefined;
      if (!g || !g.relrowsecurity || !g.has_col || !g.has_pol) {
        await ensureTenantIsolation(exec, table);
      }
    }
    return table;
  }

  private async table(kind: 'collection' | 'namespace' | 'blob', logical: string, client?: pg.PoolClient): Promise<string> {
    const exec = (client ?? this.pool) as pg.Pool | pg.PoolClient;
    return this.ensureResource(exec, kind, logical);
  }

  async openCollection<T extends { id: string }>(name: string): Promise<ICollection<T>> {
    await this.ensureReady();
    const table = await this.table('collection', name);
    // Ensured on the pool (autocommit, visible to every session): transaction-
    // bound handles for the same collection can skip the DDL round trips.
    this.tables.set(`collection:${name}`, table);
    return new PostgresCollection<T>(name, table, this.pool);
  }

  async openTenantNamespace(name: string, tenantId: string): Promise<INamespace> {
    if (!tenantId || typeof tenantId !== 'string' || !tenantId.trim()) throw new Error('openTenantNamespace requires a non-empty tenantId (fail-closed).');
    if (!/^[A-Za-z0-9_-]+$/.test(tenantId)) throw new Error(`tenantId "${tenantId}" contains characters that are not safe.`);
    await this.ensureReady();
    const scopedLogical = `${name}::${tenantId}`;
    const table = await this.table('namespace', scopedLogical);
    return new PostgresNamespace(`${name}::${tenantId}`, table, this.pool);
  }

  async openNamespace(name: string): Promise<INamespace> {
    await this.ensureReady();
    const table = await this.table('namespace', name);
    return new PostgresNamespace(name, table, this.pool);
  }

  async openTenantBlobStore(name: string, tenantId: string): Promise<IBlobStore> {
    if (!tenantId || typeof tenantId !== 'string' || !tenantId.trim()) throw new Error('openTenantBlobStore requires a non-empty tenantId (fail-closed).');
    if (!/^[A-Za-z0-9_-]+$/.test(tenantId)) throw new Error(`tenantId "${tenantId}" contains characters that are not safe.`);
    await this.ensureReady();
    const scopedLogical = `${name}::${tenantId}`;
    const table = await this.table('blob', scopedLogical);
    return new PostgresBlobStore(`${name}::${tenantId}`, table, this.pool);
  }

  async openBlobStore(name: string): Promise<IBlobStore> {
    await this.ensureReady();
    const table = await this.table('blob', name);
    return new PostgresBlobStore(name, table, this.pool);
  }

  /** Open a collection bound to an active transaction client (optionally tenant-bound). */
  private async collectionOnClient<T extends { id: string }>(client: pg.PoolClient, name: string, tenantId?: string): Promise<ICollection<T>> {
    const table = this.tables.get(`collection:${name}`) ?? (await this.table('collection', name, client));
    return new PostgresCollection<T>(name, table, this.pool, client, tenantId);
  }

  /**
   * Real multi-operation transaction across collections on one connection.
   *
   * T-06 tenant binding: pass `{ tenantId }` to run the transaction under
   * that tenant's RLS context (`SET LOCAL app.tenant_id`, which reverts on
   * commit/rollback). Every collection handle opened through the transaction
   * is then tenant-bound: the database policy restricts rows to the tenant
   * AND the driver adds explicit tenant predicates/stamping (fail-closed at
   * both layers). Without `tenantId` the transaction runs in the explicit
   * SYSTEM scope ('*') and behaves exactly like the pre-RLS driver.
   */
  async beginTransaction(options: { tenantId?: string } = {}): Promise<IStorageTransaction> {
    await this.ensureReady();
    const tenantId = options.tenantId;
    const client = await this.pool.connect();
    let settled = false;
    try {
      await client.query('BEGIN');
      if (tenantId !== undefined) {
        await setTenantContext(client, tenantId);
      } else {
        await setSystemTenantContext(client);
      }
    } catch (error) {
      client.release();
      throw error;
    }
    try {
      // R2 §14: bound statement runtime and lock waits per transaction.
      // SET LOCAL keeps the setting inside this transaction (reverts on
      // commit/rollback); other users of a shared pool are unaffected.
      // Expiry aborts the transaction — callers MUST fail closed.
      const statementTimeoutMs = this.opts.statementTimeoutMs ?? R2_DEFAULT_STATEMENT_TIMEOUT_MS;
      const lockTimeoutMs = this.opts.lockTimeoutMs ?? R2_DEFAULT_LOCK_TIMEOUT_MS;
      assertTimeoutMs(statementTimeoutMs, 'statementTimeoutMs');
      assertTimeoutMs(lockTimeoutMs, 'lockTimeoutMs');
      await client.query(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
      await client.query(`SET LOCAL lock_timeout = ${lockTimeoutMs}`);
      // F1: BEGIN + scoping + timeout round-trips succeeded — the pool is
      // talking to a live database, so any recorded degradation is over.
      this.notePoolHealthy();
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* preserve the original error */
      }
      client.release();
      throw error;
    }
    const tx: IStorageTransaction = {
      tenantId,
      collection: <T extends { id: string }>(name: string) => this.collectionOnClient<T>(client, name, tenantId),
      commit: async () => {
        if (settled) throw new Error('Transaction already settled.');
        await client.query('COMMIT');
        settled = true;
        client.release();
        // F1: the commit round-trip succeeded against a live database.
        this.notePoolHealthy();
      },
      rollback: async () => {
        if (settled) throw new Error('Transaction already settled.');
        await client.query('ROLLBACK');
        settled = true;
        client.release();
      },
    };
    return tx;
  }

  /**
   * R2 §F: idempotently ensure a reviewed secondary index exists on a
   * collection table. The table is created first when missing (same
   * concurrent-boot tolerance as `openCollection`). Index definitions
   * are strictly validated (fail closed): names and fields are
   * charset-bound, so no caller input can reach DDL unescaped.
   *
   * Indexes are performance-only: PostgreSQL enforces RLS regardless
   * of index presence, and index absence never changes query results.
   */
  async ensureIndex(logicalCollection: string, index: CollectionIndexDef): Promise<void> {
    assertIndexDef(index);
    await this.ensureReady();
    const table = await this.table('collection', logicalCollection);
    this.tables.set(`collection:${logicalCollection}`, table);
    const indexName = `ix_${table}_${index.name}`.slice(0, 55);
    const columns: string[] = [];
    if (index.includeTenant === true) columns.push(`"${TENANT_ID_COLUMN}"`);
    for (const key of index.keys) {
      columns.push(`((body->>'${key.replace(/'/g, "''")}'))`);
    }
    const ddl = `CREATE INDEX IF NOT EXISTS "${indexName.replace(/"/g, '""')}" ON "${table.replace(/"/g, '""')}" (${columns.join(', ')})`;
    try {
      await this.pool.query(ddl);
    } catch (error) {
      // Concurrent first boot can race index creation
      // (duplicate_object 42710); the index then already exists.
      if ((error as { code?: string })?.code === '42710') return;
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.opts.pool) {
      // External pool ownership: do not end a caller-provided pool.
      this._pool = undefined;
      return;
    }
    const pool = this._pool;
    this._pool = undefined;
    this.readyPromise = undefined;
    this.tables.clear();
    if (pool) await pool.end();
  }
}

function assertTimeoutMs(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 3_600_000) {
    throw new PostgresConfigError(
      `Postgres ${field} must be an integer between 0 and 3600000 ms (fail-closed).`,
    );
  }
}

const INDEX_NAME_PATTERN = /^[a-z0-9_]{1,32}$/;
const INDEX_FIELD_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

/** R2 §F: strictly validate an index definition before it reaches DDL. */
function assertIndexDef(index: CollectionIndexDef): void {
  if (!index || typeof index !== 'object') {
    throw new PostgresConfigError('ensureIndex requires an index definition object (fail-closed).');
  }
  if (typeof index.name !== 'string' || !INDEX_NAME_PATTERN.test(index.name)) {
    throw new PostgresConfigError(
      'ensureIndex: index name must match [a-z0-9_]{1,32} (fail-closed).',
    );
  }
  if (!Array.isArray(index.keys) || index.keys.length === 0 || index.keys.length > 4) {
    throw new PostgresConfigError('ensureIndex: keys must be an array of 1 to 4 body fields (fail-closed).');
  }
  for (const key of index.keys) {
    if (typeof key !== 'string' || !INDEX_FIELD_PATTERN.test(key)) {
      throw new PostgresConfigError(
        `ensureIndex: index field ${JSON.stringify(key)} is not a safe body field name (fail-closed).`,
      );
    }
  }
  if (index.includeTenant !== undefined && typeof index.includeTenant !== 'boolean') {
    throw new PostgresConfigError('ensureIndex: includeTenant must be a boolean when present (fail-closed).');
  }
}

/** Small helper mirroring entry meta shape accepted by other modules. */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

function estimateSize(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return value.length;
  if (value instanceof Uint8Array) return value.byteLength;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

export interface PostgresStorageFactory {
  /** Build a @jataqi/storage StorageModule backed by this Postgres driver. */
  storageModule(): StorageModule;
}

/**
 * Compose a @jataqi/storage StorageModule (module id "storage") whose driver is
 * PostgreSQL. Reuses the existing StorageModule so higher layers see the exact
 * same public interface as the memory/filesystem drivers.
 */
export function postgresStorageModule(driver: PostgresDriver): StorageModule {
  return new StorageModule({ driverInstance: driver });
}
