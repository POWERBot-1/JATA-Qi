import { createHash, randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { toEnvelopeFromCommercial, type EventEnvelope } from '@jataqi/core-kernel';
import {
  UnifiedOutbox,
  UNIFIED_OUTBOX_COLLECTION,
  UNIFIED_OUTBOX_COUNTER_COLLECTION,
  createTenantMutex,
  type ReplayUnifiedOutboxOptions,
  type UnifiedOutboxIntegrity,
  type UnifiedOutboxRecord,
} from './unified-outbox.js';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import { evaluatePolicy, scopeMatches, selectPolicy } from './policy-engine.js';
import { assertCampaignTransition, assertProductTransition } from './state-machine.js';
import {
  CommercialControlPlaneEvents,
  type ActionExecutionStatus,
  type ApprovalRequest,
  type ApprovalState,
  type AuthorizationCheck,
  type AuthorizationOutcome,
  type AutonomyPolicy,
  type BudgetCheck,
  type CampaignState,
  type CommercialAction,
  type CommercialActionLedgerEntry,
  type CommercialActor,
  type CommercialAuthorization,
  type CommercialBudget,
  type CommercialDecision,
  type CommercialEvent,
  type CommercialEvidence,
  type CommercialExperiment,
  type CommercialExperimentMeasurement,
  type CommercialKillSwitch,
  type CommercialLifecycleState,
  type CommercialProvenance,
  type CommercialScope,
  type CommercialSignal,
  type CommercialStateKind,
  type CommercialStateRecord,
  type CommercialStateTransition,
  type ConnectorHealth,
  type ConnectorRecord,
  type ConsentRecord,
  type CreateAutonomyPolicyInput,
  type CreateCommercialBudgetInput,
  type CreateCommercialDecisionInput,
  type CreateExperimentInput,
  type FinalizeCommercialExperimentInput,
  type LedgerEntryKind,
  type MonetaryValue,
  type PlanCommercialActionInput,
  type PublishCommercialEventInput,
  type RecordConsentInput,
  type RecordExperimentCostInput,
  type RecordExperimentMeasurementInput,
  type RecordSignalInput,
  type RegisterConnectorInput,
  type ReplayCommercialEventsOptions,
  type ReportActionResultInput,
  type ResourceRequirement,
  type RollbackStatus,
  type SetKillSwitchInput,
  type StopCommercialExperimentInput,
  type TransitionCommercialStateInput,
  type VerifyActionInput,
} from './types.js';

const COLLECTIONS = Object.freeze({
  decisions: 'commercial-control.decisions',
  authorizations: 'commercial-control.authorizations',
  actions: 'commercial-control.actions',
  ledger: 'commercial-control.action-ledger',
  policies: 'commercial-control.policies',
  budgets: 'commercial-control.budgets',
  approvals: 'commercial-control.approvals',
  productStates: 'commercial-control.product-states',
  campaignStates: 'commercial-control.campaign-states',
  transitions: 'commercial-control.state-transitions',
  killSwitches: 'commercial-control.kill-switches',
  connectors: 'commercial-control.connectors',
  consents: 'commercial-control.consents',
  signals: 'commercial-control.signals',
  experiments: 'commercial-control.experiments',
  experimentMeasurements: 'commercial-control.experiment-measurements',
  events: 'commercial-control.events',
  eventSequence: 'commercial-control.events-seq',
});

export interface CommercialControlPlaneServiceConfig {
  /** Injectable clock keeps policy, expiry, and budget tests deterministic. */
  now?: () => number;
}

export class CommercialControlPlaneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommercialControlPlaneError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

type LedgerInput = Omit<CommercialActionLedgerEntry, 'id' | 'sequence' | 'previousHash' | 'hash' | 'timestamp'> & {
  timestamp?: number;
};

/**
 * Stateful final authorization boundary for commercial actions.
 *
 * The service deliberately does not call third-party providers. An execution
 * worker may only act after this service produces an explicit authorization and
 * planned action. A reported provider response remains unverified until an
 * independent verification record is attached.
 */
export class CommercialControlPlaneService {
  private api!: KernelApi;
  private readonly clock: () => number;
  private decisions!: ICollection<CommercialDecision>;
  private authorizations!: ICollection<CommercialAuthorization>;
  private actions!: ICollection<CommercialAction>;
  private ledger!: ICollection<CommercialActionLedgerEntry>;
  /** T-01-I: per-tenant atomic sequence counter for the ledger. */
  private ledgerSequence!: ICollection<{ id: string; tenantId: string; sequence: number }>;
  private policies!: ICollection<AutonomyPolicy>;
  private budgets!: ICollection<CommercialBudget>;
  private approvals!: ICollection<ApprovalRequest>;
  private productStates!: ICollection<CommercialStateRecord>;
  private campaignStates!: ICollection<CommercialStateRecord>;
  private transitions!: ICollection<CommercialStateTransition>;
  private killSwitches!: ICollection<CommercialKillSwitch>;
  private connectors!: ICollection<ConnectorRecord>;
  private consents!: ICollection<ConsentRecord>;
  private signals!: ICollection<CommercialSignal>;
  private experiments!: ICollection<CommercialExperiment>;
  private experimentMeasurements!: ICollection<CommercialExperimentMeasurement>;
  private events!: ICollection<CommercialEvent>;
  /** F-01c: per-tenant atomic event-sequence counter (replaces count()+1). */
  private eventSequence!: ICollection<{ id: string; tenantId: string; sequence: number }>;
  /** F-01d: unified durable outbox bound to the service collections. */
  private unifiedOutbox!: UnifiedOutbox;
  /**
   * F-01c/F-01d: per-tenant in-process publish mutex. Serializes each
   * tenant's idempotency-check → sequence → persist → outbox critical
   * section so concurrent publishers in this process cannot interleave
   * check-then-act races (including the shared-driver absent-row
   * create-race). Bus delivery happens AFTER the lock is released, so a
   * subscriber that republishes can never self-deadlock. Cross-process
   * atomicity still rests on the storage driver's row-lock CAS.
   */
  private readonly publishMutex = createTenantMutex();

  constructor(config: CommercialControlPlaneServiceConfig = {}) {
    this.clock = config.now ?? (() => Date.now());
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule<StorageModule>('storage');
    this.decisions = await storage.collection<CommercialDecision>(COLLECTIONS.decisions);
    this.authorizations = await storage.collection<CommercialAuthorization>(COLLECTIONS.authorizations);
    this.actions = await storage.collection<CommercialAction>(COLLECTIONS.actions);
    this.ledger = await storage.collection<CommercialActionLedgerEntry>(COLLECTIONS.ledger);
    this.policies = await storage.collection<AutonomyPolicy>(COLLECTIONS.policies);
    this.budgets = await storage.collection<CommercialBudget>(COLLECTIONS.budgets);
    this.approvals = await storage.collection<ApprovalRequest>(COLLECTIONS.approvals);
    this.productStates = await storage.collection<CommercialStateRecord>(COLLECTIONS.productStates);
    this.campaignStates = await storage.collection<CommercialStateRecord>(COLLECTIONS.campaignStates);
    this.transitions = await storage.collection<CommercialStateTransition>(COLLECTIONS.transitions);
    this.killSwitches = await storage.collection<CommercialKillSwitch>(COLLECTIONS.killSwitches);
    this.connectors = await storage.collection<ConnectorRecord>(COLLECTIONS.connectors);
    this.consents = await storage.collection<ConsentRecord>(COLLECTIONS.consents);
    this.signals = await storage.collection<CommercialSignal>(COLLECTIONS.signals);
    this.experiments = await storage.collection<CommercialExperiment>(COLLECTIONS.experiments);
    this.experimentMeasurements = await storage.collection<CommercialExperimentMeasurement>(COLLECTIONS.experimentMeasurements);
    this.events = await storage.collection<CommercialEvent>(COLLECTIONS.events);
    this.eventSequence = await storage.collection<{ id: string; tenantId: string; sequence: number }>(COLLECTIONS.eventSequence);
    this.unifiedOutbox = new UnifiedOutbox(
      await storage.collection<UnifiedOutboxRecord>(UNIFIED_OUTBOX_COLLECTION),
      await storage.collection<{ id: string; tenantId: string; sequence: number }>(UNIFIED_OUTBOX_COUNTER_COLLECTION),
    );
    // T-01-I: per-tenant atomic sequence counter for the ledger.
    this.ledgerSequence = await storage.collection<{ id: string; tenantId: string; sequence: number }>('commercial-control-plane.ledger-seq');
  }

  // ---- Decision, policy, authorization ------------------------------------------------------

  async proposeDecision(actor: CommercialActor, input: CreateCommercialDecisionInput): Promise<CommercialDecision> {
    assertActor(actor);
    assertSameTenant(actor, input.tenantId);
    validateDecisionInput(input, this.now());
    const now = this.now();
    const id = randomUUID();
    const decision: CommercialDecision = {
      ...copy(input),
      id,
      resourceRequirements: normalizedDecisionResources(input),
      requiredApproval: input.requiredApproval ?? false,
      approvalState: input.requiredApproval ? 'PENDING' : 'NOT_REQUIRED',
      executionState: 'PROPOSED',
      alternativesConsidered: copy(input.alternativesConsidered ?? []),
      createdAt: now,
    };
    await this.decisions.put(decision);
    const auditReference = await this.appendLedger({
      kind: 'DECISION_PROPOSED',
      tenantId: decision.tenantId,
      decisionId: decision.id,
      actor: actor.id,
      agentId: actor.agentId,
      productId: decision.productId,
      campaignId: decision.campaignId,
      requestedAction: decision.proposedAction,
      auditReference: `decision:${decision.id}`,
      evidence: decision.evidence,
      payload: { actionType: decision.actionType, objective: decision.objective, authorizationLevel: decision.authorizationLevel },
    });
    await this.recordEvent(actor, {
      eventType: CommercialControlPlaneEvents.DecisionProposed,
      source: 'commercial-control-plane',
      entityId: decision.id,
      correlationId: decision.provenance.correlationId ?? decision.id,
      causationId: decision.provenance.causationId,
      payload: { decisionId: decision.id, actionType: decision.actionType, auditReference: auditReference.id },
      provenance: decision.provenance,
      privacyClassification: 'INTERNAL',
      idempotencyKey: `decision-proposed:${decision.id}`,
    });
    return copy(decision);
  }

  async getDecision(actor: CommercialActor, id: string): Promise<CommercialDecision | undefined> {
    const decision = await this.decisions.get(id);
    return decision && canReadTenant(actor, decision.tenantId) ? copy(decision) : undefined;
  }

  async listDecisions(actor: CommercialActor): Promise<CommercialDecision[]> {
    const all = await this.decisions.all();
    return all.filter((decision) => canReadTenant(actor, decision.tenantId)).map(copy);
  }

  async createPolicy(actor: CommercialActor, input: CreateAutonomyPolicyInput): Promise<AutonomyPolicy> {
    assertAdministrator(actor);
    validatePolicyInput(input, this.now());
    assertScopeAdministration(actor, input.scope);
    const now = this.now();
    const policy: AutonomyPolicy = {
      id: randomUUID(),
      version: input.version,
      scope: copy(input.scope),
      active: true,
      maximumAutonomyLevel: input.maximumAutonomyLevel,
      allowExecution: input.allowExecution ?? false,
      allowedActionTypes: input.allowedActionTypes ? [...input.allowedActionTypes] : undefined,
      deniedActionTypes: input.deniedActionTypes ? [...input.deniedActionTypes] : undefined,
      maximumRiskScore: input.maximumRiskScore,
      minimumComplianceScore: input.minimumComplianceScore,
      minimumEvidenceStrength: input.minimumEvidenceStrength,
      approvalRiskThreshold: input.approvalRiskThreshold,
      requireSimulation: input.requireSimulation,
      maximumSingleActionCost: input.maximumSingleActionCost ? copy(input.maximumSingleActionCost) : undefined,
      createdAt: now,
      updatedAt: now,
      expiresAt: input.expiresAt,
    };
    await this.policies.put(policy);
    const ledger = await this.appendLedger({
      kind: 'POLICY_CHANGED',
      tenantId: policy.scope.tenantId ?? actor.tenantId,
      actor: actor.id,
      auditReference: `policy:${policy.id}`,
      payload: { operation: 'policy_created', policyId: policy.id, version: policy.version, scope: policy.scope },
    });
    await this.recordEvent(actor, {
      eventType: CommercialControlPlaneEvents.PolicyChanged,
      source: 'commercial-control-plane',
      entityId: policy.id,
      correlationId: policy.id,
      payload: { policyId: policy.id, version: policy.version, auditReference: ledger.id },
      provenance: systemProvenance('commercial-control-plane', now, policy.id),
      privacyClassification: 'INTERNAL',
      idempotencyKey: `policy-created:${policy.id}`,
    });
    return copy(policy);
  }

  async listPolicies(actor: CommercialActor): Promise<AutonomyPolicy[]> {
    const all = await this.policies.all();
    return all
      .filter((policy) => policy.scope.tenantId === undefined ? isGlobalAdministrator(actor) : canReadTenant(actor, policy.scope.tenantId))
      .map(copy);
  }

  /** Tenant-filtered operational views used by the approval/command center. */
  async listAuthorizations(actor: CommercialActor): Promise<CommercialAuthorization[]> {
    return (await this.authorizations.all()).filter((authorization) => canReadTenant(actor, authorization.tenantId)).map(copy);
  }

  async listApprovals(actor: CommercialActor): Promise<ApprovalRequest[]> {
    return (await this.approvals.all()).filter((approval) => canReadTenant(actor, approval.tenantId)).map(copy);
  }

  async listBudgets(actor: CommercialActor): Promise<CommercialBudget[]> {
    return (await this.budgets.all()).filter((budget) => canReadTenant(actor, budget.tenantId)).map(copy);
  }

  async listKillSwitches(actor: CommercialActor): Promise<CommercialKillSwitch[]> {
    return (await this.killSwitches.all())
      .filter((killSwitch) => killSwitch.tenantId === undefined ? isGlobalAdministrator(actor) : canReadTenant(actor, killSwitch.tenantId))
      .map(copy);
  }

  async listConnectors(actor: CommercialActor): Promise<ConnectorRecord[]> {
    return (await this.connectors.all())
      .filter((connector) => connector.tenantId === undefined ? isGlobalAdministrator(actor) : canReadTenant(actor, connector.tenantId))
      .map(copy);
  }

  async listExperiments(actor: CommercialActor): Promise<CommercialExperiment[]> {
    return (await this.experiments.all()).filter((experiment) => canReadTenant(actor, experiment.tenantId)).map(copy);
  }

  async getExperiment(actor: CommercialActor, experimentId: string): Promise<CommercialExperiment | undefined> {
    const experiment = await this.experiments.get(experimentId);
    return experiment && canReadTenant(actor, experiment.tenantId) ? copy(experiment) : undefined;
  }

  async listExperimentMeasurements(actor: CommercialActor, experimentId: string): Promise<CommercialExperimentMeasurement[]> {
    await this.requireExperiment(actor, experimentId);
    return (await this.experimentMeasurements.query({ where: (measurement) => measurement.experimentId === experimentId, orderBy: 'observedAt', order: 'asc' })).map(copy);
  }

  async listSignals(actor: CommercialActor): Promise<CommercialSignal[]> {
    return (await this.signals.all()).filter((signal) => canReadTenant(actor, signal.tenantId)).map(copy);
  }

  /** Evaluate and persist a machine-readable authorization; execution remains a separate stage. */
  async authorizeDecision(actor: CommercialActor, decisionId: string): Promise<CommercialAuthorization> {
    const decision = await this.requireDecision(actor, decisionId);
    const now = this.now();
    const checks: AuthorizationCheck[] = [];
    let outcome: AuthorizationOutcome = 'ALLOW';
    let reasons: string[] = [];
    let requiredApproval = decision.requiredApproval;
    let simulationOnly = false;
    let policy: AutonomyPolicy | undefined;

    if (decision.expiresAt !== undefined && decision.expiresAt <= now) {
      checks.push({ name: 'expiry', passed: false, detail: 'Decision has expired.' });
      outcome = 'DENY';
      reasons = ['Decision has expired.'];
    } else {
      checks.push({ name: 'expiry', passed: true, detail: 'Decision is within its validity window.' });
    }

    if (outcome !== 'DENY') {
      const switches = (await this.killSwitches.all()).filter((item) => item.active && this.killSwitchApplies(item, decision, actor));
      if (switches.length > 0) {
        checks.push({ name: 'kill_switch', passed: false, detail: `Active kill switch(es): ${switches.map((item) => item.id).join(', ')}.` });
        outcome = 'DENY';
        reasons.push('A matching commercial kill switch is active.');
      } else {
        checks.push({ name: 'kill_switch', passed: true, detail: 'No matching active kill switch.' });
      }
    }

    if (outcome !== 'DENY') {
      policy = selectPolicy(await this.policies.all(), decision, now);
      const evaluation = evaluatePolicy(policy, decision);
      outcome = evaluation.outcome;
      reasons.push(...evaluation.reasons);
      requiredApproval = requiredApproval || evaluation.requiresApproval;
      simulationOnly = evaluation.simulationOnly;
      checks.push({ name: 'policy', passed: outcome !== 'DENY', detail: evaluation.reasons.join(' ') });
      checks.push({ name: 'risk', passed: outcome !== 'DENY', detail: `Risk score evaluated: ${decision.riskScore}.` });
      checks.push({ name: 'compliance', passed: outcome !== 'DENY', detail: `Compliance score evaluated: ${decision.complianceScore}.` });
      checks.push({ name: 'evidence', passed: outcome !== 'WAIT' && outcome !== 'DENY', detail: `Evidence strength evaluated: ${decision.evidenceStrength}.` });

      if (policy?.maximumSingleActionCost && decision.estimatedCost) {
        const limit = policy.maximumSingleActionCost;
        if (limit.currency !== decision.estimatedCost.currency || decision.estimatedCost.amount > limit.amount) {
          outcome = 'DENY';
          reasons.push('Estimated action cost exceeds the matching policy single-action limit.');
        }
      }
    }

    if (outcome !== 'DENY') {
      const connector = await this.connectorForDecision(decision);
      if (decision.connectorId) {
        if (!connector) {
          outcome = 'DENY';
          checks.push({ name: 'connector', passed: false, detail: `Connector ${decision.connectorId} is not registered for this tenant.` });
          reasons.push('Requested connector is not registered.');
        } else if (connector.health !== 'HEALTHY') {
          outcome = connector.health === 'DEGRADED' || connector.health === 'RATE_LIMITED' ? 'WAIT' : 'DENY';
          checks.push({ name: 'connector', passed: false, detail: `Connector health is ${connector.health}.` });
          reasons.push(`Connector health prevents execution: ${connector.health}.`);
        } else if (!connector.supportedActions.includes(decision.actionType)) {
          outcome = 'DENY';
          checks.push({ name: 'connector', passed: false, detail: `Connector does not declare action ${decision.actionType}.` });
          reasons.push('Connector capability does not support the requested action.');
        } else {
          checks.push({ name: 'connector', passed: true, detail: 'Connector is healthy and declares the requested action.' });
        }
      } else {
        checks.push({ name: 'connector', passed: true, detail: 'No external connector was requested.' });
      }
    }

    if (outcome !== 'DENY') {
      if (decision.communication) {
        const consent = await this.activeConsent(decision.tenantId, decision.communication.subjectId, decision.communication.channel, decision.communication.purpose, now);
        if (!consent) {
          outcome = 'DENY';
          checks.push({ name: 'consent', passed: false, detail: 'No active consent exists for the requested communication purpose.' });
          reasons.push('Communication consent is absent, revoked, denied, or expired.');
        } else {
          checks.push({ name: 'consent', passed: true, detail: `Active consent ${consent.id} permits the communication.` });
        }
      } else {
        checks.push({ name: 'consent', passed: true, detail: 'Decision does not request a consent-governed communication.' });
      }
    }

    const budgetChecks = outcome === 'DENY' ? [] : await this.evaluateBudgets(decision, now);
    if (budgetChecks.some((check) => !check.allowed)) {
      outcome = 'DENY';
      reasons.push('One or more commercial resource budgets would be exceeded.');
    }
    checks.push({
      name: 'budget',
      passed: budgetChecks.every((check) => check.allowed),
      detail: budgetChecks.length === 0 ? 'No matching budget applies.' : `${budgetChecks.length} matching budget(s) evaluated.`,
    });

    let approvalState = decision.approvalState;
    if (outcome !== 'DENY' && requiredApproval) {
      if (approvalState === 'REJECTED') {
        outcome = 'DENY';
        checks.push({ name: 'approval', passed: false, detail: 'Required approval was rejected.' });
        reasons.push('Required approval was rejected.');
      } else if (approvalState !== 'APPROVED') {
        const request = await this.ensureApprovalRequest(actor, decision, reasons.join(' ') || 'Approval required by commercial policy.');
        approvalState = request.state;
        outcome = 'HUMAN_APPROVAL_REQUIRED';
        checks.push({ name: 'approval', passed: false, detail: `Approval request ${request.id} is ${request.state}.` });
      } else {
        checks.push({ name: 'approval', passed: true, detail: 'Required approval is present.' });
        outcome = simulationOnly ? 'TEST' : 'ALLOW';
      }
    } else {
      checks.push({ name: 'approval', passed: true, detail: 'No approval is required.' });
    }

    const authorization: CommercialAuthorization = {
      id: randomUUID(),
      tenantId: decision.tenantId,
      decisionId: decision.id,
      outcome,
      allowed: outcome === 'ALLOW' || outcome === 'TEST',
      policyId: policy?.id,
      policyVersion: policy?.version,
      evaluatedAt: now,
      expiresAt: decision.expiresAt,
      requiredApproval,
      approvalState,
      simulationOnly,
      checks,
      budgetChecks,
      reasons: unique(reasons.length > 0 ? reasons : ['All authorization checks passed.']),
    };
    await this.authorizations.put(authorization);

    const nextState = authorizationToDecisionState(authorization.outcome);
    const updatedDecision: CommercialDecision = {
      ...decision,
      requiredApproval,
      approvalState,
      executionState: nextState,
    };
    await this.decisions.put(updatedDecision);
    const ledger = await this.appendLedger({
      kind: 'AUTHORIZATION_EVALUATED',
      tenantId: decision.tenantId,
      decisionId: decision.id,
      actor: actor.id,
      agentId: actor.agentId,
      productId: decision.productId,
      campaignId: decision.campaignId,
      authorization: authorization.outcome,
      auditReference: `authorization:${authorization.id}`,
      payload: { authorizationId: authorization.id, checks: authorization.checks, budgetChecks: authorization.budgetChecks },
    });
    await this.recordEvent(actor, {
      eventType: CommercialControlPlaneEvents.DecisionAuthorized,
      source: 'commercial-control-plane',
      entityId: decision.id,
      correlationId: decision.provenance.correlationId ?? decision.id,
      causationId: decision.provenance.causationId,
      payload: { decisionId: decision.id, authorizationId: authorization.id, outcome, auditReference: ledger.id },
      provenance: decision.provenance,
      privacyClassification: 'INTERNAL',
      idempotencyKey: `authorization:${authorization.id}`,
    });
    return copy(authorization);
  }

  async requestApproval(actor: CommercialActor, decisionId: string, reason: string): Promise<ApprovalRequest> {
    const decision = await this.requireDecision(actor, decisionId);
    return copy(await this.ensureApprovalRequest(actor, decision, reason));
  }

  async resolveApproval(
    actor: CommercialActor,
    approvalId: string,
    state: Extract<ApprovalState, 'APPROVED' | 'REJECTED' | 'DEFERRED'>,
    reason: string,
  ): Promise<ApprovalRequest> {
    assertApprover(actor);
    assertNonBlank(reason, 'Approval resolution reason');
    const approval = await this.approvals.get(approvalId);
    if (!approval || !canReadTenant(actor, approval.tenantId)) throw new CommercialControlPlaneError('Approval request not found.');
    if (approval.state !== 'PENDING') throw new CommercialControlPlaneError(`Approval request is already ${approval.state}.`);
    if (approval.requestedBy === actor.id && !isGlobalAdministrator(actor)) {
      throw new CommercialControlPlaneError('A requester cannot approve their own commercial decision.');
    }
    const now = this.now();
    const updated: ApprovalRequest = {
      ...approval,
      state,
      resolvedBy: actor.id,
      resolvedAt: now,
      resolutionReason: reason,
    };
    await this.approvals.put(updated);
    const decision = await this.decisions.get(approval.decisionId);
    if (decision) {
      await this.decisions.put({
        ...decision,
        approvalState: state,
        executionState: state === 'APPROVED' ? 'AUTHORIZING' : state === 'REJECTED' ? 'DENIED' : 'WAITING_FOR_APPROVAL',
      });
    }
    const ledger = await this.appendLedger({
      kind: 'APPROVAL_RESOLVED',
      tenantId: approval.tenantId,
      decisionId: approval.decisionId,
      actor: actor.id,
      authorization: state === 'APPROVED' ? 'ALLOW' : state === 'REJECTED' ? 'DENY' : 'WAIT',
      auditReference: `approval:${approval.id}`,
      payload: { approvalId: approval.id, state, reason },
    });
    await this.recordEvent(actor, {
      eventType: CommercialControlPlaneEvents.ApprovalResolved,
      source: 'commercial-control-plane',
      entityId: approval.decisionId,
      correlationId: approval.decisionId,
      payload: { approvalId: approval.id, decisionId: approval.decisionId, state, auditReference: ledger.id },
      provenance: systemProvenance('commercial-control-plane', now, approval.decisionId),
      privacyClassification: 'INTERNAL',
      idempotencyKey: `approval-resolved:${approval.id}`,
    });
    return copy(updated);
  }

  // ---- Action lifecycle ----------------------------------------------------------------------

  async planAction(actor: CommercialActor, decisionId: string, input: PlanCommercialActionInput): Promise<CommercialAction> {
    assertExecutionActor(actor);
    const decision = await this.requireDecision(actor, decisionId);
    validatePlanActionInput(input);
    const existing = await this.actions.query({
      where: (action) => action.tenantId === actor.tenantId && action.idempotencyKey === input.idempotencyKey,
      limit: 1,
    });
    if (existing[0]) return copy(existing[0]);

    const authorization = await this.authorizeDecision(actor, decisionId);
    if (!authorization.allowed) {
      throw new CommercialControlPlaneError(`Action cannot be planned: authorization outcome is ${authorization.outcome}.`);
    }
    const dryRun = input.dryRun ?? true;
    if (!dryRun && authorization.simulationOnly) {
      throw new CommercialControlPlaneError('The matching policy permits simulation only; real execution is not authorized.');
    }

    const now = this.now();
    const action: CommercialAction = {
      id: randomUUID(),
      tenantId: decision.tenantId,
      ventureId: decision.ventureId,
      productId: decision.productId,
      campaignId: decision.campaignId,
      decisionId: decision.id,
      actionType: decision.actionType,
      actor: actor.id,
      agentId: actor.agentId,
      modelId: actor.modelId ?? decision.model?.id,
      targetSystem: input.targetSystem,
      targetResource: input.targetResource,
      parameters: copy(input.parameters ?? {}),
      authorization,
      riskLevel: decision.riskScore,
      policyResult: authorization.outcome,
      approvalRequirement: authorization.requiredApproval,
      approvalStatus: authorization.approvalState,
      resourceRequirements: copy(input.resourceRequirements ?? decision.resourceRequirements),
      resourceConsumption: [],
      executionStatus: 'QUEUED',
      attemptCount: 0,
      verificationStatus: 'PENDING',
      verificationEvidence: [],
      rollbackStrategy: input.rollbackStrategy,
      rollbackStatus: input.rollbackStrategy ? 'NOT_REQUESTED' : 'NOT_SUPPORTED',
      auditReference: `action:${decision.id}`,
      idempotencyKey: input.idempotencyKey,
      dryRun,
      createdAt: now,
      updatedAt: now,
      correlationId: decision.provenance.correlationId ?? decision.id,
    };
    await this.actions.put(action);
    await this.decisions.put({ ...decision, executionState: 'QUEUED' });
    const ledger = await this.appendLedger({
      kind: 'ACTION_QUEUED',
      tenantId: action.tenantId,
      decisionId: action.decisionId,
      actionId: action.id,
      actor: actor.id,
      agentId: action.agentId,
      productId: action.productId,
      campaignId: action.campaignId,
      authorization: authorization.outcome,
      requestedAction: action.actionType,
      resourceConsumption: action.resourceRequirements,
      auditReference: action.auditReference,
      payload: { targetSystem: action.targetSystem, targetResource: action.targetResource, dryRun: action.dryRun },
    });
    await this.recordEvent(actor, {
      eventType: CommercialControlPlaneEvents.ActionQueued,
      source: 'commercial-control-plane',
      entityId: action.id,
      correlationId: action.correlationId,
      causationId: action.decisionId,
      payload: { actionId: action.id, decisionId: action.decisionId, dryRun: action.dryRun, auditReference: ledger.id },
      provenance: decision.provenance,
      privacyClassification: 'INTERNAL',
      idempotencyKey: `action-queued:${action.id}`,
    });
    return copy(action);
  }

  async startAction(actor: CommercialActor, actionId: string): Promise<CommercialAction> {
    assertExecutionActor(actor);
    const action = await this.requireAction(actor, actionId);
    if (action.executionStatus !== 'QUEUED' && action.executionStatus !== 'RETRYING') {
      throw new CommercialControlPlaneError(`Action ${action.id} cannot start from ${action.executionStatus}.`);
    }
    const decision = await this.requireDecision(actor, action.decisionId);
    const switches = (await this.killSwitches.all()).filter((item) => item.active && this.killSwitchApplies(item, decision, actor));
    if (switches.length > 0) {
      return this.blockAction(actor, action, `Active kill switch(es): ${switches.map((item) => item.id).join(', ')}.`);
    }
    const now = this.now();
    const updated: CommercialAction = {
      ...action,
      executionStatus: 'EXECUTING',
      attemptCount: action.attemptCount + 1,
      startedAt: now,
      updatedAt: now,
    };
    await this.actions.put(updated);
    await this.decisions.put({ ...decision, executionState: 'EXECUTING' });
    const ledger = await this.appendLedger({
      kind: 'ACTION_STARTED',
      tenantId: updated.tenantId,
      decisionId: updated.decisionId,
      actionId: updated.id,
      actor: actor.id,
      agentId: updated.agentId,
      productId: updated.productId,
      campaignId: updated.campaignId,
      authorization: updated.policyResult,
      requestedAction: updated.actionType,
      auditReference: updated.auditReference,
      payload: { attempt: updated.attemptCount, dryRun: updated.dryRun },
    });
    await this.recordEvent(actor, {
      eventType: CommercialControlPlaneEvents.ActionStarted,
      source: 'commercial-control-plane',
      entityId: updated.id,
      correlationId: updated.correlationId,
      causationId: updated.decisionId,
      payload: { actionId: updated.id, attempt: updated.attemptCount, auditReference: ledger.id },
      provenance: systemProvenance('commercial-control-plane', now, updated.correlationId),
      privacyClassification: 'INTERNAL',
      idempotencyKey: `action-started:${updated.id}:${updated.attemptCount}`,
    });
    return copy(updated);
  }

  /** Report an executor/provider response. A positive response moves to VERIFYING, never COMPLETED. */
  async reportActionResult(actor: CommercialActor, actionId: string, input: ReportActionResultInput): Promise<CommercialAction> {
    assertExecutionActor(actor);
    validateActionResult(input);
    const action = await this.requireAction(actor, actionId);
    if (action.executionStatus !== 'EXECUTING') {
      throw new CommercialControlPlaneError(`Action ${action.id} cannot accept a result from ${action.executionStatus}.`);
    }
    const now = this.now();
    const result = {
      reportedSuccess: input.reportedSuccess,
      summary: input.summary,
      externalResponse: copy(input.externalResponse ?? {}),
      internalState: copy(input.internalState ?? {}),
      recordedAt: now,
    };
    const updated: CommercialAction = {
      ...action,
      resourceConsumption: copy(input.resourceConsumption ?? action.resourceConsumption),
      financialCost: input.financialCost ? copy(input.financialCost) : action.financialCost,
      result,
      executionStatus: input.reportedSuccess ? 'VERIFYING' : 'FAILED',
      verificationStatus: input.reportedSuccess ? 'PENDING' : 'FAILED',
      completedAt: input.reportedSuccess ? undefined : now,
      error: input.reportedSuccess ? undefined : input.summary ?? 'Executor reported failure.',
      updatedAt: now,
    };
    await this.actions.put(updated);
    const decision = await this.requireDecision(actor, updated.decisionId);
    await this.decisions.put({ ...decision, executionState: input.reportedSuccess ? 'VERIFYING' : 'FAILED' });
    const ledger = await this.appendLedger({
      kind: input.reportedSuccess ? 'ACTION_RESULT_REPORTED' : 'ACTION_FAILED',
      tenantId: updated.tenantId,
      decisionId: updated.decisionId,
      actionId: updated.id,
      actor: actor.id,
      agentId: updated.agentId,
      productId: updated.productId,
      campaignId: updated.campaignId,
      requestedAction: updated.actionType,
      actualAction: updated.actionType,
      resourceConsumption: updated.resourceConsumption,
      financialCost: updated.financialCost,
      externalResponse: result.externalResponse,
      result: { reportedSuccess: input.reportedSuccess, summary: input.summary },
      failureReason: updated.error,
      auditReference: updated.auditReference,
      payload: { verificationRequired: input.reportedSuccess },
    });
    await this.recordEvent(actor, {
      eventType: input.reportedSuccess ? CommercialControlPlaneEvents.ActionResultReported : CommercialControlPlaneEvents.ActionFailed,
      source: 'commercial-control-plane',
      entityId: updated.id,
      correlationId: updated.correlationId,
      causationId: updated.decisionId,
      payload: { actionId: updated.id, reportedSuccess: input.reportedSuccess, auditReference: ledger.id },
      provenance: systemProvenance('commercial-control-plane', now, updated.correlationId),
      privacyClassification: 'INTERNAL',
      idempotencyKey: `action-result:${updated.id}:${updated.attemptCount}`,
    });
    return copy(updated);
  }

  /** Verification is the only path from a successful reported response to COMPLETED. */
  async verifyAction(actor: CommercialActor, actionId: string, input: VerifyActionInput): Promise<CommercialAction> {
    assertExecutionActor(actor);
    validateVerification(input);
    const action = await this.requireAction(actor, actionId);
    if (action.executionStatus !== 'VERIFYING') {
      throw new CommercialControlPlaneError(`Action ${action.id} cannot be verified from ${action.executionStatus}.`);
    }
    const now = this.now();
    const updated: CommercialAction = {
      ...action,
      verificationEvidence: copy(input.evidence),
      executionStatus: input.verified ? 'COMPLETED' : 'FAILED',
      verificationStatus: input.verified ? 'VERIFIED' : 'FAILED',
      completedAt: now,
      error: input.verified ? undefined : input.summary ?? 'Independent verification failed.',
      result: action.result
        ? { ...action.result, summary: input.summary ?? action.result.summary, internalState: copy(input.externalState ?? action.result.internalState ?? {}) }
        : undefined,
      updatedAt: now,
    };
    await this.actions.put(updated);
    const decision = await this.requireDecision(actor, updated.decisionId);
    await this.decisions.put({ ...decision, executionState: input.verified ? 'COMPLETED' : 'FAILED' });
    const ledger = await this.appendLedger({
      kind: input.verified ? 'ACTION_VERIFIED' : 'ACTION_FAILED',
      tenantId: updated.tenantId,
      decisionId: updated.decisionId,
      actionId: updated.id,
      actor: actor.id,
      agentId: updated.agentId,
      productId: updated.productId,
      campaignId: updated.campaignId,
      actualAction: updated.actionType,
      financialCost: updated.financialCost,
      result: { verified: input.verified, summary: input.summary },
      failureReason: updated.error,
      evidence: updated.verificationEvidence,
      auditReference: updated.auditReference,
      payload: { externalState: input.externalState ?? {} },
    });
    await this.recordEvent(actor, {
      eventType: input.verified ? CommercialControlPlaneEvents.ActionVerified : CommercialControlPlaneEvents.ActionFailed,
      source: 'commercial-control-plane',
      entityId: updated.id,
      correlationId: updated.correlationId,
      causationId: updated.decisionId,
      payload: { actionId: updated.id, verified: input.verified, auditReference: ledger.id },
      provenance: systemProvenance('commercial-control-plane', now, updated.correlationId),
      privacyClassification: 'INTERNAL',
      idempotencyKey: `action-verified:${updated.id}:${updated.attemptCount}`,
    });
    return copy(updated);
  }

  async retryAction(actor: CommercialActor, actionId: string, reason: string): Promise<CommercialAction> {
    assertExecutionActor(actor);
    assertNonBlank(reason, 'Retry reason');
    const action = await this.requireAction(actor, actionId);
    if (action.executionStatus !== 'FAILED') throw new CommercialControlPlaneError('Only failed actions can be retried.');
    const updated: CommercialAction = { ...action, executionStatus: 'RETRYING', error: undefined, updatedAt: this.now() };
    await this.actions.put(updated);
    await this.appendLedger({
      kind: 'ACTION_RESULT_REPORTED', tenantId: updated.tenantId, decisionId: updated.decisionId, actionId: updated.id,
      actor: actor.id, auditReference: updated.auditReference, payload: { operation: 'retry_queued', reason },
    });
    return copy(updated);
  }

  /** Records only a confirmed rollback result; this method never performs external reversal itself. */
  async recordRollback(actor: CommercialActor, actionId: string, confirmed: boolean, reason: string): Promise<CommercialAction> {
    assertExecutionActor(actor);
    assertNonBlank(reason, 'Rollback reason');
    const action = await this.requireAction(actor, actionId);
    if (action.rollbackStatus === 'NOT_SUPPORTED') throw new CommercialControlPlaneError('No rollback strategy was registered for this action.');
    const now = this.now();
    const rollbackStatus: RollbackStatus = confirmed ? 'VERIFIED' : 'FAILED';
    const updated: CommercialAction = {
      ...action,
      executionStatus: confirmed ? 'ROLLED_BACK' : 'ESCALATED',
      rollbackStatus,
      updatedAt: now,
      error: confirmed ? action.error : `${action.error ? `${action.error}; ` : ''}Rollback was not externally confirmed: ${reason}`,
    };
    await this.actions.put(updated);
    const ledger = await this.appendLedger({
      kind: 'ACTION_ROLLBACK_RECORDED', tenantId: updated.tenantId, decisionId: updated.decisionId, actionId: updated.id,
      actor: actor.id, actualAction: updated.actionType, rollbackState: rollbackStatus, auditReference: updated.auditReference,
      payload: { confirmed, reason },
    });
    await this.recordEvent(actor, {
      eventType: CommercialControlPlaneEvents.ActionFailed,
      source: 'commercial-control-plane', entityId: updated.id, correlationId: updated.correlationId, causationId: updated.decisionId,
      payload: { actionId: updated.id, rollbackStatus, auditReference: ledger.id },
      provenance: systemProvenance('commercial-control-plane', now, updated.correlationId), privacyClassification: 'INTERNAL',
      idempotencyKey: `action-rollback:${updated.id}:${rollbackStatus}`,
    });
    return copy(updated);
  }

  async cancelAction(actor: CommercialActor, actionId: string, reason: string): Promise<CommercialAction> {
    assertExecutionActor(actor);
    assertNonBlank(reason, 'Cancellation reason');
    const action = await this.requireAction(actor, actionId);
    if (!['PROPOSED', 'QUEUED', 'RETRYING', 'APPROVAL_REQUIRED'].includes(action.executionStatus)) {
      throw new CommercialControlPlaneError(`Action ${action.id} cannot be cancelled from ${action.executionStatus}.`);
    }
    const now = this.now();
    const updated: CommercialAction = { ...action, executionStatus: 'CANCELLED', error: reason, updatedAt: now, completedAt: now };
    await this.actions.put(updated);
    const ledger = await this.appendLedger({
      kind: 'ACTION_FAILED', tenantId: updated.tenantId, decisionId: updated.decisionId, actionId: updated.id,
      actor: actor.id, failureReason: reason, auditReference: updated.auditReference, payload: { state: 'CANCELLED' },
    });
    await this.recordEvent(actor, {
      eventType: CommercialControlPlaneEvents.ActionFailed,
      source: 'commercial-control-plane', entityId: updated.id, correlationId: updated.correlationId, causationId: updated.decisionId,
      payload: { actionId: updated.id, state: 'CANCELLED', auditReference: ledger.id },
      provenance: systemProvenance('commercial-control-plane', now, updated.correlationId), privacyClassification: 'INTERNAL',
      idempotencyKey: `action-cancelled:${updated.id}`,
    });
    return copy(updated);
  }

  async getAction(actor: CommercialActor, id: string): Promise<CommercialAction | undefined> {
    const action = await this.actions.get(id);
    return action && canReadTenant(actor, action.tenantId) ? copy(action) : undefined;
  }

  async listActions(actor: CommercialActor): Promise<CommercialAction[]> {
    return (await this.actions.all()).filter((action) => canReadTenant(actor, action.tenantId)).map(copy);
  }

  async verifyLedgerIntegrity(actor: CommercialActor, tenantId = actor.tenantId): Promise<{ valid: boolean; entries: number; brokenAt?: number; reason?: string }> {
    assertSameTenant(actor, tenantId);
    const entries = (await this.ledger.query({ where: (entry) => entry.tenantId === tenantId, orderBy: 'sequence', order: 'asc' }));
    let previousHash = 'GENESIS';
    let previousSequence = 0;
    for (const entry of entries) {
      if (entry.sequence !== previousSequence + 1) return { valid: false, entries: entries.length, brokenAt: entry.sequence, reason: 'Ledger sequence is discontinuous.' };
      if (entry.previousHash !== previousHash) return { valid: false, entries: entries.length, brokenAt: entry.sequence, reason: 'Ledger previous hash does not match.' };
      const computed = hashLedgerEntry({ ...entry, hash: '' });
      if (entry.hash !== computed) return { valid: false, entries: entries.length, brokenAt: entry.sequence, reason: 'Ledger hash does not match its canonical payload.' };
      previousHash = entry.hash;
      previousSequence = entry.sequence;
    }
    return { valid: true, entries: entries.length };
  }

  // ---- Product and campaign lifecycle --------------------------------------------------------

  async initializeProduct(actor: CommercialActor, productId: string, ventureId?: string): Promise<CommercialStateRecord> {
    assertCommercialManager(actor);
    assertNonBlank(productId, 'Product id');
    const id = stateRecordId(actor.tenantId, 'PRODUCT', productId);
    const existing = await this.productStates.get(id);
    if (existing) return copy(existing);
    const record: CommercialStateRecord = { id, tenantId: actor.tenantId, kind: 'PRODUCT', entityId: productId, productId, state: 'IDEA', updatedAt: this.now() };
    await this.productStates.put(record);
    await this.appendLedger({ kind: 'STATE_TRANSITION', tenantId: actor.tenantId, actor: actor.id, productId, auditReference: `state:${id}`, payload: { operation: 'initialized', ventureId, state: 'IDEA' } });
    return copy(record);
  }

  async initializeCampaign(actor: CommercialActor, campaignId: string, productId: string): Promise<CommercialStateRecord> {
    assertCommercialManager(actor);
    assertNonBlank(campaignId, 'Campaign id');
    assertNonBlank(productId, 'Product id');
    const id = stateRecordId(actor.tenantId, 'CAMPAIGN', campaignId);
    const existing = await this.campaignStates.get(id);
    if (existing) return copy(existing);
    const record: CommercialStateRecord = { id, tenantId: actor.tenantId, kind: 'CAMPAIGN', entityId: campaignId, campaignId, productId, state: 'DRAFT', updatedAt: this.now() };
    await this.campaignStates.put(record);
    await this.appendLedger({ kind: 'STATE_TRANSITION', tenantId: actor.tenantId, actor: actor.id, productId, campaignId, auditReference: `state:${id}`, payload: { operation: 'initialized', state: 'DRAFT' } });
    return copy(record);
  }

  async transitionProduct(actor: CommercialActor, productId: string, input: TransitionCommercialStateInput): Promise<CommercialStateTransition> {
    const current = await this.initializeProduct(actor, productId);
    if (!isProductState(input.newState)) throw new CommercialControlPlaneError(`Invalid product commercial state: ${input.newState}.`);
    assertProductTransition(current.state as ProductState, input.newState);
    return this.applyTransition(actor, current, input);
  }

  async transitionCampaign(actor: CommercialActor, campaignId: string, productId: string, input: TransitionCommercialStateInput): Promise<CommercialStateTransition> {
    const current = await this.initializeCampaign(actor, campaignId, productId);
    if (!isCampaignState(input.newState)) throw new CommercialControlPlaneError(`Invalid campaign state: ${input.newState}.`);
    assertCampaignTransition(current.state as CampaignState, input.newState);
    return this.applyTransition(actor, current, input);
  }

  async getProductState(actor: CommercialActor, productId: string): Promise<CommercialStateRecord | undefined> {
    const record = await this.productStates.get(stateRecordId(actor.tenantId, 'PRODUCT', productId));
    return record && canReadTenant(actor, record.tenantId) ? copy(record) : undefined;
  }

  async getCampaignState(actor: CommercialActor, campaignId: string): Promise<CommercialStateRecord | undefined> {
    const record = await this.campaignStates.get(stateRecordId(actor.tenantId, 'CAMPAIGN', campaignId));
    return record && canReadTenant(actor, record.tenantId) ? copy(record) : undefined;
  }

  // ---- Budget, experiment, connector, consent, signal, and event control -------------------

  async createBudget(actor: CommercialActor, input: CreateCommercialBudgetInput): Promise<CommercialBudget> {
    assertAdministrator(actor);
    validateBudgetInput(input);
    assertScopeAdministration(actor, input.scope);
    const now = this.now();
    const budget: CommercialBudget = {
      id: randomUUID(), tenantId: input.scope.tenantId ?? actor.tenantId, scope: { ...copy(input.scope), tenantId: input.scope.tenantId ?? actor.tenantId },
      resourceType: input.resourceType, period: input.period, limit: input.limit, unit: input.unit, currency: input.currency,
      active: input.active ?? true, createdAt: now, updatedAt: now,
    };
    await this.budgets.put(budget);
    const ledger = await this.appendLedger({ kind: 'BUDGET_CHANGED', tenantId: budget.tenantId, actor: actor.id, auditReference: `budget:${budget.id}`, payload: { operation: 'created', budgetId: budget.id, resourceType: budget.resourceType, limit: budget.limit, period: budget.period } });
    await this.recordEvent(actor, { eventType: CommercialControlPlaneEvents.BudgetChanged, source: 'commercial-control-plane', entityId: budget.id, correlationId: budget.id, payload: { budgetId: budget.id, auditReference: ledger.id }, provenance: systemProvenance('commercial-control-plane', now, budget.id), privacyClassification: 'INTERNAL', idempotencyKey: `budget-created:${budget.id}` });
    return copy(budget);
  }

  async setKillSwitch(actor: CommercialActor, input: SetKillSwitchInput): Promise<CommercialKillSwitch> {
    assertAdministrator(actor);
    assertNonBlank(input.reason, 'Kill switch reason');
    assertScopeAdministration(actor, input.scope);
    const now = this.now();
    const existing = (await this.killSwitches.query({ where: (item) => item.scopeType === input.scopeType && stableStringify(item.scope) === stableStringify(input.scope), limit: 1 }))[0];
    const switchRecord: CommercialKillSwitch = existing
      ? {
          ...existing,
          active: input.active,
          reason: input.reason,
          activatedBy: input.active ? actor.id : existing.activatedBy,
          activatedAt: input.active ? now : existing.activatedAt,
          deactivatedBy: input.active ? undefined : actor.id,
          deactivatedAt: input.active ? undefined : now,
        }
      : {
          id: randomUUID(), tenantId: input.scope.tenantId ?? actor.tenantId, scopeType: input.scopeType, scope: copy(input.scope),
          active: input.active, reason: input.reason, activatedBy: actor.id, activatedAt: now,
        };
    await this.killSwitches.put(switchRecord);
    const ledger = await this.appendLedger({ kind: 'KILL_SWITCH_CHANGED', tenantId: switchRecord.tenantId ?? actor.tenantId, actor: actor.id, auditReference: `kill-switch:${switchRecord.id}`, payload: { killSwitchId: switchRecord.id, active: switchRecord.active, scopeType: switchRecord.scopeType, reason: switchRecord.reason } });
    await this.recordEvent(actor, { eventType: CommercialControlPlaneEvents.KillSwitchChanged, source: 'commercial-control-plane', entityId: switchRecord.id, correlationId: switchRecord.id, payload: { killSwitchId: switchRecord.id, active: switchRecord.active, auditReference: ledger.id }, provenance: systemProvenance('commercial-control-plane', now, switchRecord.id), privacyClassification: 'RESTRICTED', idempotencyKey: `kill-switch:${switchRecord.id}:${switchRecord.active}` });
    return copy(switchRecord);
  }

  async registerConnector(actor: CommercialActor, input: RegisterConnectorInput): Promise<ConnectorRecord> {
    assertAdministrator(actor);
    assertNonBlank(input.providerId, 'Provider id');
    assertNonBlank(input.providerType, 'Provider type');
    if (input.tenantId && input.tenantId !== actor.tenantId && !isGlobalAdministrator(actor)) throw new CommercialControlPlaneError('Only a global administrator may register a connector for another tenant.');
    const now = this.now();
    const record: ConnectorRecord = {
      id: randomUUID(), providerId: input.providerId, providerType: input.providerType, tenantId: input.tenantId ?? actor.tenantId,
      supportedActions: [...input.supportedActions], authenticationMethod: input.authenticationMethod, requiredPermissions: [...input.requiredPermissions],
      rateLimits: input.rateLimits ? copy(input.rateLimits) : undefined, costModel: input.costModel, regions: input.regions ? [...input.regions] : undefined,
      availability: input.availability, rollbackSupport: input.rollbackSupport, webhookSupport: input.webhookSupport,
      sandboxSupport: input.sandboxSupport, productionSupport: input.productionSupport, lastVerifiedAt: input.lastVerifiedAt,
      health: input.health ?? 'DISABLED', healthReason: input.healthReason, updatedAt: now,
    };
    await this.connectors.put(record);
    return copy(record);
  }

  async updateConnectorHealth(actor: CommercialActor, connectorId: string, health: ConnectorHealth, reason?: string): Promise<ConnectorRecord> {
    assertCommercialManager(actor);
    const connector = await this.connectors.get(connectorId);
    if (!connector || (connector.tenantId && !canReadTenant(actor, connector.tenantId))) throw new CommercialControlPlaneError('Connector not found.');
    const updated: ConnectorRecord = { ...connector, health, healthReason: reason, updatedAt: this.now(), lastVerifiedAt: health === 'HEALTHY' ? this.now() : connector.lastVerifiedAt };
    await this.connectors.put(updated);
    await this.recordEvent(actor, { eventType: CommercialControlPlaneEvents.ConnectorHealthChanged, source: 'commercial-control-plane', entityId: updated.id, correlationId: updated.id, payload: { connectorId: updated.id, health: updated.health, reason }, provenance: systemProvenance('commercial-control-plane', this.now(), updated.id), privacyClassification: 'INTERNAL', idempotencyKey: `connector-health:${updated.id}:${updated.updatedAt}` });
    return copy(updated);
  }

  async recordConsent(actor: CommercialActor, input: RecordConsentInput): Promise<ConsentRecord> {
    assertCommercialManager(actor);
    assertNonBlank(input.subjectId, 'Consent subject');
    assertNonBlank(input.channel, 'Consent channel');
    assertNonBlank(input.purpose, 'Consent purpose');
    assertProvenance(input.provenance);
    const now = this.now();
    const record: ConsentRecord = { id: randomUUID(), tenantId: actor.tenantId, ...copy(input), timestamp: now };
    await this.consents.put(record);
    await this.recordEvent(actor, { eventType: CommercialControlPlaneEvents.ConsentChanged, source: 'commercial-control-plane', entityId: record.id, correlationId: record.id, payload: { consentId: record.id, state: record.consentState, channel: record.channel, purpose: record.purpose }, provenance: record.provenance, privacyClassification: 'RESTRICTED', idempotencyKey: `consent:${record.id}` });
    return copy(record);
  }

  async recordSignal(actor: CommercialActor, input: RecordSignalInput): Promise<CommercialSignal> {
    assertCommercialManager(actor);
    assertNonBlank(input.signalType, 'Signal type');
    assertProvenance(input.provenance);
    if (input.confidence !== undefined) assertScore(input.confidence, 'Signal confidence');
    const signal: CommercialSignal = {
      id: randomUUID(), tenantId: actor.tenantId, kind: input.kind, signalType: input.signalType, entityId: input.entityId,
      value: copy(input.value), inputSignalIds: [...(input.inputSignalIds ?? [])], confidence: input.confidence,
      provenance: copy(input.provenance), privacyClassification: input.privacyClassification ?? 'INTERNAL', createdAt: this.now(),
    };
    await this.signals.put(signal);
    await this.recordEvent(actor, { eventType: CommercialControlPlaneEvents.SignalRecorded, source: 'commercial-control-plane', entityId: signal.id, correlationId: signal.provenance.correlationId ?? signal.id, causationId: signal.provenance.causationId, payload: { signalId: signal.id, kind: signal.kind, signalType: signal.signalType }, provenance: signal.provenance, privacyClassification: signal.privacyClassification, idempotencyKey: `signal:${signal.id}` });
    return copy(signal);
  }

  async createExperiment(actor: CommercialActor, input: CreateExperimentInput): Promise<CommercialExperiment> {
    assertCommercialManager(actor);
    validateExperimentInput(input);
    const duplicates = (await this.experiments.all()).filter((experiment) =>
      experiment.tenantId === actor.tenantId && experiment.productId === input.productId && experiment.campaignId === input.campaignId &&
      experiment.hypothesis.trim().toLowerCase() === input.hypothesis.trim().toLowerCase() &&
      ['DRAFT', 'APPROVAL_REQUIRED', 'APPROVED', 'RUNNING'].includes(experiment.state),
    );
    if (duplicates.length > 0 && !input.duplicateJustification?.trim()) {
      throw new CommercialControlPlaneError(`A materially duplicate active experiment already exists: ${duplicates[0]!.id}.`);
    }
    const now = this.now();
    const experiment: CommercialExperiment = {
      id: randomUUID(), tenantId: actor.tenantId, hypothesis: input.hypothesis, productId: input.productId, campaignId: input.campaignId,
      audience: input.audience ? copy(input.audience) : undefined, market: input.market, channel: input.channel, control: input.control, variant: input.variant,
      objective: input.objective, primaryMetric: input.primaryMetric, secondaryMetrics: [...(input.secondaryMetrics ?? [])], sampleDefinition: input.sampleDefinition,
      durationMs: input.durationMs, budget: copy(input.budget), cost: [], measurementIds: [], state: 'APPROVAL_REQUIRED', duplicateJustification: input.duplicateJustification,
      createdAt: now, updatedAt: now,
    };
    await this.experiments.put(experiment);
    const ledger = await this.appendLedger({ kind: 'EXPERIMENT_CHANGED', tenantId: experiment.tenantId, actor: actor.id, productId: experiment.productId, campaignId: experiment.campaignId, auditReference: `experiment:${experiment.id}`, payload: { experimentId: experiment.id, state: experiment.state, hypothesis: experiment.hypothesis } });
    await this.emitExperimentChanged(actor, experiment, 'CREATED', { auditReference: ledger.id });
    return copy(experiment);
  }

  async approveExperiment(actor: CommercialActor, experimentId: string): Promise<CommercialExperiment> {
    assertApprover(actor);
    const experiment = await this.requireExperiment(actor, experimentId);
    if (experiment.state !== 'APPROVAL_REQUIRED') throw new CommercialControlPlaneError(`Experiment is ${experiment.state}, not awaiting approval.`);
    const updated: CommercialExperiment = { ...experiment, state: 'APPROVED', updatedAt: this.now() };
    await this.experiments.put(updated);
    const ledger = await this.appendLedger({ kind: 'EXPERIMENT_CHANGED', tenantId: updated.tenantId, actor: actor.id, productId: updated.productId, campaignId: updated.campaignId, auditReference: `experiment:${updated.id}`, payload: { experimentId: updated.id, state: updated.state, trigger: 'APPROVED' } });
    await this.emitExperimentChanged(actor, updated, 'APPROVED', { auditReference: ledger.id });
    return copy(updated);
  }

  async startExperiment(actor: CommercialActor, experimentId: string): Promise<CommercialExperiment> {
    assertCommercialManager(actor);
    const experiment = await this.requireExperiment(actor, experimentId);
    if (experiment.state !== 'APPROVED') throw new CommercialControlPlaneError('Experiment must be explicitly approved before it can start.');
    const now = this.now();
    const updated: CommercialExperiment = { ...experiment, state: 'RUNNING', startTime: now, updatedAt: now };
    await this.experiments.put(updated);
    const ledger = await this.appendLedger({ kind: 'EXPERIMENT_CHANGED', tenantId: updated.tenantId, actor: actor.id, productId: updated.productId, campaignId: updated.campaignId, auditReference: `experiment:${updated.id}`, payload: { experimentId: updated.id, state: updated.state, trigger: 'STARTED' } });
    await this.emitExperimentChanged(actor, updated, 'STARTED', { auditReference: ledger.id });
    return copy(updated);
  }

  async recordExperimentCost(actor: CommercialActor, experimentId: string, input: RecordExperimentCostInput): Promise<CommercialExperiment> {
    assertCommercialManager(actor);
    const experiment = await this.requireExperiment(actor, experimentId);
    if (experiment.state !== 'RUNNING') throw new CommercialControlPlaneError('Only running experiments can record measurement/cost.');
    assertResources(input.cost);
    const cost = [...experiment.cost, ...copy(input.cost)];
    const now = this.now();
    const exhausted = experimentBudgetExceeded(experiment.budget, cost, experiment.startTime, now);
    const updated: CommercialExperiment = {
      ...experiment, cost, result: input.result ? copy(input.result) : experiment.result, confidence: input.confidence ?? experiment.confidence,
      uncertainty: input.uncertainty ?? experiment.uncertainty, decision: input.decision ?? experiment.decision,
      learning: input.learning ?? experiment.learning, reusableInsight: input.reusableInsight ?? experiment.reusableInsight,
      state: exhausted ? 'STOPPED' : experiment.state, endTime: exhausted ? now : experiment.endTime,
      stopReason: exhausted ? 'Configured experiment resource or duration limit reached.' : experiment.stopReason, updatedAt: now,
    };
    await this.experiments.put(updated);
    const ledger = await this.appendLedger({ kind: 'EXPERIMENT_CHANGED', tenantId: updated.tenantId, actor: actor.id, productId: updated.productId, campaignId: updated.campaignId, auditReference: `experiment:${updated.id}`, resourceConsumption: input.cost, payload: { experimentId: updated.id, state: updated.state, automaticStop: exhausted, stopReason: updated.stopReason } });
    await this.emitExperimentChanged(actor, updated, exhausted ? 'LIMIT_REACHED' : 'COST_RECORDED', { auditReference: ledger.id, automaticStop: exhausted });
    return copy(updated);
  }

  /**
   * Record an evidence-bound experiment measurement. A simulated measurement is
   * retained but cannot stop, complete, or scale a running experiment. Current
   * measured/observed limit breaches stop the experiment locally; no external
   * campaign, spend, or connector operation is performed here.
   */
  async recordExperimentMeasurement(actor: CommercialActor, experimentId: string, input: RecordExperimentMeasurementInput): Promise<{ experiment: CommercialExperiment; measurement: CommercialExperimentMeasurement }> {
    assertCommercialManager(actor);
    const experiment = await this.requireExperiment(actor, experimentId);
    if (experiment.state !== 'RUNNING') throw new CommercialControlPlaneError('Only running experiments can record measurements.');
    const now = this.now();
    validateExperimentMeasurement(input, now);
    const measurement: CommercialExperimentMeasurement = {
      id: randomUUID(), tenantId: experiment.tenantId, experimentId: experiment.id, kind: input.kind, metric: input.metric,
      value: input.value, unit: input.unit, classification: input.classification, evidence: copy(input.evidence),
      provenance: copy(input.provenance), observedAt: input.observedAt ?? now, createdAt: now,
    };
    await this.experimentMeasurements.put(measurement);
    const stopReason = measurement.classification === 'SIMULATED' ? undefined : experimentMeasurementStopReason(experiment, measurement);
    const updated: CommercialExperiment = {
      ...experiment,
      // Older persisted experiment records predate measurementIds; preserve
      // them safely while adding the first explicit measurement.
      measurementIds: unique([...(experiment.measurementIds ?? []), measurement.id]),
      state: stopReason ? 'STOPPED' : experiment.state,
      endTime: stopReason ? now : experiment.endTime,
      stopReason: stopReason ?? experiment.stopReason,
      updatedAt: now,
    };
    await this.experiments.put(updated);
    const ledger = await this.appendLedger({
      kind: 'EXPERIMENT_CHANGED', tenantId: updated.tenantId, actor: actor.id, productId: updated.productId, campaignId: updated.campaignId,
      auditReference: `experiment:${updated.id}`, evidence: measurement.evidence,
      payload: { experimentId: updated.id, measurementId: measurement.id, metric: measurement.metric, classification: measurement.classification, state: updated.state, automaticStop: Boolean(stopReason), stopReason },
    });
    await this.emitExperimentChanged(actor, updated, stopReason ? 'MEASUREMENT_LIMIT_REACHED' : 'MEASUREMENT_RECORDED', { auditReference: ledger.id, measurementId: measurement.id, classification: measurement.classification, automaticStop: Boolean(stopReason) });
    return { experiment: copy(updated), measurement: copy(measurement) };
  }

  /** Explicitly stop a running experiment without deleting its measurements or audit history. */
  async stopExperiment(actor: CommercialActor, experimentId: string, input: StopCommercialExperimentInput): Promise<CommercialExperiment> {
    assertCommercialManager(actor);
    const experiment = await this.requireExperiment(actor, experimentId);
    if (experiment.state !== 'RUNNING') throw new CommercialControlPlaneError('Only running experiments can be stopped.');
    const now = this.now();
    validateStopExperimentInput(input, now);
    const updated: CommercialExperiment = {
      ...experiment, state: 'STOPPED', stopReason: input.reason.trim(), endTime: now, updatedAt: now,
    };
    await this.experiments.put(updated);
    const ledger = await this.appendLedger({
      kind: 'EXPERIMENT_CHANGED', tenantId: updated.tenantId, actor: actor.id, productId: updated.productId, campaignId: updated.campaignId,
      auditReference: `experiment:${updated.id}`, evidence: input.evidence ? copy(input.evidence) : undefined,
      payload: { experimentId: updated.id, state: updated.state, trigger: 'MANUAL_STOP', reason: updated.stopReason },
    });
    await this.emitExperimentChanged(actor, updated, 'MANUAL_STOP', { auditReference: ledger.id });
    return copy(updated);
  }

  /**
   * Persist an evidence-bound experiment conclusion. A SCALED experiment result
   * is only a recorded conclusion; a separate commercial decision, policy,
   * budget, approval, and action path is still required before any scale action.
   */
  async finalizeExperiment(actor: CommercialActor, experimentId: string, input: FinalizeCommercialExperimentInput): Promise<CommercialExperiment> {
    assertCommercialManager(actor);
    const experiment = await this.requireExperiment(actor, experimentId);
    if (experiment.state !== 'RUNNING' && experiment.state !== 'STOPPED') throw new CommercialControlPlaneError('Only running or stopped experiments can be finalized.');
    const now = this.now();
    validateFinalizeExperimentInput(input, now);
    const updated: CommercialExperiment = {
      ...experiment,
      state: input.state,
      result: copy(input.result),
      confidence: input.confidence,
      uncertainty: input.uncertainty.trim(),
      causalMethod: input.causalMethod.trim(),
      decision: input.decision.trim(),
      learning: input.learning.trim(),
      reusableInsight: input.reusableInsight?.trim(),
      endTime: now,
      updatedAt: now,
    };
    await this.experiments.put(updated);
    const ledger = await this.appendLedger({
      kind: 'EXPERIMENT_CHANGED', tenantId: updated.tenantId, actor: actor.id, productId: updated.productId, campaignId: updated.campaignId,
      auditReference: `experiment:${updated.id}`, evidence: copy(input.evidence), result: copy(input.result),
      payload: { experimentId: updated.id, state: updated.state, decision: updated.decision, causalMethod: updated.causalMethod, scaleAuthorization: 'NOT_AUTHORIZED' },
    });
    await this.emitExperimentChanged(actor, updated, 'FINALIZED', { auditReference: ledger.id, scaleAuthorization: 'NOT_AUTHORIZED' });
    return copy(updated);
  }

  /**
   * Versioned durable event recording with idempotency and tenant-scoped replay.
   *
   * F-01: sequence is assigned from a per-tenant CAS counter (replacing the
   * previous global `count() + 1`, which raced under concurrency); every event
   * is projected into the unified durable outbox (idempotent, self-healing on
   * the duplicate path); bus delivery is enveloped with the exact legacy
   * `CommercialEvent` payload preserved for existing subscribers.
   */
  async publishEvent(actor: CommercialActor, input: PublishCommercialEventInput): Promise<CommercialEvent> {
    assertActor(actor);
    validateEventInput(input);
    // Durable state (idempotency check, sequencing, persistence, outbox
    // projection) commits under the per-tenant mutex BEFORE volatile bus
    // delivery: a crash between the two is recoverable via replay
    // (at-least-once + idempotent).
    const event = await this.publishMutex.runExclusive(actor.tenantId, async () => {
      if (input.idempotencyKey) {
        const duplicate = (await this.events.query({ where: (event) => event.tenantId === actor.tenantId && event.idempotencyKey === input.idempotencyKey, limit: 1 }))[0];
        if (duplicate) {
          // Self-healing: a pre-F-01 duplicate may lack a unified-outbox record.
          await this.unifiedOutbox.publish(toEnvelopeFromCommercial(duplicate.eventType, duplicate));
          return copy(duplicate);
        }
      }
      const now = this.now();
      const fresh: CommercialEvent = {
        id: randomUUID(), sequence: await this.nextEventSequence(actor.tenantId), eventType: input.eventType, eventVersion: input.eventVersion ?? 1,
        tenantId: actor.tenantId, source: input.source, actor: actor.id, entityId: input.entityId, timestamp: now,
        correlationId: input.correlationId, causationId: input.causationId, payload: copy(input.payload), schemaVersion: input.schemaVersion ?? 1,
        provenance: copy(input.provenance), privacyClassification: input.privacyClassification ?? 'INTERNAL', idempotencyKey: input.idempotencyKey,
      };
      await this.events.put(fresh);
      await this.unifiedOutbox.publish(toEnvelopeFromCommercial(fresh.eventType, fresh));
      return copy(fresh);
    });
    await this.emitEnvelopedEvent(event);
    return copy(event);
  }

  /**
   * F-01 enveloped dual delivery: every recorded commercial event is emitted
   * once under its own type and once under the canonical audit topic, exactly
   * as before — but as a first-class envelope, with the legacy
   * `CommercialEvent` payload preserved for existing subscribers.
   */
  private async emitEnvelopedEvent(event: CommercialEvent): Promise<void> {
    const envelope: EventEnvelope = toEnvelopeFromCommercial(event.eventType, event);
    const auditEnvelope: EventEnvelope = toEnvelopeFromCommercial(CommercialControlPlaneEvents.EventRecorded, event);
    await this.api.bus.emitEnveloped(event.eventType, envelope, { legacyPayload: copy(event) });
    await this.api.bus.emitEnveloped(CommercialControlPlaneEvents.EventRecorded, auditEnvelope, { legacyPayload: copy(event) });
  }

  /**
   * F-01c: concurrency-safe per-tenant event sequencing (T-01-I pattern).
   * Replaces the previous global `(await this.events.count()) + 1`, under
   * which two concurrent publishers could both observe the same count and
   * produce duplicate sequences.
   *
   * Sequences are per-tenant (replay is tenant-scoped). The counter is
   * initialized from the tenant's current maximum sequence so pre-F-01 rows
   * (globally numbered) are never collided with.
   */
  private async nextEventSequence(tenantId: string): Promise<number> {
    const counterId = `seq:${tenantId}`;
    const absent = await this.eventSequence.get(counterId);
    if (!absent) {
      const rows = await this.events.query({ where: (event) => event.tenantId === tenantId });
      let maximum = 0;
      for (const row of rows) {
        if (row.sequence > maximum) maximum = row.sequence;
      }
      // Preserve-existing create (never clobber): on drivers where CAS of an
      // absent row cannot lock, a late-committing create must not reset a
      // concurrently advanced counter. First-use callers serialize in-process
      // via `publishMutex`; see the residual cross-process note on
      // `UnifiedOutbox.nextSequence`.
      await this.eventSequence.cas(
        counterId,
        () => true,
        (current) => (current as { id: string; tenantId: string; sequence: number } | undefined) ?? { id: counterId, tenantId, sequence: maximum },
      );
    }
    // Bounded but burst-tolerant: concurrent-publish bursts larger than a
    // handful of writers need more rounds than the T-01-I ledger default of 8
    // (each round lets at least one writer through). The bound keeps the
    // fail-closed property; sustained exhaustion still throws rather than
    // spinning forever.
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const current = await this.eventSequence.get(counterId);
      const observed = current ?? { id: counterId, tenantId, sequence: 0 };
      const next = { id: counterId, tenantId, sequence: observed.sequence + 1 };
      const res = await this.eventSequence.cas(
        counterId,
        (candidate) => (candidate?.sequence ?? 0) === observed.sequence,
        () => next,
      );
      if (res.ok) return next.sequence;
    }
    throw new CommercialControlPlaneError('Event sequence counter CAS exhausted retries.');
  }

  /** Access the unified durable outbox (F-01d). Callers must respect tenant boundaries. */
  getUnifiedOutbox(): UnifiedOutbox {
    return this.unifiedOutbox;
  }

  /**
   * Tenant-scoped replay over the unified durable outbox (F-01d). The replay
   * is inherently tenant-bound: only the actor's own tenant records are
   * visible (global_admin reads another tenant only via explicit per-tenant
   * tooling, never implicitly here).
   */
  async replayUnifiedOutbox(actor: CommercialActor, options: ReplayUnifiedOutboxOptions = {}): Promise<UnifiedOutboxRecord[]> {
    assertActor(actor);
    return this.unifiedOutbox.replay(actor.tenantId, options);
  }

  /** Verify unified-outbox integrity for the actor tenant (F-01d). */
  async verifyUnifiedOutboxIntegrity(actor: CommercialActor): Promise<UnifiedOutboxIntegrity> {
    assertActor(actor);
    return this.unifiedOutbox.verifyIntegrity(actor.tenantId);
  }

  async replayEvents(actor: CommercialActor, options: ReplayCommercialEventsOptions = {}): Promise<CommercialEvent[]> {
    const events = await this.events.query({
      where: (event) => canReadTenant(actor, event.tenantId) &&
        (options.afterSequence === undefined || event.sequence > options.afterSequence) &&
        (options.eventTypes === undefined || options.eventTypes.includes(event.eventType)),
      orderBy: 'sequence', order: 'asc', limit: options.limit,
    });
    return events.map(copy);
  }

  // ---- Internal infrastructure ---------------------------------------------------------------

  private now(): number { return this.clock(); }

  private async requireDecision(actor: CommercialActor, id: string): Promise<CommercialDecision> {
    const decision = await this.decisions.get(id);
    if (!decision || !canReadTenant(actor, decision.tenantId)) throw new CommercialControlPlaneError('Commercial decision not found.');
    return decision;
  }

  private async requireAction(actor: CommercialActor, id: string): Promise<CommercialAction> {
    const action = await this.actions.get(id);
    if (!action || !canReadTenant(actor, action.tenantId)) throw new CommercialControlPlaneError('Commercial action not found.');
    return action;
  }

  private async requireExperiment(actor: CommercialActor, id: string): Promise<CommercialExperiment> {
    const experiment = await this.experiments.get(id);
    if (!experiment || !canReadTenant(actor, experiment.tenantId)) throw new CommercialControlPlaneError('Commercial experiment not found.');
    return experiment;
  }

  private async ensureApprovalRequest(actor: CommercialActor, decision: CommercialDecision, reason: string): Promise<ApprovalRequest> {
    const existing = (await this.approvals.query({ where: (request) => request.decisionId === decision.id && request.state === 'PENDING', limit: 1 }))[0];
    if (existing) return existing;
    const now = this.now();
    const request: ApprovalRequest = { id: randomUUID(), tenantId: decision.tenantId, decisionId: decision.id, state: 'PENDING', requestedBy: actor.id, requestedAt: now, reason };
    await this.approvals.put(request);
    await this.decisions.put({ ...decision, approvalState: 'PENDING', executionState: 'WAITING_FOR_APPROVAL', requiredApproval: true });
    const ledger = await this.appendLedger({ kind: 'APPROVAL_REQUESTED', tenantId: decision.tenantId, decisionId: decision.id, actor: actor.id, productId: decision.productId, campaignId: decision.campaignId, authorization: 'HUMAN_APPROVAL_REQUIRED', auditReference: `approval:${request.id}`, payload: { approvalId: request.id, reason } });
    await this.recordEvent(actor, { eventType: CommercialControlPlaneEvents.ApprovalRequested, source: 'commercial-control-plane', entityId: request.id, correlationId: decision.provenance.correlationId ?? decision.id, causationId: decision.id, payload: { approvalId: request.id, decisionId: decision.id, auditReference: ledger.id }, provenance: decision.provenance, privacyClassification: 'RESTRICTED', idempotencyKey: `approval-requested:${decision.id}` });
    return request;
  }

  private async evaluateBudgets(decision: CommercialDecision, now: number): Promise<BudgetCheck[]> {
    const budgets = (await this.budgets.all()).filter((budget) => budget.active && budget.tenantId === decision.tenantId && scopeMatches(budget.scope, decision));
    if (budgets.length === 0) return [];
    const allActions = (await this.actions.all()).filter((action) => action.tenantId === decision.tenantId);
    const allDecisions = new Map((await this.decisions.all()).map((item) => [item.id, item]));
    return budgets.map((budget) => {
      const requested = sumMatchingResources(decision.resourceRequirements, budget);
      let consumed = 0;
      let reserved = 0;
      for (const action of allActions) {
        const actionDecision = allDecisions.get(action.decisionId);
        if (!actionDecision || !scopeMatches(budget.scope, actionDecision)) continue;
        if (!withinBudgetPeriod(action.completedAt ?? action.createdAt, budget.period, now)) continue;
        if (action.executionStatus === 'COMPLETED') {
          const consumedResources = action.resourceConsumption.length > 0 ? action.resourceConsumption : action.resourceRequirements;
          consumed += sumMatchingResources(consumedResources, budget);
          const hasMatchingMoneyConsumption = consumedResources.some((resource) =>
            resource.resourceType === 'MONEY' && resource.unit === budget.unit && (budget.currency === undefined || resource.currency === budget.currency),
          );
          if (budget.resourceType === 'MONEY' && action.financialCost && !hasMatchingMoneyConsumption && moneyMatchesBudget(action.financialCost, budget)) {
            consumed += action.financialCost.amount;
          }
        } else if (['QUEUED', 'EXECUTING', 'VERIFYING', 'RETRYING'].includes(action.executionStatus)) {
          reserved += sumMatchingResources(action.resourceRequirements, budget);
        }
      }
      const remaining = Math.max(0, budget.limit - consumed - reserved);
      return { budgetId: budget.id, allowed: requested <= remaining, limit: budget.limit, consumed, reserved, requested, remaining, currency: budget.currency ?? '' };
    });
  }

  private async connectorForDecision(decision: CommercialDecision): Promise<ConnectorRecord | undefined> {
    if (!decision.connectorId) return undefined;
    const connector = await this.connectors.get(decision.connectorId);
    if (!connector) return undefined;
    if (connector.tenantId !== undefined && connector.tenantId !== decision.tenantId) return undefined;
    return connector;
  }

  private async activeConsent(tenantId: string, subjectId: string, channel: string, purpose: string, now: number): Promise<ConsentRecord | undefined> {
    const records = await this.consents.query({
      where: (record) => record.tenantId === tenantId && record.subjectId === subjectId && record.channel === channel && record.purpose === purpose,
      orderBy: 'timestamp', order: 'desc',
    });
    const latest = records[0];
    if (!latest || latest.consentState !== 'GRANTED' || (latest.expiresAt !== undefined && latest.expiresAt <= now)) return undefined;
    return latest;
  }

  private killSwitchApplies(switchRecord: CommercialKillSwitch, decision: CommercialDecision, actor: CommercialActor): boolean {
    if (switchRecord.scopeType === 'GLOBAL') return true;
    if (switchRecord.tenantId !== undefined && switchRecord.tenantId !== decision.tenantId) return false;
    if (switchRecord.scope.agentId && switchRecord.scope.agentId !== actor.agentId) return false;
    if (switchRecord.scopeType === 'SPENDING' && !decision.estimatedCost && !decision.resourceRequirements.some((item) => item.resourceType === 'MONEY' || item.resourceType === 'AD_SPEND')) return false;
    if (switchRecord.scopeType === 'MESSAGING' && !decision.communication) return false;
    return scopeMatches(switchRecord.scope, decision);
  }

  private async applyTransition(actor: CommercialActor, current: CommercialStateRecord, input: TransitionCommercialStateInput): Promise<CommercialStateTransition> {
    assertCommercialManager(actor);
    assertNonBlank(input.trigger, 'Transition trigger');
    assertNonBlank(input.reason, 'Transition reason');
    if (input.policyCheck && input.policyCheck !== 'ALLOW' && input.policyCheck !== 'TEST') {
      throw new CommercialControlPlaneError(`State transition is blocked by policy outcome ${input.policyCheck}.`);
    }
    const evidence = copy(input.evidence ?? []);
    for (const item of evidence) validateEvidence(item, this.now());
    const now = this.now();
    const transition: CommercialStateTransition = {
      id: randomUUID(), tenantId: current.tenantId, kind: current.kind, entityId: current.entityId, productId: current.productId, campaignId: current.campaignId,
      previousState: current.state, newState: input.newState, trigger: input.trigger, evidence, decisionId: input.decisionId, actor: actor.id,
      timestamp: now, reason: input.reason, policyCheck: input.policyCheck ?? 'ALLOW', approvalState: input.approvalState ?? 'NOT_REQUIRED', rollbackOption: input.rollbackOption,
    };
    const updatedRecord: CommercialStateRecord = { ...current, state: input.newState, updatedAt: now };
    if (current.kind === 'PRODUCT') await this.productStates.put(updatedRecord);
    else await this.campaignStates.put(updatedRecord);
    await this.transitions.put(transition);
    const ledger = await this.appendLedger({ kind: 'STATE_TRANSITION', tenantId: transition.tenantId, decisionId: transition.decisionId, actor: actor.id, productId: transition.productId, campaignId: transition.campaignId, authorization: transition.policyCheck, evidence: transition.evidence, auditReference: `transition:${transition.id}`, payload: { kind: transition.kind, previousState: transition.previousState, newState: transition.newState, trigger: transition.trigger, reason: transition.reason, rollbackOption: transition.rollbackOption } });
    await this.recordEvent(actor, { eventType: CommercialControlPlaneEvents.StateTransitioned, source: 'commercial-control-plane', entityId: transition.entityId, correlationId: transition.decisionId ?? transition.id, causationId: transition.decisionId, payload: { transitionId: transition.id, kind: transition.kind, previousState: transition.previousState, newState: transition.newState, auditReference: ledger.id }, provenance: systemProvenance('commercial-control-plane', now, transition.decisionId ?? transition.id), privacyClassification: 'INTERNAL', idempotencyKey: `transition:${transition.id}` });
    return copy(transition);
  }

  private async blockAction(actor: CommercialActor, action: CommercialAction, reason: string): Promise<CommercialAction> {
    const now = this.now();
    const blocked: CommercialAction = { ...action, executionStatus: 'BLOCKED', error: reason, updatedAt: now, completedAt: now };
    await this.actions.put(blocked);
    await this.appendLedger({ kind: 'ACTION_FAILED', tenantId: blocked.tenantId, decisionId: blocked.decisionId, actionId: blocked.id, actor: actor.id, failureReason: reason, auditReference: blocked.auditReference, payload: { state: 'BLOCKED' } });
    return copy(blocked);
  }

  /**
   * Concurrency-safe ledger append (T-01-I).
   *
   * Replaces the previous query-then-write pattern
   *   sequence: (previous?.sequence ?? 0) + 1
   * which allowed two concurrent writers to both observe the same
   * `previous` and both produce the same sequence, creating a
   * hash-chain fork and a sequence collision.
   *
   * The replacement CAS-advances a per-tenant atomic counter and
   * then reads back the previous entry by (tenantId, sequence =
   * current-1). If the previous entry is not yet committed
   * (concurrent writer still in flight) we poll briefly so the
   * chain does not develop a hash gap.
   */
  private async appendLedger(input: LedgerInput): Promise<CommercialActionLedgerEntry> {
    const tenantId = input.tenantId;
    const counterId = `seq:${tenantId}`;
    // Initialize the counter if it does not exist (idempotent).
    await this.ledgerSequence.cas(counterId, (cur) => cur === undefined, () => ({ id: counterId, tenantId, sequence: 0 }));
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.ledgerSequence.get(counterId);
      const cur = current ?? { id: counterId, tenantId, sequence: 0 };
      const nextSequence = cur.sequence + 1;
      const next = { id: counterId, tenantId, sequence: nextSequence };
      const res = await this.ledgerSequence.cas(counterId, (c) => (c?.sequence ?? 0) === cur.sequence, () => next);
      if (res.ok) {
        let previousHash = 'GENESIS';
        if (cur.sequence > 0) {
          for (let i = 0; i < 8; i += 1) {
            const previous = (await this.ledger.query({ where: (entry) => entry.tenantId === tenantId && entry.sequence === cur.sequence, limit: 1 }))[0];
            if (previous) { previousHash = previous.hash; break; }
            await new Promise<void>((r) => setTimeout(r, 5 * (i + 1)));
          }
        }
        const draft: Omit<CommercialActionLedgerEntry, 'hash'> = {
          ...input,
          id: randomUUID(),
          sequence: nextSequence,
          previousHash,
          timestamp: input.timestamp ?? this.now(),
        };
        const entry: CommercialActionLedgerEntry = { ...draft, hash: hashLedgerEntry({ ...draft, hash: '' }) };
        await this.ledger.put(entry);
        return entry;
      }
    }
    throw new CommercialControlPlaneError('Ledger counter CAS exhausted retries.');
  }

  private async emitExperimentChanged(actor: CommercialActor, experiment: CommercialExperiment, trigger: string, payload: Record<string, unknown>): Promise<void> {
    const now = this.now();
    const auditReference = typeof payload.auditReference === 'string' ? payload.auditReference : String(experiment.updatedAt);
    await this.recordEvent(actor, {
      eventType: CommercialControlPlaneEvents.ExperimentChanged,
      source: 'commercial-control-plane',
      entityId: experiment.id,
      correlationId: experiment.id,
      payload: { experimentId: experiment.id, state: experiment.state, trigger, ...payload },
      provenance: systemProvenance('commercial-control-plane', now, experiment.id),
      privacyClassification: 'INTERNAL',
      idempotencyKey: `experiment:${experiment.id}:${trigger}:${auditReference}`,
    });
  }

  private async recordEvent(actor: CommercialActor, input: PublishCommercialEventInput): Promise<CommercialEvent> {
    return this.publishEvent(actor, input);
  }
}

