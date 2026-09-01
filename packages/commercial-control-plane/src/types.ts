// JATA Qi Commercial Control Plane — shared commercial governance contracts.
// These contracts deliberately distinguish observation, prediction, simulation,
// recommendation, authorization, execution, and verified outcomes.

export type CommercialAutonomyLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const CommercialAutonomy = Object.freeze({
  Observe: 0 as CommercialAutonomyLevel,
  Recommend: 1 as CommercialAutonomyLevel,
  Generate: 2 as CommercialAutonomyLevel,
  Publish: 3 as CommercialAutonomyLevel,
  Optimize: 4 as CommercialAutonomyLevel,
  Evolve: 5 as CommercialAutonomyLevel,
  Ecosystem: 6 as CommercialAutonomyLevel,
  SelfOptimize: 7 as CommercialAutonomyLevel,
});

export type CommercialActorRole =
  | 'observer'
  | 'agent'
  | 'operator'
  | 'approver'
  | 'admin'
  | 'global_admin'
  | 'system';

/** Caller identity supplied by an upstream identity provider or trusted service. */
export interface CommercialActor {
  id: string;
  tenantId: string;
  roles: readonly CommercialActorRole[];
  agentId?: string;
  modelId?: string;
}

export interface MonetaryValue {
  amount: number;
  currency: string;
}

export type EvidenceStatus =
  | 'UNVERIFIED'
  | 'PARTIAL'
  | 'OBSERVED'
  | 'MEASURED'
  | 'CUSTOMER_CONFIRMED'
  | 'DEMONSTRATED'
  | 'REPEATED'
  | 'VERIFIED'
  | 'ESTIMATED'
  | 'ASSUMPTION'
  | 'PREDICTION'
  | 'STALE'
  | 'CONFLICTING'
  | 'UNAVAILABLE';

export type PrivacyClassification = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED' | 'PERSONAL_DATA';

export interface CommercialProvenance {
  source: string;
  collectedAt: number;
  correlationId?: string;
  causationId?: string;
  sourceReference?: string;
  contentHash?: string;
}

export interface CommercialEvidence {
  id: string;
  status: EvidenceStatus;
  source: string;
  observedAt: number;
  confidence: number;
  summary: string;
  provenance: CommercialProvenance;
  validUntil?: number;
  privacyClassification?: PrivacyClassification;
}

export interface ModelReference {
  id: string;
  version: string;
  evaluationStatus?: 'UNASSESSED' | 'TESTED' | 'MONITORED' | 'DEGRADED' | 'RETIRED';
}

export interface AudienceReference {
  /** Privacy-minimized segment identifier, never a raw customer list. */
  segmentId?: string;
  description?: string;
  estimatedSize?: number;
}

export interface DecisionAlternative {
  id: string;
  actionType: string;
  expectedValue?: MonetaryValue;
  estimatedCost?: MonetaryValue;
  riskScore?: number;
  reason: string;
}

export type CommercialDecisionExecutionState =
  | 'PROPOSED'
  | 'AUTHORIZING'
  | 'WAITING_FOR_APPROVAL'
  | 'AUTHORIZED'
  | 'QUEUED'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'DENIED'
  | 'EXPIRED'
  | 'FAILED'
  | 'CANCELLED';

export type ApprovalState = 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'DEFERRED' | 'EXPIRED';

export interface CommercialDecision {
  /** Canonical decision identifier (decision_id in external contracts). */
  id: string;
  tenantId: string;
  productId: string;
  ventureId?: string;
  campaignId?: string;
  objective: string;
  audience?: AudienceReference;
  market?: string;
  channel?: string;
  connectorId?: string;
  proposedAction: string;
  actionType: string;
  expectedValue?: MonetaryValue;
  estimatedCost?: MonetaryValue;
  resourceRequirements: ResourceRequirement[];
  evidence: CommercialEvidence[];
  evidenceStrength: number;
  trustScore?: number;
  pmfScore?: number;
  conversionProbability?: number;
  economicScore?: number;
  riskScore: number;
  complianceScore: number;
  reputationScore?: number;
  confidence: number;
  model?: ModelReference;
  policyVersion?: string;
  authorizationLevel: CommercialAutonomyLevel;
  requiredApproval: boolean;
  approvalState: ApprovalState;
  createdAt: number;
  expiresAt?: number;
  executionState: CommercialDecisionExecutionState;
  result?: Record<string, unknown>;
  outcome?: Record<string, unknown>;
  decisionReason: string;
  alternativesConsidered: DecisionAlternative[];
  provenance: CommercialProvenance;
  communication?: { subjectId: string; channel: string; purpose: string };
}

