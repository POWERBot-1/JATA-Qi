import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { RegulatoryGateService } from './regulatory-gate-service.js';

/**
 * Local regulatory-gate metadata/evaluation registry. It has no legal advice,
 * authority integration, compliance-certificate issuance, policy bypass, or
 * physical execution capability.
 */
export class RegulatoryGateModule implements IModule {
  readonly id = 'regulatory-gates';
  readonly tags = ['research', 'regulatory', 'gates', 'human-approval', 'safety', 'governance'] as const;
  readonly dependsOn = ['storage', 'research-evidence', 'human-approval'] as const;
  private readonly service = new RegulatoryGateService();

  async init(kernel: KernelApi): Promise<void> {
    await this.service.init(kernel);
    kernel.container.registerValue('regulatory-gates.service', this.service);
    kernel.container.registerValue('regulatory-gates', this.service);
    kernel.logger.info('regulatory gates initialized (local requirements only; no authority or physical execution integration)');
  }

  getService(): RegulatoryGateService {
    return this.service;
  }
}
