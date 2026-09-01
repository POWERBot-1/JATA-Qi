import { createHash, randomUUID } from 'node:crypto';
import type { KernelApi } from '@jataqi/core-kernel';
import { StorageModule } from '@jataqi/storage';
import type { ICollection } from '@jataqi/storage';
import { CognitiveKernelModule } from '@jataqi/cognitive-kernel';
import type { CognitiveKernelService } from '@jataqi/cognitive-kernel';
import { ReproducibilityModule } from '@jataqi/reproducibility';
import type { ReproducibilityService } from '@jataqi/reproducibility';
import type {
  CommercialActor,
  CommercialEvidence,
  CommercialProvenance,
  PrivacyClassification,
} from '@jataqi/commercial-control-plane';
import {
  ResearchEvidenceEvents,
  type CreateResearchClaimInput,
  type RecordResearchEvidenceInput,
  type ResearchClaim,
  type ResearchClaimAssessment,
  type ResearchClaimStatus,
  type ResearchDomain,
  type ResearchEpistemicStatus,
  type ResearchEvidenceIntegrityResult,
  type ResearchEvidenceKind,
  type ResearchEvidenceRecord,
  type ResearchNextStep,
  type ResearchSafetyClassification,
} from './types.js';

const CLAIMS_COLLECTION = 'research-evidence.claims';
const RECORDS_COLLECTION = 'research-evidence.records';
const ASSESSMENTS_COLLECTION = 'research-evidence.assessments';
const MAX_EVIDENCE = 100;
const MAX_TEXT_LIST = 20;
const RESEARCH_DOMAINS = new Set<ResearchDomain>(['GENERAL', 'SOFTWARE', 'MATERIALS', 'LIFE_SCIENCES', 'MEDICAL', 'AEROSPACE', 'NUCLEAR', 'SEMICONDUCTOR']);
const SAFETY_CLASSIFICATIONS = new Set<ResearchSafetyClassification>(['STANDARD', 'SENSITIVE', 'REGULATED_OR_HAZARDOUS']);
const EVIDENCE_KINDS = new Set<ResearchEvidenceKind>(['OBSERVATION', 'MEASUREMENT', 'SIMULATION', 'ANALYSIS', 'LITERATURE', 'REPLICATION', 'EXPERT_REVIEW', 'REGULATORY_RECORD']);
const EPISTEMIC_STATUSES = new Set<ResearchEpistemicStatus>(['OBSERVED', 'INFERRED', 'HYPOTHESIZED', 'SIMULATED', 'UNKNOWN']);
const EVIDENCE_STATUSES = new Set<CommercialEvidence['status']>([
  'UNVERIFIED', 'PARTIAL', 'OBSERVED', 'MEASURED', 'CUSTOMER_CONFIRMED', 'DEMONSTRATED', 'REPEATED', 'VERIFIED',
  'ESTIMATED', 'ASSUMPTION', 'PREDICTION', 'STALE', 'CONFLICTING', 'UNAVAILABLE',
]);
// Commercial customer confirmation is intentionally not treated as scientific
// evidence strength in this research registry.
const STRONG_EVIDENCE = new Set<CommercialEvidence['status']>(['MEASURED', 'DEMONSTRATED', 'REPEATED', 'VERIFIED']);
const PRIVACY_CLASSIFICATIONS = new Set<PrivacyClassification>(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'PERSONAL_DATA']);
const PRIVACY_RANK: Record<PrivacyClassification, number> = { PUBLIC: 0, INTERNAL: 1, CONFIDENTIAL: 2, RESTRICTED: 3, PERSONAL_DATA: 4 };
const REGULATED_DOMAINS = new Set<ResearchDomain>(['LIFE_SCIENCES', 'MEDICAL', 'AEROSPACE', 'NUCLEAR', 'SEMICONDUCTOR']);

export class ResearchEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResearchEvidenceError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Tenant-bound, evidence-first research registry. It stores concise metadata
 * and audit hashes only; it does not generate protocols, collect evidence,
 * run simulations, operate laboratory/fabrication equipment, or control any
 * physical or safety-critical system.
 */