export interface CreateCommercialDecisionInput {
  tenantId: string;
  productId: string;
  ventureId?: string;
  campaignId?: string;
  objective: string;
  audience?: AudienceReference;
  market?: string;
  channel?: string;
  connectorId?: string;
  proposedAction: string;
  actionType: string;
  expectedValue?: MonetaryValue;
  estimatedCost?: MonetaryValue;
  resourceRequirements?: ResourceRequirement[];
  evidence: CommercialEvidence[];
  evidenceStrength: number;
  trustScore?: number;
  pmfScore?: number;
  conversionProbability?: number;
  economicScore?: number;
  riskScore: number;
  complianceScore: number;
  reputationScore?: number;
  confidence: number;
  model?: ModelReference;
  policyVersion?: string;
  authorizationLevel: CommercialAutonomyLevel;
  requiredApproval?: boolean;
  expiresAt?: number;
  decisionReason: string;
  alternativesConsidered?: DecisionAlternative[];
  provenance: CommercialProvenance;
  communication?: { subjectId: string; channel: string; purpose: string };
}

export type ProductCommercialState =
  | 'IDEA'
  | 'DISCOVERED'
  | 'VALIDATING'
  | 'PMF_TESTING'
  | 'COLD_START'
  | 'INITIAL_SIGNAL'
  | 'EARLY_TRACTION'
  | 'REPEATABLE_ACQUISITION'
  | 'ORGANIC_PROPAGATION'
  | 'COMMERCIAL_SCALE'
  | 'MARKET_EXPANSION'
  | 'GLOBAL_SCALE'
  | 'PAUSED'
  | 'BLOCKED'
  | 'UNDER_REVIEW'
  | 'DEGRADED'
  | 'REPAIRING'
  | 'RETESTING'
  | 'PIVOTING'
  | 'RETIRED';

export type CampaignState =
  | 'DRAFT'
  | 'HYPOTHESIS'
  | 'VALIDATING'
  | 'APPROVED'
  | 'QUEUED'
  | 'AUTHORIZING'
  | 'READY'
  | 'PUBLISHING'
  | 'PUBLISHED'
  | 'TELEMETRY_ACTIVE'
  | 'OPTIMIZING'
  | 'COMPLETED'
  | 'DECAYING'
  | 'RETIRED'
  | 'BLOCKED'
  | 'REJECTED'
  | 'RATE_LIMITED'
  | 'AUTHORIZATION_FAILED'
  | 'POLICY_BLOCKED'
  | 'PLATFORM_REJECTED'
  | 'CONTENT_REJECTED'
  | 'NETWORK_ERROR'
  | 'CREDENTIAL_EXPIRED'
  | 'HUMAN_REVIEW_REQUIRED'
  | 'ECONOMICALLY_UNVIABLE';

export type CommercialStateKind = 'PRODUCT' | 'CAMPAIGN';
export type CommercialLifecycleState = ProductCommercialState | CampaignState;

export interface CommercialStateRecord {
  id: string;
  tenantId: string;
  kind: CommercialStateKind;
  entityId: string;
  productId?: string;
  campaignId?: string;
  state: CommercialLifecycleState;
  updatedAt: number;
}

export interface CommercialStateTransition {
  id: string;
  tenantId: string;
  kind: CommercialStateKind;
  entityId: string;
  productId?: string;
  campaignId?: string;
  previousState: CommercialLifecycleState;
  newState: CommercialLifecycleState;
  trigger: string;
  evidence: CommercialEvidence[];
  decisionId?: string;
  actor: string;
  timestamp: number;
  reason: string;
  policyCheck: AuthorizationOutcome;
  approvalState: ApprovalState;
  rollbackOption?: string;
}

export interface TransitionCommercialStateInput {
  newState: CommercialLifecycleState;
  trigger: string;
  evidence?: CommercialEvidence[];
  decisionId?: string;
  reason: string;
  policyCheck?: AuthorizationOutcome;
  approvalState?: ApprovalState;
  rollbackOption?: string;
}

export type AuthorizationOutcome = 'ALLOW' | 'DENY' | 'WAIT' | 'TEST' | 'ESCALATE' | 'HUMAN_APPROVAL_REQUIRED';

