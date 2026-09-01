import type { CommercialEvidence, CommercialProvenance, EvidenceStatus, MonetaryValue } from '@jataqi/commercial-control-plane';
import type { CostCategory } from '@jataqi/revenue-ledger';

export type FunnelEventType = 'VISITOR' | 'SIGNUP' | 'ACTIVATION' | 'TRIAL_STARTED' | 'PAID_CUSTOMER' | 'CANCELLATION' | 'REFUND' | 'REFERRAL' | 'ADVOCACY';

export interface CommercialFunnelEvent {
  id: string;
  tenantId: string;
  type: FunnelEventType;
  count: number;
  customerReference?: string;
  productId?: string;
  campaignId?: string;
  channel?: string;
  market?: string;
  timestamp: number;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
}

export interface RecordFunnelEventInput {
  type: FunnelEventType;
  count?: number;
  customerReference?: string;
  productId?: string;
  campaignId?: string;
  channel?: string;
  market?: string;
  timestamp?: number;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
}

export type EconomicMetricName =
  | 'VISITORS'
  | 'SIGNUPS'
  | 'ACTIVATIONS'
  | 'TRIALS'
  | 'PAID_CUSTOMERS'
  | 'MRR'
  | 'ARR'
  | 'RECOGNIZED_REVENUE'
  | 'PAYMENT_COST'
  | 'AI_COST'
  | 'MARKETING_COST'
  | 'INFRASTRUCTURE_COST'
  | 'SUPPORT_COST'
  | 'GROSS_PROFIT'
  | 'CONTRIBUTION_MARGIN'
  | 'CAC'
  | 'ROAS'
  | 'ARPU'
  | 'LTV'
  | 'CHURN_RATE'
  | 'RETENTION_RATE'
  | 'REFUNDS'
  | 'FAILED_PAYMENTS';

/** Evidence-backed economic observation suitable for future decision engines. */
export interface EconomicObservation {
  id: string;
  tenantId: string;
  metric: EconomicMetricName | string;
  value?: number;
  currency?: string;
  unit: string;
  evidenceStatus: EvidenceStatus;
  source: string;
  confidence: number;
  period: { start: number; end: number };
  timestamp: number;
  calculationMethod: string;
  sourceReferences: string[];
  provenance: CommercialProvenance;
}

export interface AnalyticsPeriod {
  start?: number;
  end?: number;
}

export interface ChannelEconomics {
  channel: string;
  visitors: number;
  signups: number;
  activations: number;
  paidCustomers: number;
  referrals: number;
}

export interface CurrencyEconomics {
  currency: string;
  recognizedRevenue: number;
  reversedRevenue: number;
  measuredCosts: Record<CostCategory, number>;
  estimatedCosts: Record<CostCategory, number>;
  grossProfit: number;
  contributionMargin: number;
  mrr: number;
  arr: number;
  arpu?: number;
  cac?: number;
  roas?: number;
  ltv?: number;
}

export interface CommercialAnalyticsSnapshot {
  tenantId: string;
  period: { start: number; end: number };
  visitors: number;
  signups: number;
  activations: number;
  trials: number;
  paidCustomers: number;
  refunds: number;
  failedPayments: number;
  churnedSubscriptions: number;
  activeSubscriptions: number;
  churnRate?: number;
  retentionRate?: number;
  currencies: CurrencyEconomics[];
  channels: ChannelEconomics[];
  observations: EconomicObservation[];
  calculatedAt: number;
}

export const CommercialAnalyticsEvents = Object.freeze({
  FunnelEventRecorded: 'commercial.analytics.funnel.recorded',
  SnapshotCalculated: 'commercial.analytics.snapshot.calculated',
} as const);