type ProductState = Exclude<CommercialLifecycleState, CampaignState>;

function isProductState(state: CommercialLifecycleState): state is ProductState {
  return [
    'IDEA', 'DISCOVERED', 'VALIDATING', 'PMF_TESTING', 'COLD_START', 'INITIAL_SIGNAL', 'EARLY_TRACTION', 'REPEATABLE_ACQUISITION',
    'ORGANIC_PROPAGATION', 'COMMERCIAL_SCALE', 'MARKET_EXPANSION', 'GLOBAL_SCALE', 'PAUSED', 'BLOCKED', 'UNDER_REVIEW', 'DEGRADED',
    'REPAIRING', 'RETESTING', 'PIVOTING', 'RETIRED',
  ].includes(state as ProductState);
}

function isCampaignState(state: CommercialLifecycleState): state is CampaignState {
  return [
    'DRAFT', 'HYPOTHESIS', 'VALIDATING', 'APPROVED', 'QUEUED', 'AUTHORIZING', 'READY', 'PUBLISHING', 'PUBLISHED', 'TELEMETRY_ACTIVE',
    'OPTIMIZING', 'COMPLETED', 'DECAYING', 'RETIRED', 'BLOCKED', 'REJECTED', 'RATE_LIMITED', 'AUTHORIZATION_FAILED', 'POLICY_BLOCKED',
    'PLATFORM_REJECTED', 'CONTENT_REJECTED', 'NETWORK_ERROR', 'CREDENTIAL_EXPIRED', 'HUMAN_REVIEW_REQUIRED', 'ECONOMICALLY_UNVIABLE',
  ].includes(state as CampaignState);
}