export interface CommercialScope {
  tenantId?: string;
  ventureId?: string;
  productId?: string;
  market?: string;
  campaignId?: string;
  channel?: string;
  connectorId?: string;
  actionType?: string;
}

export interface AutonomyPolicy {
  id: string;
  version: string;
  scope: CommercialScope;
  active: boolean;
  maximumAutonomyLevel: CommercialAutonomyLevel;
  allowExecution: boolean;
  allowedActionTypes?: string[];
  deniedActionTypes?: string[];
  maximumRiskScore?: number;
  minimumComplianceScore?: number;
  minimumEvidenceStrength?: number;
  approvalRiskThreshold?: number;
  requireSimulation?: boolean;
  maximumSingleActionCost?: MonetaryValue;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
}

export interface CreateAutonomyPolicyInput {
  version: string;
  scope: CommercialScope;
  maximumAutonomyLevel: CommercialAutonomyLevel;
  allowExecution?: boolean;
  allowedActionTypes?: string[];
  deniedActionTypes?: string[];
  maximumRiskScore?: number;
  minimumComplianceScore?: number;
  minimumEvidenceStrength?: number;
  approvalRiskThreshold?: number;
  requireSimulation?: boolean;
  maximumSingleActionCost?: MonetaryValue;
  expiresAt?: number;
}

export interface AuthorizationCheck {
  name: 'expiry' | 'kill_switch' | 'policy' | 'risk' | 'compliance' | 'evidence' | 'budget' | 'connector' | 'consent' | 'approval';
  passed: boolean;
  detail: string;
}

export interface BudgetCheck {
  budgetId: string;
  allowed: boolean;
  limit: number;
  consumed: number;
  reserved: number;
  requested: number;
  remaining: number;
  currency: string;
}

export interface CommercialAuthorization {
  id: string;
  tenantId: string;
  decisionId: string;
  outcome: AuthorizationOutcome;
  allowed: boolean;
  policyId?: string;
  policyVersion?: string;
  evaluatedAt: number;
  expiresAt?: number;
  requiredApproval: boolean;
  approvalState: ApprovalState;
  simulationOnly: boolean;
  checks: AuthorizationCheck[];
  budgetChecks: BudgetCheck[];
  reasons: string[];
}

export type ResourceType =
  | 'MONEY'
  | 'AD_SPEND'
  | 'AI_INFERENCE'
  | 'COMPUTE'
  | 'STORAGE'
  | 'API_CALLS'
  | 'MESSAGING'
  | 'CONTENT_GENERATION'
  | 'EXPERIMENT'
  | 'EXTERNAL_SERVICE'
  | 'HUMAN_REVIEW';

export interface ResourceRequirement {
  resourceType: ResourceType;
  amount: number;
  unit: string;
  currency?: string;
}

export type BudgetPeriod = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'EXPERIMENT' | 'LIFETIME';

