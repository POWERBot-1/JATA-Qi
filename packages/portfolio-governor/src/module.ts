import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { PortfolioGovernorService } from './portfolio-governor-service.js';

/** Portfolio governor creates recommendations only; resource consumption remains control-plane governed. */
export class PortfolioGovernorModule implements IModule {
  readonly id = 'portfolio-governor';
  readonly tags = ['commercial', 'portfolio', 'resource-allocation', 'governance'] as const;
  readonly dependsOn = ['storage', 'commercial-control-plane'] as const;
  private readonly service = new PortfolioGovernorService();

  async init(kernel: KernelApi): Promise<void> {
    await this.service.init(kernel);
    kernel.container.registerValue('portfolio-governor.service', this.service);
    kernel.container.registerValue('portfolio-governor', this.service);
    kernel.logger.info('portfolio governor initialized (recommendation-only)');
  }

  getService(): PortfolioGovernorService {
    return this.service;
  }
}
