import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { AutonomousActionRuntimeModule } from '@jataqi/autonomous-action-runtime';
import { PaymentsService } from './payments-service.js';

/** Payments module with no registered payment provider or credentials at boot. */
export class PaymentsModule implements IModule {
  readonly id = 'payments';
  readonly tags = ['payments', 'billing', 'revenue', 'governance'] as const;
  readonly dependsOn = ['storage', 'commercial-control-plane', 'autonomous-action-runtime'] as const;
  private readonly service = new PaymentsService();

  async init(kernel: KernelApi): Promise<void> {
    const runtime = kernel.getModule<AutonomousActionRuntimeModule>('autonomous-action-runtime').getService();
    await this.service.init(kernel, runtime);
    kernel.container.registerValue('payments.service', this.service);
    kernel.container.registerValue('payments', this.service);
    kernel.logger.info('payments initialized (no payment provider registered)');
  }

  async start(_kernel: KernelApi): Promise<void> {
    // Payment providers and credentials require explicit authorized registration.
  }

  async stop(_kernel: KernelApi): Promise<void> {
    // Payment intent records persist through the configured storage provider.
  }

  getService(): PaymentsService {
    return this.service;
  }
}
