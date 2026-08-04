// EnterpriseModule — CRM/ERP/HR/Finance/Procurement records (#21).
import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';

export type EnterpriseModuleType = 'crm' | 'erp' | 'hr' | 'finance' | 'procurement' | 'inventory' | string;

export interface EnterpriseOrgUnit {
  id: string; name: string; module: EnterpriseModuleType; organizationId?: string;
  status: 'active' | 'inactive'; createdAt: number;
}
export interface EnterpriseRecord {
  id: string; orgUnitId: string; module: EnterpriseModuleType; type: string;
  data: Record<string, unknown>; createdBy: string; organizationId?: string; createdAt: number;
}
export interface EnterpriseWorkflow {
  id: string; orgUnitId: string; name: string; steps: string[];
  status: 'draft' | 'active' | 'completed' | 'cancelled'; createdBy: string; createdAt: number;
}
export const EnterpriseEvents = Object.freeze({ RecordCreated: 'enterprise.record.created' } as const);

export class EnterpriseModule implements IModule {
  readonly id = 'enterprise'; readonly tags = ['intelligence', 'enterprise'] as const; readonly dependsOn = ['storage'] as const;
  private api!: KernelApi; private orgUnits!: ICollection<EnterpriseOrgUnit>;
  private records!: ICollection<EnterpriseRecord>; private workflows!: ICollection<EnterpriseWorkflow>;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as { collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>> };
    this.orgUnits = await storage.collection<EnterpriseOrgUnit>('enterprise.org_units');
    this.records = await storage.collection<EnterpriseRecord>('enterprise.records');
    this.workflows = await storage.collection<EnterpriseWorkflow>('enterprise.workflows');
    kernel.container.registerValue('enterprise', this);
    kernel.logger.info('enterprise module initialized');
  }
  async start(_k: KernelApi): Promise<void> {} async stop(_k: KernelApi): Promise<void> {}

  async createOrgUnit(input: { name: string; module: EnterpriseModuleType; organizationId?: string }): Promise<EnterpriseOrgUnit> {
    const u: EnterpriseOrgUnit = { id: randomUUID(), name: input.name, module: input.module, status: 'active', createdAt: Date.now(), ...(input.organizationId ? { organizationId: input.organizationId } : {}) };
    await this.orgUnits.put(u); return u;
  }
  async listOrgUnits(module?: EnterpriseModuleType): Promise<EnterpriseOrgUnit[]> {
    const all = await this.orgUnits.all(); return module ? all.filter((u) => u.module === module) : all;
  }

  async createRecord(input: { orgUnitId: string; module: EnterpriseModuleType; type: string; data: Record<string, unknown>; createdBy: string; organizationId?: string }): Promise<EnterpriseRecord> {
    const r: EnterpriseRecord = { id: randomUUID(), ...input, createdAt: Date.now() };
    await this.records.put(r);
    await this.api.bus.emit(EnterpriseEvents.RecordCreated, { id: r.id, module: input.module, type: input.type });
    await this.audit(input.createdBy, 'record_created', { id: r.id, module: input.module, type: input.type });
    return r;
  }
  async getRecord(id: string): Promise<EnterpriseRecord | undefined> { return this.records.get(id); }
  async listRecords(filter?: { module?: EnterpriseModuleType; type?: string; orgUnitId?: string }): Promise<EnterpriseRecord[]> {
    let all = await this.records.all();
    if (filter?.module) all = all.filter((r) => r.module === filter.module);
    if (filter?.type) all = all.filter((r) => r.type === filter.type);
    if (filter?.orgUnitId) all = all.filter((r) => r.orgUnitId === filter.orgUnitId);
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  async createWorkflow(input: { orgUnitId: string; name: string; steps: string[]; createdBy: string }): Promise<EnterpriseWorkflow> {
    const w: EnterpriseWorkflow = { id: randomUUID(), ...input, status: 'draft', createdAt: Date.now() };
    await this.workflows.put(w); return w;
  }
  async activateWorkflow(id: string): Promise<EnterpriseWorkflow> {
    const w = await this.workflows.get(id); if (!w) throw new Error(`enterprise: workflow "${id}" not found`);
    const u: EnterpriseWorkflow = { ...w, status: 'active' }; await this.workflows.put(u); return u;
  }
  async listWorkflows(orgUnitId?: string): Promise<EnterpriseWorkflow[]> {
    const all = await this.workflows.all(); return orgUnitId ? all.filter((w) => w.orgUnitId === orgUnitId) : all;
  }

  private async audit(actor: string, action: string, detail: Record<string, unknown>): Promise<void> {
    try { const s = this.api.getModule('security') as unknown as { audit: (r: Record<string, unknown>) => Promise<unknown> } | undefined; if (s?.audit) await s.audit({ actor, action: `enterprise.${action}`, result: 'success', detail }); } catch {}
  }
}
