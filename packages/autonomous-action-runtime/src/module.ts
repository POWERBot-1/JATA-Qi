import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { CommercialControlPlaneModule } from '@jataqi/commercial-control-plane';
import { ActionRuntimeService } from './action-runtime-service.js';

/**
 * Explicit action-runtime module. It starts no worker and registers no external
 * credentials or providers by default; adapters are opt-in capabilities.
 */
export class AutonomousActionRuntimeModule implements IModule {
  readonly id = 'autonomous-action-runtime';
  readonly tags = ['autonomy', 'execution', 'governance', 'commercial'] as const;
  readonly dependsOn = ['commercial-control-plane'] as const;
  private service!: ActionRuntimeService;

  async init(kernel: KernelApi): Promise<void> {
    const controlPlane = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
    this.service = new ActionRuntimeService(controlPlane);
    kernel.container.registerValue('autonomous-action-runtime.service', this.service);
    kernel.container.registerValue('autonomous-action-runtime', this.service);
    kernel.logger.info('autonomous action runtime initialized (no adapters registered)');
  }

  async start(_kernel: KernelApi): Promise<void> {
    // Action execution is explicit; no external work starts during boot.
  }

  async stop(_kernel: KernelApi): Promise<void> {
    // CommercialControlPlaneService owns durable action records.
  }

  getService(): ActionRuntimeService {
    return this.service;
  }
}
