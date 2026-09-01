import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { AutonomousActionRuntimeModule } from '@jataqi/autonomous-action-runtime';
import { UniversalDistributionService } from './distribution-service.js';

/** UDNS module; plans distribution but activates no connector or publisher at boot. */
export class UniversalDistributionNervousSystemModule implements IModule {
  readonly id = 'universal-distribution-nervous-system';
  readonly tags = ['commercial', 'distribution', 'events', 'connectors', 'governance'] as const;
  readonly dependsOn = ['storage', 'commercial-control-plane', 'autonomous-action-runtime', 'external-connectors', 'universal-visibility-fabric'] as const;
  private readonly service = new UniversalDistributionService();

  async init(kernel: KernelApi): Promise<void> {
    const runtime = kernel.getModule<AutonomousActionRuntimeModule>('autonomous-action-runtime').getService();
    await this.service.init(kernel, runtime);
    kernel.container.registerValue('universal-distribution-nervous-system.service', this.service);
    kernel.container.registerValue('universal-distribution-nervous-system', this.service);
    kernel.logger.info('universal distribution nervous system initialized (no connector publisher active)');
  }

  getService(): UniversalDistributionService {
    return this.service;
  }
}
