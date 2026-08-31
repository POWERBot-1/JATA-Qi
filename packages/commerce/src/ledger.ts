// Immutable payment ledger and verification service.

import type { PaymentIntent, LedgerRecord, UniversalReceipt, VerificationState } from './types.js';

export class PaymentLedger {
  private readonly ledger = new Map<string, LedgerRecord>();
  private readonly idempotencyCache = new Map<string, LedgerRecord>();

  recordTransaction(
    intent: PaymentIntent,
    providerTxId: string,
    providerId: string,
    fees: number,
    status: PaymentIntentStatusMock,
    verification: VerificationState
  ): LedgerRecord {
    if (this.idempotencyCache.has(intent.idempotencyKey)) {
      return this.idempotencyCache.get(intent.idempotencyKey)!;
    }

    const record: LedgerRecord = {
      ledgerId: `ledg-${Math.random().toString(36).substring(2, 10)}`,
      paymentIntentId: intent.paymentIntentId,
      providerTransactionId: providerTxId,
      payer: intent.payerId,
      payee: intent.payee.identifier,
      amount: intent.amount,
      currency: intent.currency,
      fees,
      netAmount: intent.amount - fees,
      provider: providerId,
      paymentMethod: providerId,
      status: status as any,
      verificationStatus: verification,
      timestamp: new Date().toISOString(),
      idempotencyKey: intent.idempotencyKey,
      auditHash: `sha256:${Buffer.from(intent.paymentIntentId + providerTxId + intent.amount).toString('hex').slice(0, 32)}`,
    };

    this.ledger.set(record.ledgerId, record);
    this.idempotencyCache.set(intent.idempotencyKey, record);
    return record;
  }

  getRecord(ledgerId: string): LedgerRecord | undefined {
    return this.ledger.get(ledgerId);
  }

  generateReceipt(record: LedgerRecord): UniversalReceipt {
    return {
      receiptId: `rcpt-${Math.random().toString(36).substring(2, 10)}`,
      paymentId: record.ledgerId,
      payer: record.payer,
      payee: record.payee,
      amount: record.amount,
      currency: record.currency,
      purpose: 'Payment execution via Universal Prompt-to-Payment Layer',
      paymentMethod: record.paymentMethod,
      provider: record.provider,
      providerReference: record.providerTransactionId,
      status: record.status as any,
      transactionTime: record.timestamp,
      fees: record.fees,
      verificationStatus: record.verificationStatus,
      auditReference: record.auditHash,
    };
  }
}

type PaymentIntentStatusMock = string;
