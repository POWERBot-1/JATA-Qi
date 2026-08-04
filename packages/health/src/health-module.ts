// HealthModule — health information management. Records, vital tracking, and
// educational content. NOT a diagnostic tool (see HEALTH_DISCLAIMER). All data
// is treated as RESTRICTED. Requires patient consent for record creation when
// the privacy module is present.

import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';
import { HealthEvents } from './types.js';
import type { HealthEducation, HealthRecord, RecordCategory, VitalReading } from './types.js';

const COL_RECORDS = 'health.records';
const COL_VITALS = 'health.vitals';
const COL_EDU = 'health.education';

export class HealthModule implements IModule {
  readonly id = 'health';
  readonly tags = ['intelligence', 'health'] as const;
  readonly dependsOn = ['storage'] as const;

  private api!: KernelApi;
  private records!: ICollection<HealthRecord>;
  private vitals!: ICollection<VitalReading>;
  private education!: ICollection<HealthEducation>;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as {
      collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>>;
    };
    const C = <T extends { id: string }>(n: string) => storage.collection<T>(n);
    this.records = await C<HealthRecord>(COL_RECORDS);
    this.vitals = await C<VitalReading>(COL_VITALS);
    this.education = await C<HealthEducation>(COL_EDU);
    kernel.container.registerValue('health', this);
    kernel.logger.info('health module initialized (information management only — NOT a diagnostic tool)');
  }

  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  // --- records -------------------------------------------------------------

  async createRecord(input: { patientId: string; category: RecordCategory; title: string; content: string; provider?: string; organizationId?: string; createdBy: string }): Promise<HealthRecord> {
    // Check patient consent when the privacy module is present.
    const hasConsent = await this.checkConsent(input.patientId);
    if (!hasConsent) throw new Error('health: patient consent required (privacy module active)');

    const rec: HealthRecord = {
      id: randomUUID(), sensitivity: 'restricted', createdAt: Date.now(),
      ...input,
    };
    await this.records.put(rec);
    await this.api.bus.emit(HealthEvents.RecordCreated, { id: rec.id, patientId: input.patientId });
    await this.audit(input.createdBy, 'record_created', { recordId: rec.id, patientId: input.patientId, category: input.category });
    return rec;
  }

  async getRecord(id: string): Promise<HealthRecord | undefined> { return this.records.get(id); }

  async listRecords(patientId: string, category?: RecordCategory): Promise<HealthRecord[]> {
    let all = (await this.records.all()).filter((r) => r.patientId === patientId);
    if (category) all = all.filter((r) => r.category === category);
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  // --- vitals --------------------------------------------------------------

  async recordVitals(input: { patientId: string; type: string; value: number; unit: string; notes?: string }): Promise<VitalReading> {
    const reading: VitalReading = { id: randomUUID(), recordedAt: Date.now(), ...input };
    await this.vitals.put(reading);
    await this.api.bus.emit(HealthEvents.VitalRecorded, { patientId: input.patientId, type: input.type });
    return reading;
  }

  async getVitals(patientId: string, type?: string, limit = 100): Promise<VitalReading[]> {
    let all = (await this.vitals.all()).filter((v) => v.patientId === patientId);
    if (type) all = all.filter((v) => v.type === type);
    return all.sort((a, b) => b.recordedAt - a.recordedAt).slice(0, limit);
  }

  // --- educational content -------------------------------------------------

  async createEducation(input: { topic: string; title: string; content: string; audience?: string; source?: string }): Promise<HealthEducation> {
    const edu: HealthEducation = {
      id: randomUUID(), ...input,
      disclaimer: 'Educational content only — not medical advice.',
      createdAt: Date.now(),
    };
    await this.education.put(edu);
    return edu;
  }

  async listEducation(topic?: string): Promise<HealthEducation[]> {
    let all = await this.education.all();
    if (topic) all = all.filter((e) => e.topic === topic);
    return all;
  }

  // --- helpers -------------------------------------------------------------

  private async checkConsent(patientId: string): Promise<boolean> {
    try {
      const privacy = this.api.getModule('privacy') as unknown as { hasConsent: (subjectType: string, subjectId: string) => Promise<boolean> } | undefined;
      if (!privacy || typeof privacy.hasConsent !== 'function') return true; // no privacy module → no consent requirement
      return privacy.hasConsent('data-use', patientId);
    } catch { return true; }
  }

  private async audit(actor: string, action: string, detail: Record<string, unknown>): Promise<void> {
    try {
      const sec = this.api.getModule('security') as unknown as { audit: (rec: Record<string, unknown>) => Promise<unknown> } | undefined;
      if (sec && typeof sec.audit === 'function') await sec.audit({ actor, action: `health.${action}`, result: 'success', detail });
    } catch { /* optional */ }
  }
}
