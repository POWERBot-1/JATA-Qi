// In-memory storage driver. Used for tests, caches, and ephemeral environments.

import {
  Entry,
  EntryMeta,
  IBlobStore,
  ICollection,
  INamespace,
  IStorageDriver,
  ListOptions,
  ListResult,
  Predicate,
  QueryOptions,
} from '../types.js';

function newMeta(key: string, size?: number, prev?: EntryMeta): EntryMeta {
  const now = Date.now();
  return {
    key,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    size,
    etag: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  };
}

function encodeToBytes(data: Uint8Array | string): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  return data;
}

export class MemoryNamespace implements INamespace {
  private store = new Map<string, Entry<unknown>>();
  constructor(public readonly name: string) {}

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.store.get(key)?.value as T | undefined;
  }
  async getEntry<T = unknown>(key: string): Promise<Entry<T> | undefined> {
    return this.store.get(key) as Entry<T> | undefined;
  }
  async set<T = unknown>(key: string, value: T): Promise<EntryMeta> {
    const size = estimateSize(value);
    const prev = this.store.get(key)?.meta;
    const meta = newMeta(key, size, prev);
    this.store.set(key, { value, meta });
    return meta;
  }
  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }
  async has(key: string): Promise<boolean> {
    return this.store.has(key);
  }
  async list<T = unknown>(opts: ListOptions = {}): Promise<ListResult<T>> {
    let entries = [...this.store.values()];
    if (opts.prefix) entries = entries.filter((e) => e.meta.key.startsWith(opts.prefix!));
    entries.sort((a, b) => (a.meta.key < b.meta.key ? -1 : a.meta.key > b.meta.key ? 1 : 0));
    const limit = opts.limit ?? entries.length;
    const start = opts.cursor ? entries.findIndex((e) => e.meta.key === opts.cursor) + 1 : 0;
    const slice = entries.slice(start, start + limit);
    const nextCursor = start + limit < entries.length ? slice[slice.length - 1]!.meta.key : undefined;
    return { items: slice as Entry<T>[], nextCursor };
  }
  async clear(): Promise<void> {
    this.store.clear();
  }
  async size(): Promise<number> {
    return this.store.size;
  }
}

export class MemoryCollection<T extends { id: string }> implements ICollection<T> {
  private store = new Map<string, T>();
  constructor(public readonly name: string) {}

  async put(doc: T): Promise<T> {
    if (!doc.id) throw new Error(`Collection "${this.name}": document must have an id`);
    this.store.set(doc.id, doc);
    return doc;
  }
  async get(id: string): Promise<T | undefined> {
    return this.store.get(id);
  }
  async delete(id: string): Promise<boolean> {
    return this.store.delete(id);
  }
  async has(id: string): Promise<boolean> {
    return this.store.has(id);
  }
  async query(opts: QueryOptions<T> = {}): Promise<T[]> {
    let items = [...this.store.values()];
    if (opts.where) items = items.filter(opts.where as Predicate<{ id: string }>);
    if (opts.orderBy) {
      const k = opts.orderBy;
      const dir = opts.order === 'desc' ? -1 : 1;
      items.sort((a, b) => {
        const av = (a as any)[k];
        const bv = (b as any)[k];
        if (av === bv) return 0;
        return av > bv ? dir : -dir;
      });
    }
    if (opts.offset) items = items.slice(opts.offset);
    if (opts.limit) items = items.slice(0, opts.limit);
    return items;
  }
  async all(): Promise<T[]> {
    return [...this.store.values()];
  }
  async count(): Promise<number> {
    return this.store.size;
  }
  async replaceAll(docs: readonly T[]): Promise<void> {
    const next = new Map<string, T>();
    for (const doc of docs) {
      if (!doc.id) throw new Error(`Collection "${this.name}": document must have an id`);
      if (next.has(doc.id)) throw new Error(`Collection "${this.name}": duplicate document id "${doc.id}" in replacement snapshot`);
      next.set(doc.id, doc);
    }
    this.store = next;
  }
  async clear(): Promise<void> {
    await this.replaceAll([]);
  }
}

export class MemoryBlobStore implements IBlobStore {
  private store = new Map<string, { data: Uint8Array; meta: EntryMeta; contentType?: string }>();
  constructor(public readonly name: string) {}

  async put(key: string, data: Uint8Array | string, contentType?: string): Promise<EntryMeta> {
    const bytes = encodeToBytes(data);
    const prev = this.store.get(key)?.meta;
    const meta = newMeta(key, bytes.byteLength, prev);
    this.store.set(key, { data: bytes, meta, contentType });
    return meta;
  }
  async get(key: string): Promise<Uint8Array | undefined> {
    return this.store.get(key)?.data;
  }
  async getAsText(key: string): Promise<string | undefined> {
    const b = this.store.get(key);
    if (!b) return undefined;
    return new TextDecoder().decode(b.data);
  }
  async getMeta(key: string): Promise<EntryMeta | undefined> {
    return this.store.get(key)?.meta;
  }
  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }
  async has(key: string): Promise<boolean> {
    return this.store.has(key);
  }
  async list(opts: ListOptions = {}): Promise<ListResult<Uint8Array>> {
    let items = [...this.store.values()].map(({ data, meta }) => ({ value: data, meta }));
    if (opts.prefix) items = items.filter((e) => e.meta.key.startsWith(opts.prefix!));
    items.sort((a, b) => (a.meta.key < b.meta.key ? -1 : 1));
    const limit = opts.limit ?? items.length;
    const start = opts.cursor ? items.findIndex((e) => e.meta.key === opts.cursor) + 1 : 0;
    const slice = items.slice(start, start + limit);
    const nextCursor = start + limit < items.length ? slice[slice.length - 1]!.meta.key : undefined;
    return { items: slice, nextCursor };
  }
  async clear(): Promise<void> {
    this.store.clear();
  }
}

export class MemoryDriver implements IStorageDriver {
  readonly id = 'memory';
  private namespaces = new Map<string, MemoryNamespace>();
  private collections = new Map<string, MemoryCollection<any>>();
  private blobs = new Map<string, MemoryBlobStore>();

  async openNamespace(name: string): Promise<INamespace> {
    let ns = this.namespaces.get(name);
    if (!ns) {
      ns = new MemoryNamespace(name);
      this.namespaces.set(name, ns);
    }
    return ns;
  }
  async openCollection<T extends { id: string }>(name: string): Promise<ICollection<T>> {
    let c = this.collections.get(name);
    if (!c) {
      c = new MemoryCollection<T>(name);
      this.collections.set(name, c);
    }
    return c;
  }
  async openBlobStore(name: string): Promise<IBlobStore> {
    let b = this.blobs.get(name);
    if (!b) {
      b = new MemoryBlobStore(name);
      this.blobs.set(name, b);
    }
    return b;
  }
  async close(): Promise<void> {
    this.namespaces.clear();
    this.collections.clear();
    this.blobs.clear();
  }
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