function authorizationToDecisionState(outcome: AuthorizationOutcome): CommercialDecision['executionState'] {
  switch (outcome) {
    case 'ALLOW':
    case 'TEST': return 'AUTHORIZED';
    case 'DENY': return 'DENIED';
    case 'HUMAN_APPROVAL_REQUIRED':
    case 'ESCALATE': return 'WAITING_FOR_APPROVAL';
    case 'WAIT': return 'AUTHORIZING';
  }
}

function stateRecordId(tenantId: string, kind: CommercialStateKind, entityId: string): string {
  return `${tenantId}:${kind.toLowerCase()}:${entityId}`;
}

function normalizedDecisionResources(input: CreateCommercialDecisionInput): ResourceRequirement[] {
  const requirements = copy(input.resourceRequirements ?? []);
  if (input.estimatedCost && !requirements.some((requirement) => requirement.resourceType === 'MONEY' && requirement.currency === input.estimatedCost!.currency)) {
    requirements.push({ resourceType: 'MONEY', amount: input.estimatedCost.amount, unit: input.estimatedCost.currency, currency: input.estimatedCost.currency });
  }
  assertResources(requirements);
  return requirements;
}

function validateDecisionInput(input: CreateCommercialDecisionInput, now: number): void {
  assertNonBlank(input.tenantId, 'Tenant id');
  assertNonBlank(input.productId, 'Product id');
  assertNonBlank(input.objective, 'Decision objective');
  assertNonBlank(input.proposedAction, 'Proposed action');
  assertNonBlank(input.actionType, 'Action type');
  assertNonBlank(input.decisionReason, 'Decision reason');
  assertScore(input.evidenceStrength, 'Evidence strength');
  assertScore(input.riskScore, 'Risk score');
  assertScore(input.complianceScore, 'Compliance score');
  assertScore(input.confidence, 'Decision confidence');
  for (const score of [input.trustScore, input.pmfScore, input.conversionProbability, input.economicScore, input.reputationScore]) {
    if (score !== undefined) assertScore(score, 'Decision score');
  }
  if (!Number.isInteger(input.authorizationLevel) || input.authorizationLevel < 0 || input.authorizationLevel > 7) throw new CommercialControlPlaneError('Authorization level must be an integer between 0 and 7.');
  if (input.expiresAt !== undefined && input.expiresAt <= now) throw new CommercialControlPlaneError('Decision expiry must be in the future.');
  if (!input.evidence.length) throw new CommercialControlPlaneError('Significant commercial decisions require at least one evidence record.');
  for (const evidence of input.evidence) validateEvidence(evidence, now);
  if (input.expectedValue) assertMoney(input.expectedValue, 'Expected value');
  if (input.estimatedCost) assertMoney(input.estimatedCost, 'Estimated cost');
  assertProvenance(input.provenance);
}