export class ResearchEvidenceService {
  private api!: KernelApi;
  private cognitive!: CognitiveKernelService;
  private reproducibility!: ReproducibilityService;
  private claims!: ICollection<ResearchClaim>;
  private records!: ICollection<ResearchEvidenceRecord>;
  private assessments!: ICollection<ResearchClaimAssessment>;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule<StorageModule>('storage');
    this.claims = await storage.collection<ResearchClaim>(CLAIMS_COLLECTION);
    this.records = await storage.collection<ResearchEvidenceRecord>(RECORDS_COLLECTION);
    this.assessments = await storage.collection<ResearchClaimAssessment>(ASSESSMENTS_COLLECTION);
    this.cognitive = kernel.getModule<CognitiveKernelModule>('cognitive-kernel').getService();
    this.reproducibility = kernel.getModule<ReproducibilityModule>('reproducibility').getService();
  }

  async createClaim(actor: CommercialActor, input: CreateResearchClaimInput): Promise<ResearchClaim> {
    assertActor(actor);
    validateClaimInput(input);
    const state = await this.cognitive.getState(actor, input.cognitiveStateId);
    if (!state || state.tenantId !== actor.tenantId) {
      throw new ResearchEvidenceError('A cognitive state from the actor tenant is required for a research claim.');
    }
    const domain = input.domain;
    const safetyClassification = input.safetyClassification;
    if (REGULATED_DOMAINS.has(domain) && safetyClassification !== 'REGULATED_OR_HAZARDOUS') {
      throw new ResearchEvidenceError(`${domain} claims must be classified REGULATED_OR_HAZARDOUS for later qualified human/regulatory gating.`);
    }
    const now = Date.now();
    const claim: ResearchClaim = {
      id: randomUUID(),
      tenantId: actor.tenantId,
      cognitiveStateId: state.id,
      domain,
      safetyClassification,
      hypothesis: requiredText(input.hypothesis, 'Research hypothesis', 1_000),
      assumptions: textList(input.assumptions, 'Research claim assumptions'),
      limitations: textList(input.limitations, 'Research claim limitations'),
      privacyClassification: privacyClassification(input.privacyClassification),
      status: 'OPEN',
      provenance: sanitizeProvenance(input.provenance),
      createdAt: now,
      updatedAt: now,
    };
    await this.claims.put(claim);
    await this.api.bus.emit(ResearchEvidenceEvents.ClaimCreated, {
      claimId: claim.id,
      tenantId: claim.tenantId,
      domain: claim.domain,
      safetyClassification: claim.safetyClassification,
    });
    return copy(claim);
  }

  /**
   * Record high-level evidence metadata for a claim. The input is bounded to
   * concise summaries and references; it is not an experiment execution API.
   */
  async recordEvidence(actor: CommercialActor, input: RecordResearchEvidenceInput): Promise<ResearchEvidenceRecord> {
    assertActor(actor);
    validateEvidenceInput(input);
    const claim = await this.requireClaim(actor, input.claimId);
    const reproducibilityRecordIds = unique(textList(input.reproducibilityRecordIds ?? [], 'Reproducibility record ids', MAX_TEXT_LIST, 120));
    for (const recordId of reproducibilityRecordIds) {
      const reproducibility = await this.reproducibility.getRecord(actor, recordId);
      if (!reproducibility || reproducibility.tenantId !== claim.tenantId) {
        throw new ResearchEvidenceError(`Reproducibility record ${recordId} is not available in this tenant.`);
      }
    }
    if (input.kind === 'REPLICATION' && reproducibilityRecordIds.length === 0) {
      throw new ResearchEvidenceError('A REPLICATION evidence record requires at least one reproducibility-record reference.');
    }
    const privacy = privacyClassification(input.privacyClassification ?? claim.privacyClassification);
    if (PRIVACY_RANK[privacy] < PRIVACY_RANK[claim.privacyClassification]) {
      throw new ResearchEvidenceError('Evidence privacy classification cannot be less restrictive than its research claim.');
    }
    const record = await this.appendRecord({
      tenantId: claim.tenantId,
      claimId: claim.id,
      kind: input.kind,
      epistemicStatus: input.epistemicStatus,
      summary: requiredText(input.summary, 'Research evidence summary', 800),
      methodologySummary: requiredText(input.methodologySummary, 'Research methodology summary', 800),
      limitations: textList(input.limitations, 'Research evidence limitations'),
      evidence: sanitizeEvidenceList(input.evidence, true),
      reproducibilityRecordIds,
      safetyClassification: claim.safetyClassification,
      privacyClassification: privacy,
      provenance: sanitizeProvenance(input.provenance),
    });
    await this.claims.put({ ...claim, status: 'UNDER_REVIEW', updatedAt: record.createdAt });
    await this.api.bus.emit(ResearchEvidenceEvents.EvidenceRecorded, {
      claimId: claim.id,
      evidenceRecordId: record.id,
      tenantId: record.tenantId,
      kind: record.kind,
      epistemicStatus: record.epistemicStatus,
      safetyClassification: record.safetyClassification,
    });
    return copy(record);
  }

  /**
   * Deterministically assess stored metadata. A conditional support outcome is
   * explicitly not discovery, physical authorization, clinical advice, or a
   * replacement for expert/regulatory review.
   */
  async assessClaim(actor: CommercialActor, claimId: string): Promise<ResearchClaimAssessment> {
    assertActor(actor);
    const claim = await this.requireClaim(actor, claimId);
    const records = await this.recordsFor(claim.id);
    const flattenedEvidence = records.flatMap((record) => record.evidence);
    const now = Date.now();
    const strongEvidence = flattenedEvidence.filter((evidence) => STRONG_EVIDENCE.has(evidence.status) && evidence.status !== 'STALE' && (evidence.validUntil === undefined || evidence.validUntil >= now));
    const strongSources = new Set(strongEvidence.map((evidence) => normalize(evidence.source)));
    const hasConflictingEvidence = flattenedEvidence.some((evidence) => evidence.status === 'CONFLICTING');
    const simulationOnly = records.length > 0 && records.every((record) => record.kind === 'SIMULATION' || record.epistemicStatus === 'SIMULATED');
    const reproducibilityRecordIds = unique(records.flatMap((record) => record.reproducibilityRecordIds));
    const reproducibleRecordIds: string[] = [];
    for (const reproducibilityRecordId of reproducibilityRecordIds) {
      const record = await this.reproducibility.getRecord(actor, reproducibilityRecordId);
      if (record?.tenantId === claim.tenantId && record.status === 'REPRODUCIBLE') reproducibleRecordIds.push(reproducibilityRecordId);
    }
    const result = assessmentResult({
      recordCount: records.length,
      strongEvidenceCount: strongEvidence.length,
      independentStrongSourceCount: strongSources.size,
      hasConflictingEvidence,
      simulationOnly,
      reproducibleRecordIds,
      regulated: claim.safetyClassification === 'REGULATED_OR_HAZARDOUS',
    });
    const assessment: ResearchClaimAssessment = {
      id: randomUUID(),
      tenantId: claim.tenantId,
      claimId: claim.id,
      evidenceRecordIds: records.map((record) => record.id),
      evidenceIds: unique(flattenedEvidence.map((evidence) => evidence.id)),
      reproducibilityRecordIds,
      independentStrongSourceCount: strongSources.size,
      strongEvidenceCount: strongEvidence.length,
      simulationOnly,
      status: result.status,
      conclusionSummary: result.conclusionSummary,
      uncertaintySummary: result.uncertaintySummary,
      nextStep: result.nextStep,
      regulatedWorkRequiresHumanReview: claim.safetyClassification === 'REGULATED_OR_HAZARDOUS',
      physicalExecutionAuthorization: 'NOT_AUTHORIZED',
      createdAt: Date.now(),
    };
    await this.assessments.put(assessment);
    const claimStatus = claimStatusForAssessment(assessment.status);
    await this.claims.put({ ...claim, status: claimStatus, latestAssessmentId: assessment.id, updatedAt: assessment.createdAt });
    await this.api.bus.emit(ResearchEvidenceEvents.ClaimAssessed, {
      claimId: claim.id,
      assessmentId: assessment.id,
      status: assessment.status,
      nextStep: assessment.nextStep,
      physicalExecutionAuthorization: assessment.physicalExecutionAuthorization,
    });
    return copy(assessment);
  }

  async getClaim(actor: CommercialActor, claimId: string): Promise<ResearchClaim | undefined> {
    const claim = await this.claims.get(claimId);
    return claim && canRead(actor, claim.tenantId) ? copy(claim) : undefined;
  }

  async listClaims(actor: CommercialActor): Promise<ResearchClaim[]> {
    return sorted(await this.claims.query({ where: (claim) => canRead(actor, claim.tenantId) })).map(copy);
  }

  async listEvidence(actor: CommercialActor, claimId: string): Promise<ResearchEvidenceRecord[]> {
    const claim = await this.requireClaim(actor, claimId);
    return (await this.recordsFor(claim.id)).map(copy);
  }

  async listAssessments(actor: CommercialActor, claimId: string): Promise<ResearchClaimAssessment[]> {
    const claim = await this.requireClaim(actor, claimId);
    return sorted(await this.assessments.query({ where: (assessment) => assessment.claimId === claim.id })).map(copy);
  }

  /** Verify the tenant-local evidence metadata hash chain; no external evidence check is implied. */
  async verifyIntegrity(actor: CommercialActor, tenantId = actor.tenantId): Promise<ResearchEvidenceIntegrityResult> {
    assertActor(actor);
    if (tenantId !== actor.tenantId && !actor.roles.includes('global_admin')) throw new ResearchEvidenceError('Only a global administrator can verify another tenant ledger.');
    const records = await this.records.query({ where: (record) => record.tenantId === tenantId });
    const ordered = [...records].sort((first, second) => first.sequence - second.sequence || first.createdAt - second.createdAt || first.id.localeCompare(second.id));
    let previousHash = 'GENESIS';
    for (let index = 0; index < ordered.length; index += 1) {
      const record = ordered[index]!;
      if (record.sequence !== index + 1) return { tenantId, valid: false, recordCount: ordered.length, failure: `Unexpected sequence at record ${record.id}.` };
      if (record.previousHash !== previousHash) return { tenantId, valid: false, recordCount: ordered.length, failure: `Previous hash mismatch at record ${record.id}.` };
      if (record.hash !== hashRecord({ ...record, hash: '' })) return { tenantId, valid: false, recordCount: ordered.length, failure: `Hash mismatch at record ${record.id}.` };
      previousHash = record.hash;
    }
    return { tenantId, valid: true, recordCount: ordered.length };
  }

  private async requireClaim(actor: CommercialActor, claimId: string): Promise<ResearchClaim> {
    const claim = await this.getClaim(actor, claimId);
    if (!claim) throw new ResearchEvidenceError('Research claim not found.');
    return claim;
  }

  private async recordsFor(claimId: string): Promise<ResearchEvidenceRecord[]> {
    return sorted(await this.records.query({ where: (record) => record.claimId === claimId }));
  }

  private async appendRecord(input: Omit<ResearchEvidenceRecord, 'id' | 'sequence' | 'previousHash' | 'hash' | 'createdAt'>): Promise<ResearchEvidenceRecord> {
    const previous = (await this.records.query({ where: (record) => record.tenantId === input.tenantId, orderBy: 'sequence', order: 'desc', limit: 1 }))[0];
    const draft: Omit<ResearchEvidenceRecord, 'hash'> = {
      id: randomUUID(),
      ...copy(input),
      sequence: (previous?.sequence ?? 0) + 1,
      previousHash: previous?.hash ?? 'GENESIS',
      createdAt: Date.now(),
    };
    const record: ResearchEvidenceRecord = { ...draft, hash: hashRecord({ ...draft, hash: '' }) };
    await this.records.put(record);
    return record;
  }
}

