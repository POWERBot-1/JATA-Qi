import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { CommercialIntelligenceService } from './commercial-intelligence-service.js';

/** Commercial intelligence produces evidence-bound recommendations, never direct execution. */
export class CommercialIntelligenceModule implements IModule {
  readonly id = 'commercial-intelligence';
  readonly tags = ['commercial', 'sea', 'opportunity', 'readiness', 'recommendation'] as const;
  readonly dependsOn = ['storage', 'commercial-control-plane', 'commercial-analytics'] as const;
  private readonly service = new CommercialIntelligenceService();

  async init(kernel: KernelApi): Promise<void> {
    await this.service.init(kernel);
    kernel.container.registerValue('commercial-intelligence.service', this.service);
    kernel.container.registerValue('commercial-intelligence', this.service);
    kernel.logger.info('commercial intelligence initialized (recommendation-only)');
  }

  getService(): CommercialIntelligenceService {
    return this.service;
  }
}