function validatePolicyInput(input: CreateAutonomyPolicyInput, now: number): void {
  assertNonBlank(input.version, 'Policy version');
  if (!Number.isInteger(input.maximumAutonomyLevel) || input.maximumAutonomyLevel < 0 || input.maximumAutonomyLevel > 7) throw new CommercialControlPlaneError('Policy maximum autonomy must be an integer between 0 and 7.');
  for (const [name, value] of Object.entries({ maximumRiskScore: input.maximumRiskScore, minimumComplianceScore: input.minimumComplianceScore, minimumEvidenceStrength: input.minimumEvidenceStrength, approvalRiskThreshold: input.approvalRiskThreshold })) {
    if (value !== undefined) assertScore(value, name);
  }
  if (input.expiresAt !== undefined && input.expiresAt <= now) throw new CommercialControlPlaneError('Policy expiry must be in the future.');
  if (input.maximumSingleActionCost) assertMoney(input.maximumSingleActionCost, 'Policy single-action cost limit');
}

function validatePlanActionInput(input: PlanCommercialActionInput): void {
  assertNonBlank(input.targetSystem, 'Action target system');
  assertNonBlank(input.idempotencyKey, 'Action idempotency key');
  if (input.resourceRequirements) assertResources(input.resourceRequirements);
}

