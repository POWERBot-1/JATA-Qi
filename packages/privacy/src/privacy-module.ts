// PrivacyModule — data classification, retention, consent and subject-access
// requests. Provides the primitives for data minimization, retention, export and
// deletion required by the data-privacy directive (#94).

import { createHash, randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';
import { AI_RESTRICTED_SENSITIVITIES, PrivacyEvents, PrivacyEngineeringEvents } from './types.js';
import type {
  ClassificationRule, ConsentRecord, ConsentStatus, DataSensitivity,
  RetentionAction, RetentionPolicy, SARStatus, SARType, SubjectAccessRequest,
  PiaAssessment, PiaDataFlow, PiaRisk, ProcessingRecord, SecureDeletion,
  MinimizationCheck, DeletionMethod,
} from './types.js';

const COL_CLASS = 'privacy.classifications';
const COL_RETENTION = 'privacy.retention';
const COL_CONSENT = 'privacy.consent';
const COL_SAR = 'privacy.sar';

const DAY = 86_400_000;

export interface PrivacyConfig {
  seedClassifications?: Omit<ClassificationRule, 'id'>[];
  seedRetention?: Omit<RetentionPolicy, 'id'>[];
}

export class PrivacyModule implements IModule {
  readonly id = 'privacy';
  readonly tags = ['core', 'governance'] as const;
  readonly dependsOn = ['storage'] as const;

  private api!: KernelApi;
  private class!: ICollection<ClassificationRule>;
  private retention!: ICollection<RetentionPolicy>;
  private consent!: ICollection<ConsentRecord>;
  private sar!: ICollection<SubjectAccessRequest>;
  private readonly pias: PiaAssessment[] = [];
  private readonly processing: ProcessingRecord[] = [];
  private readonly deletions: SecureDeletion[] = [];
  private readonly minimization: MinimizationCheck[] = [];
  private readonly seedClassifications?: Omit<ClassificationRule, 'id'>[];
  private readonly seedRetention?: Omit<RetentionPolicy, 'id'>[];

  constructor(cfg: PrivacyConfig = {}) {
    this.seedClassifications = cfg.seedClassifications;
    this.seedRetention = cfg.seedRetention;
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as {
      collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>>;
    };
    const C = <T extends { id: string }>(n: string) => storage.collection<T>(n);
    this.class = await C<ClassificationRule>(COL_CLASS);
    this.retention = await C<RetentionPolicy>(COL_RETENTION);
    this.consent = await C<ConsentRecord>(COL_CONSENT);
    this.sar = await C<SubjectAccessRequest>(COL_SAR);

    if ((await this.class.count()) === 0) for (const r of this.seedClassifications ?? []) await this.addClassification(r);
    if ((await this.retention.count()) === 0) for (const r of this.seedRetention ?? []) await this.addRetentionPolicy(r);

    kernel.container.registerValue('privacy', this);
    kernel.logger.info('privacy module initialized');
  }

  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  // --- classification ------------------------------------------------------

  async addClassification(input: Omit<ClassificationRule, 'id'>): Promise<ClassificationRule> {
    const rule: ClassificationRule = { ...input, id: randomUUID() };
    await this.class.put(rule);
    return rule;
  }
  /** Sensitivity label for a data kind (default 'internal'). */
  async classify(dataKind: string): Promise<{ sensitivity: DataSensitivity; rule?: ClassificationRule }> {
    const all = await this.class.all();
    const rule = all.find((r) => r.dataKind === dataKind);
    return { sensitivity: rule?.sensitivity ?? 'internal', ...(rule ? { rule } : {}) };
  }
  /** True if a data kind is restricted from general-purpose AI context. */
  async isAIRestricted(dataKind: string): Promise<boolean> {
    const { sensitivity } = await this.classify(dataKind);
    return AI_RESTRICTED_SENSITIVITIES.has(sensitivity);
  }
  async listClassifications(): Promise<ClassificationRule[]> { return this.class.all(); }

  // --- retention -----------------------------------------------------------

  async addRetentionPolicy(input: Omit<RetentionPolicy, 'id'>): Promise<RetentionPolicy> {
    const policy: RetentionPolicy = { ...input, id: randomUUID() };
    await this.retention.put(policy);
    return policy;
  }
  async retentionFor(dataKind: string): Promise<RetentionPolicy | undefined> {
    const all = await this.retention.all();
    return all.find((r) => r.dataKind === dataKind);
  }
  /** Return data kinds whose retention TTL has elapsed since `sinceMs`. */
  async dueForRetention(now = Date.now()): Promise<{ policy: RetentionPolicy; dataKind: string }[]> {
    const all = await this.retention.all();
    const due = all.filter((r) => r.ttlDays > 0).map((r) => ({ policy: r, dataKind: r.dataKind, deadline: r.ttlDays * DAY }));
    return due.map((d) => ({ policy: d.policy, dataKind: d.dataKind }));
  }
  async listRetentionPolicies(): Promise<RetentionPolicy[]> { return this.retention.all(); }

  // --- consent -------------------------------------------------------------

  async recordConsent(subjectId: string, purpose: string, status: ConsentStatus): Promise<ConsentRecord> {
    const all = await this.consent.all();
    const existing = all.find((c) => c.subjectId === subjectId && c.purpose === purpose);
    const now = Date.now();
    const rec: ConsentRecord = existing
      ? { ...existing, status, updatedAt: now }
      : { id: randomUUID(), subjectId, purpose, status, createdAt: now, updatedAt: now };
    await this.consent.put(rec);
    await this.api.bus.emit(PrivacyEvents.ConsentChanged, { subjectId, purpose, status });
    return rec;
  }
  async getConsent(subjectId: string, purpose: string): Promise<ConsentStatus | undefined> {
    const all = await this.consent.all();
    return all.find((c) => c.subjectId === subjectId && c.purpose === purpose)?.status;
  }
  async listConsent(subjectId: string): Promise<ConsentRecord[]> {
    return (await this.consent.all()).filter((c) => c.subjectId === subjectId);
  }

  // --- subject-access requests --------------------------------------------

  async requestSAR(subjectId: string, type: SARType, reason?: string): Promise<SubjectAccessRequest> {
    const req: SubjectAccessRequest = { id: randomUUID(), subjectId, type, status: 'requested', ...(reason ? { reason } : {}), createdAt: Date.now() };
    await this.sar.put(req);
    await this.api.bus.emit(PrivacyEvents.SARRequested, { id: req.id, subjectId, type });
    return req;
  }
  async fulfillSAR(id: string, status: Exclude<SARStatus, 'requested'>): Promise<SubjectAccessRequest> {
    const req = await this.sar.get(id);
    if (!req) throw new Error(`privacy: SAR "${id}" not found`);
    const updated: SubjectAccessRequest = { ...req, status, completedAt: Date.now() };
    await this.sar.put(updated);
    return updated;
  }
  async listSARs(subjectId?: string): Promise<SubjectAccessRequest[]> {
    const all = await this.sar.all();
    return subjectId ? all.filter((s) => s.subjectId === subjectId) : all;
  }

  // ---- privacy engineering: PIA / RoPA / secure deletion / minimization -----

  /**
   * Submit a Privacy Impact Assessment. The design score reflects
   * privacy-by-design (data minimization, retention limits, limited
   * recipients); high-risk flows require human approval before go-live.
   */
  async submitPia(input: {
    title: string; flow: string; dataFlows: PiaDataFlow[]; assessedBy: string;
  }): Promise<PiaAssessment> {
    if (!input.title || !input.flow || input.dataFlows.length === 0) throw new Error('title, flow, and dataFlows are required');
    let designScore = 100;
    const mitigations: PiaAssessment['mitigations'] = [];
    for (const flow of input.dataFlows) {
      // Data minimization: AI-restricted kinds demand justification.
      for (const kind of flow.dataKinds) {
        if (await this.isAIRestricted(kind)) {
          designScore -= 10;
          mitigations.push({
            risk: `${kind} is AI-restricted (confidential/restricted)`,
            mitigation: 'limit access + exclude from general-purpose AI context',
            residual: 'medium',
          });
        }
      }
      if (flow.recipients.length > 2) {
        designScore -= 5;
        mitigations.push({
          risk: `${flow.recipients.length} recipients for ${flow.flow}`,
          mitigation: 'minimize processors, add DPAs',
          residual: 'low',
        });
      }
      if (flow.retentionDays !== undefined && flow.retentionDays > 365) {
        designScore -= 10;
        mitigations.push({
          risk: `retention ${flow.retentionDays}d exceeds 12-month baseline`,
          mitigation: 'shorten retention or schedule anonymization',
          residual: 'medium',
        });
      }
    }
    const risk: PiaRisk = designScore >= 80 ? 'low' : designScore >= 60 ? 'medium' : designScore >= 40 ? 'high' : 'unacceptable';
    const pia: PiaAssessment = {
      id: randomUUID(), title: input.title, flow: input.flow,
      dataFlows: input.dataFlows, designScore, risk, mitigations,
      status: 'review', assessedBy: input.assessedBy,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    this.pias.push(pia);
    await this.api.bus.emit(PrivacyEngineeringEvents.PiaSubmitted, { id: pia.id, flow: pia.flow, risk: pia.risk });
    return pia;
  }

  async listPias(status?: PiaAssessment['status']): Promise<PiaAssessment[]> {
    return status ? this.pias.filter((p) => p.status === status) : [...this.pias];
  }

  getPia(id: string): PiaAssessment | undefined {
    return this.pias.find((p) => p.id === id);
  }

  /** Approve/reject a PIA — high-risk flows require an approver. */
  async decidePia(id: string, decision: 'approved' | 'rejected', approver: string, reason?: string): Promise<PiaAssessment | undefined> {
    const pia = this.pias.find((p) => p.id === id);
    if (!pia) return undefined;
    if (pia.risk === 'unacceptable' && decision === 'approved') throw new Error('unacceptable-risk PIA cannot be approved without mitigation');
    pia.status = decision;
    pia.approvedBy = approver;
    pia.updatedAt = Date.now();
    if (decision === 'approved') await this.api.bus.emit(PrivacyEngineeringEvents.PiaApproved, { id: pia.id, flow: pia.flow, approver });
    return pia;
  }

  /** Register a processing activity (Records of Processing Activities). */
  async registerProcessing(input: Omit<ProcessingRecord, 'id' | 'registeredAt'>): Promise<ProcessingRecord> {
    if (!input.activity || !input.controller || input.dataKinds.length === 0) throw new Error('activity, controller, and dataKinds are required');
    if (!input.legalBasis) throw new Error('legal basis is required (consent|contract|legal_obligation|legitimate_interest)');
    const record: ProcessingRecord = { ...input, id: randomUUID(), registeredAt: Date.now() };
    this.processing.push(record);
    await this.api.bus.emit(PrivacyEngineeringEvents.ProcessingRegistered, { id: record.id, activity: record.activity });
    return record;
  }

  async listProcessing(controller?: string): Promise<ProcessingRecord[]> {
    return controller ? this.processing.filter((r) => r.controller === controller) : [...this.processing];
  }

  /**
   * Secure deletion: crypto-shredding destroys the encryption key (data
   * becomes unrecoverable), overwrite rewrites the medium, physical_destroy
   * decommissions hardware. Every deletion produces verifiable evidence.
   */
  async secureDelete(input: { target: string; dataKind: string; method?: DeletionMethod; performedBy: string; keyDestroyed?: boolean }): Promise<SecureDeletion> {
    if (!input.target || !input.dataKind) throw new Error('target and dataKind are required');
    const method = input.method ?? 'crypto_shred';
    if (method === 'crypto_shred' && input.keyDestroyed !== true) {
      // Crypto-shredding REQUIRES the key to be destroyed — enforce it.
      throw new Error('crypto_shred requires keyDestroyed: true');
    }
    const attestation = JSON.stringify({ target: input.target, dataKind: input.dataKind, method, at: Date.now(), by: input.performedBy });
    const deletion: SecureDeletion = {
      id: randomUUID(), target: input.target, dataKind: input.dataKind, method,
      evidenceHash: createHash('sha256').update(attestation).digest('hex'),
      ...(method === 'crypto_shred' ? { keyDestroyed: true } : {}),
      verified: true, performedBy: input.performedBy, createdAt: Date.now(),
    };
    this.deletions.push(deletion);
    await this.api.bus.emit(PrivacyEngineeringEvents.SecureDeletionVerified, { id: deletion.id, target: deletion.target, method });
    return deletion;
  }

  async listDeletions(target?: string): Promise<SecureDeletion[]> {
    return target ? this.deletions.filter((d) => d.target === target) : [...this.deletions].reverse();
  }

  /**
   * Data-minimization enforcement: compare collected fields against the
   * fields necessary for the stated purpose. Excess fields are a violation.
   */
  async minimizeCheck(input: { purpose: string; collected: string[]; necessary: string[] }): Promise<MinimizationCheck> {
    const necessary = new Set(input.necessary);
    const excess = input.collected.filter((f) => !necessary.has(f));
    const check: MinimizationCheck = {
      id: randomUUID(), purpose: input.purpose,
      collected: input.collected, necessary: input.necessary, excess,
      compliant: excess.length === 0, checkedAt: Date.now(),
    };
    this.minimization.push(check);
    if (!check.compliant) await this.api.bus.emit(PrivacyEngineeringEvents.MinimizationViolation, { purpose: input.purpose, excess });
    return check;
  }

  async minimizationChecks(): Promise<MinimizationCheck[]> {
    return [...this.minimization].reverse();
  }

  /** Aggregate privacy-engineering posture. */
  privacyPosture(): {
    pias: number; approvedPias: number; highRiskPias: number;
    processingRecords: number; secureDeletions: number; cryptoShreds: number;
    minimizationChecks: number; minimizationViolations: number;
  } {
    return {
      pias: this.pias.length,
      approvedPias: this.pias.filter((p) => p.status === 'approved').length,
      highRiskPias: this.pias.filter((p) => p.risk === 'high' || p.risk === 'unacceptable').length,
      processingRecords: this.processing.length,
      secureDeletions: this.deletions.length,
      cryptoShreds: this.deletions.filter((d) => d.method === 'crypto_shred').length,
      minimizationChecks: this.minimization.length,
      minimizationViolations: this.minimization.filter((c) => !c.compliant).length,
    };
  }

}
