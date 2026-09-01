import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { CausalEngineService } from './causal-engine-service.js';

/** Classical causal/counterfactual model engine; no intervention is executed in the real world. */
export class CausalEngineModule implements IModule {
  readonly id = 'causal-engine';
  readonly tags = ['jqb', 'causal', 'counterfactual', 'simulation', 'governance'] as const;
  readonly dependsOn = ['storage', 'world-model'] as const;
  private readonly service = new CausalEngineService();

  async init(kernel: KernelApi): Promise<void> {
    await this.service.init(kernel);
    kernel.container.registerValue('causal-engine.service', this.service);
    kernel.container.registerValue('causal-engine', this.service);
    kernel.logger.info('causal engine initialized (classical simulated intervention only)');
  }

  getService(): CausalEngineService {
    return this.service;
  }
}
