import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { HypothesisEngineService } from './hypothesis-engine-service.js';

/** Persistent bridge between JQB Cognitive Kernel and classical Bayesian hypotheses. */
export class HypothesisEngineModule implements IModule {
  readonly id = 'hypothesis-engine';
  readonly tags = ['jqb', 'hypothesis', 'probability', 'cognition'] as const;
  readonly dependsOn = ['storage', 'cognitive-kernel', 'probabilistic-engine'] as const;
  private readonly service = new HypothesisEngineService();

  async init(kernel: KernelApi): Promise<void> {
    await this.service.init(kernel);
    kernel.container.registerValue('hypothesis-engine.service', this.service);
    kernel.container.registerValue('hypothesis-engine', this.service);
    kernel.logger.info('hypothesis engine initialized (classical Bayesian cognitive bridge)');
  }

  getService(): HypothesisEngineService {
    return this.service;
  }
}
