export { StorageModule } from './storage-module.js';
export { TenantScopedStorage } from './storage-module.js';
export type { StorageModuleConfig } from './storage-module.js';
export { MemoryDriver, MemoryNamespace, MemoryCollection, MemoryBlobStore } from './drivers/memory.js';
export { FsDriver, FsNamespace, FsCollection, FsBlobStore } from './drivers/filesystem.js';
export type { FsDriverOptions } from './drivers/filesystem.js';
export { SqliteDriver } from './drivers/sqlite.js';
export type { SqliteDriverOptions } from './drivers/sqlite.js';
export { EncryptedDriver } from './drivers/encrypted.js';
export type { EncryptedDriverOptions } from './drivers/encrypted.js';
export { QuotaDriver, QuotaExceededError } from './drivers/quota.js';
export type { QuotaDriverOptions } from './drivers/quota.js';
export { Cipher, generateEncryptionKey, normalizeKey, keysEqual } from './encryption.js';
export { StorageEvents, TENANT_PARTITION_PREFIX, tenantPartitionName, isTenantPartition } from './types.js';
export type {
  IBlobStore,
  ICollection,
  INamespace,
  IStorageDriver,
  TenantScope,
  Entry,
  EntryMeta,
  ListOptions,
  ListResult,
  QueryOptions,
  Predicate,
} from './types.js';
