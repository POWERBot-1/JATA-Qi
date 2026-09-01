import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { CommercialHealthService } from './commercial-health-service.js';

/** Detects commercial anomalies/drift and emits recommendations; it never pauses or spends automatically. */
export class CommercialHealthModule implements IModule {
  readonly id = 'commercial-health';
  readonly tags = ['commercial', 'observability', 'anomaly', 'drift', 'containment'] as const;
  readonly dependsOn = ['storage', 'commercial-control-plane'] as const;
  private readonly service = new CommercialHealthService();

  async init(kernel: KernelApi): Promise<void> {
    await this.service.init(kernel);
    kernel.container.registerValue('commercial-health.service', this.service);
    kernel.container.registerValue('commercial-health', this.service);
    kernel.logger.info('commercial health initialized (recommendation-only containment)');
  }

  getService(): CommercialHealthService {
    return this.service;
  }
}