function validateActionResult(input: ReportActionResultInput): void {
  if (input.financialCost) assertMoney(input.financialCost, 'Action financial cost');
  if (input.resourceConsumption) assertResources(input.resourceConsumption);
}

function validateVerification(input: VerifyActionInput): void {
  if (!input.evidence.length) throw new CommercialControlPlaneError('Action verification requires independent evidence.');
  for (const evidence of input.evidence) validateEvidence(evidence, Date.now());
}

function validateBudgetInput(input: CreateCommercialBudgetInput): void {
  if (!Number.isFinite(input.limit) || input.limit < 0) throw new CommercialControlPlaneError('Budget limit must be a non-negative finite number.');
  assertNonBlank(input.unit, 'Budget unit');
}

function validateExperimentInput(input: CreateExperimentInput): void {
  for (const [name, value] of Object.entries({ hypothesis: input.hypothesis, productId: input.productId, control: input.control, variant: input.variant, objective: input.objective, primaryMetric: input.primaryMetric, sampleDefinition: input.sampleDefinition })) assertNonBlank(value, name);
  if (!Number.isFinite(input.durationMs) || input.durationMs <= 0) throw new CommercialControlPlaneError('Experiment duration must be positive.');
  if (!Number.isFinite(input.budget.maximumDurationMs) || input.budget.maximumDurationMs <= 0) throw new CommercialControlPlaneError('Experiment maximum duration must be positive.');
  assertNonBlank(input.budget.stoppingRule, 'Experiment stopping rule');
  if (input.budget.maximumMonetaryCost) assertMoney(input.budget.maximumMonetaryCost, 'Experiment maximum monetary cost');
  for (const [name, value] of Object.entries({ maximumComputeCost: input.budget.maximumComputeCost, maximumApiConsumption: input.budget.maximumApiConsumption, maximumAudienceExposure: input.budget.maximumAudienceExposure, maximumMessageFrequency: input.budget.maximumMessageFrequency, maximumAcceptableDownside: input.budget.maximumAcceptableDownside })) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new CommercialControlPlaneError(`Experiment ${name} must be a non-negative finite number.`);
  }
  for (const [name, value] of Object.entries({ successThreshold: input.budget.successThreshold, failureThreshold: input.budget.failureThreshold })) {
    if (value !== undefined && !Number.isFinite(value)) throw new CommercialControlPlaneError(`Experiment ${name} must be finite.`);
  }
  if ((input.budget.successThreshold !== undefined || input.budget.failureThreshold !== undefined) && !input.budget.primaryMetricDirection) throw new CommercialControlPlaneError('Experiment primary metric direction is required when success or failure thresholds are configured.');
  if (input.budget.primaryMetricDirection !== undefined && !['HIGHER_IS_BETTER', 'LOWER_IS_BETTER'].includes(input.budget.primaryMetricDirection)) throw new CommercialControlPlaneError('Experiment primary metric direction is invalid.');
  if (input.budget.successThreshold !== undefined && input.budget.failureThreshold !== undefined) {
    const correct = input.budget.primaryMetricDirection === 'HIGHER_IS_BETTER'
      ? input.budget.successThreshold >= input.budget.failureThreshold
      : input.budget.successThreshold <= input.budget.failureThreshold;
    if (!correct) throw new CommercialControlPlaneError('Experiment success/failure thresholds are inconsistent with primary metric direction.');
  }
}

