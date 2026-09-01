import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { ResearchEvidenceService } from './research-evidence-service.js';

/**
 * Evidence/provenance foundation for future research workflows. It has no
 * experiment executor, laboratory/fabrication control, physical-system access,
 * model invocation, or external collection adapter.
 */
export class ResearchEvidenceModule implements IModule {
  readonly id = 'research-evidence';
  readonly tags = ['research', 'evidence', 'provenance', 'reproducibility', 'safety'] as const;
  readonly dependsOn = ['storage', 'cognitive-kernel', 'reproducibility'] as const;
  private readonly service = new ResearchEvidenceService();

  async init(kernel: KernelApi): Promise<void> {
    await this.service.init(kernel);
    kernel.container.registerValue('research-evidence.service', this.service);
    kernel.container.registerValue('research-evidence', this.service);
    kernel.logger.info('research evidence initialized (metadata/provenance only; no physical execution)');
  }

  getService(): ResearchEvidenceService {
    return this.service;
  }
}
