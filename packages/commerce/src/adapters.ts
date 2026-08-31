// Provider-neutral payment adapters (M-Pesa, Card, Bank, Wallet).

import type { IPaymentProvider, PaymentIntent, PaymentIntentStatus, VerificationState } from './types.js';

export class MockPaymentAdapter implements IPaymentProvider {
  constructor(
    readonly providerId: string,
    private readonly failureRate = 0
  ) {}

  async createPayment(intent: PaymentIntent): Promise<{ providerTransactionId: string; status: PaymentIntentStatus }> {
    if (Math.random() < this.failureRate) {
      throw new Error(`Provider ${this.providerId} connection failed`);
    }
    return {
      providerTransactionId: `txn-${this.providerId}-${Math.random().toString(36).substring(2, 8)}`,
      status: 'PROCESSING',
    };
  }

  async executePayment(providerTransactionId: string): Promise<{ success: boolean; reference: string; fees: number }> {
    return {
      success: true,
      reference: `ref-${providerTransactionId}`,
      fees: 15.00,
    };
  }

  async verifyPayment(providerTransactionId: string): Promise<VerificationState> {
    return 'VERIFIED_SUCCESS';
  }

  async refundPayment(providerTransactionId: string, amount?: number): Promise<boolean> {
    return true;
  }
}