function validateClaimInput(input: CreateResearchClaimInput): void {
  if (!input || typeof input !== 'object') throw new ResearchEvidenceError('Research claim input is required.');
  requiredText(input.cognitiveStateId, 'Cognitive state id', 120);
  if (!RESEARCH_DOMAINS.has(input.domain)) throw new ResearchEvidenceError('Research domain is invalid.');
  if (!SAFETY_CLASSIFICATIONS.has(input.safetyClassification)) throw new ResearchEvidenceError('Research safety classification is invalid.');
  requiredText(input.hypothesis, 'Research hypothesis', 1_000);
  textList(input.assumptions, 'Research claim assumptions');
  textList(input.limitations, 'Research claim limitations');
  privacyClassification(input.privacyClassification);
  sanitizeProvenance(input.provenance);
}

function validateEvidenceInput(input: RecordResearchEvidenceInput): void {
  if (!input || typeof input !== 'object') throw new ResearchEvidenceError('Research evidence input is required.');
  requiredText(input.claimId, 'Research claim id', 120);
  if (!EVIDENCE_KINDS.has(input.kind) || !EPISTEMIC_STATUSES.has(input.epistemicStatus)) throw new ResearchEvidenceError('Research evidence kind or epistemic status is invalid.');
  if (input.kind === 'SIMULATION' && input.epistemicStatus !== 'SIMULATED') throw new ResearchEvidenceError('SIMULATION evidence must remain explicitly SIMULATED.');
  if (input.kind !== 'SIMULATION' && input.epistemicStatus === 'SIMULATED') throw new ResearchEvidenceError('SIMULATED epistemic status is reserved for SIMULATION evidence records.');
  requiredText(input.summary, 'Research evidence summary', 800);
  requiredText(input.methodologySummary, 'Research methodology summary', 800);
  textList(input.limitations, 'Research evidence limitations');
  sanitizeEvidenceList(input.evidence, true);
  textList(input.reproducibilityRecordIds ?? [], 'Reproducibility record ids', MAX_TEXT_LIST, 120);
  privacyClassification(input.privacyClassification);
  sanitizeProvenance(input.provenance);
}

