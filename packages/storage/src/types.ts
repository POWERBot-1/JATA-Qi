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
 * A Namespace is a logical key-value bucket. Backed by memory, disk, SQLite, etc.
 * All methods are async to accommodate any backend.
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

/**
 * A tenant-scoped view of storage. Every collection / namespace / blob store
 * opened through a TenantScope is partitioned by the tenant id, so one
 * organization can never read or write another organization's data. This is the
 * platform-wide multi-tenancy enforcement primitive (PR4 — Security Hardening).
 */
export interface TenantScope {
  /** The tenant (organization) id this scope is bound to. */
  readonly tenantId: string;
  collection<T extends { id: string }>(name: string): Promise<ICollection<T>>;
  namespace(name: string): Promise<INamespace>;
  blobStore(name: string): Promise<IBlobStore>;
}

/**
 * Build the physical partition name for a tenant + logical name. Tenant ids are
 * validated and disambiguated with a reserved prefix so tenant data can never
 * collide with global (non-tenant) collections.
 */
export const TENANT_PARTITION_PREFIX = 'tenant';

export function tenantPartitionName(tenantId: string, name: string): string {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('storage: tenantId is required for tenant-scoped access');
  }
  if (name === undefined || name === null || name === '') {
    throw new Error('storage: a collection/namespace name is required for tenant-scoped access');
  }
  // Reject tenant ids that could break the partition scheme (path separators,
  // the reserved prefix, or control characters).
  if (/[/:\\]/.test(tenantId) || tenantId === TENANT_PARTITION_PREFIX) {
    throw new Error(`storage: invalid tenantId "${tenantId}"`);
  }
  return `${TENANT_PARTITION_PREFIX}:${tenantId}:${name}`;
}

/** True if a physical name lives under a tenant partition. */
export function isTenantPartition(name: string): boolean {
  return typeof name === 'string' && name.startsWith(`${TENANT_PARTITION_PREFIX}:`);
}

/** Events published on the kernel event bus. */
export const StorageEvents = Object.freeze({
  NamespaceCreated: 'storage.namespace.created',
  CollectionCreated: 'storage.collection.created',
  BlobStoreCreated: 'storage.blob.created',
  DriverRegistered: 'storage.driver.registered',
  DriverClosed: 'storage.driver.closed',
} as const);
