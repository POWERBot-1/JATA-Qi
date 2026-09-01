import type { CommercialEvidence, MonetaryValue } from '@jataqi/commercial-control-plane';
import type { ProviderPaymentStatus } from '@jataqi/payments';

export type ReconciliationStatus = 'PENDING_EXTERNAL' | 'RECONCILED' | 'UNRECONCILED' | 'DISPUTED' | 'FAILED';
export type ReconciliationDiscrepancyKind = 'MISSING_LEDGER' | 'ORPHAN_LEDGER' | 'DUPLICATE_LEDGER' | 'AMOUNT_MISMATCH' | 'CURRENCY_MISMATCH' | 'MISSING_PROVIDER' | 'PROVIDER_STATUS_MISMATCH';

export interface ProviderPaymentObservation {
  providerReference: string;
  status: ProviderPaymentStatus;
  amount: MonetaryValue;
  observedAt: number;
  evidence: CommercialEvidence[];
}

/** Read-only provider observation contract. It cannot create, refund, or mutate a payment. */
export interface PaymentReconciliationSource {
  id: string;
  tenantId?: string;
  providerId: string;
  observe(input: { tenantId: string; since?: number; until?: number; signal: AbortSignal }): Promise<ProviderPaymentObservation[]>;
}

export interface ReconciliationDiscrepancy {
  id: string;
  kind: ReconciliationDiscrepancyKind;
  paymentId?: string;
  ledgerEntryId?: string;
  providerReference?: string;
  detail: string;
  expected?: MonetaryValue;
  observed?: MonetaryValue;
}

export interface ReconciliationRun {
  id: string;
  tenantId: string;
  providerId?: string;
  sourceId?: string;
  status: ReconciliationStatus;
  internalReconciled: boolean;
  externalObserved: boolean;
  paymentCount: number;
  revenueEntryCount: number;
  providerObservationCount: number;
  discrepancies: ReconciliationDiscrepancy[];
  evidence: CommercialEvidence[];
  createdAt: number;
}

export interface RunReconciliationInput {
  providerId?: string;
  sourceId?: string;
  since?: number;
  until?: number;
}

export const ReconciliationEvents = Object.freeze({
  Completed: 'reconciliation.completed',
} as const);
