import type {
  ApprovalRequest,
  CommercialAction,
  CommercialAuthorization,
  CommercialBudget,
  CommercialDecision,
  CommercialExperiment,
  CommercialKillSwitch,
  ConnectorRecord,
} from '@jataqi/commercial-control-plane';
import type { CommercialAnalyticsSnapshot } from '@jataqi/commercial-analytics';
import type { CommercialAnomaly, DriftAssessment } from '@jataqi/commercial-health';
import type { EventDeliveryRecord } from '@jataqi/commercial-event-stream';
import type { CommercialReadinessReport } from '@jataqi/commercial-intelligence';
import type { CommercialAlert, CommercialIncident, CommercialObservabilitySnapshot } from '@jataqi/commercial-observability';
import type { PortfolioAssessment, ResourceAllocationRecommendation } from '@jataqi/portfolio-governor';
import type { ReconciliationRun } from '@jataqi/reconciliation';

export interface ApprovalQueueItem {
  approval: ApprovalRequest;
  decision?: CommercialDecision;
}

export interface CommandCenterSnapshot {
  tenantId: string;
  generatedAt: number;
  approvals: ApprovalQueueItem[];
  decisions: CommercialDecision[];
  authorizations: CommercialAuthorization[];
  actions: CommercialAction[];
  budgets: CommercialBudget[];
  activeKillSwitches: CommercialKillSwitch[];
  connectors: ConnectorRecord[];
  experiments: CommercialExperiment[];
  financial?: {
    analytics: CommercialAnalyticsSnapshot;
    reconciliation: ReconciliationRun[];
    paymentStates: Record<string, number>;
    invoiceStates: Record<string, number>;
  };
  health?: {
    anomalies: CommercialAnomaly[];
    drift: DriftAssessment[];
  };
  observability?: {
    snapshot: CommercialObservabilitySnapshot;
    activeAlerts: CommercialAlert[];
    activeIncidents: CommercialIncident[];
  };
  eventDelivery?: {
    deadLetters: EventDeliveryRecord[];
    retrying: EventDeliveryRecord[];
  };
  readiness?: CommercialReadinessReport[];
  portfolio?: {
    assessments: PortfolioAssessment[];
    allocations: ResourceAllocationRecommendation[];
  };
  memory?: {
    learningCount: number;
    failureCount: number;
    prohibitedStrategyCount: number;
  };
  unavailable: string[];
}

export const CommercialCommandCenterEvents = Object.freeze({
  SnapshotRequested: 'commercial.command_center.snapshot.requested',
} as const);