export interface CommercialBudget {
  id: string;
  tenantId: string;
  scope: CommercialScope;
  resourceType: ResourceType;
  period: BudgetPeriod;
  limit: number;
  unit: string;
  currency?: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CreateCommercialBudgetInput {
  scope: CommercialScope;
  resourceType: ResourceType;
  period: BudgetPeriod;
  limit: number;
  unit: string;
  currency?: string;
  active?: boolean;
}

export type ActionExecutionStatus =
  | 'PROPOSED'
  | 'POLICY_CHECK'
  | 'RISK_CHECK'
  | 'AUTHORIZATION_CHECK'
  | 'APPROVAL_REQUIRED'
  | 'APPROVED'
  | 'QUEUED'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'BLOCKED'
  | 'FAILED'
  | 'RETRYING'
  | 'ESCALATED'
  | 'ROLLED_BACK'
  | 'COMPENSATED'
  | 'CANCELLED';

export type VerificationStatus = 'NOT_REQUIRED' | 'PENDING' | 'VERIFIED' | 'FAILED';
export type RollbackStatus = 'NOT_REQUESTED' | 'PENDING' | 'VERIFIED' | 'FAILED' | 'NOT_SUPPORTED';

export interface ActionResult {
  /** A provider/executor response is only reported, never treated as verified success. */
  reportedSuccess: boolean;
  summary?: string;
  externalResponse?: Record<string, unknown>;
  internalState?: Record<string, unknown>;
  recordedAt: number;
}

export interface CommercialAction {
  /** Canonical action identifier (action_id in external contracts). */
  id: string;
  tenantId: string;
  ventureId?: string;
  productId: string;
  campaignId?: string;
  decisionId: string;
  actionType: string;
  actor: string;
  agentId?: string;
  modelId?: string;
  targetSystem: string;
  targetResource?: string;
  parameters: Record<string, unknown>;
  authorization: CommercialAuthorization;
  riskLevel: number;
  policyResult: AuthorizationOutcome;
  approvalRequirement: boolean;
  approvalStatus: ApprovalState;
  resourceRequirements: ResourceRequirement[];
  resourceConsumption: ResourceRequirement[];
  financialCost?: MonetaryValue;
  executionStatus: ActionExecutionStatus;
  attemptCount: number;
  startedAt?: number;
  completedAt?: number;
  result?: ActionResult;
  verificationStatus: VerificationStatus;
  verificationEvidence: CommercialEvidence[];
  rollbackStrategy?: string;
  rollbackStatus: RollbackStatus;
  error?: string;
  auditReference: string;
  idempotencyKey: string;
  dryRun: boolean;
  createdAt: number;
  updatedAt: number;
  correlationId: string;
}

export interface PlanCommercialActionInput {
  targetSystem: string;
  targetResource?: string;
  parameters?: Record<string, unknown>;
  idempotencyKey: string;
  /** Safe default: real execution requires an explicit false value and policy authorization. */
  dryRun?: boolean;
  resourceRequirements?: ResourceRequirement[];
  rollbackStrategy?: string;
}

export interface ReportActionResultInput {
  reportedSuccess: boolean;
  summary?: string;
  externalResponse?: Record<string, unknown>;
  internalState?: Record<string, unknown>;
  resourceConsumption?: ResourceRequirement[];
  financialCost?: MonetaryValue;
}

export interface VerifyActionInput {
  verified: boolean;
  evidence: CommercialEvidence[];
  summary?: string;
  externalState?: Record<string, unknown>;
}

export type LedgerEntryKind =
  | 'DECISION_PROPOSED'
  | 'AUTHORIZATION_EVALUATED'
  | 'APPROVAL_REQUESTED'
  | 'APPROVAL_RESOLVED'
  | 'ACTION_QUEUED'
  | 'ACTION_STARTED'
  | 'ACTION_RESULT_REPORTED'
  | 'ACTION_VERIFIED'
  | 'ACTION_FAILED'
  | 'ACTION_ROLLBACK_RECORDED'
  | 'STATE_TRANSITION'
  | 'POLICY_CHANGED'
  | 'KILL_SWITCH_CHANGED'
  | 'BUDGET_CHANGED'
  | 'EXPERIMENT_CHANGED';

/** Append-only, hash-chained ledger record. */
export interface CommercialActionLedgerEntry {
  id: string;
  sequence: number;
  previousHash: string;
  hash: string;
  kind: LedgerEntryKind;
  tenantId: string;
  decisionId?: string;
  actionId?: string;
  actor: string;
  agentId?: string;
  productId?: string;
  campaignId?: string;
  channel?: string;
  authorization?: AuthorizationOutcome;
  timestamp: number;
  requestedAction?: string;
  actualAction?: string;
  resourceConsumption?: ResourceRequirement[];
  financialCost?: MonetaryValue;
  externalResponse?: Record<string, unknown>;
  result?: Record<string, unknown>;
  failureReason?: string;
  rollbackState?: RollbackStatus;
  evidence?: CommercialEvidence[];
  auditReference: string;
  payload: Record<string, unknown>;
}

export interface ApprovalRequest {
  id: string;
  tenantId: string;
  decisionId: string;
  state: ApprovalState;
  requestedBy: string;
  requestedAt: number;
  reason: string;
  resolvedBy?: string;
  resolvedAt?: number;
  resolutionReason?: string;
}

export type KillSwitchScope = 'GLOBAL' | 'TENANT' | 'VENTURE' | 'PRODUCT' | 'MARKET' | 'CAMPAIGN' | 'CHANNEL' | 'CONNECTOR' | 'AGENT' | 'SPENDING' | 'MESSAGING' | 'CONTENT';

export interface CommercialKillSwitch {
  id: string;
  tenantId?: string;
  scopeType: KillSwitchScope;
  scope: CommercialScope & { agentId?: string };
  active: boolean;
  reason: string;
  activatedBy: string;
  activatedAt: number;
  deactivatedBy?: string;
  deactivatedAt?: number;
}

export interface SetKillSwitchInput {
  scopeType: KillSwitchScope;
  scope: CommercialScope & { agentId?: string };
  active: boolean;
  reason: string;
}

export type ConnectorHealth =
  | 'HEALTHY'
  | 'DEGRADED'
  | 'RATE_LIMITED'
  | 'AUTHORIZATION_REQUIRED'
  | 'CREDENTIAL_EXPIRED'
  | 'FAILED'
  | 'DISABLED'
  | 'PLATFORM_RESTRICTED'
  | 'API_VERSION_INCOMPATIBLE';

export interface ConnectorCapability {
  providerId: string;
  providerType: string;
  supportedActions: string[];
  authenticationMethod: string;
  requiredPermissions: string[];
  rateLimits?: Record<string, number>;
  costModel?: string;
  regions?: string[];
  availability?: string;
  rollbackSupport: boolean;
  webhookSupport: boolean;
  sandboxSupport: boolean;
  productionSupport: boolean;
  lastVerifiedAt?: number;
}

export interface ConnectorRecord extends ConnectorCapability {
  id: string;
  tenantId?: string;
  health: ConnectorHealth;
  healthReason?: string;
  updatedAt: number;
}

export interface RegisterConnectorInput extends Omit<ConnectorCapability, 'providerId'> {
  providerId: string;
  tenantId?: string;
  health?: ConnectorHealth;
  healthReason?: string;
}

export interface ConsentRecord {
  id: string;
  tenantId: string;
  subjectId: string;
  channel: string;
  purpose: string;
  consentState: 'GRANTED' | 'DENIED' | 'REVOKED' | 'EXPIRED';
  source: string;
  timestamp: number;
  scope?: string;
  jurisdiction?: string;
  expiresAt?: number;
  revokedAt?: number;
  legalBasis?: string;
  provenance: CommercialProvenance;
}

export interface RecordConsentInput {
  subjectId: string;
  channel: string;
  purpose: string;
  consentState: ConsentRecord['consentState'];
  source: string;
  scope?: string;
  jurisdiction?: string;
  expiresAt?: number;
  legalBasis?: string;
  provenance: CommercialProvenance;
}

export type CommercialSignalKind = 'RAW_EVENT' | 'DERIVED_SIGNAL' | 'MODELED_FEATURE' | 'PREDICTION' | 'DECISION';

export interface CommercialSignal {
  id: string;
  tenantId: string;
  kind: CommercialSignalKind;
  signalType: string;
  entityId?: string;
  value: unknown;
  inputSignalIds: string[];
  confidence?: number;
  provenance: CommercialProvenance;
  privacyClassification: PrivacyClassification;
  createdAt: number;
}

export interface RecordSignalInput {
  kind: CommercialSignalKind;
  signalType: string;
  entityId?: string;
  value: unknown;
  inputSignalIds?: string[];
  confidence?: number;
  provenance: CommercialProvenance;
  privacyClassification?: PrivacyClassification;
}

export type ExperimentState = 'DRAFT' | 'APPROVAL_REQUIRED' | 'APPROVED' | 'RUNNING' | 'STOPPED' | 'SCALED' | 'REVISED' | 'COMPLETED' | 'FAILED';

export type ExperimentMetricDirection = 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER';

export interface ExperimentBudget {
  maximumMonetaryCost?: MonetaryValue;
  maximumComputeCost?: number;
  maximumApiConsumption?: number;
  maximumDurationMs: number;
  maximumAudienceExposure?: number;
  maximumMessageFrequency?: number;
  maximumAcceptableDownside?: number;
  successThreshold?: number;
  failureThreshold?: number;
  /** Required to interpret success/failure thresholds; absent means no threshold-based automatic stop. */
  primaryMetricDirection?: ExperimentMetricDirection;
  stoppingRule: string;
}

export type ExperimentMeasurementKind = 'PRIMARY_METRIC' | 'SECONDARY_METRIC' | 'AUDIENCE_EXPOSURE' | 'MESSAGE_FREQUENCY' | 'DOWNSIDE' | 'OTHER';
export type ExperimentMeasurementClassification = 'OBSERVED' | 'MEASURED' | 'SIMULATED';

/** An evidence-bound experiment measurement. Simulated measurements never stop or complete a live experiment. */
export interface CommercialExperimentMeasurement {
  id: string;
  tenantId: string;
  experimentId: string;
  kind: ExperimentMeasurementKind;
  metric: string;
  value: number;
  unit: string;
  classification: ExperimentMeasurementClassification;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
  observedAt: number;
  createdAt: number;
}

export interface RecordExperimentMeasurementInput {
  kind: ExperimentMeasurementKind;
  metric: string;
  value: number;
  unit: string;
  classification: ExperimentMeasurementClassification;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
  observedAt?: number;
}

export type ExperimentFinalState = Extract<ExperimentState, 'COMPLETED' | 'SCALED' | 'REVISED' | 'FAILED'>;

/** Finalizes an experiment record only; SCALED is a conclusion, never an authorization to spend or execute. */
export interface FinalizeCommercialExperimentInput {
  state: ExperimentFinalState;
  result: Record<string, unknown>;
  confidence: number;
  uncertainty: string;
  causalMethod: string;
  decision: string;
  learning: string;
  reusableInsight?: string;
  evidence: CommercialEvidence[];
  provenance: CommercialProvenance;
}

export interface StopCommercialExperimentInput {
  reason: string;
  evidence?: CommercialEvidence[];
  provenance?: CommercialProvenance;
}

export interface CommercialExperiment {
  id: string;
  tenantId: string;
  hypothesis: string;
  productId: string;
  campaignId?: string;
  audience?: AudienceReference;
  market?: string;
  channel?: string;
  control: string;
  variant: string;
  objective: string;
  primaryMetric: string;
  secondaryMetrics: string[];
  sampleDefinition: string;
  durationMs: number;
  budget: ExperimentBudget;
  cost: ResourceRequirement[];
  measurementIds: string[];
  state: ExperimentState;
  startTime?: number;
  endTime?: number;
  result?: Record<string, unknown>;
  confidence?: number;
  uncertainty?: string;
  causalMethod?: string;
  decision?: string;
  learning?: string;
  reusableInsight?: string;
  stopReason?: string;
  duplicateJustification?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateExperimentInput {
  hypothesis: string;
  productId: string;
  campaignId?: string;
  audience?: AudienceReference;
  market?: string;
  channel?: string;
  control: string;
  variant: string;
  objective: string;
  primaryMetric: string;
  secondaryMetrics?: string[];
  sampleDefinition: string;
  durationMs: number;
  budget: ExperimentBudget;
  duplicateJustification?: string;
}

export interface RecordExperimentCostInput {
  cost: ResourceRequirement[];
  result?: Record<string, unknown>;
  confidence?: number;
  uncertainty?: string;
  decision?: string;
  learning?: string;
  reusableInsight?: string;
}

export interface CommercialEvent {
  id: string;
  sequence: number;
  eventType: string;
  eventVersion: number;
  tenantId: string;
  source: string;
  actor?: string;
  entityId?: string;
  timestamp: number;
  correlationId: string;
  causationId?: string;
  payload: Record<string, unknown>;
  schemaVersion: number;
  provenance: CommercialProvenance;
  privacyClassification: PrivacyClassification;
  idempotencyKey?: string;
}

export interface PublishCommercialEventInput {
  eventType: string;
  eventVersion?: number;
  source: string;
  entityId?: string;
  correlationId: string;
  causationId?: string;
  payload: Record<string, unknown>;
  schemaVersion?: number;
  provenance: CommercialProvenance;
  privacyClassification?: PrivacyClassification;
  idempotencyKey?: string;
}

export interface ReplayCommercialEventsOptions {
  afterSequence?: number;
  eventTypes?: string[];
  limit?: number;
}

export const CommercialControlPlaneEvents = Object.freeze({
  DecisionProposed: 'commercial.decision.proposed',
  DecisionAuthorized: 'commercial.decision.authorized',
  ApprovalRequested: 'commercial.approval.requested',
  ApprovalResolved: 'commercial.approval.resolved',
  ActionQueued: 'commercial.action.queued',
  ActionStarted: 'commercial.action.started',
  ActionResultReported: 'commercial.action.result_reported',
  ActionVerified: 'commercial.action.verified',
  ActionFailed: 'commercial.action.failed',
  StateTransitioned: 'commercial.state.transitioned',
  PolicyChanged: 'commercial.policy.changed',
  KillSwitchChanged: 'commercial.kill_switch.changed',
  BudgetChanged: 'commercial.budget.changed',
  ExperimentChanged: 'commercial.experiment.changed',
  EventRecorded: 'commercial.event.recorded',
  ConnectorHealthChanged: 'commercial.connector.health_changed',
  ConsentChanged: 'commercial.consent.changed',
  SignalRecorded: 'commercial.signal.recorded',
} as const);
