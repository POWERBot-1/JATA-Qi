// Storage abstraction — key-value, blob, and collection (document) interfaces.

/** Metadata returned alongside values when listing or getting with meta. */
export interface EntryMeta {
  readonly key: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly size?: number;
  readonly etag?: string;
}

/** A key-value entry with optional metadata. */
export interface Entry<T = unknown> {
  value: T;
  meta: EntryMeta;
}

/** Query options for list operations. */
export interface ListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}

export interface ListResult<T = unknown> {
  items: Entry<T>[];
  nextCursor?: string;
}

/** Simple predicate for collection queries. */
export type Predicate<T> = (item: T) => boolean;

export interface QueryOptions<T> {
  where?: Predicate<T>;
  limit?: number;
  offset?: number;
  orderBy?: keyof T & string;
  order?: 'asc' | 'desc';
}

/**
 * A Namespace is a logical key-value bucket. The bundled filesystem driver is
 * development-only/single-process; a future transactional backend is required
 * for authoritative production state. All methods are async to accommodate it.
 */
export interface INamespace {
  readonly name: string;

  get<T = unknown>(key: string): Promise<T | undefined>;
  getEntry<T = unknown>(key: string): Promise<Entry<T> | undefined>;
  set<T = unknown>(key: string, value: T): Promise<EntryMeta>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
  list<T = unknown>(opts?: ListOptions): Promise<ListResult<T>>;
  clear(): Promise<void>;
  size(): Promise<number>;
}

/** Result of a single-document compare-and-swap. */
export interface CasWriteResult<T> {
  /**
   * true when the document was atomically changed to `makeNext(current)`.
   * false when the guard rejected the current document (no write occurred).
   */
  ok: boolean;
  /**
   * - when `ok`: the newly persisted document (the result of `makeNext`).
   * - when `!ok`: the current document that made the guard false
   *   (`undefined` when no document exists for the id).
   */
  doc: T | undefined;
}

/**
 * A Collection stores structured documents keyed by a string id.
 * Supports basic predicate queries (adapters may add indexing).
 *
 * Drivers that back authoritative/concurrent state additionally implement
 * `cas` — a single-document, driver-level-atomic compare-and-swap used for
 * concurrency-safe transitions (leases, queue state, checkpoints). The guard
 * is a pure synchronous predicate on the current document (`undefined` when
 * absent); drivers evaluate it under an exclusive per-document lock or a
 * database row lock so that two concurrent writers cannot both observe the
 * same pre-state. Implementers must not leave the collection in a partial
 * state if the guard throws.
 */
export interface ICollection<T extends { id: string } = { id: string }> {
  readonly name: string;

  put(doc: T): Promise<T>;
  get(id: string): Promise<T | undefined>;
  delete(id: string): Promise<boolean>;
  has(id: string): Promise<boolean>;
  query(opts?: QueryOptions<T>): Promise<T[]>;
  all(): Promise<T[]>;
  count(): Promise<number>;
  /** Replace the complete collection atomically where the selected driver supports it. */
  replaceAll(docs: readonly T[]): Promise<void>;
  clear(): Promise<void>;

  /**
   * Atomically transition one document.
   *
   * @param id      target document id.
   * @param guard   synchronous predicate on the current document; must not
   *                perform async work. `current` is `undefined` when absent.
   * @param makeNext pure synchronous builder of the replacement document from
   *                the *current* document. Only invoked when `guard` is true.
   */
  cas(
    id: string,
    guard: (current: T | undefined) => boolean,
    makeNext: (current: T) => T,
  ): Promise<CasWriteResult<T>>;
}

/**
 * A single transaction scope over one or more collections. Obtained from a
 * driver that supports real transactions (`IStorageDriver.beginTransaction`).
 * Every `collection()` handle returned from a scope is bound to one backend
 * transaction/connection, so operations across collections commit or roll back
 * together. Non-transactional drivers do not implement `beginTransaction`.
 */
export interface IStorageTransaction {
  collection<T extends { id: string }>(name: string): Promise<ICollection<T>>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/**
 * Blob storage for raw binary/text content (e.g. original document bytes).
 */
export interface IBlobStore {
  put(key: string, data: Uint8Array | string, contentType?: string): Promise<EntryMeta>;
  get(key: string): Promise<Uint8Array | undefined>;
  getAsText(key: string): Promise<string | undefined>;
  getMeta(key: string): Promise<EntryMeta | undefined>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
  list(opts?: ListOptions): Promise<ListResult<Uint8Array>>;
  clear(): Promise<void>;
}

/** Factory that knows how to open namespaces/collections/blobs. */
export interface IStorageDriver {
  readonly id: string;
  openNamespace(name: string): Promise<INamespace>;
  openCollection<T extends { id: string }>(name: string): Promise<ICollection<T>>;
  openBlobStore(name: string): Promise<IBlobStore>;
  /** Close the driver and release resources (file handles, db connections). */
  close(): Promise<void>;
  /**
   * Start a real multi-operation transaction when the driver supports one
   * (e.g. a transactional database). Undefined for development-only drivers.
   */
  beginTransaction?(): Promise<IStorageTransaction>;
}

/** Events published on the kernel event bus. */
export const StorageEvents = Object.freeze({
  NamespaceCreated: 'storage.namespace.created',
  CollectionCreated: 'storage.collection.created',
  BlobStoreCreated: 'storage.blob.created',
  DriverRegistered: 'storage.driver.registered',
  DriverClosed: 'storage.driver.closed',
} as const);
