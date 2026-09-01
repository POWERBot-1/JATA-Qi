import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { CognitiveKernelService } from './cognitive-kernel-service.js';

/**
 * JQB v0.1 cognitive kernel. This module is classical by default and does not
 * invoke a model, quantum backend, or external action at boot.
 */
export class CognitiveKernelModule implements IModule {
  readonly id = 'cognitive-kernel';
  readonly tags = ['jqb', 'cognition', 'state', 'memory', 'governance'] as const;
  readonly dependsOn = ['storage'] as const;
  private readonly service = new CognitiveKernelService();

  async init(kernel: KernelApi): Promise<void> {
    await this.service.init(kernel);
    kernel.container.registerValue('cognitive-kernel.service', this.service);
    kernel.container.registerValue('cognitive-kernel', this.service);
    kernel.logger.info('cognitive kernel initialized (classical state/trace foundation)');
  }

  getService(): CognitiveKernelService {
    return this.service;
  }
}
