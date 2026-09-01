import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { OrbitalIntelligenceService } from './orbital-intelligence-service.js';

/**
 * Provider-neutral OIE metadata foundation. No satellite, weather, aviation,
 * marine, ground-sensor, or other observation provider is bundled or invoked.
 */
export class OrbitalIntelligenceModule implements IModule {
  readonly id = 'orbital-intelligence';
  readonly tags = ['oie', 'geospatial', 'orbital', 'observation', 'world-model', 'temporal', 'safety'] as const;
  readonly dependsOn = ['storage', 'world-model', 'temporal-engine'] as const;
  private readonly service = new OrbitalIntelligenceService();

  async init(kernel: KernelApi): Promise<void> {
    await this.service.init(kernel);
    kernel.container.registerValue('orbital-intelligence.service', this.service);
    kernel.container.registerValue('orbital-intelligence', this.service);
    kernel.logger.info('orbital intelligence initialized (authorized-reference metadata only; no provider or tasking adapter active)');
  }

  getService(): OrbitalIntelligenceService {
    return this.service;
  }
}
