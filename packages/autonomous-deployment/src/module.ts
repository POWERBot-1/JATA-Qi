import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { AutonomousActionRuntimeModule } from '@jataqi/autonomous-action-runtime';
import { DeploymentService } from './deployment-service.js';

/** Deployment module; no cloud, VPS, DNS, or production adapter is registered by default. */
export class AutonomousDeploymentModule implements IModule {
  readonly id = 'autonomous-deployment';
  readonly tags = ['deployment', 'infrastructure', 'governance', 'verification'] as const;
  readonly dependsOn = ['storage', 'autonomous-action-runtime'] as const;
  private readonly service = new DeploymentService();

  async init(kernel: KernelApi): Promise<void> {
    const runtime = kernel.getModule<AutonomousActionRuntimeModule>('autonomous-action-runtime').getService();
    await this.service.init(kernel, runtime);
    kernel.container.registerValue('autonomous-deployment.service', this.service);
    kernel.container.registerValue('autonomous-deployment', this.service);
    kernel.logger.info('autonomous deployment initialized (no provider adapter registered)');
  }

  async start(_kernel: KernelApi): Promise<void> {
    // Deployment requires explicit, authorized adapter registration and invocation.
  }

  async stop(_kernel: KernelApi): Promise<void> {
    // Persistent deployment records remain in configured storage.
  }

  getService(): DeploymentService {
    return this.service;
  }
}
