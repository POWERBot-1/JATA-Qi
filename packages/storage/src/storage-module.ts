import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { MemoryDriver } from './drivers/memory.js';
import { FsDriver } from './drivers/filesystem.js';
import { EncryptedDriver } from './drivers/encrypted.js';
import { QuotaDriver } from './drivers/quota.js';
import {
  IBlobStore,
  ICollection,
  INamespace,
  IStorageDriver,
  StorageEvents,
  TenantScope,
  isTenantPartition,
  tenantPartitionName,
} from './types.js';

export interface StorageModuleConfig {
  /** 'memory' (default) or 'filesystem'. SQLite added later. */
  driver?: 'memory' | 'filesystem' | string;
  /** Root dir for filesystem driver. */
  fsRoot?: string;
  /** Pre-configured driver instance (overrides driver option). */
  driverInstance?: IStorageDriver;
  /**
   * Encryption-at-rest key (AES-256-GCM). When set, all values/docs/blobs are
   * transparently encrypted before reaching the underlying driver (PR7).
   * Accepts a 44-char base64 string, 64-char hex string, Buffer, or passphrase.
   */
  encryptionKey?: string | Buffer;
  /** Per-name byte quotas (namespace/collection name -> max bytes). PR7. */
  quotas?: Record<string, number>;
  /** Default byte quota applied to any name without an explicit entry. PR7. */
  defaultQuotaBytes?: number;
}

/**
 * A tenant-scoped storage facade. All collections / namespaces / blob stores it
 * opens are physically partitioned under the tenant id, enforcing hard isolation
 * between organizations at the storage layer (PR4 — multi-tenancy enforcement).
 */
export class TenantScopedStorage implements TenantScope {
  readonly tenantId: string;
  private readonly mod: StorageModule;

  constructor(tenantId: string, mod: StorageModule) {
    this.tenantId = tenantId;
    this.mod = mod;
  }

  collection<T extends { id: string }>(name: string): Promise<ICollection<T>> {
    return this.mod.collection<T>(tenantPartitionName(this.tenantId, name));
  }

  namespace(name: string): Promise<INamespace> {
    return this.mod.namespace(tenantPartitionName(this.tenantId, name));
  }

  blobStore(name: string): Promise<IBlobStore> {
    return this.mod.blobStore(tenantPartitionName(this.tenantId, name));
  }
}

export class StorageModule implements IModule {
  readonly id = 'storage';
  readonly tags = ['core', 'storage'] as const;
  readonly dependsOn = [] as const;

  private driver!: IStorageDriver;
  private namespaces = new Map<string, INamespace>();
  private collections = new Map<string, ICollection<any>>();
  private blobs = new Map<string, IBlobStore>();
  private api!: KernelApi;
  private readonly opts: StorageModuleConfig;

  constructor(opts: StorageModuleConfig = {}) {
    this.opts = opts;
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;

    if (this.opts.driverInstance) {
      this.driver = this.opts.driverInstance;
    } else {
      const driverName = this.opts.driver ?? kernel.config.get('storage.driver', 'memory');
      switch (driverName) {
        case 'memory':
          this.driver = new MemoryDriver();
          break;
        case 'filesystem':
        case 'fs':
          this.driver = new FsDriver({ root: this.opts.fsRoot ?? kernel.config.get('storage.fsRoot', undefined) });
          break;
        case 'sqlite': {
          const { SqliteDriver } = await import('./drivers/sqlite.js');
          const dbPath = this.opts.fsRoot ?? kernel.config.get('storage.sqlitePath', undefined) ?? './.jataqi/jataqi.db';
          this.driver = new SqliteDriver({ path: dbPath });
          break;
        }
        default:
          throw new Error(`Storage: unknown driver "${driverName}"`);
      }
    }
    // Compose hardening decorators over the base driver. Order is
    // QuotaDriver(EncryptedDriver(base)) so quotas count logical (pre-encryption)
    // size and encryption is applied just above the physical store (PR7).
    if (this.opts.encryptionKey) {
      this.driver = new EncryptedDriver(this.driver, { key: this.opts.encryptionKey });
      kernel.logger.info('storage: encryption at rest ENABLED (AES-256-GCM)');
    }
    if (this.opts.quotas || this.opts.defaultQuotaBytes !== undefined) {
      this.driver = new QuotaDriver(this.driver, {
        ...(this.opts.quotas ? { quotas: this.opts.quotas } : {}),
        ...(this.opts.defaultQuotaBytes !== undefined ? { defaultQuotaBytes: this.opts.defaultQuotaBytes } : {}),
      });
      kernel.logger.info(`storage: quota enforcement ENABLED (default=${this.opts.defaultQuotaBytes ?? 'unlimited'})`);
    }
    kernel.container.registerValue('storage.driver', this.driver);
    kernel.container.registerValue('storage.module', this);
    kernel.container.registerFactory('storage', () => this);
    kernel.logger.info(`storage driver initialized: ${this.driver.id}`);
    await kernel.bus.emit(StorageEvents.DriverRegistered, { driverId: this.driver.id });
  }

  async start(_kernel: KernelApi): Promise<void> {
    // No background services yet; drivers are opened lazily via namespace().
  }

  async stop(_kernel: KernelApi): Promise<void> {
    await this.driver.close();
    this.namespaces.clear();
    this.collections.clear();
    this.blobs.clear();
  }

  /** Get or open a namespace. */
  async namespace(name: string): Promise<INamespace> {
    let ns = this.namespaces.get(name);
    if (!ns) {
      ns = await this.driver.openNamespace(name);
      this.namespaces.set(name, ns);
      await this.api.bus.emit(StorageEvents.NamespaceCreated, { name });
    }
    return ns;
  }

  /** Get or open a typed collection. */
  async collection<T extends { id: string }>(name: string): Promise<ICollection<T>> {
    let c = this.collections.get(name);
    if (!c) {
      c = await this.driver.openCollection<T>(name);
      this.collections.set(name, c);
      await this.api.bus.emit(StorageEvents.CollectionCreated, { name });
    }
    return c as ICollection<T>;
  }

  /** Get or open a blob store. */
  async blobStore(name: string): Promise<IBlobStore> {
    let b = this.blobs.get(name);
    if (!b) {
      b = await this.driver.openBlobStore(name);
      this.blobs.set(name, b);
      await this.api.bus.emit(StorageEvents.BlobStoreCreated, { name });
    }
    return b;
  }

  /** Access the underlying driver (escape hatch). */
  getDriver(): IStorageDriver {
    return this.driver;
  }

  /**
   * Open a tenant-scoped view of storage for the given organization id. Data
   * written through the returned scope is partitioned under `tenant:<orgId>:`
   * and is invisible to every other tenant (PR4 — multi-tenancy enforcement).
   */
  tenant(tenantId: string): TenantScope {
    // Validate the tenant id eagerly (the helper throws on invalid ids).
    tenantPartitionName(tenantId, 'probe');
    return new TenantScopedStorage(tenantId, this);
  }

  /** True when a logical name resolves to a tenant partition. */
  isTenantPartition(name: string): boolean {
    return isTenantPartition(name);
  }
}
