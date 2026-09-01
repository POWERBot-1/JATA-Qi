import type { CommercialEvidence, MonetaryValue } from '@jataqi/commercial-control-plane';

export type RevenueEntryType = 'REVENUE' | 'REFUND_REVERSAL' | 'COST';
export type CostCategory = 'PAYMENT' | 'AI' | 'MARKETING' | 'INFRASTRUCTURE' | 'SUPPORT' | 'THIRD_PARTY' | 'OTHER';
export type RevenueRecognitionStatus = 'RECOGNIZED' | 'REVERSED' | 'ESTIMATED' | 'PENDING_VERIFICATION';

export interface RevenueLedgerEntry {
  id: string;
  tenantId: string;
  sequence: number;
  previousHash: string;
  hash: string;
  entryType: RevenueEntryType;
  recognitionStatus: RevenueRecognitionStatus;
  invoiceId?: string;
  paymentId?: string;
  providerReference?: string;
  productId?: string;
  ventureId?: string;
  customerReference?: string;
  amount: MonetaryValue;
  costCategory?: CostCategory;
  sourceEventId?: string;
  evidence: CommercialEvidence[];
  createdAt: number;
  notes?: string;
}

export interface RecordCostInput {
  productId?: string;
  ventureId?: string;
  amount: MonetaryValue;
  category: CostCategory;
  evidence: CommercialEvidence[];
  notes?: string;
  /** False means an estimate is retained as estimated rather than financial fact. */
  measured?: boolean;
}

export interface RevenueSummary {
  currency: string;
  recognizedRevenue: number;
  reversedRevenue: number;
  measuredCosts: number;
  estimatedCosts: number;
  contribution: number;
}

export const RevenueLedgerEvents = Object.freeze({
  RevenueRecorded: 'revenue.recorded',
  RevenueReversed: 'revenue.reversed',
  CostRecorded: 'revenue.cost.recorded',
} as const);
