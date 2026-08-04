// SimulationModule — kernel module exposing the Monte-Carlo simulator.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { simulate } from './simulator.js';
import { SimulationEvents } from './types.js';
import type { Scenario, SimulationResult } from './types.js';

export class SimulationModule implements IModule {
  readonly id = 'simulation';
  readonly tags = ['intelligence', 'simulation'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('simulation', this);
    kernel.logger.info('simulation module initialized');
  }

  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  /** Run a scenario and publish the result on the bus. */
  async run<T = number>(scenario: Scenario<T>): Promise<SimulationResult<T>> {
    const result = simulate(scenario);
    await this.api.bus.emit(SimulationEvents.SimulationCompleted, {
      scenario: result.scenario,
      trials: result.trials,
      mean: result.stats.mean,
    });
    return result;
  }
}
