import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { HumanApprovalService } from './human-approval-service.js';
import type { HumanApprovalConfig } from './human-approval-service.js';

/**
 * Research human-review/attestation boundary. It records review quorum only;
 * it has no identity provider, credential store, provider integration, policy
 * write, laboratory control, physical experiment, or external-action capability.
 */
export class HumanApprovalModule implements IModule {
  readonly id = 'human-approval';
  readonly tags = ['research', 'human-approval', 'attestation', 'safety', 'governance'] as const;
  readonly dependsOn = ['storage', 'research-evidence'] as const;
  private readonly service: HumanApprovalService;

  constructor(config: HumanApprovalConfig = {}) {
    this.service = new HumanApprovalService(config);
  }

  async init(kernel: KernelApi): Promise<void> {
    await this.service.init(kernel);
    kernel.container.registerValue('human-approval.service', this.service);
    kernel.container.registerValue('human-approval', this.service);
    kernel.logger.info('human approval initialized (attestation/quorum records only; no execution authorization)');
  }

  getService(): HumanApprovalService {
    return this.service;
  }
}
