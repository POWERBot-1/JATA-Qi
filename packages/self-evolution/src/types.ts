// JATA Qi Self-Evolution — types (#52/#86). Every autonomous action is
// explainable, auditable, reversible, policy-governed, and tenant-aware.
// Safety before autonomy; human-governed evolution.

export type ObservationType =
  | 'latency' | 'failure' | 'throughput' | 'cost' | 'quality'
  | 'feedback' | 'resource' | 'anomaly' | string;

export type Severity = 'info' | 'warning' | 'critical';

export interface Observation {
  id: string;
  type: ObservationType;
  source: string; // 'orchestrator' | 'tool-intelligence' | 'api-gateway' | ...
  metric: string;
  value: number;
  baseline?: number;
  severity: Severity;
  detail?: string;
  organizationId?: string;
  createdAt: number;
}

export type ProposalStatus =
  | 'proposed' | 'analyzing' | 'approved' | 'rejected' | 'experimenting'
  | 'deployed' | 'rolled_back' | 'abandoned';

export type ProposalKind =
  | 'prompt' | 'routing' | 'workflow' | 'caching' | 'scheduling'
  | 'model_selection' | 'cost' | 'latency' | 'retry' | 'architecture' | string;

export interface Proposal {
  id: string;
  title: string;
  kind: ProposalKind;
  description: string;
  expectedImpact: string;
  estimatedComplexity: 'low' | 'medium' | 'high';
  confidence: number; // 0..1
  rollbackStrategy: string;
  affectedSystems: string[];
  evidence: string[]; // observation ids
  status: ProposalStatus;
  governanceDecision?: string;
  governanceEvaluationId?: string;
  riskScore: number; // 0..5
  organizationId?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export type ExperimentMode = 'ab' | 'canary' | 'shadow' | 'simulation';
export type ExperimentStatus = 'created' | 'running' | 'completed' | 'failed' | 'aborted';

export interface Experiment {
  id: string;
  proposalId: string;
  mode: ExperimentMode;
  status: ExperimentStatus;
  baseline: Record<string, number>;
  variant: Record<string, number>;
  result?: { winner: 'baseline' | 'variant' | 'inconclusive'; improvementPct?: number };
  createdBy: string;
  createdAt: number;
  completedAt?: number;
}

export interface LessonLearned {
  id: string;
  title: string;
  category: 'success' | 'failure' | 'pattern' | 'best_practice';
  description: string;
  proposalId?: string;
  experimentId?: string;
  organizationId?: string;
  createdAt: number;
}

export interface ExplainabilityReport {
  proposalId: string;
  reasoningSummary: string;
  evidence: string[];
  confidence: number;
  expectedImpact: string;
  affectedSystems: string[];
  rollbackStrategy: string;
  governanceDecision?: string;
  auditReference?: string;
}

export const EvolutionEvents = Object.freeze({
  ObservationRecorded: 'evolution.observation.recorded',
  ProposalCreated: 'evolution.proposal.created',
  ProposalApproved: 'evolution.proposal.approved',
  ProposalRejected: 'evolution.proposal.rejected',
  ExperimentStarted: 'evolution.experiment.started',
  ExperimentCompleted: 'evolution.experiment.completed',
  ProposalDeployed: 'evolution.proposal.deployed',
  ProposalRolledBack: 'evolution.proposal.rolled_back',
  LessonLearned: 'evolution.lesson.learned',
  EvolutionBlocked: 'evolution.blocked',
} as const);

/** Confidence threshold for autonomous action (configurable). */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.75;

/** Max consecutive evolution cycles without human review (safety). */
export const MAX_AUTONOMOUS_CYCLES = 10;
