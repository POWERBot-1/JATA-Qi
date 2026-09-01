import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { AutonomousActionRuntimeModule } from '@jataqi/autonomous-action-runtime';
import { ExternalConnectorModule } from '@jataqi/external-connectors';
import { GitHubExecutionService } from './github-execution-service.js';

/**
 * GitHub execution module. It exposes only an unconfigured service at boot;
 * authorized credential-backed clients must be supplied explicitly by a caller.
 */
export class GitHubExecutionModule implements IModule {
  readonly id = 'github-execution';
  readonly tags = ['commercial', 'connector', 'github', 'execution', 'governance'] as const;
  readonly dependsOn = ['external-connectors', 'autonomous-action-runtime'] as const;
  private readonly service = new GitHubExecutionService();

  async init(kernel: KernelApi): Promise<void> {
    const registry = kernel.getModule<ExternalConnectorModule>('external-connectors').getRegistry();
    const runtime = kernel.getModule<AutonomousActionRuntimeModule>('autonomous-action-runtime').getService();
    await this.service.init(kernel, registry, runtime);
    kernel.container.registerValue('github-execution.service', this.service);
    kernel.container.registerValue('github-execution', this.service);
    kernel.logger.info('github execution initialized (unconfigured; no GitHub operation is attempted)');
  }

  async start(_kernel: KernelApi): Promise<void> {
    // No GitHub client is activated implicitly.
  }

  async stop(_kernel: KernelApi): Promise<void> {
    // External connector lifecycle remains explicit.
  }

  getService(): GitHubExecutionService {
    return this.service;
  }
}
