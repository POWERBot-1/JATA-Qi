// PoliciesModule — governance: a persisted registry of declarative policies and
// compliance controls, with a policy engine that decides allow / deny /
// require_approval for any action context.

import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';
import { PolicyEvents } from './types.js';
import { evaluate } from './engine.js';
import type { ComplianceControl, ControlStatus, Policy, PolicyContext, PolicyDecision, PolicyEffect } from './types.js';

const COL_POLICIES = 'policies.policies';
const COL_CONTROLS = 'policies.controls';

export interface PoliciesConfig {
  /** Default effect when no policy matches (default 'allow'). */
  defaultEffect?: PolicyEffect;
  /** Seed policies/controls. */
  seedPolicies?: Omit<Policy, 'id' | 'createdAt'>[];
  seedControls?: Omit<ComplianceControl, 'id' | 'createdAt'>[];
}

export class PoliciesModule implements IModule {
  readonly id = 'policies';
  readonly tags = ['core', 'governance'] as const;
  readonly dependsOn = ['storage'] as const;

  private api!: KernelApi;
  private policies!: ICollection<Policy>;
  private controls!: ICollection<ComplianceControl>;
  private readonly defaultEffect: PolicyEffect;
  private readonly seedPolicies?: Omit<Policy, 'id' | 'createdAt'>[];
  private readonly seedControls?: Omit<ComplianceControl, 'id' | 'createdAt'>[];

  constructor(cfg: PoliciesConfig = {}) {
    this.defaultEffect = cfg.defaultEffect ?? 'allow';
    this.seedPolicies = cfg.seedPolicies;
    this.seedControls = cfg.seedControls;
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as {
      collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>>;
    };
    this.policies = await storage.collection<Policy>(COL_POLICIES);
    this.controls = await storage.collection<ComplianceControl>(COL_CONTROLS);
    if ((await this.policies.count()) === 0) for (const p of this.seedPolicies ?? []) await this.createPolicy(p);
    if ((await this.controls.count()) === 0) for (const c of this.seedControls ?? []) await this.createControl(c);
    kernel.container.registerValue('policies', this);
    kernel.logger.info(`policies module initialized (default: ${this.defaultEffect})`);
  }

  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  // --- policies ------------------------------------------------------------

  async createPolicy(input: Omit<Policy, 'id' | 'createdAt'>): Promise<Policy> {
    const policy: Policy = { ...input, id: randomUUID(), createdAt: Date.now() };
    await this.policies.put(policy);
    await this.api.bus.emit(PolicyEvents.PolicyCreated, { id: policy.id, effect: policy.effect });
    return policy;
  }
  async getPolicy(id: string): Promise<Policy | undefined> { return this.policies.get(id); }
  async listPolicies(): Promise<Policy[]> { return this.policies.all(); }
  async setPolicyStatus(id: string, status: 'active' | 'disabled'): Promise<Policy> {
    const p = await this.policies.get(id);
    if (!p) throw new Error(`policies: policy "${id}" not found`);
    const updated: Policy = { ...p, status };
    await this.policies.put(updated);
    return updated;
  }

  /** Evaluate the governance decision for an action context. */
  async decide(ctx: PolicyContext): Promise<PolicyDecision> {
    const decision = evaluate(await this.policies.all(), ctx, this.defaultEffect);
    if (decision.effect === 'deny') await this.api.bus.emit(PolicyEvents.DecisionDeny, { ctx });
    return decision;
  }

  // --- compliance controls -------------------------------------------------

  async createControl(input: Omit<ComplianceControl, 'id' | 'createdAt'>): Promise<ComplianceControl> {
    const control: ComplianceControl = { ...input, id: randomUUID(), createdAt: Date.now() };
    await this.controls.put(control);
    return control;
  }
  async listControls(framework?: string): Promise<ComplianceControl[]> {
    const all = await this.controls.all();
    return framework ? all.filter((c) => c.framework === framework) : all;
  }
  async setControlStatus(id: string, status: ControlStatus, evidence?: string[]): Promise<ComplianceControl> {
    const c = await this.controls.get(id);
    if (!c) throw new Error(`policies: control "${id}" not found`);
    const updated: ComplianceControl = { ...c, status, ...(evidence ? { evidence } : {}) };
    await this.controls.put(updated);
    return updated;
  }

  /** Compliance coverage summary by framework + status. */
  async complianceSummary(): Promise<Record<string, Record<string, number>>> {
    const all = await this.controls.all();
    const out: Record<string, Record<string, number>> = {};
    for (const c of all) {
      (out[c.framework] ??= {})[c.status] = (out[c.framework]![c.status] ?? 0) + 1;
    }
    return out;
  }
}
