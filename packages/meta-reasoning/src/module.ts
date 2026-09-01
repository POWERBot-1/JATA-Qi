import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { MetaReasoningService } from './meta-reasoning-service.js';
import type { MetaReasoningConfig } from './types.js';

/**
 * Classical JQB meta-reasoning layer. It records/calculates transparent
 * epistemic metrics only; it has no model, connector, policy-write, or action
 * execution capability.
 */
export class MetaReasoningModule implements IModule {
  readonly id = 'meta-reasoning';
  readonly tags = ['jqb', 'meta-reasoning', 'calibration', 'safety', 'governance'] as const;
  readonly dependsOn = ['storage', 'cognitive-kernel', 'multi-agent-cognition'] as const;
  private readonly service: MetaReasoningService;

  constructor(config: MetaReasoningConfig = {}) {
    this.service = new MetaReasoningService(config);
  }

  async init(kernel: KernelApi): Promise<void> {
    await this.service.init(kernel);
    kernel.container.registerValue('meta-reasoning.service', this.service);
    kernel.container.registerValue('meta-reasoning', this.service);
    kernel.logger.info('meta reasoning initialized (calibration/advisory-only; no policy or action mutation)');
  }

  getService(): MetaReasoningService {
    return this.service;
  }
}
