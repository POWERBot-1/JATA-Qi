// PostgreSQL-backed ICollection<T> with a real, database-level compare-and-swap
// (`cas`) and full document CRUD/query parity with the memory/filesystem
// drivers. Generic storage only — it holds no lease, policy, or authority
// logic; concurrency safety comes from database row locks held across the
// read-guard-write of each `cas`.

import type pg from 'pg';
import type {
  CasWriteResult,
  ICollection,
  QueryOptions,
} from '@jataqi/storage';

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

export class PostgresCollection<T extends { id: string }> implements ICollection<T> {
  readonly name: string;
  private readonly table: string;
  private readonly pool: pg.Pool;
  private readonly txClient?: pg.PoolClient;

  constructor(name: string, table: string, pool: pg.Pool, txClient?: pg.PoolClient) {
    this.name = name;
    this.table = table;
    this.pool = pool;
    this.txClient = txClient;
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

  async put(doc: T): Promise<T> {
    if (!doc.id) throw new Error(`Collection "${this.name}": document must have an id`);
    const t = escapeId(this.table);
    await this.q(
      `INSERT INTO ${t} (id, body, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, updated_at = now()`,
      [doc.id, JSON.stringify(doc)],
    );
    return doc;
  }

  async get(id: string): Promise<T | undefined> {
    const t = escapeId(this.table);
    const res = await this.q(`SELECT body FROM ${t} WHERE id = $1`, [id]);
    return this.parse(res.rows[0]);
  }

  async delete(id: string): Promise<boolean> {
    const t = escapeId(this.table);
    const res = await this.q(`DELETE FROM ${t} WHERE id = $1`, [id]);
    return (res.rowCount ?? 0) > 0;
  }

  async has(id: string): Promise<boolean> {
    return (await this.get(id)) !== undefined;
  }

  async all(): Promise<T[]> {
    const t = escapeId(this.table);
    const res = await this.q(`SELECT body FROM ${t}`);
    return res.rows.map((row) => this.parse(row) as T).filter((x): x is T => x !== undefined);
  }

  async count(): Promise<number> {
    const t = escapeId(this.table);
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
      await client.query(`TRUNCATE ${t}`);
      for (const doc of docs) {
        if (!doc.id) throw new Error(`Collection "${this.name}": document must have an id`);
        await client.query(
          `INSERT INTO ${t} (id, body, updated_at) VALUES ($1, $2::jsonb, now())
           ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, updated_at = now()`,
          [doc.id, JSON.stringify(doc)],
        );
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
      const res = await client.query(`SELECT body FROM ${t} WHERE id = $1 FOR UPDATE`, [id]);
      const current = this.parse(res.rows[0]);
      if (!guard(current)) {
        if (ownsTransaction) await client.query('COMMIT');
        return { ok: false, doc: current };
      }
      const next = makeNext(current as T);
      ensureId(next, id);
      await client.query(
        `INSERT INTO ${t} (id, body, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, updated_at = now()`,
        [id, JSON.stringify(next)],
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
