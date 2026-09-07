import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { AutonomousActionRuntimeModule } from '@jataqi/autonomous-action-runtime';
import { PaymentsService } from './payments-service.js';
import { WalletService } from './wallet-service.js';

/** Payments module with no registered payment provider or credentials at boot. */
export class PaymentsModule implements IModule {
  readonly id = 'payments';
  readonly tags = ['payments', 'billing', 'revenue', 'governance'] as const;
  readonly dependsOn = ['storage', 'commercial-control-plane', 'autonomous-action-runtime'] as const;
  private readonly service = new PaymentsService();
  /** T-09: per-currency internal wallet (no PSP, no external money movement). */
  private readonly wallet = new WalletService();

  async init(kernel: KernelApi): Promise<void> {
    const runtime = kernel.getModule<AutonomousActionRuntimeModule>('autonomous-action-runtime').getService();
    await this.service.init(kernel, runtime);
    await this.wallet.init(kernel);
    kernel.container.registerValue('payments.service', this.service);
    kernel.container.registerValue('payments', this.service);
    kernel.container.registerValue('payments.wallet', this.wallet);
    kernel.logger.info('payments initialized (no payment provider registered; per-currency wallet active, no FX source injected)');
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

  /** T-09 per-currency wallet service (balances, withdrawals, injected-FX conversions). */
  getWalletService(): WalletService {
    return this.wallet;
  }
}
