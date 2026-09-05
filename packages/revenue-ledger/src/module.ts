import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { RevenueLedgerService } from './revenue-ledger-service.js';

/** Revenue ledger module; records revenue only from verified billing/payment events. */
export class RevenueLedgerModule implements IModule {
  readonly id = 'revenue-ledger';
  readonly tags = ['revenue', 'finance', 'ledger', 'governance'] as const;
  /** T-05: a durable subscriber requires the canonical delivery worker in the composition (fail-closed at boot). */
  readonly dependsOn = ['storage', 'commercial-control-plane', 'payments', 'billing', 'commercial-event-stream'] as const;
  private readonly service = new RevenueLedgerService();

  async init(kernel: KernelApi): Promise<void> {
    await this.service.init(kernel);
    kernel.container.registerValue('revenue-ledger.service', this.service);
    kernel.container.registerValue('revenue-ledger', this.service);
    kernel.logger.info('revenue ledger initialized (verified revenue recognition only)');
  }

  async stop(_kernel: KernelApi): Promise<void> {
    this.service.stop();
  }

  getService(): RevenueLedgerService {
    return this.service;
  }
}