function validateExperimentMeasurement(input: RecordExperimentMeasurementInput, now: number): void {
  if (!['PRIMARY_METRIC', 'SECONDARY_METRIC', 'AUDIENCE_EXPOSURE', 'MESSAGE_FREQUENCY', 'DOWNSIDE', 'OTHER'].includes(input.kind)) throw new CommercialControlPlaneError('Experiment measurement kind is invalid.');
  if (!['OBSERVED', 'MEASURED', 'SIMULATED'].includes(input.classification)) throw new CommercialControlPlaneError('Experiment measurement classification is invalid.');
  assertNonBlank(input.metric, 'Experiment measurement metric');
  assertNonBlank(input.unit, 'Experiment measurement unit');
  if (!Number.isFinite(input.value)) throw new CommercialControlPlaneError('Experiment measurement value must be finite.');
  if (['AUDIENCE_EXPOSURE', 'MESSAGE_FREQUENCY'].includes(input.kind) && input.value < 0) throw new CommercialControlPlaneError('Audience exposure and message frequency measurements must be non-negative.');
  if (input.observedAt !== undefined && (!Number.isFinite(input.observedAt) || input.observedAt <= 0 || input.observedAt > now + 60_000)) throw new CommercialControlPlaneError('Experiment measurement observedAt must be a valid timestamp.');
  if (!input.evidence.length) throw new CommercialControlPlaneError('Experiment measurements require evidence.');
  for (const evidence of input.evidence) validateEvidence(evidence, now);
  assertProvenance(input.provenance);
}

