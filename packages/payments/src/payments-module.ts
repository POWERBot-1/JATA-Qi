// PaymentsModule — kernel module that owns payment provider instances and
// exposes them to the rest of the platform (the commerce module can call
// createPaymentIntent / refund / webhook verification through this module).
//
// Providers are registered from configuration only (never hard-coded): Stripe
// and M-Pesa (Safaricom Daraja) both implement the PaymentProvider interface.
// The pending-intent registry maps provider-side intent ids (e.g. M-Pesa
// CheckoutRequestID) back to JATA Qi customers so incoming webhook callbacks
// can be attributed without trusting any callback field.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { PaymentProvider } from './types.js';
import { StripeProvider, type StripeConfig } from './stripe.js';
import { MpesaProvider, type MpesaConfig } from './mpesa.js';

export interface PaymentsModuleConfig {
  stripe?: StripeConfig;
  mpesa?: MpesaConfig;
}

export interface PendingIntentMeta {
  customerId: string;
  amount: number;
  currency: string;
  reference?: string;
}

export class PaymentsModule implements IModule {
  readonly id = 'payments';
  readonly tags = ['core', 'commerce'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private providers = new Map<string, PaymentProvider>();
  /** provider intent id (e.g. M-Pesa CheckoutRequestID) -> customer attribution. */
  private pendingIntents = new Map<string, PendingIntentMeta>();

  constructor(private readonly cfg: PaymentsModuleConfig = {}) {}

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    if (this.cfg.stripe) {
      const provider = new StripeProvider(this.cfg.stripe);
      this.providers.set('stripe', provider);
      kernel.logger.info('payments: stripe provider registered');
    }
    if (this.cfg.mpesa) {
      const provider = new MpesaProvider(this.cfg.mpesa);
      this.providers.set('mpesa', provider);
      kernel.logger.info(
        `payments: mpesa provider registered (${this.cfg.mpesa.environment ?? 'sandbox'})`,
      );
    }
    kernel.container.registerValue('payments', this);
  }

  async start(_k: KernelApi): Promise<void> {}
  async stop(_k: KernelApi): Promise<void> {}

  getProvider(name: string): PaymentProvider | undefined { return this.providers.get(name); }
  get stripe(): PaymentProvider | undefined { return this.providers.get('stripe'); }
  get mpesa(): PaymentProvider | undefined { return this.providers.get('mpesa'); }

  /** M-Pesa environment label ('sandbox' | 'production' | 'custom' when apiBase overridden). */
  get mpesaEnvironment(): string {
    if (this.cfg.mpesa?.environment) return this.cfg.mpesa.environment;
    return this.cfg.mpesa?.apiBase ? 'custom' : 'sandbox';
  }

  /** Attribute a provider-side intent to a customer before/at initiation time. */
  recordPendingIntent(intentId: string, meta: PendingIntentMeta): void {
    if (!intentId) return;
    this.pendingIntents.set(intentId, meta);
    this.api.logger.info(`payments: pending intent ${intentId} → customer ${meta.customerId}`);
  }

  /** Resolve the customer attribution for a webhook event (returns undefined when unknown). */
  resolvePendingIntent(intentId: string): PendingIntentMeta | undefined {
    const meta = this.pendingIntents.get(intentId);
    if (meta) this.pendingIntents.delete(intentId); // single-use attribution
    return meta;
  }

  /** Number of unresolved intents (observability / tests). */
  get pendingIntentCount(): number { return this.pendingIntents.size; }
}
