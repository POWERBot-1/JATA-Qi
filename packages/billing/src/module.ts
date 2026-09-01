import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { BillingService } from './billing-service.js';

/** Billing module activates subscriptions/invoices only from verified payment events. */
export class BillingModule implements IModule {
  readonly id = 'billing';
  readonly tags = ['billing', 'payments', 'revenue', 'governance'] as const;
  readonly dependsOn = ['storage', 'commercial-control-plane', 'payments'] as const;
  private readonly service = new BillingService();

  async init(kernel: KernelApi): Promise<void> {
    await this.service.init(kernel);
    kernel.container.registerValue('billing.service', this.service);
    kernel.container.registerValue('billing', this.service);
    kernel.logger.info('billing initialized (verified payment activation only)');
  }

  async stop(_kernel: KernelApi): Promise<void> {
    this.service.stop();
  }

  getService(): BillingService {
    return this.service;
  }
}
