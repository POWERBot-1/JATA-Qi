import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { MemoryDriver } from './drivers/memory.js';
import { FsDriver } from './drivers/filesystem.js';
import {
  IBlobStore,
  ICollection,
  INamespace,
  IStorageDriver,
  IStorageTransaction,
  StorageEvents,
  StorageWriteScope,
} from './types.js';

export interface StorageModuleConfig {
  /** 'memory' (default) or development-only single-process 'filesystem'. */
  driver?: 'memory' | 'filesystem' | string;
  /** Development-only root dir for the filesystem driver; never authoritative production state. */
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
    if (this.driver.id === 'filesystem') {
      kernel.logger.warn('filesystem storage is development-only, single-process, and not authoritative production persistence');
    }
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

  /** True when the resolved driver composes multi-collection writes atomically. */
  supportsTransactions(): boolean {
    return typeof this.driver.beginTransaction === 'function';
  }

  /**
   * T-05: run `fn` as ONE composed write.
   *
   * Transactional drivers: a real backend transaction is opened, every
   * `scope.collection()` handle is bound to it, `fn` resolving commits and
   * `fn` throwing rolls back (the error is rethrown unchanged). Nothing
   * written inside the scope is visible to other connections before commit,
   * and a `cas()` on a scoped handle participates in the same transaction
   * (T-04: caller-owned client, no nested BEGIN, no premature COMMIT).
   *
   * Non-transactional drivers (development only): `fn` runs against the
   * plain collections with `scope.atomic === false`; there is no rollback.
   *
   * Never nest `atomically` inside a scoped body on the same tenant/rows:
   * the inner scope would be a second connection and could self-block on the
   * outer scope's row locks. Compose by passing the outer scope down instead.
   */
  async atomically<T>(fn: (scope: StorageWriteScope) => Promise<T>): Promise<T> {
    const commitHooks: Array<() => void | Promise<void>> = [];
    const settleHooks: Array<() => void | Promise<void>> = [];
    const runHooks = async (hooks: Array<() => void | Promise<void>>): Promise<void> => {
      for (const hook of hooks.splice(0)) await hook();
    };
    const begin = this.driver.beginTransaction?.bind(this.driver);
    if (!begin) {
      const scope: StorageWriteScope = {
        atomic: false,
        collection: (name) => this.collection(name),
        onCommit: (callback) => { commitHooks.push(callback); },
        onSettle: (callback) => { settleHooks.push(callback); },
      };
      let result: T;
      try {
        result = await fn(scope);
      } finally {
        await runHooks(settleHooks);
      }
      await runHooks(commitHooks);
      return result;
    }

    const tx: IStorageTransaction = await begin();
    const scoped = new Map<string, Promise<ICollection<any>>>();
    const scope: StorageWriteScope = {
      atomic: true,
      collection: <D extends { id: string }>(name: string): Promise<ICollection<D>> => {
        let handle = scoped.get(name);
        if (!handle) {
          // Also register the collection on the module cache so post-commit
          // readers see the same (lazily created) resource.
          handle = this.collection<D>(name).then(() => tx.collection<D>(name));
          scoped.set(name, handle);
        }
        return handle as Promise<ICollection<D>>;
      },
      onCommit: (callback) => { commitHooks.push(callback); },
      onSettle: (callback) => { settleHooks.push(callback); },
    };
    let result: T;
    try {
      result = await fn(scope);
    } catch (error) {
      try {
        await tx.rollback();
      } catch {
        /* preserve the original error */
      }
      await runHooks(settleHooks).catch(() => undefined);
      throw error;
    }
    try {
      await tx.commit();
    } catch (error) {
      try {
        await tx.rollback();
      } catch {
        /* the transaction may already be settled */
      }
      await runHooks(settleHooks).catch(() => undefined);
      throw error;
    }
    await runHooks(settleHooks);
    await runHooks(commitHooks);
    return result;
  }
}
