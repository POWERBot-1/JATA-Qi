import type { IModule, KernelApi } from '@jataqi/core-kernel';
import { ReconciliationService } from './reconciliation-service.js';

/** Read-only reconciliation module; it cannot mutate provider or ledger source records. */
export class ReconciliationModule implements IModule {
  readonly id = 'reconciliation';
  readonly tags = ['payments', 'revenue', 'reconciliation', 'governance'] as const;
  readonly dependsOn = ['storage', 'commercial-control-plane', 'payments', 'revenue-ledger'] as const;
  private readonly service = new ReconciliationService();

  async init(kernel: KernelApi): Promise<void> {
    await this.service.init(kernel);
    kernel.container.registerValue('reconciliation.service', this.service);
    kernel.container.registerValue('reconciliation', this.service);
    kernel.logger.info('reconciliation initialized (read-only provider comparison)');
  }

  getService(): ReconciliationService {
    return this.service;
  }
}
