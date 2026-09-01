import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { CommercialObservabilityService } from './commercial-observability-service.js';
import type { CommercialObservabilityConfig } from './types.js';

/**
 * Commercial telemetry, alert, and incident-recording module. It subscribes to
 * CCP event metadata only and has no external exporter or remediation worker.
 */
export class CommercialObservabilityModule implements IModule {
  readonly id = 'commercial-observability';
  readonly tags = ['commercial', 'observability', 'telemetry', 'traces', 'alerts', 'incidents'] as const;
  readonly dependsOn = ['storage', 'commercial-control-plane'] as const;
  private readonly service: CommercialObservabilityService;

  constructor(config: CommercialObservabilityConfig = {}) {
    this.service = new CommercialObservabilityService(config);
  }

  async init(kernel: KernelApi): Promise<void> {
    await this.service.init(kernel);
    kernel.container.registerValue('commercial-observability.service', this.service);
    kernel.container.registerValue('commercial-observability', this.service);
    kernel.logger.info('commercial observability initialized (safe metadata telemetry; no exporter or remediation active)');
  }

  async stop(_kernel: KernelApi): Promise<void> {
    this.service.stop();
  }

  getService(): CommercialObservabilityService {
    return this.service;
  }
}
