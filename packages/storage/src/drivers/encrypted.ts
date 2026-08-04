// EncryptedDriver — a transparent decorator over any IStorageDriver that
// encrypts values at rest with AES-256-GCM (see ../encryption.ts). Namespaces,
// collections, and blob stores all get authenticated encryption; the underlying
// driver only ever sees ciphertext. PR7 — encryption at rest.

import type {
  IBlobStore, ICollection, INamespace, IStorageDriver,
  Entry, EntryMeta, ListOptions, ListResult, QueryOptions,
} from '../types.js';
import { Cipher } from '../encryption.js';

/** Internal sealed record stored by EncryptedCollection. */
interface SealedDoc { id: string; __e: string }

export interface EncryptedDriverOptions {
  key: string | Buffer;
}

export class EncryptedDriver implements IStorageDriver {
  readonly id: string;
  private readonly cipher: Cipher;
  constructor(private readonly inner: IStorageDriver, opts: EncryptedDriverOptions) {
    this.cipher = new Cipher(opts.key);
    this.id = `${inner.id}+encrypted`;
  }

  async openNamespace(name: string): Promise<INamespace> {
    return new EncryptedNamespace(name, await this.inner.openNamespace(name), this.cipher);
  }
  async openCollection<T extends { id: string }>(name: string): Promise<ICollection<T>> {
    const inner = await this.inner.openCollection<SealedDoc>(name);
    return new EncryptedCollection<T>(name, inner, this.cipher);
  }
  async openBlobStore(name: string): Promise<IBlobStore> {
    return new EncryptedBlobStore(name, await this.inner.openBlobStore(name), this.cipher);
  }
  close(): Promise<void> { return this.inner.close(); }
}

// --- EncryptedNamespace -----------------------------------------------------

class EncryptedNamespace implements INamespace {
  constructor(readonly name: string, private inner: INamespace, private cipher: Cipher) {}

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const sealed = await this.inner.get<string>(key);
    if (sealed === undefined) return undefined;
    return JSON.parse(this.cipher.open(sealed)) as T;
  }

  async getEntry<T = unknown>(key: string): Promise<Entry<T> | undefined> {
    const e = await this.inner.getEntry<string>(key);
    if (!e) return undefined;
    return { value: JSON.parse(this.cipher.open(e.value)) as T, meta: e.meta };
  }

  async set<T = unknown>(key: string, value: T): Promise<EntryMeta> {
    const sealed = this.cipher.seal(JSON.stringify(value));
    return this.inner.set(key, sealed);
  }

  async delete(key: string): Promise<boolean> { return this.inner.delete(key); }
  async has(key: string): Promise<boolean> { return this.inner.has(key); }

  async list<T = unknown>(opts?: ListOptions): Promise<ListResult<T>> {
    const res = await this.inner.list<string>(opts);
    const items = res.items.map((e) => ({ value: JSON.parse(this.cipher.open(e.value)) as T, meta: e.meta }));
    return { items, ...(res.nextCursor ? { nextCursor: res.nextCursor } : {}) };
  }

  async clear(): Promise<void> { return this.inner.clear(); }
  async size(): Promise<number> { return this.inner.size(); }
}

// --- EncryptedCollection ----------------------------------------------------

class EncryptedCollection<T extends { id: string }> implements ICollection<T> {
  constructor(readonly name: string, private inner: ICollection<SealedDoc>, private cipher: Cipher) {}

  async put(doc: T): Promise<T> {
    await this.inner.put({ id: doc.id, __e: this.cipher.seal(JSON.stringify(doc)) });
    return doc;
  }

  async get(id: string): Promise<T | undefined> {
    const rec = await this.inner.get(id);
    if (!rec) return undefined;
    return JSON.parse(this.cipher.open(rec.__e)) as T;
  }

  async delete(id: string): Promise<boolean> { return this.inner.delete(id); }
  async has(id: string): Promise<boolean> { return this.inner.has(id); }
  async count(): Promise<number> { return this.inner.count(); }
  async clear(): Promise<void> { return this.inner.clear(); }

  async all(): Promise<T[]> {
    const rows = await this.inner.all();
    return rows.map((r) => JSON.parse(this.cipher.open(r.__e)) as T);
  }

  async query(opts: QueryOptions<T> = {}): Promise<T[]> {
    // The DB cannot evaluate predicates over ciphertext — load + decrypt, then filter.
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
}

// --- EncryptedBlobStore -----------------------------------------------------

class EncryptedBlobStore implements IBlobStore {
  constructor(readonly name: string, private inner: IBlobStore, private cipher: Cipher) {}

  async put(key: string, data: Uint8Array | string, contentType?: string): Promise<EntryMeta> {
    const plain = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    return this.inner.put(key, this.cipher.sealBytes(plain), contentType);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const sealed = await this.inner.get(key);
    return sealed ? this.cipher.openBytes(sealed) : undefined;
  }

  async getAsText(key: string): Promise<string | undefined> {
    const bytes = await this.get(key);
    return bytes ? new TextDecoder().decode(bytes) : undefined;
  }

  async getMeta(key: string): Promise<EntryMeta | undefined> { return this.inner.getMeta(key); }
  async delete(key: string): Promise<boolean> { return this.inner.delete(key); }
  async has(key: string): Promise<boolean> { return this.inner.has(key); }

  async list(opts?: ListOptions): Promise<ListResult<Uint8Array>> {
    const res = await this.inner.list(opts);
    const items = res.items.map((e) => ({ value: this.cipher.openBytes(e.value), meta: e.meta }));
    return { items, ...(res.nextCursor ? { nextCursor: res.nextCursor } : {}) };
  }

  async clear(): Promise<void> { return this.inner.clear(); }
}
