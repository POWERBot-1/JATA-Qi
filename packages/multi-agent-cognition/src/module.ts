import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { MultiAgentCognitionService } from './multi-agent-cognition-service.js';
import type { MultiAgentCognitionConfig } from './types.js';

/**
 * JQB structured multi-agent critique. It is data-only by default: no bundled
 * LLM, reviewer, external connector, execution adapter, or background worker.
 */
export class MultiAgentCognitionModule implements IModule {
  readonly id = 'multi-agent-cognition';
  readonly tags = ['jqb', 'cognition', 'multi-agent', 'critique', 'safety', 'reproducibility'] as const;
  readonly dependsOn = ['storage', 'cognitive-kernel'] as const;
  private readonly service: MultiAgentCognitionService;

  constructor(config: MultiAgentCognitionConfig = {}) {
    this.service = new MultiAgentCognitionService(config);
  }

  async init(kernel: KernelApi): Promise<void> {
    await this.service.init(kernel);
    kernel.container.registerValue('multi-agent-cognition.service', this.service);
    kernel.container.registerValue('multi-agent-cognition', this.service);
    kernel.logger.info('multi-agent cognition initialized (explicit injected-reviewer critique only)');
  }

  getService(): MultiAgentCognitionService {
    return this.service;
  }
}
