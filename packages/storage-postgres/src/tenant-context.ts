// Tenant-aware transactional execution (T-01-F + T-01-G).
//
// `runWithTenant` opens a transaction, sets the per-tx tenant GUC,
// and runs the caller's function with a transaction-scoped collection
// view that is bound to the active tenant. The transaction commits on
// success and rolls back on any throw. RLS enforces isolation even
// when the underlying query forgets the tenant predicate.

import type pg from 'pg';
import { PostgresCollection } from './postgres-collection.js';
import { ensureTenantIsolation, setTenantContext, TENANT_ID_COLUMN } from './tenant-isolation.js';
import { TenantIsolationDriverError } from './tenant-isolation.js';
import { PostgresDriverError } from './errors.js';
import { deriveTableName } from './naming.js';

export interface TenantContextOptions {
  /** Tenant id to bind the transaction to. */
  tenantId: string;
  /**
   * When true, the helper ALSO writes the document's tenantId into the
   * collection (so RLS-with-check passes). Defaults to true.
   */
  injectTenantId?: boolean;
}

export interface TenantBoundCollection<T extends { id: string }> {
  /** Get a document by id, scoped to the active tenant. */
  get(id: string): Promise<T | undefined>;
  /** Insert or upsert a document, enforcing tenant binding. */
  put(doc: T): Promise<T>;
  /**
   * Atomic compare-and-swap. The guard runs under a row lock; the
   * tenant predicate is enforced by RLS even if the guard is
   * mis-written.
   */
  cas(
    id: string,
    guard: (current: T | undefined) => boolean,
    makeNext: (current: T) => T,
  ): Promise<{ ok: boolean; doc: T | undefined }>;
  /** Query documents, scoped to the active tenant. */
  query(opts: {
    where?: (item: T) => boolean;
    orderBy?: keyof T & string;
    order?: 'asc' | 'desc';
    limit?: number;
    offset?: number;
  }): Promise<T[]>;
  /** All documents in this tenant. */
  all(): Promise<T[]>;
  /** Count of documents in this tenant. */
  count(): Promise<number>;
  /** Delete a document by id (must belong to the active tenant). */
  delete(id: string): Promise<boolean>;
  /** Has a document with this id in the active tenant. */
  has(id: string): Promise<boolean>;
}

/**
 * Run `fn` inside a PostgreSQL transaction bound to `tenantId`. The
 * function receives a `getCollection` accessor that hands out
 * tenant-bound collection views; each call opens a fresh collection
 * bound to the same transaction client. The transaction is committed
 * when `fn` returns and rolled back when it throws.
 *
 * The `withTenantIsolation` flag (default true) ensures the collection
 * tables have RLS enabled and the tenant_id column. This is invoked
 * ONCE per (pool, table) combination and is idempotent.
 */
export async function runWithTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (tx: {
    getCollection: <U extends { id: string }>(name: string) => Promise<TenantBoundCollection<U>>;
    raw: pg.PoolClient;
    tenantId: string;
  }) => Promise<T>,
  options: { withTenantIsolation?: boolean } = {},
): Promise<T> {
  if (!tenantId || typeof tenantId !== 'string' || tenantId.trim().length === 0) {
    throw new TenantIsolationDriverError('Tenant id must be a non-empty string (fail-closed).');
  }
  const client = await pool.connect();
  let settled = false;
  let result: T;
  try {
    await client.query('BEGIN');
    await setTenantContext(client, tenantId);
    // Cache the table-name derivation so a single transaction doesn't
    // re-derive for every getCollection call.
    const tableCache = new Map<string, string>();
    result = await fn({
      tenantId,
      raw: client,
      getCollection: async <U extends { id: string }>(name: string): Promise<TenantBoundCollection<U>> => {
        let table = tableCache.get(name);
        if (!table) {
          table = deriveTableName('collection', name);
          tableCache.set(name, table);
        }
        // Create the table first (idempotent), then enable tenant
        // isolation. The DDL also creates the table with the
        // tenant_id column so we don't need a follow-up ALTER.
        await client.query(
          `CREATE TABLE IF NOT EXISTS "${table}" (
             id text PRIMARY KEY,
             body jsonb NOT NULL,
             ${TENANT_ID_COLUMN} text,
             updated_at timestamptz NOT NULL DEFAULT now()
           )`,
        );
        if (options.withTenantIsolation !== false) {
          await ensureTenantIsolation(client, table);
        }
        const collection = new PostgresCollection<U>(name, table, pool, client);
        return new TenantBoundCollectionImpl<U>(collection, client, tenantId);
      },
    });
    await client.query('COMMIT');
    settled = true;
  } catch (err) {
    if (!settled) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
    }
    throw err;
  } finally {
    client.release();
  }
  return result;
}

