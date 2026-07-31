// PaymentsModule — kernel module that owns payment provider instances and
// exposes them to the rest of the platform (the commerce module can call
// createPaymentIntent / refund / webhook verification through this module).

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { PaymentProvider } from './types.js';
import { StripeProvider, type StripeConfig } from './stripe.js';

export interface PaymentsModuleConfig {
  stripe?: StripeConfig;
}

export class PaymentsModule implements IModule {
  readonly id = 'payments';
  readonly tags = ['core', 'commerce'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private providers = new Map<string, PaymentProvider>();

  constructor(private readonly cfg: PaymentsModuleConfig = {}) {}

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    if (this.cfg.stripe) {
      const provider = new StripeProvider(this.cfg.stripe);
      this.providers.set('stripe', provider);
      kernel.logger.info('payments: stripe provider registered');
    }
    kernel.container.registerValue('payments', this);
  }

  async start(_k: KernelApi): Promise<void> {}
  async stop(_k: KernelApi): Promise<void> {}

  getProvider(name: string): PaymentProvider | undefined { return this.providers.get(name); }
  get stripe(): PaymentProvider | undefined { return this.providers.get('stripe'); }
}
