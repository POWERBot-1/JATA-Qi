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

/**
 * A Collection stores structured documents keyed by a string id.
 * Supports basic predicate queries (adapters may add indexing).
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
}

/** Events published on the kernel event bus. */
export const StorageEvents = Object.freeze({
  NamespaceCreated: 'storage.namespace.created',
  CollectionCreated: 'storage.collection.created',
  BlobStoreCreated: 'storage.blob.created',
  DriverRegistered: 'storage.driver.registered',
  DriverClosed: 'storage.driver.closed',
} as const);
