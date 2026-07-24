// SchedulerModule — exposes the compute scheduler as a kernel service, wiring
// task lifecycle events onto the bus.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { Scheduler } from './scheduler.js';
import type { SchedulerOptions } from './scheduler.js';
import type { ComputeTarget, SchedulerStats, Task } from './types.js';

export class SchedulerModule implements IModule {
  readonly id = 'scheduler';
  readonly tags = ['core', 'scheduler'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private scheduler!: Scheduler;

  constructor(private readonly opts: SchedulerOptions = {}) {}

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    this.scheduler = new Scheduler(this.opts, (event, payload) => {
      void kernel.bus.emit(event, payload);
    });
    kernel.container.registerValue('scheduler', this);
    kernel.logger.info('compute scheduler initialized');
  }

  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* drain handled by callers */ }

  registerTarget(target: ComputeTarget): void {
    this.scheduler.registerTarget(target);
  }

  submit<T>(task: Task<T>): Promise<T> {
    return this.scheduler.submit(task);
  }

  stats(): SchedulerStats {
    return this.scheduler.stats();
  }

  async idle(): Promise<void> {
    return this.scheduler.idle();
  }
}
