import { EventBus } from './event-bus.js';
import { Container } from './container.js';
import { Logger } from './logger.js';
import { Config, EnvConfigSource, ObjectConfigSource } from './config.js';
import {
  IModule,
  KernelApi,
  KernelEvents,
  KernelEventName,
  ModuleId,
  ModuleState,
} from './types.js';

export interface KernelOptions {
  logger?: Logger;
  configDefaults?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
}

export class Kernel implements KernelApi {
  readonly bus: EventBus;
  readonly container: Container;
  readonly logger: Logger;
  readonly config: Config;

  private modules = new Map<ModuleId, IModule>();
  private states = new Map<ModuleId, ModuleState>();
  private startedOrder: ModuleId[] = [];
  private booted = false;

  constructor(opts: KernelOptions = {}) {
    this.bus = new EventBus();
    this.container = new Container();
    this.logger = opts.logger ?? new Logger();
    this.config = new Config();

    // Layered config: explicit defaults < env vars.
    if (opts.configDefaults) {
      this.config.addSourceLast(new ObjectConfigSource(opts.configDefaults));
    }
    this.config.addSourceFirst(new EnvConfigSource(opts.env));

    // Register core services in the container so modules can resolve them.
    this.container.registerValue('kernel.bus', this.bus);
    this.container.registerValue('kernel.container', this.container);
    this.container.registerValue('kernel.logger', this.logger);
    this.container.registerValue('kernel.config', this.config);
    this.container.registerValue('kernel', this);
  }

  /** Register a module. Must be called before boot(). */
  register(module: IModule): void {
    if (this.modules.has(module.id)) {
      throw new Error(`Kernel: module "${module.id}" is already registered`);
    }
    this.modules.set(module.id, module);
    this.states.set(module.id, 'registered');
    this.logger.debug(`module registered: ${module.id}`);
    this.bus.emit(KernelEvents.ModuleRegistered, { id: module.id });
  }

  getModule<T extends IModule = IModule>(id: ModuleId): T {
    const m = this.modules.get(id);
    if (!m) throw new Error(`Kernel: module "${id}" not registered`);
    return m as T;
  }

  getModulesByTag(tag: string): IModule[] {
    const out: IModule[] = [];
    for (const m of this.modules.values()) {
      if (m.tags?.includes(tag)) out.push(m);
    }
    return out;
  }

  getModuleState(id: ModuleId): ModuleState {
    const s = this.states.get(id);
    if (!s) throw new Error(`Kernel: module "${id}" not registered`);
    return s;
  }

  /** Is the kernel fully booted (all modules started)? */
  isBooted(): boolean {
    return this.booted;
  }

  /** Topologically sort registered modules according to `dependsOn`. Throws on cycles/missing deps. */
  topology(): ModuleId[] {
    const sorted: ModuleId[] = [];
    const visited = new Set<ModuleId>();
    const visiting = new Set<ModuleId>();

    const visit = (id: ModuleId) => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        throw new Error(`Kernel: circular dependency detected at "${id}"`);
      }
      const m = this.modules.get(id);
      if (!m) throw new Error(`Kernel: module "${id}" not found during resolution`);
      visiting.add(id);
      for (const dep of m.dependsOn ?? []) visit(dep);
      visiting.delete(id);
      visited.add(id);
      sorted.push(id);
    };

    for (const id of this.modules.keys()) visit(id);
    return sorted;
  }

  /** Boot: init then start every module in dependency order. Idempotent. */
  async boot(): Promise<void> {
    if (this.booted) return;
    this.logger.info('kernel booting');
    await this.bus.emit(KernelEvents.KernelBooting, {});

    const order = this.topology();

    // Phase 1: init (construct resources, no cross-module runtime calls expected).
    for (const id of order) {
      const m = this.modules.get(id)!;
      this.setState(id, 'initializing');
      await this.bus.emit(KernelEvents.ModuleInitStart, { id });
      try {
        if (m.init) await m.init(this);
        this.setState(id, 'initialized');
        await this.bus.emit(KernelEvents.ModuleInitDone, { id });
      } catch (err) {
        this.setState(id, 'error');
        await this.bus.emit(KernelEvents.ModuleError, { id, phase: 'init', err });
        throw err;
      }
    }

    // Phase 2: start (services may now interact with started dependencies).
    for (const id of order) {
      const m = this.modules.get(id)!;
      this.setState(id, 'starting');
      await this.bus.emit(KernelEvents.ModuleStart, { id });
      try {
        if (m.start) await m.start(this);
        this.setState(id, 'started');
        this.startedOrder.push(id);
        await this.bus.emit(KernelEvents.ModuleStarted, { id });
      } catch (err) {
        this.setState(id, 'error');
        await this.bus.emit(KernelEvents.ModuleError, { id, phase: 'start', err });
        // Best-effort shutdown of already-started modules.
        await this.shutdown();
        throw err;
      }
    }

    this.booted = true;
    this.logger.info(`kernel booted (${order.length} modules)`);
    await this.bus.emit(KernelEvents.KernelBooted, { moduleCount: order.length });
  }

  /** Graceful shutdown in reverse-start order. Idempotent. */
  async shutdown(): Promise<void> {
    if (!this.booted && this.startedOrder.length === 0) return;
    this.logger.info('kernel shutting down');
    await this.bus.emit(KernelEvents.KernelShuttingDown, {});

    for (const id of [...this.startedOrder].reverse()) {
      const m = this.modules.get(id);
      if (!m) continue;
      this.setState(id, 'stopping');
      await this.bus.emit(KernelEvents.ModuleStop, { id });
      try {
        if (m.stop) await m.stop(this);
      } catch (err) {
        this.logger.error(`error stopping module ${id}`, err as Error);
        await this.bus.emit(KernelEvents.ModuleError, { id, phase: 'stop', err });
      }
      this.setState(id, 'stopped');
      await this.bus.emit(KernelEvents.ModuleStopped, { id });
    }
    this.startedOrder = [];
    this.booted = false;
    this.logger.info('kernel shut down');
    await this.bus.emit(KernelEvents.KernelShutdown, {});
  }

  /** Wait for a kernel event once. Convenience for tests/orchestration. */
  waitFor(event: KernelEventName | string, timeoutMs = 10_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          off();
          reject(new Error(`Kernel: timed out waiting for event "${event}"`));
        },
        timeoutMs,
      );
      const off = this.bus.once(event, (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }

  private setState(id: ModuleId, state: ModuleState): void {
    this.states.set(id, state);
  }
}