function assessmentResult(input: {
  recordCount: number;
  strongEvidenceCount: number;
  independentStrongSourceCount: number;
  hasConflictingEvidence: boolean;
  simulationOnly: boolean;
  reproducibleRecordIds: string[];
  regulated: boolean;
}): Pick<ResearchClaimAssessment, 'status' | 'conclusionSummary' | 'uncertaintySummary' | 'nextStep'> {
  const regulatedStep: ResearchNextStep | undefined = input.regulated ? 'REQUEST_HUMAN_REVIEW_AND_REGULATORY_GATE' : undefined;
  if (input.recordCount === 0) {
    return {
      status: 'INSUFFICIENT_EVIDENCE',
      conclusionSummary: 'No research evidence metadata is attached. The hypothesis remains unassessed and is not a fact or discovery.',
      uncertaintySummary: 'No supplied evidence record is available for deterministic assessment.',
      nextStep: regulatedStep ?? 'GATHER_EVIDENCE',
    };
  }
  if (input.hasConflictingEvidence) {
    return {
      status: 'CONFLICTING_EVIDENCE',
      conclusionSummary: 'At least one attached evidence record explicitly reports conflict. The registry retains the conflict and does not select a factual conclusion.',
      uncertaintySummary: 'Conflicting evidence requires qualified review and/or further independent evidence.',
      nextStep: regulatedStep ?? 'NO_ACTION',
    };
  }
  if (input.simulationOnly) {
    return {
      status: 'REPRODUCIBILITY_REQUIRED',
      conclusionSummary: 'Only simulated evidence metadata is attached. Simulation is not a physical result, discovery, or external validation.',
      uncertaintySummary: 'Independent reproduction and non-simulated evidence are required before conditional support can be assessed.',
      nextStep: regulatedStep ?? 'REQUEST_REPRODUCTION',
    };
  }
  if (input.strongEvidenceCount < 2 || input.independentStrongSourceCount < 2) {
    return {
      status: 'INSUFFICIENT_EVIDENCE',
      conclusionSummary: 'The claim lacks two current strong evidence records from independent sources, so it remains insufficiently supported.',
      uncertaintySummary: 'Correlation, a single source, or a supplied summary is not treated as proof.',
      nextStep: regulatedStep ?? 'GATHER_EVIDENCE',
    };
  }
  if (input.reproducibleRecordIds.length === 0) {
    return {
      status: 'REPRODUCIBILITY_REQUIRED',
      conclusionSummary: 'Strong evidence metadata exists, but no linked reproducible run is currently recorded. The hypothesis is not promoted to a discovery or fact.',
      uncertaintySummary: 'A reproducibility record may still mismatch or be incomplete; no independent physical replication is claimed.',
      nextStep: regulatedStep ?? 'REQUEST_REPRODUCTION',
    };
  }
  return {
    status: 'CONDITIONALLY_SUPPORTED',
    conclusionSummary: 'The recorded metadata conditionally supports further qualified review under the stated assumptions and limitations. It is not a discovery, fact, physical result, or execution authorization.',
    uncertaintySummary: 'Conditional support is limited to supplied evidence metadata and linked reproducibility status.',
    nextStep: regulatedStep ?? 'NO_ACTION',
  };
}