class TenantBoundCollectionImpl<T extends { id: string }> implements TenantBoundCollection<T> {
  constructor(
    private readonly collection: PostgresCollection<T>,
    private readonly client: pg.PoolClient,
    private readonly tenantId: string,
  ) {}

  private get exec(): pg.PoolClient { return this.client; }

  private async q(text: string, values?: unknown[]): Promise<pg.QueryResult<any>> {
    return this.exec.query(text, values);
  }

  async get(id: string): Promise<T | undefined> {
    const res = await this.q(`SELECT body FROM ${this.table} WHERE id = $1 AND ${TENANT_ID_COLUMN} = $2`, [id, this.tenantId]);
    return this.parse(res.rows[0]);
  }

  async put(doc: T): Promise<T> {
    if (!doc.id) throw new PostgresDriverError(`Collection "${this.collection.name}": document must have an id`);
    // Enforce tenant binding at the application layer; RLS gives the
    // database-level guarantee.
    const docTenant = (doc as { tenantId?: string }).tenantId;
    if (docTenant !== undefined && docTenant !== this.tenantId) {
      throw new TenantIsolationDriverError(
        `Document in ${this.collection.name} has tenantId="${docTenant}" which does not match active tenant "${this.tenantId}".`,
      );
    }
    // Inject the tenant id so the row is visible in this tenant's
    // session; the WITH CHECK policy requires it to match the GUC.
    const bodyWithTenant = { ...doc, tenantId: this.tenantId };
    await this.q(
      `INSERT INTO ${this.table} (id, body, ${TENANT_ID_COLUMN}, updated_at) VALUES ($1, $2::jsonb, $3, now())
       ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, ${TENANT_ID_COLUMN} = EXCLUDED.${TENANT_ID_COLUMN}, updated_at = now()`,
      [doc.id, JSON.stringify(bodyWithTenant), this.tenantId],
    );
    return bodyWithTenant as T;
  }

  async cas(
    id: string,
    guard: (current: T | undefined) => boolean,
    makeNext: (current: T) => T,
  ): Promise<{ ok: boolean; doc: T | undefined }> {
    return this.collection.cas(id, guard, makeNext);
  }

  async query(opts: { where?: (item: T) => boolean; orderBy?: keyof T & string; order?: 'asc' | 'desc'; limit?: number; offset?: number } = {}): Promise<T[]> {
    // The base query (collection.all) runs SELECT * FROM table. RLS
    // already restricts to the active tenant; we also filter in
    // memory as a defense-in-depth check.
    let items = await this.collection.all();
    items = items.filter((it) => (it as { tenantId?: string }).tenantId === this.tenantId);
    if (opts.where) items = items.filter(opts.where);
    if (opts.orderBy) {
      const key = opts.orderBy as keyof T & string;
      const direction = opts.order === 'desc' ? -1 : 1;
      items.sort((a, b) => {
        const av = a[key] as unknown;
        const bv = b[key] as unknown;
        if (av === bv) return 0;
        return (av as never) > (bv as never) ? direction : -direction;
      });
    }
    if (opts.offset) items = items.slice(opts.offset);
    if (opts.limit) items = items.slice(0, opts.limit);
    return items;
  }

  async all(): Promise<T[]> {
    const items = await this.collection.all();
    return items.filter((it) => (it as { tenantId?: string }).tenantId === this.tenantId);
  }

  async count(): Promise<number> {
    return (await this.all()).length;
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.q(`DELETE FROM ${this.table} WHERE id = $1 AND ${TENANT_ID_COLUMN} = $2`, [id, this.tenantId]);
    return (res.rowCount ?? 0) > 0;
  }

  async has(id: string): Promise<boolean> {
    return (await this.get(id)) !== undefined;
  }

  private get table(): string {
    return (this.collection as unknown as { table: string }).table;
  }

  private parse(row: { body?: unknown } | undefined): T | undefined {
    return row && row.body !== undefined && row.body !== null ? (row.body as T) : undefined;
  }
}