function validateStopExperimentInput(input: StopCommercialExperimentInput, now: number): void {
  assertNonBlank(input.reason, 'Experiment stop reason');
  if (input.evidence) for (const evidence of input.evidence) validateEvidence(evidence, now);
  if (input.provenance) assertProvenance(input.provenance);
}

function validateFinalizeExperimentInput(input: FinalizeCommercialExperimentInput, now: number): void {
  if (!['COMPLETED', 'SCALED', 'REVISED', 'FAILED'].includes(input.state)) throw new CommercialControlPlaneError('Experiment final state is invalid.');
  if (!input.result || typeof input.result !== 'object' || Array.isArray(input.result)) throw new CommercialControlPlaneError('Experiment final result must be an object.');
  assertScore(input.confidence, 'Experiment confidence');
  for (const [name, value] of Object.entries({ uncertainty: input.uncertainty, causalMethod: input.causalMethod, decision: input.decision, learning: input.learning })) assertNonBlank(value, `Experiment ${name}`);
  if (input.reusableInsight !== undefined) assertNonBlank(input.reusableInsight, 'Experiment reusable insight');
  if (!input.evidence.length) throw new CommercialControlPlaneError('Experiment finalization requires evidence.');
  for (const evidence of input.evidence) validateEvidence(evidence, now);
  assertProvenance(input.provenance);
}