function claimStatusForAssessment(status: ResearchClaimAssessment['status']): ResearchClaimStatus {
  switch (status) {
    case 'INSUFFICIENT_EVIDENCE': return 'INSUFFICIENT_EVIDENCE';
    case 'CONFLICTING_EVIDENCE': return 'CONFLICTING_EVIDENCE';
    case 'REPRODUCIBILITY_REQUIRED': return 'REPRODUCIBILITY_REQUIRED';
    case 'CONDITIONALLY_SUPPORTED': return 'CONDITIONALLY_SUPPORTED';
  }
}

function sanitizeEvidenceList(value: unknown, required: boolean): CommercialEvidence[] {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE || (required && value.length === 0)) {
    throw new ResearchEvidenceError(`Evidence must be an array with ${required ? 'at least one and ' : ''}at most ${MAX_EVIDENCE} record(s).`);
  }
  const ids = new Set<string>();
  return value.map((item) => {
    const evidence = record(item, 'Evidence record');
    const id = requiredText(evidence.id, 'Evidence id', 120);
    if (ids.has(id)) throw new ResearchEvidenceError(`Duplicate evidence id ${id}.`);
    ids.add(id);
    const status = evidence.status;
    if (typeof status !== 'string' || !EVIDENCE_STATUSES.has(status as CommercialEvidence['status'])) throw new ResearchEvidenceError('Evidence status is invalid.');
    return {
      id,
      status: status as CommercialEvidence['status'],
      source: requiredText(evidence.source, 'Evidence source', 180),
      observedAt: finite(evidence.observedAt, 'Evidence observation time'),
      confidence: percent(evidence.confidence, 'Evidence confidence'),
      summary: requiredText(evidence.summary, 'Evidence summary', 640),
      provenance: sanitizeProvenance(evidence.provenance),
      validUntil: optionalFinite(evidence.validUntil, 'Evidence validity time'),
      privacyClassification: privacyClassification(evidence.privacyClassification),
    };
  });
}

