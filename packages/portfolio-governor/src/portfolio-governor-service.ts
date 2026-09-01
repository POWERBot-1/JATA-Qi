import { randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import { CommercialControlPlaneModule } from '@jataqi/commercial-control-plane';
import type { CommercialActor, CommercialControlPlaneService, CommercialProvenance, ResourceRequirement } from '@jataqi/commercial-control-plane';
import {
  PortfolioEvents,
  type ConfigurePortfolioPolicyInput,
  type CreateResourceAllocationInput,
  type PortfolioAssessment,
  type PortfolioClassification,
  type PortfolioDecision,
  type PortfolioPolicy,
  type ProductPerformanceInput,
  type ResourceAllocationRecommendation,
} from './types.js';

const POLICIES_COLLECTION = 'portfolio-governor.policies';
const ASSESSMENTS_COLLECTION = 'portfolio-governor.assessments';
const ALLOCATIONS_COLLECTION = 'portfolio-governor.allocations';

export class PortfolioGovernorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PortfolioGovernorError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const defaultThresholds: Omit<PortfolioPolicy, 'id' | 'tenantId' | 'createdAt' | 'updatedAt'> = {
  winnerScore: 75, promisingScore: 60, stableScore: 45, pivotScore: 30, minimumConfidence: 60, maximumScaleRisk: 35,
};

/**
 * Produces explainable portfolio classifications and allocation recommendations.
 * It has no method that spends resources, changes a product state, or executes
 * a scale/pivot/retire action; those remain separate control-plane decisions.
 */
export class PortfolioGovernorService {
  private policies!: ICollection<PortfolioPolicy>;
  private assessments!: ICollection<PortfolioAssessment>;
  private allocations!: ICollection<ResourceAllocationRecommendation>;
  private controlPlane!: CommercialControlPlaneService;

  async init(kernel: KernelApi): Promise<void> {
    const storage = kernel.getModule<StorageModule>('storage');
    this.policies = await storage.collection<PortfolioPolicy>(POLICIES_COLLECTION);
    this.assessments = await storage.collection<PortfolioAssessment>(ASSESSMENTS_COLLECTION);
    this.allocations = await storage.collection<ResourceAllocationRecommendation>(ALLOCATIONS_COLLECTION);
    this.controlPlane = kernel.getModule<CommercialControlPlaneModule>('commercial-control-plane').getService();
  }

  async configurePolicy(actor: CommercialActor, input: ConfigurePortfolioPolicyInput): Promise<PortfolioPolicy> {
    assertAdministrator(actor);
    const thresholds = { ...defaultThresholds, ...input };
    validateThresholds(thresholds);
    const existing = (await this.policies.query({ where: (policy) => policy.tenantId === actor.tenantId, limit: 1 }))[0];
    const now = Date.now();
    const policy: PortfolioPolicy = existing
      ? { ...existing, ...thresholds, updatedAt: now }
      : { id: randomUUID(), tenantId: actor.tenantId, ...thresholds, createdAt: now, updatedAt: now };
    await this.policies.put(policy);
    return copy(policy);
  }

  async assess(actor: CommercialActor, input: ProductPerformanceInput): Promise<PortfolioAssessment> {
    assertManager(actor);
    validatePerformance(input);
    const policy = await this.policyFor(actor.tenantId);
    const performanceScore = round((input.growthScore * 0.15) + (input.contributionMarginScore * 0.2) + (input.retentionScore * 0.2) + (input.pmfScore * 0.2) + (input.strategicValueScore * 0.1) + (input.capitalEfficiencyScore * 0.15));
    const outcome = classify(performanceScore, input.confidenceScore, input.riskScore, input, policy);
    const assessment: PortfolioAssessment = {
      id: randomUUID(), tenantId: actor.tenantId, productId: input.productId, ventureId: input.ventureId, performanceScore,
      confidenceScore: input.confidenceScore, riskScore: input.riskScore, classification: outcome.classification, decision: outcome.decision,
      reason: outcome.reason, evidence: copy(input.evidence), provenance: copy(input.provenance), createdAt: Date.now(),
    };
    await this.assessments.put(assessment);
    await this.emit(actor, PortfolioEvents.Assessed, assessment.id, { assessmentId: assessment.id, productId: assessment.productId, classification: assessment.classification, decision: assessment.decision, performanceScore });
    return copy(assessment);
  }

  /** Recommendation only. No budget reservation or spend occurs in this module. */
  async recommendAllocation(actor: CommercialActor, input: CreateResourceAllocationInput): Promise<ResourceAllocationRecommendation> {
    assertManager(actor);
    const assessment = await this.requireAssessment(actor, input.assessmentId);
    if (assessment.classification === 'RETIRE') throw new PortfolioGovernorError('A retired portfolio candidate cannot receive a resource allocation recommendation.');
    validateResources(input.requestedResources);
    const recommendation: ResourceAllocationRecommendation = {
      id: randomUUID(), tenantId: assessment.tenantId, assessmentId: assessment.id, productId: assessment.productId,
      classification: assessment.classification, decision: assessment.decision,
      priorityScore: round(Math.max(0, assessment.performanceScore * 0.65 + assessment.confidenceScore * 0.25 - assessment.riskScore * 0.1)),
      requestedResources: copy(input.requestedResources), status: 'RECOMMENDATION_ONLY', rationale: `Recommendation follows ${assessment.classification}/${assessment.decision}; it requires a separate Commercial Control Plane authorization before resource consumption.`,
      evidence: copy(assessment.evidence), createdAt: Date.now(),
    };
    await this.allocations.put(recommendation);
    await this.emit(actor, PortfolioEvents.AllocationRecommended, recommendation.id, { recommendationId: recommendation.id, assessmentId: assessment.id, productId: assessment.productId, priorityScore: recommendation.priorityScore, status: recommendation.status });
    return copy(recommendation);
  }

  async getAssessment(actor: CommercialActor, id: string): Promise<PortfolioAssessment | undefined> {
    const assessment = await this.assessments.get(id);
    return assessment && canRead(actor, assessment.tenantId) ? copy(assessment) : undefined;
  }

  async listAssessments(actor: CommercialActor): Promise<PortfolioAssessment[]> {
    return (await this.assessments.all()).filter((assessment) => canRead(actor, assessment.tenantId)).map(copy);
  }

  async listAllocations(actor: CommercialActor): Promise<ResourceAllocationRecommendation[]> {
    return (await this.allocations.all()).filter((allocation) => canRead(actor, allocation.tenantId)).map(copy);
  }

  private async policyFor(tenantId: string): Promise<PortfolioPolicy> {
    const existing = (await this.policies.query({ where: (policy) => policy.tenantId === tenantId, limit: 1 }))[0];
    if (existing) return existing;
    const now = Date.now();
    return { id: `default:${tenantId}`, tenantId, ...defaultThresholds, createdAt: now, updatedAt: now };
  }

  private async requireAssessment(actor: CommercialActor, id: string): Promise<PortfolioAssessment> {
    const assessment = await this.getAssessment(actor, id);
    if (!assessment) throw new PortfolioGovernorError('Portfolio assessment not found.');
    return assessment;
  }

  private async emit(actor: CommercialActor, eventType: string, entityId: string, payload: Record<string, unknown>): Promise<void> {
    const now = Date.now();
    const provenance: CommercialProvenance = { source: 'portfolio-governor', collectedAt: now, correlationId: entityId };
    await this.controlPlane.publishEvent(actor, { eventType, source: 'portfolio-governor', entityId, correlationId: entityId, payload, provenance, privacyClassification: 'INTERNAL', idempotencyKey: `${eventType}:${entityId}` });
  }
}

function classify(score: number, confidence: number, risk: number, input: ProductPerformanceInput, policy: PortfolioPolicy): { classification: PortfolioClassification; decision: PortfolioDecision; reason: string } {
  if (confidence < policy.minimumConfidence) return { classification: 'PROMISING', decision: 'HOLD', reason: 'Evidence confidence is below the configured threshold; hold or gather more evidence before allocation.' };
  if (risk > policy.maximumScaleRisk && score >= policy.winnerScore) return { classification: 'PROMISING', decision: 'EXPERIMENT', reason: 'Performance is high but risk exceeds the scale boundary; run bounded experiments rather than scale.' };
  if (score >= policy.winnerScore) return { classification: 'WINNER', decision: 'SCALE', reason: 'Performance, confidence, and risk satisfy configured winner/scale thresholds.' };
  if (score >= policy.promisingScore) return { classification: 'PROMISING', decision: 'EXPERIMENT', reason: 'Evidence supports controlled experiments before scaling.' };
  if (score >= policy.stableScore) return { classification: 'STABLE', decision: 'HOLD', reason: 'Product is stable but does not yet meet promising/winner thresholds.' };
  if (score >= policy.pivotScore || input.pmfScore < 40 || input.retentionScore < 40) return { classification: 'PIVOT', decision: 'CHANGE_THESIS', reason: 'Performance or PMF/retention indicates a change thesis should be evaluated.' };
  return { classification: 'RETIRE', decision: 'RETIRE', reason: 'Evidence-adjusted performance is below the configured pivot threshold.' };
}

function validatePerformance(input: ProductPerformanceInput): void {
  if (!input.productId.trim() || !input.evidence.length || !input.provenance.source.trim()) throw new PortfolioGovernorError('Product id, evidence, and provenance are required for portfolio assessment.');
  for (const [name, score] of Object.entries({ growthScore: input.growthScore, contributionMarginScore: input.contributionMarginScore, retentionScore: input.retentionScore, pmfScore: input.pmfScore, confidenceScore: input.confidenceScore, riskScore: input.riskScore, strategicValueScore: input.strategicValueScore, capitalEfficiencyScore: input.capitalEfficiencyScore })) validateScore(score, name);
}

function validateThresholds(policy: Omit<PortfolioPolicy, 'id' | 'tenantId' | 'createdAt' | 'updatedAt'>): void {
  for (const [name, score] of Object.entries(policy)) validateScore(score, name);
  if (!(policy.winnerScore >= policy.promisingScore && policy.promisingScore >= policy.stableScore && policy.stableScore >= policy.pivotScore)) throw new PortfolioGovernorError('Portfolio score thresholds must be ordered winner >= promising >= stable >= pivot.');
}

function validateResources(resources: readonly ResourceRequirement[]): void {
  if (!resources.length) throw new PortfolioGovernorError('Allocation recommendation requires one or more resource requests.');
  for (const resource of resources) if (!Number.isFinite(resource.amount) || resource.amount < 0 || !resource.unit.trim()) throw new PortfolioGovernorError('Resource request amount and unit must be valid.');
}
function validateScore(score: number, name: string): void { if (!Number.isFinite(score) || score < 0 || score > 100) throw new PortfolioGovernorError(`${name} must be from 0 to 100.`); }
function round(value: number): number { return Math.round(value * 10000) / 10000; }
function assertAdministrator(actor: CommercialActor): void { if (!actor.roles.includes('admin') && !actor.roles.includes('global_admin')) throw new PortfolioGovernorError('Commercial administrator role is required.'); }
function assertManager(actor: CommercialActor): void { if (!actor.roles.some((role) => ['operator', 'admin', 'global_admin', 'system'].includes(role))) throw new PortfolioGovernorError('Commercial operator role is required.'); }
function canRead(actor: CommercialActor, tenantId: string): boolean { return actor.tenantId === tenantId || actor.roles.includes('global_admin'); }
function copy<T>(value: T): T { return structuredClone(value); }
