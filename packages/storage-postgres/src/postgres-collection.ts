// PostgreSQL-backed ICollection<T> with a real, database-level compare-and-swap
// (`cas`) and full document CRUD/query parity with the memory/filesystem
// drivers. Generic storage only — it holds no lease, policy, or authority
// logic; concurrency safety comes from database row locks held across the
// read-guard-write of each `cas`.
//
// T-06 tenant binding: a collection opened inside a tenant-scoped transaction
// (`PostgresDriver.beginTransaction({ tenantId })`) is bound to that tenant:
//
//   * every write stamps the row's `tenant_id` column with the binding tenant
//     (from the document body when it carries one, otherwise the binding) and
//     refuses a document whose body tenant does not match the binding
//     (application-level fail-closed complement to the RLS WITH CHECK policy);
//   * every read/delete/count/cas carries an explicit `tenant_id` predicate,
//     so even a superuser test session (which PostgreSQL exempts from RLS)
//     observes tenant isolation;
//   * replaceAll/clear only ever affect the binding tenant's rows.
//
// Unscoped collections (no tenant binding) behave exactly like the pre-RLS
// driver: the connection session runs with the system scope ('*') and rows
// are stamped with `tenant_id` from their own body when present, so
// tenant-scoped sessions can see them later.

import type pg from 'pg';
import type {
  CasWriteResult,
  ICollection,
  QueryOptions,
} from '@jataqi/storage';
import {
  TENANT_ID_COLUMN,
  TenantIsolationDriverError,
} from './tenant-isolation.js';

/** Minimal query surface shared by a pool and a transaction client. */
export interface PgExecutor {
  query(text: string, values?: unknown[]): Promise<pg.QueryResult<any>>;
}

function isClient(exec: PgExecutor): exec is pg.PoolClient {
  return typeof (exec as pg.PoolClient).release === 'function';
}

