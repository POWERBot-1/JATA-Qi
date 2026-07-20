// JATA Qi Core Kernel — public type definitions

import type { EventBus } from './event-bus.js';
import type { Container } from './container.js';
import type { Logger } from './logger.js';
import type { Config } from './config.js';

/** Lifecycle states a module moves through. */
export type ModuleState =
  | 'registered'
  | 'initializing'
  | 'initialized'
  | 'starting'
  | 'started'
  | 'stopping'
  | 'stopped'
  | 'error';

/** Unique module identifier. */
export type ModuleId = string;

/** A JATA Qi module plugin. */
export interface IModule {
  readonly id: ModuleId;
  /** Modules that must be started before this one. */
  readonly dependsOn?: readonly ModuleId[];
  /** Tags for discovery / grouping. */
  readonly tags?: readonly string[];

  /** Called once after dependency injection wiring but before start. */
  init?(kernel: KernelApi): Promise<void> | void;
  /** Called after all dependencies have started. */
  start?(kernel: KernelApi): Promise<void> | void;
  /** Called during graceful shutdown (in reverse start order). */
  stop?(kernel: KernelApi): Promise<void> | void;
}

/** Facade of kernel services exposed to modules. */
export interface KernelApi {
  readonly bus: EventBus;
  readonly container: Container;
  readonly logger: Logger;
  readonly config: Config;
  /** Retrieve a registered module instance by id. Throws if missing. */
  getModule<T extends IModule = IModule>(id: ModuleId): T;
  /** Return all modules matching a tag. */
  getModulesByTag(tag: string): IModule[];
  /** Current lifecycle state of a module. */
  getModuleState(id: ModuleId): ModuleState;
  /** Register a module at runtime (must be initialized/started manually if kernel already started). */
  register(module: IModule): void;
}

/** Static kernel-level events published on the bus. */
export const KernelEvents = Object.freeze({
  ModuleRegistered: 'kernel.module.registered',
  ModuleInitStart: 'kernel.module.init.start',
  ModuleInitDone: 'kernel.module.init.done',
  ModuleStart: 'kernel.module.start',
  ModuleStarted: 'kernel.module.started',
  ModuleStop: 'kernel.module.stop',
  ModuleStopped: 'kernel.module.stopped',
  ModuleError: 'kernel.module.error',
  KernelBooting: 'kernel.booting',
  KernelBooted: 'kernel.booted',
  KernelShuttingDown: 'kernel.shutting_down',
  KernelShutdown: 'kernel.shutdown',
} as const);

export type KernelEventName = (typeof KernelEvents)[keyof typeof KernelEvents];
