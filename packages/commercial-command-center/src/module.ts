import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { CommercialCommandCenterService } from './command-center-service.js';

/** Read-only aggregation and approval facade; no connector, budget, or action is invoked at boot. */
export class CommercialCommandCenterModule implements IModule {
  readonly id = 'commercial-command-center';
  readonly tags = ['commercial', 'dashboard', 'approvals', 'observability', 'governance'] as const;
  readonly dependsOn = ['commercial-control-plane'] as const;
  private readonly service = new CommercialCommandCenterService();

  async init(kernel: KernelApi): Promise<void> {
    await this.service.init(kernel);
    kernel.container.registerValue('commercial-command-center.service', this.service);
    kernel.container.registerValue('commercial-command-center', this.service);
    kernel.logger.info('commercial command center initialized (read-only projection)');
  }

  getService(): CommercialCommandCenterService {
    return this.service;
  }
}
