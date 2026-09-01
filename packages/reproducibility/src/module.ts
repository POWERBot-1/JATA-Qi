import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { ReproducibilityService } from './reproducibility-service.js';

/** Metadata/hash registry only; it never runs an experiment or simulation itself. */
export class ReproducibilityModule implements IModule {
  readonly id = 'reproducibility';
  readonly tags = ['jqb', 'research', 'reproducibility', 'provenance'] as const;
  readonly dependsOn = ['storage'] as const;
  private readonly service = new ReproducibilityService();

  async init(kernel: KernelApi): Promise<void> {
    await this.service.init(kernel);
    kernel.container.registerValue('reproducibility.service', this.service);
    kernel.container.registerValue('reproducibility', this.service);
    kernel.logger.info('reproducibility registry initialized (metadata/hash comparison only)');
  }

  getService(): ReproducibilityService {
    return this.service;
  }
}
