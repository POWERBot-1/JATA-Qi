import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { AutonomousActionRuntimeModule } from '@jataqi/autonomous-action-runtime';
import { InfrastructureStateRegistry } from './registry.js';

/** Generic infrastructure registry; no provider credential or resource is created at boot. */
export class InfrastructureStateRegistryModule implements IModule {
  readonly id = 'infrastructure-state-registry';
  readonly tags = ['infrastructure', 'provisioning', 'reconciliation', 'governance'] as const;
  readonly dependsOn = ['storage', 'autonomous-action-runtime'] as const;
  private readonly registry = new InfrastructureStateRegistry();

  async init(kernel: KernelApi): Promise<void> {
    const runtime = kernel.getModule<AutonomousActionRuntimeModule>('autonomous-action-runtime').getService();
    await this.registry.init(kernel, runtime);
    kernel.container.registerValue('infrastructure-state-registry', this.registry);
    kernel.container.registerValue('infrastructure-state-registry.service', this.registry);
    kernel.logger.info('infrastructure state registry initialized (no provider adapter registered)');
  }

  async start(_kernel: KernelApi): Promise<void> {
    // Provisioning requires explicit adapter registration and control-plane authorization.
  }

  async stop(_kernel: KernelApi): Promise<void> {
    // Resource registry state persists through the storage module.
  }

  getRegistry(): InfrastructureStateRegistry {
    return this.registry;
  }
}
