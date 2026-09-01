import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { AutonomousActionRuntimeModule } from '@jataqi/autonomous-action-runtime';
import { CodingAgentTaskGraph } from './task-graph.js';

/**
 * Coding agents are bounded task workers, not autonomous administrators.
 * No worker is registered, connected, or executed at boot.
 */
export class CopilotExecutionAdapterModule implements IModule {
  readonly id = 'copilot-execution-adapter';
  readonly tags = ['engineering', 'execution', 'task-graph', 'governance'] as const;
  readonly dependsOn = ['storage', 'autonomous-action-runtime'] as const;
  private readonly taskGraph = new CodingAgentTaskGraph();

  async init(kernel: KernelApi): Promise<void> {
    const runtime = kernel.getModule<AutonomousActionRuntimeModule>('autonomous-action-runtime').getService();
    await this.taskGraph.init(kernel, runtime);
    kernel.container.registerValue('copilot-execution-adapter.task-graph', this.taskGraph);
    kernel.container.registerValue('copilot-execution-adapter', this.taskGraph);
    kernel.logger.info('copilot execution adapter initialized (no coding worker registered)');
  }

  async start(_kernel: KernelApi): Promise<void> {
    // Workers are injected and invoked only through an authorized task action.
  }

  async stop(_kernel: KernelApi): Promise<void> {
    // Persisted task state remains in the configured storage provider.
  }

  getTaskGraph(): CodingAgentTaskGraph {
    return this.taskGraph;
  }
}
