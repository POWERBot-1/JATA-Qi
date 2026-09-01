import type { CommercialEvidence, CommercialProvenance } from '@jataqi/commercial-control-plane';

export type VentureState = 'DISCOVERED' | 'VALIDATED' | 'APPROVED' | 'DESIGNED' | 'BUILDING' | 'TESTING' | 'SANDBOX' | 'STAGING' | 'PRODUCTION' | 'GROWTH' | 'SCALE' | 'PIVOT' | 'RETIRED' | 'BLOCKED';

export interface VentureBlueprint {
  businessModel: string;
  targetCustomers: string[];
  valueProposition: string;
  pricingStrategy: string;
  distributionStrategy: string;
  retentionStrategy: string;
  unitEconomicsSummary: string;
  costStructureSummary: string;
  productSpecificationReference?: string;
  engineeringPlanReference?: string;
}

export interface Venture {
  id: string;
  tenantId: string;
  name: string;
  productId: string;
  opportunityId?: string;
  state: VentureState;
  blueprint: VentureBlueprint;
  evidence: CommercialEvidence[];
  createdAt: number;
  updatedAt: number;
  stateHistory: VentureStateTransition[];
}

export interface CreateVentureInput {
  name: string;
  productId: string;
  opportunityId?: string;
  blueprint: VentureBlueprint;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
}

export interface VentureStateTransition {
  id: string;
  previousState: VentureState;
  newState: VentureState;
  reason: string;
  decisionId?: string;
  readinessReportId?: string;
  evidence: CommercialEvidence[];
  actor: string;
  timestamp: number;
}

export interface TransitionVentureInput {
  newState: VentureState;
  reason: string;
  decisionId?: string;
  readinessReportId?: string;
  evidence: CommercialEvidence[];
}

export const VentureFactoryEvents = Object.freeze({
  Created: 'venture.created',
  Transitioned: 'venture.transitioned',
  Blocked: 'venture.blocked',
} as const);