function sanitizeProvenance(value: unknown): CommercialProvenance {
  const provenance = record(value, 'Provenance');
  return {
    source: requiredText(provenance.source, 'Provenance source', 180),
    collectedAt: finite(provenance.collectedAt, 'Provenance collection time'),
    correlationId: optionalText(provenance.correlationId, 'Provenance correlation id', 180),
    causationId: optionalText(provenance.causationId, 'Provenance causation id', 180),
    sourceReference: optionalText(provenance.sourceReference, 'Provenance source reference', 320),
    contentHash: optionalText(provenance.contentHash, 'Provenance content hash', 180),
  };
}

function privacyClassification(value: unknown): PrivacyClassification {
  if (value === undefined) return 'INTERNAL';
  if (typeof value !== 'string' || !PRIVACY_CLASSIFICATIONS.has(value as PrivacyClassification)) throw new ResearchEvidenceError('Privacy classification is invalid.');
  return value as PrivacyClassification;
}

function textList(value: unknown, name: string, maximumItems = MAX_TEXT_LIST, maximumLength = 320): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) throw new ResearchEvidenceError(`${name} must be an array with at most ${maximumItems} item(s).`);
  return unique(value.map((item) => requiredText(item, name, maximumLength)));
}

function requiredText(value: unknown, name: string, maximumLength: number): string {
  if (typeof value !== 'string') throw new ResearchEvidenceError(`${name} must be a string.`);
  const clean = value.trim().replace(/\s+/g, ' ');
  if (!clean) throw new ResearchEvidenceError(`${name} is required.`);
  return bounded(clean, maximumLength);
}

function optionalText(value: unknown, name: string, maximumLength: number): string | undefined {
  return value === undefined ? undefined : requiredText(value, name, maximumLength);
}

function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ResearchEvidenceError(`${name} must be finite.`);
  return value;
}

function optionalFinite(value: unknown, name: string): number | undefined {
  return value === undefined ? undefined : finite(value, name);
}

function percent(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw new ResearchEvidenceError(`${name} must be a finite number from 0 to 100.`);
  return value;
}

function assertActor(actor: CommercialActor): void {
  if (!actor || !actor.id.trim() || !actor.tenantId.trim() || !actor.roles.length) throw new ResearchEvidenceError('A tenant-bound research actor is required.');
}

function canRead(actor: CommercialActor, tenantId: string): boolean {
  return actor.tenantId === tenantId || actor.roles.includes('global_admin');
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

function sorted<T extends { id: string; createdAt: number }>(items: readonly T[]): T[] {
  return [...items].sort((first, second) => first.createdAt - second.createdAt || first.id.localeCompare(second.id));
}

function hashRecord(record: ResearchEvidenceRecord): string {
  return createHash('sha256').update(stable(record)).digest('hex');
}

function stable(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ResearchEvidenceError(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}
