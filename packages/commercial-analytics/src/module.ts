import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { CommercialAnalyticsService } from './commercial-analytics-service.js';

/** Commercial metrics module; computes transparent observations from persisted source records. */
export class CommercialAnalyticsModule implements IModule {
  readonly id = 'commercial-analytics';
  readonly tags = ['commercial', 'analytics', 'economics', 'observability'] as const;
  readonly dependsOn = ['storage', 'commercial-control-plane', 'payments', 'billing', 'revenue-ledger'] as const;
  private readonly service = new CommercialAnalyticsService();

  async init(kernel: KernelApi): Promise<void> {
    await this.service.init(kernel);
    kernel.container.registerValue('commercial-analytics.service', this.service);
    kernel.container.registerValue('commercial-analytics', this.service);
    kernel.logger.info('commercial analytics initialized (evidence-classified calculations)');
  }

  getService(): CommercialAnalyticsService {
    return this.service;
  }
}
