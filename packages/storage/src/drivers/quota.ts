// QuotaDriver — a transparent decorator that enforces byte quotas per namespace
// and collection, so a runaway writer (or a noisy tenant) cannot grow storage
// without bound. Quotas are enforced on logical (pre-encryption) value size and
// are counted accurately across restarts via lazy initialization. PR7 — storage
// size limits / DoS protection.

import type {
  IBlobStore, ICollection, INamespace, IStorageDriver,
  Entry, EntryMeta, ListOptions, ListResult, QueryOptions,
} from '../types.js';

/** Thrown when a write would exceed the configured quota. */
export class QuotaExceededError extends Error {
  readonly code = 'QUOTA_EXCEEDED' as const;
  readonly quota: number;
  readonly attempted: number;
  readonly used: number;
  constructor(quota: number, used: number, attempted: number, name: string) {
    super(`storage: quota exceeded for "${name}" (${used + attempted} > ${quota} bytes)`);
    this.name = 'QuotaExceededError';
    this.quota = quota;
    this.used = used;
    this.attempted = attempted;
  }
}

export interface QuotaDriverOptions {
  /** Per-name byte quotas (namespace or collection name -> max bytes). */
  quotas?: Record<string, number>;
  /** Default quota applied to any name without an explicit entry. */
  defaultQuotaBytes?: number;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

export class QuotaDriver implements IStorageDriver {
  readonly id: string;
  private readonly quotas: Map<string, number>;
  private readonly defaultQuota: number;
  constructor(private readonly inner: IStorageDriver, opts: QuotaDriverOptions = {}) {
    this.quotas = new Map(Object.entries(opts.quotas ?? {}));
    this.defaultQuota = opts.defaultQuotaBytes ?? Infinity;
    this.id = `${inner.id}+quota`;
  }

  private limit(name: string): number {
    return this.quotas.has(name) ? this.quotas.get(name)! : this.defaultQuota;
  }

  async openNamespace(name: string): Promise<INamespace> {
    return new QuotaNamespace(name, await this.inner.openNamespace(name), this.limit(name));
  }
  async openCollection<T extends { id: string }>(name: string): Promise<ICollection<T>> {
    return new QuotaCollection<T>(name, await this.inner.openCollection<T>(name), this.limit(name));
  }
  async openBlobStore(name: string): Promise<IBlobStore> {
    return new QuotaBlobStore(name, await this.inner.openBlobStore(name), this.limit(name));
  }
  close(): Promise<void> { return this.inner.close(); }
}

/** Shared size-accounting helper. */
class SizeLedger {
  private sizes = new Map<string, number>();
  private total = 0;
  private initialized = false;

  init(entries: Iterable<{ key: string; size: number }>): void {
    if (this.initialized) return;
    for (const e of entries) {
      this.sizes.set(e.key, e.size);
      this.total += e.size;
    }
    this.initialized = true;
  }
  isInitialized(): boolean { return this.initialized; }
  propose(key: string, newSize: number, limit: number, name: string): void {
    const oldSize = this.sizes.get(key) ?? 0;
    const nextTotal = this.total - oldSize + newSize;
    if (nextTotal > limit) throw new QuotaExceededError(limit, this.total, newSize - oldSize, name);
  }
  commit(key: string, newSize: number): void {
    const oldSize = this.sizes.get(key) ?? 0;
    this.total += newSize - oldSize;
    this.sizes.set(key, newSize);
  }
  remove(key: string): void {
    const oldSize = this.sizes.get(key);
    if (oldSize !== undefined) {
      this.total -= oldSize;
      this.sizes.delete(key);
    }
  }
  reset(): void { this.sizes.clear(); this.total = 0; this.initialized = false; }
  used(): number { return this.total; }
}

// --- QuotaNamespace ---------------------------------------------------------

class QuotaNamespace implements INamespace {
  private readonly ledger = new SizeLedger();
  constructor(readonly name: string, private inner: INamespace, private limit: number) {}

  private async ensure(): Promise<void> {
    if (this.ledger.isInitialized()) return;
    const all = await this.inner.list({ limit: 1_000_000 });
    this.ledger.init(all.items.map((e) => ({ key: e.meta.key, size: byteLength((e as { value: unknown }).value) })));
  }