function experimentMeasurementStopReason(experiment: CommercialExperiment, measurement: CommercialExperimentMeasurement): string | undefined {
  // Exposure/frequency values are interpreted as the current cumulative/rate
  // value supplied by the measured observation, never inferred from a count.
  if (measurement.kind === 'AUDIENCE_EXPOSURE' && experiment.budget.maximumAudienceExposure !== undefined && measurement.value >= experiment.budget.maximumAudienceExposure) return 'Configured maximum audience exposure reached.';
  if (measurement.kind === 'MESSAGE_FREQUENCY' && experiment.budget.maximumMessageFrequency !== undefined && measurement.value >= experiment.budget.maximumMessageFrequency) return 'Configured maximum message frequency reached.';
  if (measurement.kind === 'DOWNSIDE' && experiment.budget.maximumAcceptableDownside !== undefined && measurement.value >= experiment.budget.maximumAcceptableDownside) return 'Configured maximum acceptable downside reached.';
  if (measurement.kind !== 'PRIMARY_METRIC' || measurement.metric.trim().toLocaleLowerCase() !== experiment.primaryMetric.trim().toLocaleLowerCase() || !experiment.budget.primaryMetricDirection) return undefined;
  const direction = experiment.budget.primaryMetricDirection;
  if (experiment.budget.successThreshold !== undefined && (direction === 'HIGHER_IS_BETTER' ? measurement.value >= experiment.budget.successThreshold : measurement.value <= experiment.budget.successThreshold)) return 'Configured primary-metric success threshold reached.';
  if (experiment.budget.failureThreshold !== undefined && (direction === 'HIGHER_IS_BETTER' ? measurement.value <= experiment.budget.failureThreshold : measurement.value >= experiment.budget.failureThreshold)) return 'Configured primary-metric failure threshold reached.';
  return undefined;
}

function validateEventInput(input: PublishCommercialEventInput): void {
  assertNonBlank(input.eventType, 'Event type');
  assertNonBlank(input.source, 'Event source');
  assertNonBlank(input.correlationId, 'Event correlation id');
  if (input.eventVersion !== undefined && (!Number.isInteger(input.eventVersion) || input.eventVersion < 1)) throw new CommercialControlPlaneError('Event version must be a positive integer.');
  if (input.schemaVersion !== undefined && (!Number.isInteger(input.schemaVersion) || input.schemaVersion < 1)) throw new CommercialControlPlaneError('Event schema version must be a positive integer.');
  assertProvenance(input.provenance);
}

function validateEvidence(evidence: CommercialEvidence, now: number): void {
  assertNonBlank(evidence.id, 'Evidence id');
  assertNonBlank(evidence.source, 'Evidence source');
  assertNonBlank(evidence.summary, 'Evidence summary');
  assertScore(evidence.confidence, 'Evidence confidence');
  if (!Number.isFinite(evidence.observedAt) || evidence.observedAt <= 0 || evidence.observedAt > now + 60_000) throw new CommercialControlPlaneError('Evidence observedAt must be a valid timestamp.');
  assertProvenance(evidence.provenance);
}

function assertProvenance(provenance: CommercialProvenance): void {
  assertNonBlank(provenance.source, 'Provenance source');
  if (!Number.isFinite(provenance.collectedAt) || provenance.collectedAt <= 0) throw new CommercialControlPlaneError('Provenance collectedAt must be a valid timestamp.');
}

function assertResources(resources: readonly ResourceRequirement[]): void {
  for (const resource of resources) {
    if (!Number.isFinite(resource.amount) || resource.amount < 0) throw new CommercialControlPlaneError(`Resource ${resource.resourceType} amount must be a non-negative finite number.`);
    assertNonBlank(resource.unit, `Resource ${resource.resourceType} unit`);
    if (resource.currency) assertNonBlank(resource.currency, `Resource ${resource.resourceType} currency`);
  }
}

function assertMoney(value: MonetaryValue, name: string): void {
  if (!Number.isFinite(value.amount) || value.amount < 0) throw new CommercialControlPlaneError(`${name} amount must be a non-negative finite number.`);
  assertNonBlank(value.currency, `${name} currency`);
}

function assertScore(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new CommercialControlPlaneError(`${name} must be a number from 0 to 100.`);
}

function assertNonBlank(value: string | undefined, name: string): void {
  if (!value?.trim()) throw new CommercialControlPlaneError(`${name} is required.`);
}

function assertActor(actor: CommercialActor): void {
  assertNonBlank(actor.id, 'Actor id');
  assertNonBlank(actor.tenantId, 'Actor tenant id');
  if (!Array.isArray(actor.roles) || actor.roles.length === 0) throw new CommercialControlPlaneError('Actor must have at least one declared role.');
}

function assertSameTenant(actor: CommercialActor, tenantId: string): void {
  assertActor(actor);
  if (actor.tenantId !== tenantId && !isGlobalAdministrator(actor)) throw new CommercialControlPlaneError('Cross-tenant commercial operation is not authorized.');
}

function canReadTenant(actor: CommercialActor, tenantId: string): boolean {
  return actor.tenantId === tenantId || isGlobalAdministrator(actor);
}

function hasRole(actor: CommercialActor, roles: readonly string[]): boolean {
  return actor.roles.some((role) => roles.includes(role));
}

function isGlobalAdministrator(actor: CommercialActor): boolean {
  return actor.roles.includes('global_admin');
}

function assertAdministrator(actor: CommercialActor): void {
  assertActor(actor);
  if (!hasRole(actor, ['admin', 'global_admin'])) throw new CommercialControlPlaneError('Commercial administrator role is required.');
}

function assertApprover(actor: CommercialActor): void {
  assertActor(actor);
  if (!hasRole(actor, ['approver', 'admin', 'global_admin'])) throw new CommercialControlPlaneError('Commercial approver role is required.');
}

function assertCommercialManager(actor: CommercialActor): void {
  assertActor(actor);
  if (!hasRole(actor, ['operator', 'admin', 'global_admin', 'system'])) throw new CommercialControlPlaneError('Commercial operator role is required.');
}

function assertExecutionActor(actor: CommercialActor): void {
  assertCommercialManager(actor);
}

function assertScopeAdministration(actor: CommercialActor, scope: CommercialScope): void {
  if (scope.tenantId === undefined && !isGlobalAdministrator(actor)) throw new CommercialControlPlaneError('Only a global administrator may create a global commercial policy, budget, or kill switch.');
  if (scope.tenantId !== undefined) assertSameTenant(actor, scope.tenantId);
}

function sumMatchingResources(resources: readonly ResourceRequirement[], budget: CommercialBudget): number {
  return resources
    .filter((resource) => resource.resourceType === budget.resourceType && resource.unit === budget.unit && (budget.currency === undefined || resource.currency === budget.currency))
    .reduce((sum, resource) => sum + resource.amount, 0);
}

function moneyMatchesBudget(value: MonetaryValue, budget: CommercialBudget): boolean {
  return budget.resourceType === 'MONEY' && (budget.currency === undefined || budget.currency === value.currency);
}

function withinBudgetPeriod(timestamp: number, period: CommercialBudget['period'], now: number): boolean {
  if (period === 'LIFETIME' || period === 'EXPERIMENT') return true;
  const duration = period === 'DAILY' ? 86_400_000 : period === 'WEEKLY' ? 604_800_000 : 2_592_000_000;
  return timestamp >= now - duration && timestamp <= now;
}

function experimentBudgetExceeded(budget: CommercialExperiment['budget'], cost: readonly ResourceRequirement[], startedAt: number | undefined, now: number): boolean {
  if (startedAt !== undefined && now - startedAt >= budget.maximumDurationMs) return true;
  const money = budget.maximumMonetaryCost
    ? cost.filter((item) => item.resourceType === 'MONEY' && item.currency === budget.maximumMonetaryCost!.currency).reduce((sum, item) => sum + item.amount, 0)
    : 0;
  if (budget.maximumMonetaryCost && money >= budget.maximumMonetaryCost.amount) return true;
  const compute = cost.filter((item) => item.resourceType === 'COMPUTE').reduce((sum, item) => sum + item.amount, 0);
  if (budget.maximumComputeCost !== undefined && compute >= budget.maximumComputeCost) return true;
  const api = cost.filter((item) => item.resourceType === 'API_CALLS').reduce((sum, item) => sum + item.amount, 0);
  return budget.maximumApiConsumption !== undefined && api >= budget.maximumApiConsumption;
}

function systemProvenance(source: string, now: number, correlationId: string): CommercialProvenance {
  return { source, collectedAt: now, correlationId };
}

function hashLedgerEntry(entry: CommercialActionLedgerEntry): string {
  return createHash('sha256').update(stableStringify(entry)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  // JSON persistence omits undefined object properties, so the ledger hash must
  // do the same or a valid persisted/reloaded entry would appear tampered with.
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

/**
 * F-01f enveloped cutover: rebuild the `CommercialEvent` view a legacy
 * subscriber expects from a first-class envelope (metadata from the envelope,
 * content from its payload). When the envelope content already IS a legacy
 * `CommercialEvent` (bridge-synthesized from a raw `CommercialEvent` emit by
 * a not-yet-migrated producer), it is returned as-is. Never grants authority:
 * pure data reconstruction for migrated consumers.
 */
export function commercialEventFromEnvelope(envelope: EventEnvelope): CommercialEvent {
  const inner = envelope.payload as Partial<CommercialEvent> | undefined;
  if (isCommercialEventShape(inner)) return inner as CommercialEvent;
  const content: Record<string, unknown> =
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? (inner as Record<string, unknown>)
      : {};
  return {
    id: envelope.id,
    // First-class commercial envelopes always carry a sequence; unsequenced
    // bridge deliveries (plain-payload producers) report 0 rather than a
    // fabricated order position.
    sequence: envelope.sequence ?? 0,
    eventType: envelope.eventType,
    eventVersion: envelope.eventVersion,
    tenantId: envelope.tenantId,
    source: envelope.source,
    ...(envelope.actor !== undefined ? { actor: envelope.actor } : {}),
    ...(envelope.entityId !== undefined ? { entityId: envelope.entityId } : {}),
    timestamp: envelope.timestamp,
    correlationId: envelope.correlationId,
    ...(envelope.causationId !== undefined ? { causationId: envelope.causationId } : {}),
    payload: content,
    schemaVersion: envelope.schemaVersion,
    provenance: envelope.provenance,
    privacyClassification: envelope.privacyClassification,
    ...(envelope.idempotencyKey !== undefined ? { idempotencyKey: envelope.idempotencyKey } : {}),
  };
}

function isCommercialEventShape(value: unknown): value is CommercialEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Partial<CommercialEvent>;
  return (
    typeof event.id === 'string' &&
    typeof event.tenantId === 'string' &&
    typeof event.eventType === 'string' &&
    typeof event.eventVersion === 'number' &&
    typeof event.schemaVersion === 'number' &&
    typeof event.source === 'string' &&
    typeof event.correlationId === 'string' &&
    typeof event.timestamp === 'number' &&
    event.payload !== null &&
    typeof event.payload === 'object'
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
