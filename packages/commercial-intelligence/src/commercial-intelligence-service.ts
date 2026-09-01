import { randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import { CommercialAnalyticsModule } from '@jataqi/commercial-analytics';
import type { CommercialAnalyticsService, CommercialAnalyticsSnapshot } from '@jataqi/commercial-analytics';
import { CommercialControlPlaneModule } from '@jataqi/commercial-control-plane';
import type { CommercialActor, CommercialControlPlaneService, CommercialEvidence, CommercialProvenance, EvidenceStatus } from '@jataqi/commercial-control-plane';
import {
  CommercialIntelligenceEvents,
  type CommercialOpportunity,
  type CommercialReadinessReport,
  type CreateOpportunityInput,
  type EstimateRange,
  type EvaluateReadinessInput,
  type OpportunityFactors,
  type OpportunityRecommendation,
  type ReadinessRequirement,
} from './types.js';

const OPPORTUNITIES_COLLECTION = 'commercial-intelligence.opportunities';
const READINESS_COLLECTION = 'commercial-intelligence.readiness';
const FACTUAL_EVIDENCE = new Set<EvidenceStatus>(['OBSERVED', 'MEASURED', 'CUSTOMER_CONFIRMED', 'DEMONSTRATED', 'REPEATED', 'VERIFIED']);

export class CommercialIntelligenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommercialIntelligenceError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Evidence-bound commercial reasoning. It can score and recommend, including
 * deliberate no-action outcomes, but it cannot create ventures, spend money,
 * publish content, or execute a commercial action.
 */
export class CommercialIntelligenceService {
  private opportunities!: ICollection<CommercialOpportunity>;
  private readiness!: ICollection<CommercialReadinessReport>;
  private controlPlane!: CommercialControlPlaneService;
  private analytics!: CommercialAnalyticsService;

  async init(kernel: KernelApi): Promise<void> {
    const storage = kernel.getModule<StorageModule>('storage');
    this.opportunities = await storage.collection<CommercialOpportunity>(OPPORTUNITIES_COLLECTION);
    this.readiness = await storage.collection<CommercialReadinessReport>(READINESS_COLLECTION);
    this.controlPlane = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
    this.analytics = kernel.getModule<CommercialAnalyticsModule>('commercial-analytics').getService();
  }

  async createOpportunity(actor: CommercialActor, input: CreateOpportunityInput): Promise<CommercialOpportunity> {
    assertManager(actor);
    validateInput(input);
    const now = Date.now();
    const scores = scoreOpportunity(input.factors, input.evidence);
    const recommendation = recommendationFor(scores.opportunityScore, scores.confidenceScore, scores.riskScore, input.evidence);
    const opportunity: CommercialOpportunity = {
      id: randomUUID(), tenantId: actor.tenantId, title: input.title, description: input.description, market: input.market, targetCustomer: input.targetCustomer,
      evidence: copy(input.evidence), factors: copy(input.factors), opportunityScore: scores.opportunityScore, confidenceScore: scores.confidenceScore, riskScore: scores.riskScore,
      expectedRevenue: copy(input.expectedRevenue), expectedCost: copy(input.expectedCost), expectedTimeToRevenueDays: copy(input.expectedTimeToRevenueDays),
      state: stateForRecommendation(recommendation.kind), recommendation: recommendation.kind, recommendationReason: recommendation.reason, provenance: copy(input.provenance),
      createdAt: now, updatedAt: now,
    };
    await this.opportunities.put(opportunity);
    await this.emit(actor, CommercialIntelligenceEvents.OpportunityScored, opportunity.id, { opportunityId: opportunity.id, score: opportunity.opportunityScore, confidence: opportunity.confidenceScore, risk: opportunity.riskScore });
    await this.emit(actor, CommercialIntelligenceEvents.OpportunityRecommendation, opportunity.id, { opportunityId: opportunity.id, recommendation: opportunity.recommendation, reason: opportunity.recommendationReason });
    return copy(opportunity);
  }

  /** Expose source analytics without transforming it into a decision or fact. */
  async currentEconomics(actor: CommercialActor): Promise<CommercialAnalyticsSnapshot> {
    return this.analytics.snapshot(actor);
  }

  /** A high score cannot override an unmet hard requirement. */
  async evaluateReadiness(actor: CommercialActor, input: EvaluateReadinessInput): Promise<CommercialReadinessReport> {
    assertManager(actor);
    if (!input.productId.trim() || !input.provenance.source.trim()) throw new CommercialIntelligenceError('Product id and readiness provenance are required.');
    const required = requiredReadinessRequirements();
    const present = new Set(input.requirements.map((item) => item.requirement));
    const missing = required.filter((item) => !present.has(item));
    if (missing.length > 0) throw new CommercialIntelligenceError(`Readiness assessment is missing requirements: ${missing.join(', ')}.`);
    if (present.size !== input.requirements.length) throw new CommercialIntelligenceError('Readiness assessment contains duplicate requirements.');
    for (const item of input.requirements) {
      if (!item.evidence.length) throw new CommercialIntelligenceError(`Readiness requirement ${item.requirement} requires evidence.`);
    }
    const score = round((input.requirements.filter((item) => item.passed).length / input.requirements.length) * 100);
    const hardFailures = input.requirements.filter((item) => !item.passed && item.hardBlocker);
    const softFailures = input.requirements.filter((item) => !item.passed && !item.hardBlocker);
    const status = hardFailures.length > 0 ? 'BLOCKED' : softFailures.length > 0 ? 'HUMAN_REVIEW' : 'GO';
    const report: CommercialReadinessReport = { id: randomUUID(), tenantId: actor.tenantId, productId: input.productId, score, status, requirements: copy(input.requirements), createdAt: Date.now(), provenance: copy(input.provenance) };
    await this.readiness.put(report);
    await this.emit(actor, CommercialIntelligenceEvents.ReadinessEvaluated, report.id, { reportId: report.id, productId: report.productId, score, status, hardBlockers: hardFailures.map((item) => item.requirement), softFailures: softFailures.map((item) => item.requirement) });
    return copy(report);
  }

  async getOpportunity(actor: CommercialActor, id: string): Promise<CommercialOpportunity | undefined> {
    const opportunity = await this.opportunities.get(id);
    return opportunity && canRead(actor, opportunity.tenantId) ? copy(opportunity) : undefined;
  }

  async listOpportunities(actor: CommercialActor): Promise<CommercialOpportunity[]> {
    return (await this.opportunities.all()).filter((opportunity) => canRead(actor, opportunity.tenantId)).map(copy);
  }

  async getReadiness(actor: CommercialActor, id: string): Promise<CommercialReadinessReport | undefined> {
    const report = await this.readiness.get(id);
    return report && canRead(actor, report.tenantId) ? copy(report) : undefined;
  }

  async listReadiness(actor: CommercialActor): Promise<CommercialReadinessReport[]> {
    return (await this.readiness.all()).filter((report) => canRead(actor, report.tenantId)).map(copy);
  }

  private async emit(actor: CommercialActor, eventType: string, entityId: string, payload: Record<string, unknown>): Promise<void> {
    const now = Date.now();
    const provenance: CommercialProvenance = { source: 'commercial-intelligence', collectedAt: now, correlationId: entityId };
    await this.controlPlane.publishEvent(actor, { eventType, source: 'commercial-intelligence', entityId, correlationId: entityId, payload, provenance, privacyClassification: 'INTERNAL', idempotencyKey: `${eventType}:${entityId}` });
  }
}

function scoreOpportunity(factors: OpportunityFactors, evidence: readonly CommercialEvidence[]): { opportunityScore: number; confidenceScore: number; riskScore: number } {
  const positive = [factors.demand, factors.monetization, factors.marketSize, factors.competitionGap, factors.buildability, factors.distributionPotential, factors.retentionPotential, factors.grossMarginPotential, factors.capitalEfficiency, factors.timeToMarket, factors.defensibility];
  const positiveScore = positive.reduce((sum, score) => sum + score, 0) / positive.length;
  const riskScore = round((factors.technicalRisk + factors.regulatoryRisk) / 2);
  const opportunityScore = round(Math.max(0, Math.min(100, positiveScore * 0.8 + factors.grossMarginPotential * 0.1 + factors.capitalEfficiency * 0.1 - riskScore * 0.25)));
  const factual = evidence.filter((item) => FACTUAL_EVIDENCE.has(item.status));
  const confidenceScore = round((evidence.reduce((sum, item) => sum + item.confidence, 0) / evidence.length) * (factual.length / evidence.length));
  return { opportunityScore, confidenceScore, riskScore };
}

function recommendationFor(score: number, confidence: number, risk: number, evidence: readonly CommercialEvidence[]): { kind: OpportunityRecommendation; reason: string } {
  const factualCount = evidence.filter((item) => FACTUAL_EVIDENCE.has(item.status)).length;
  if (factualCount === 0 || confidence < 40) return { kind: 'WAIT_FOR_EVIDENCE', reason: 'Evidence is insufficiently observed/measured to support a commercial action.' };
  if (risk >= 80) return { kind: 'HUMAN_REVIEW', reason: 'Technical or regulatory risk is high enough to require human review.' };
  if (score >= 70 && confidence >= 70) return { kind: 'PURSUE_VALIDATION', reason: 'Opportunity score and evidence confidence support bounded validation, not automatic launch.' };
  if (score >= 45) return { kind: 'RUN_EXPERIMENT', reason: 'Opportunity merits a bounded experiment before further commitment.' };
  return { kind: 'DO_NOT_PURSUE', reason: 'Current evidence-adjusted score does not justify resource commitment.' };
}

function stateForRecommendation(recommendation: OpportunityRecommendation): CommercialOpportunity['state'] {
  switch (recommendation) {
    case 'PURSUE_VALIDATION': return 'VALIDATING';
    case 'RUN_EXPERIMENT': return 'VALIDATING';
    case 'HUMAN_REVIEW': return 'APPROVAL_REQUIRED';
    case 'DO_NOT_PURSUE': return 'REJECTED';
    case 'WAIT_FOR_EVIDENCE': return 'DISCOVERED';
  }
}

function validateInput(input: CreateOpportunityInput): void {
  if (!input.title.trim() || !input.description.trim() || !input.evidence.length || !input.provenance.source.trim()) throw new CommercialIntelligenceError('Opportunity title, description, evidence, and provenance are required.');
  for (const [name, value] of Object.entries(input.factors)) assertScore(value, `Opportunity factor ${name}`);
  for (const range of [input.expectedRevenue, input.expectedCost, input.expectedTimeToRevenueDays]) validateRange(range);
}

function validateRange(range: EstimateRange): void {
  if (!Number.isFinite(range.low) || !Number.isFinite(range.likely) || !Number.isFinite(range.high) || range.low < 0 || range.low > range.likely || range.likely > range.high || !range.calculationMethod.trim()) throw new CommercialIntelligenceError('Estimate range must have non-negative low <= likely <= high values and a calculation method.');
}

function requiredReadinessRequirements(): ReadinessRequirement[] {
  return ['PRODUCT_READY', 'PMF_READY', 'TRUST_READY', 'PROOF_READY', 'CONVERSION_READY', 'PAYMENT_READY', 'IDENTITY_READY', 'PLATFORM_READY', 'PERMISSIONS_READY', 'COMPLIANCE_READY', 'TELEMETRY_READY', 'ECONOMICS_READY', 'SECURITY_READY', 'RECOVERY_READY', 'GOVERNANCE_READY', 'KILL_SWITCH_READY', 'SUPPORT_READY'];
}

function assertScore(value: number, name: string): void { if (!Number.isFinite(value) || value < 0 || value > 100) throw new CommercialIntelligenceError(`${name} must be from 0 to 100.`); }
function round(value: number): number { return Math.round(value * 10000) / 10000; }
function assertManager(actor: CommercialActor): void { if (!actor.roles.some((role) => ['observer', 'agent', 'operator', 'admin', 'global_admin', 'system'].includes(role))) throw new CommercialIntelligenceError('Commercial actor role is required.'); }
function canRead(actor: CommercialActor, tenantId: string): boolean { return actor.tenantId === tenantId || actor.roles.includes('global_admin'); }
function copy<T>(value: T): T { return structuredClone(value); }
