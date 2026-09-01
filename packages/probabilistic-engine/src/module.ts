import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { ProbabilisticEngine } from './probabilistic-engine.js';

/** Classical Bayesian engine; no quantum backend or quantum-native claim is made. */
export class ProbabilisticEngineModule implements IModule {
  readonly id = 'probabilistic-engine';
  readonly tags = ['jqb', 'probability', 'hypothesis', 'uncertainty'] as const;
  readonly dependsOn = [] as const;
  private readonly engine = new ProbabilisticEngine();

  async init(kernel: KernelApi): Promise<void> {
    kernel.container.registerValue('probabilistic-engine', this.engine);
    kernel.container.registerValue('probabilistic-engine.service', this.engine);
    kernel.logger.info('probabilistic engine initialized (classical Bayesian calculations)');
  }

  getEngine(): ProbabilisticEngine {
    return this.engine;
  }
}
