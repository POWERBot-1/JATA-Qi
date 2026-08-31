// Universal Payment Router and Quoting service.

import type { PaymentIntent, PaymentQuote, IPaymentProvider } from './types.js';

export class UniversalPaymentRouter {
  private readonly providers = new Map<string, IPaymentProvider>();

  registerProvider(providerId: string, provider: IPaymentProvider): void {
    this.providers.set(providerId, provider);
  }

  getProvider(providerId: string): IPaymentProvider {
    const p = this.providers.get(providerId);
    if (!p) throw new Error(`UniversalPaymentRouter: provider ${providerId} not found`);
    return p;
  }

  route(intent: PaymentIntent): string {
    // Determine optimal rail based on currency and preference
    if (intent.preferredPaymentMethod && this.providers.has(intent.preferredPaymentMethod.toLowerCase())) {
      return intent.preferredPaymentMethod.toLowerCase();
    }
    if (intent.currency === 'KES') return 'mpesa';
    if (intent.currency === 'USD') return 'card';
    return 'bank';
  }

  quote(intent: PaymentIntent, providerId: string): PaymentQuote {
    const fee = intent.currency === 'KES' ? 15 : 1.50;
    return {
      requestedAmount: intent.amount,
      requestedCurrency: intent.currency,
      selectedMethod: providerId,
      provider: providerId,
      providerFee: fee,
      fxFee: 0,
      totalDebit: intent.amount + fee,
      expectedRecipientAmount: intent.amount,
      estimatedSettlementTimeMs: 2000,
      quoteExpiry: new Date(Date.now() + 300000).toISOString(),
    };
  }
}
