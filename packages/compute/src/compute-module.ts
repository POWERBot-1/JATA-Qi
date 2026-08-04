// ComputeModule — registers the scientific/math computation service with the
// kernel and exposes the pure functions through the module for ergonomic access.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import * as stats from './statistics.js';
import { linearRegression } from './regression.js';
import { minimize, bisect } from './numerical.js';

export class ComputeModule implements IModule {
  readonly id = 'compute';
  readonly tags = ['intelligence', 'compute'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('compute', this);
    kernel.logger.info('compute module initialized');
  }

  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  // Re-exported pure functions for callers that resolve the module.
  readonly stats = stats;
  readonly linearRegression = linearRegression;
  readonly minimize = minimize;
  readonly bisect = bisect;
}