  async get<T = unknown>(key: string): Promise<T | undefined> { return this.inner.get<T>(key); }
  async getEntry<T = unknown>(key: string): Promise<Entry<T> | undefined> { return this.inner.getEntry<T>(key); }

  async set<T = unknown>(key: string, value: T): Promise<EntryMeta> {
    await this.ensure();
    const size = byteLength(value);
    this.ledger.propose(key, size, this.limit, this.name);
    const meta = await this.inner.set(key, value);
    this.ledger.commit(key, size);
    return meta;
  }

  async delete(key: string): Promise<boolean> {
    await this.ensure();
    const removed = await this.inner.delete(key);
    if (removed) this.ledger.remove(key);
    return removed;
  }

  async has(key: string): Promise<boolean> { return this.inner.has(key); }
  async list<T = unknown>(opts?: ListOptions): Promise<ListResult<T>> { return this.inner.list<T>(opts); }
  async clear(): Promise<void> { await this.inner.clear(); this.ledger.reset(); }
  async size(): Promise<number> { return this.inner.size(); }
  usedBytes(): number { return this.ledger.used(); }
}

// --- QuotaCollection --------------------------------------------------------

class QuotaCollection<T extends { id: string }> implements ICollection<T> {
  private readonly ledger = new SizeLedger();
  constructor(readonly name: string, private inner: ICollection<T>, private limit: number) {}

  private async ensure(): Promise<void> {
    if (this.ledger.isInitialized()) return;
    const all = await this.inner.all();
    this.ledger.init(all.map((d) => ({ key: d.id, size: byteLength(d) })));
  }

  async put(doc: T): Promise<T> {
    await this.ensure();
    const size = byteLength(doc);
    this.ledger.propose(doc.id, size, this.limit, this.name);
    await this.inner.put(doc);
    this.ledger.commit(doc.id, size);
    return doc;
  }

  async get(id: string): Promise<T | undefined> { return this.inner.get(id); }
  async delete(id: string): Promise<boolean> {
    await this.ensure();
    const removed = await this.inner.delete(id);
    if (removed) this.ledger.remove(id);
    return removed;
  }
  async has(id: string): Promise<boolean> { return this.inner.has(id); }
  async query(opts?: QueryOptions<T>): Promise<T[]> { return this.inner.query(opts); }
  async all(): Promise<T[]> { return this.inner.all(); }
  async count(): Promise<number> { return this.inner.count(); }
  async clear(): Promise<void> { await this.inner.clear(); this.ledger.reset(); }
  usedBytes(): number { return this.ledger.used(); }
}

// --- QuotaBlobStore ---------------------------------------------------------

class QuotaBlobStore implements IBlobStore {
  private readonly ledger = new SizeLedger();
  constructor(readonly name: string, private inner: IBlobStore, private limit: number) {}

  private async ensure(): Promise<void> {
    if (this.ledger.isInitialized()) return;
    const all = await this.inner.list({ limit: 1_000_000 });
    this.ledger.init(all.items.map((e) => ({ key: e.meta.key, size: (e as { value: Uint8Array }).value.byteLength })));
  }

  async put(key: string, data: Uint8Array | string, contentType?: string): Promise<EntryMeta> {
    await this.ensure();
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    this.ledger.propose(key, bytes.byteLength, this.limit, this.name);
    const meta = await this.inner.put(key, data, contentType);
    this.ledger.commit(key, bytes.byteLength);
    return meta;
  }

  async get(key: string): Promise<Uint8Array | undefined> { return this.inner.get(key); }
  async getAsText(key: string): Promise<string | undefined> { return this.inner.getAsText(key); }
  async getMeta(key: string): Promise<EntryMeta | undefined> { return this.inner.getMeta(key); }
  async delete(key: string): Promise<boolean> {
    await this.ensure();
    const removed = await this.inner.delete(key);
    if (removed) this.ledger.remove(key);
    return removed;
  }
  async has(key: string): Promise<boolean> { return this.inner.has(key); }
  async list(opts?: ListOptions): Promise<ListResult<Uint8Array>> { return this.inner.list(opts); }
  async clear(): Promise<void> { await this.inner.clear(); this.ledger.reset(); }
  usedBytes(): number { return this.ledger.used(); }
}
