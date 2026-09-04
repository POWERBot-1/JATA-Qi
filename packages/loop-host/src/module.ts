import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { LoopHostService, type LoopHostConfig } from './host-service.js';

/**
 * O-01 loop-host module.
 *
 * Registers the continuous-operation host service only. Boot performs no
 * action and starts no background work: the host begins IDLE and requires an
 * explicit operator `start()` followed by explicit `tick()`/`recover()`
 * calls (or an explicitly configured auto-tick interval). There is no
 * automatic production start.
 */
export class LoopHostModule implements IModule {
  readonly id = 'loop-host';
  readonly tags = ['orchestration', 'operation', 'scheduler', 'leases', 'checkpoints'] as const;
  // Runs after the fabric it drives; nothing may depend on the host.
  readonly dependsOn = ['storage', 'unified-loop'] as const;

  private readonly config: LoopHostConfig;
  private service: LoopHostService | undefined;

  constructor(config: LoopHostConfig = {}) {
    this.config = { ...config };
  }

  async init(kernel: KernelApi): Promise<void> {
    this.service = new LoopHostService(this.config);
    await this.service.init(kernel);
    kernel.container.registerValue('loop-host.service', this.service);
    kernel.container.registerValue('loop-host', this.service);
    kernel.logger.info('loop host initialized (O-01 driver; idle until explicit start; no action taken at boot)');
  }

  getService(): LoopHostService {
    if (!this.service) throw new Error('Loop host module is not initialized.');
    return this.service;
  }
}
