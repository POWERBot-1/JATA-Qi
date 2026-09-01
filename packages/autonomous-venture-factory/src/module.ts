import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { AutonomousVentureFactoryService } from './venture-factory-service.js';

/** Venture Factory coordinates state and evidence; it starts no build/deploy worker. */
export class AutonomousVentureFactoryModule implements IModule {
  readonly id = 'autonomous-venture-factory';
  readonly tags = ['commercial', 'venture', 'lifecycle', 'governance'] as const;
  readonly dependsOn = ['storage', 'commercial-control-plane', 'commercial-intelligence'] as const;
  private readonly service = new AutonomousVentureFactoryService();

  async init(kernel: KernelApi): Promise<void> {
    await this.service.init(kernel);
    kernel.container.registerValue('autonomous-venture-factory.service', this.service);
    kernel.container.registerValue('autonomous-venture-factory', this.service);
    kernel.logger.info('autonomous venture factory initialized (state/evidence coordination only)');
  }

  getService(): AutonomousVentureFactoryService {
    return this.service;
  }
}
