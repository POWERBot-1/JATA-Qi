import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { MemoryDriver } from './drivers/memory.js';
import { FsDriver } from './drivers/filesystem.js';
import {
  IBlobStore,
  ICollection,
  INamespace,
  IStorageDriver,
  StorageEvents,
} from './types.js';

export interface StorageModuleConfig {
  /** 'memory' (default) or 'filesystem'. SQLite added later. */
  driver?: 'memory' | 'filesystem' | string;
  /** Root dir for filesystem driver. */
  fsRoot?: string;
  /** Pre-configured driver instance (overrides driver option). */
  driverInstance?: IStorageDriver;
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
        default:
          throw new Error(`Storage: unknown driver "${driverName}"`);
      }
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
}
