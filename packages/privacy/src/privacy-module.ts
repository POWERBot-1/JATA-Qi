// PrivacyModule — data classification, retention, consent and subject-access
// requests. Provides the primitives for data minimization, retention, export and
// deletion required by the data-privacy directive (#94).

import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';
import { AI_RESTRICTED_SENSITIVITIES, PrivacyEvents } from './types.js';
import type {
  ClassificationRule, ConsentRecord, ConsentStatus, DataSensitivity,
  RetentionAction, RetentionPolicy, SARStatus, SARType, SubjectAccessRequest,
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
}