function escapeId(identifier: string): string {
  return '"' + identifier.replace(/"/g, '""') + '"';
}

function ensureId(doc: { id: string } | undefined, id: string): void {
  if (!doc || !doc.id) throw new Error('Compare-and-swap produced a document without an id.');
  if (doc.id !== id) {
    throw new Error(`Compare-and-swap changed the document id (expected "${id}", got "${doc.id}").`);
  }
}

function bodyTenant(doc: { id: string }): string | undefined {
  const t = (doc as { tenantId?: unknown }).tenantId;
  return typeof t === 'string' && t.length > 0 ? t : undefined;
}

export class PostgresCollection<T extends { id: string }> implements ICollection<T> {
  readonly name: string;
  /** When set, every operation is scoped (SQL + assertions) to this tenant. */
  readonly tenantId?: string;
  private readonly table: string;
  private readonly pool: pg.Pool;
  private readonly txClient?: pg.PoolClient;

  constructor(name: string, table: string, pool: pg.Pool, txClient?: pg.PoolClient, tenantId?: string) {
    this.name = name;
    this.table = table;
    this.pool = pool;
    this.txClient = txClient;
    this.tenantId = tenantId;
  }

  private get exec(): PgExecutor {
    return (this.txClient ?? this.pool) as PgExecutor;
  }

  private async q(text: string, values?: unknown[]): Promise<pg.QueryResult<any>> {
    try {
      return await this.exec.query(text, values);
    } catch (error) {
      // Surface a clear error; callers must not treat a failed write as success.
      throw error;
    }
  }

  private parse(row: { body?: unknown } | undefined): T | undefined {
    return row && row.body !== undefined && row.body !== null ? (row.body as T) : undefined;
  }

  /**
   * Refuse to write a document that would land on a row currently owned by a
   * DIFFERENT tenant (same global id). The database RLS WITH CHECK already
   * refuses this for non-superuser sessions; this explicit check keeps the
   * behavior identical (and the error clear) even when the session bypasses
   * RLS. Returns the tenant id that will be stamped on the row. Unscoped
   * (system-scope) collections accept any document and stamp the column from
   * the document's own tenantId when present.
   */
  private async tenantGuard(doc: T): Promise<string> {
    const binding = this.tenantId;
    const docTenant = bodyTenant(doc);
    if (binding === undefined) return docTenant ?? '';
    if (docTenant !== undefined && docTenant !== binding) {
      throw new TenantIsolationDriverError(
        `Document in "${this.name}" has tenantId="${docTenant}" which does not match the active tenant "${binding}" (cross-tenant write refused).`,
      );
    }
    const t = escapeId(this.table);
    const clash = await this.q(
      `SELECT 1 FROM ${t} WHERE id = $1 AND ${TENANT_ID_COLUMN} IS DISTINCT FROM $2 LIMIT 1`,
      [doc.id, binding],
    );
    if (clash.rows.length > 0) {
      throw new TenantIsolationDriverError(
        `Document id "${doc.id}" in "${this.name}" already exists under a different tenant (cross-tenant write refused).`,
      );
    }
    return binding;
  }

  private insertSql(): string {
    const t = escapeId(this.table);
    return `INSERT INTO ${t} (id, body, ${TENANT_ID_COLUMN}, updated_at) VALUES ($1, $2::jsonb, $3, now())
            ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, ${TENANT_ID_COLUMN} = EXCLUDED.${TENANT_ID_COLUMN}, updated_at = now()`;
  }

  private tenantPredicateSql(): { clause: string; values: unknown[] } {
    if (this.tenantId !== undefined) {
      return { clause: ` AND ${TENANT_ID_COLUMN} = $2`, values: [this.tenantId] };
    }
    return { clause: '', values: [] };
  }

  async put(doc: T): Promise<T> {
    if (!doc.id) throw new Error(`Collection "${this.name}": document must have an id`);
    const stamp = await this.tenantGuard(doc);
    const tenantValue = this.tenantId !== undefined ? stamp : bodyTenant(doc) ?? null;
    await this.q(this.insertSql(), [doc.id, JSON.stringify(doc), tenantValue]);
    return doc;
  }

  async get(id: string): Promise<T | undefined> {
    const t = escapeId(this.table);
    const { clause, values } = this.tenantPredicateSql();
    const res = await this.q(`SELECT body FROM ${t} WHERE id = $1${clause}`, [id, ...values]);
    return this.parse(res.rows[0]);
  }

  async delete(id: string): Promise<boolean> {
    const t = escapeId(this.table);
    const { clause, values } = this.tenantPredicateSql();
    const res = await this.q(`DELETE FROM ${t} WHERE id = $1${clause}`, [id, ...values]);
    return (res.rowCount ?? 0) > 0;
  }

  async has(id: string): Promise<boolean> {
    return (await this.get(id)) !== undefined;
  }

  async all(): Promise<T[]> {
    const t = escapeId(this.table);
    if (this.tenantId !== undefined) {
      const res = await this.q(`SELECT body FROM ${t} WHERE ${TENANT_ID_COLUMN} = $1`, [this.tenantId]);
      return res.rows.map((row) => this.parse(row) as T).filter((x): x is T => x !== undefined);
    }
    const res = await this.q(`SELECT body FROM ${t}`);
    return res.rows.map((row) => this.parse(row) as T).filter((x): x is T => x !== undefined);
  }

  async count(): Promise<number> {
    const t = escapeId(this.table);
    if (this.tenantId !== undefined) {
      const res = await this.q(`SELECT count(*)::int AS n FROM ${t} WHERE ${TENANT_ID_COLUMN} = $1`, [this.tenantId]);
      return res.rows[0]?.n ?? 0;
    }
    const res = await this.q(`SELECT count(*)::int AS n FROM ${t}`);
    return res.rows[0]?.n ?? 0;
  }

  async query(opts: QueryOptions<T> = {}): Promise<T[]> {
    let items = await this.all();
    if (opts.where) items = items.filter(opts.where as (item: T) => boolean);
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

  async replaceAll(docs: readonly T[]): Promise<void> {
    const t = escapeId(this.table);
    const client = this.txClient ?? (await this.pool.connect());
    const owns = !this.txClient;
    try {
      if (!this.txClient) await client.query('BEGIN');
      if (this.tenantId !== undefined) {
        // Tenant-scoped snapshot: replace only THIS tenant's rows so one
        // tenant's snapshot can never wipe another tenant's data.
        await client.query(`DELETE FROM ${t} WHERE ${TENANT_ID_COLUMN} = $1`, [this.tenantId]);
        for (const doc of docs) {
          if (!doc.id) throw new Error(`Collection "${this.name}": document must have an id`);
          await client.query(
            `INSERT INTO ${t} (id, body, ${TENANT_ID_COLUMN}, updated_at) VALUES ($1, $2::jsonb, $3, now())
             ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, ${TENANT_ID_COLUMN} = EXCLUDED.${TENANT_ID_COLUMN}, updated_at = now()`,
            [doc.id, JSON.stringify(doc), bodyTenant(doc) ?? this.tenantId],
          );
        }
      } else {
        await client.query(`TRUNCATE ${t}`);
        for (const doc of docs) {
          if (!doc.id) throw new Error(`Collection "${this.name}": document must have an id`);
          await client.query(
            `INSERT INTO ${t} (id, body, ${TENANT_ID_COLUMN}, updated_at) VALUES ($1, $2::jsonb, $3, now())
             ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, ${TENANT_ID_COLUMN} = EXCLUDED.${TENANT_ID_COLUMN}, updated_at = now()`,
            [doc.id, JSON.stringify(doc), bodyTenant(doc) ?? null],
          );
        }
      }
      if (!this.txClient) await client.query('COMMIT');
    } catch (error) {
      if (!this.txClient) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* preserve original error */
        }
      }
      throw error;
    } finally {
      if (owns) client.release();
    }
  }

  async clear(): Promise<void> {
    const t = escapeId(this.table);
    if (this.tenantId !== undefined) {
      await this.q(`DELETE FROM ${t} WHERE ${TENANT_ID_COLUMN} = $1`, [this.tenantId]);
      return;
    }
    await this.replaceAll([]);
  }

  /**
   * Atomic compare-and-swap. The guard runs under a PostgreSQL row lock
   * (`SELECT ... FOR UPDATE`) inside one transaction, so two concurrent
   * workers/processes can never both observe the same pre-state and both
   * "win". Guard must be a pure synchronous predicate.
   */
  async cas(
    id: string,
    guard: (current: T | undefined) => boolean,
    makeNext: (current: T) => T,
  ): Promise<CasWriteResult<T>> {
    const t = escapeId(this.table);
    if (this.txClient) {
      // This collection is bound to an already-open caller-owned transaction.
      // CAS must participate in that transaction without changing its
      // lifecycle; the outer IStorageTransaction retains commit/rollback
      // ownership.
      return this.casOn(this.txClient, t, id, guard, makeNext, false);
    }
    const client = await this.pool.connect();
    try {
      // Standalone CAS owns this connection's transaction and preserves the
      // existing one-operation atomic behavior.
      return await this.casOn(client, t, id, guard, makeNext, true);
    } finally {
      client.release();
    }
  }

  private async casOn(
    client: pg.PoolClient,
    t: string,
    id: string,
    guard: (current: T | undefined) => boolean,
    makeNext: (current: T) => T,
    ownsTransaction: boolean,
  ): Promise<CasWriteResult<T>> {
    if (ownsTransaction) await client.query('BEGIN');
    try {
      if (this.tenantId !== undefined) {
        // A tenant-bound CAS must never read or mutate another tenant's row.
        const clash = await client.query(
          `SELECT 1 FROM ${t} WHERE id = $1 AND ${TENANT_ID_COLUMN} IS DISTINCT FROM $2 LIMIT 1`,
          [id, this.tenantId],
        );
        if (clash.rows.length > 0) {
          throw new TenantIsolationDriverError(
            `Compare-and-swap id "${id}" in "${this.name}" already exists under a different tenant (cross-tenant write refused).`,
          );
        }
      }
      const tenantFilter = this.tenantId !== undefined ? ` AND ${TENANT_ID_COLUMN} = $2` : '';
      const res = await client.query(
        `SELECT body FROM ${t} WHERE id = $1${tenantFilter} FOR UPDATE`,
        this.tenantId !== undefined ? [id, this.tenantId] : [id],
      );
      const current = this.parse(res.rows[0]);
      if (!guard(current)) {
        if (ownsTransaction) await client.query('COMMIT');
        return { ok: false, doc: current };
      }
      const next = makeNext(current as T);
      ensureId(next, id);
      if (this.tenantId !== undefined) {
        const docTenant = bodyTenant(next);
        if (docTenant !== undefined && docTenant !== this.tenantId) {
          throw new TenantIsolationDriverError(
            `Compare-and-swap produced a document with tenantId="${docTenant}" which does not match the active tenant "${this.tenantId}" (cross-tenant write refused).`,
          );
        }
      }
      const tenantValue = this.tenantId !== undefined ? (bodyTenant(next) ?? this.tenantId) : (bodyTenant(next) ?? null);
      if (current === undefined) {
        // First-create CAS: the guard observed NO row. On PostgreSQL a
        // `SELECT ... FOR UPDATE` over an absent row locks nothing, so two
        // processes first-creating the same id could both believe they won.
        // The election is therefore decided by the INSERT itself: the losing
        // writer gets rowCount 0 and an `ok: false` result instead of
        // silently OVERWRITING the winner (which would be a lost update).
        // Callers whose CAS must converge (sequence counters) loop on the
        // result; the row now exists, so subsequent rounds serialize on the
        // row lock. This closes the documented first-create race.
        const ins = await client.query(
          `INSERT INTO ${t} (id, body, ${TENANT_ID_COLUMN}, updated_at) VALUES ($1, $2::jsonb, $3, now())
           ON CONFLICT (id) DO NOTHING`,
          [id, JSON.stringify(next), tenantValue],
        );
        if ((ins.rowCount ?? 0) === 0) {
          if (ownsTransaction) await client.query('COMMIT');
          return { ok: false, doc: undefined };
        }
        if (ownsTransaction) await client.query('COMMIT');
        return { ok: true, doc: next };
      }
      await client.query(
        `INSERT INTO ${t} (id, body, ${TENANT_ID_COLUMN}, updated_at) VALUES ($1, $2::jsonb, $3, now())
         ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, ${TENANT_ID_COLUMN} = EXCLUDED.${TENANT_ID_COLUMN}, updated_at = now()`,
        [id, JSON.stringify(next), tenantValue],
      );
      if (ownsTransaction) await client.query('COMMIT');
      return { ok: true, doc: next };
    } catch (error) {
      // An outer transaction belongs to the caller. Do not roll it back here;
      // the caller must decide whether to commit or roll back the full scope.
      if (ownsTransaction) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* preserve original error */
        }
      }
      throw error;
    }
  }
}
