// PolicyGovernanceModule — the centralized, versioned, tenant-aware governance
// control plane. Sits AFTER authorization (security) and BEFORE domain modules.
// Integrates (optionally) with organizations (tenant scope), commerce
// (entitlements), tool-intelligence (approvals), notifications, and the security
// audit ledger. The Creator Root is never modifiable through this module.

import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';
import { GovernanceEvents } from './types.js';
import { AUTONOMY_ORDER } from './types.js';
import type {
  AgentGovernance, AutonomyLevel, EvaluationResult, Policy, PolicyContext,
  PolicyOverride, PolicySubject,
} from './types.js';
import { autonomyAllowed, evaluate as evaluatePolicies } from './engine.js';

const COL_POLICIES = 'gov.policies';
const COL_VERSIONS = 'gov.policy_versions';
const COL_OVERRIDES = 'gov.overrides';
const COL_AGENTS = 'gov.agents';
const COL_EVALS = 'gov.evaluations';

export interface CreatePolicyInput {
  name: string;
  category: Policy['category'];
  scope: Policy['scope'];
  effect: Policy['effect'];
  action?: string;
  subjectType?: string;
  resourceType?: string;
  conditions?: Policy['conditions'];
  priority?: number;
  organizationId?: string;
  effectiveAt?: number;
  expiresAt?: number;
  description?: string;
  approvedBy?: string;
}

export interface AgentCheckContext {
  action?: string;
  toolId?: string;
  autonomy?: AutonomyLevel;
  spent?: number;
  cost?: number;
  iterations?: number;
}

export interface AgentCheckResult {
  allowed: boolean;
  reason: string;
  autonomyCap?: AutonomyLevel;
  humanApprovalRequired?: boolean;
}

export class PolicyGovernanceModule implements IModule {
  readonly id = 'policy-governance';
  readonly tags = ['core', 'governance'] as const;
  readonly dependsOn = ['storage'] as const;

  private api!: KernelApi;
  private policies!: ICollection<Policy>;
  private versions!: ICollection<Policy>;
  private overrides!: ICollection<PolicyOverride>;
  private agents!: ICollection<AgentGovernance>;
  private evaluations!: ICollection<EvaluationResult & { id: string; actor: string; action: string }>;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as {
      collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>>;
    };
    const C = <T extends { id: string }>(n: string) => storage.collection<T>(n);
    this.policies = await C<Policy>(COL_POLICIES);
    this.versions = await C<Policy>(COL_VERSIONS);
    this.overrides = await C<PolicyOverride>(COL_OVERRIDES);
    this.agents = await C<AgentGovernance>(COL_AGENTS);
    this.evaluations = await C<EvaluationResult & { id: string; actor: string; action: string }>(COL_EVALS);
    kernel.container.registerValue('policy-governance', this);
    kernel.logger.info('policy-governance module initialized');
  }

  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  // --- policy CRUD + versioning -------------------------------------------

  async createPolicy(input: CreatePolicyInput, createdBy: string): Promise<Policy> {
    const now = Date.now();
    const policy: Policy = {
      id: randomUUID(),
      name: input.name,
      category: input.category,
      scope: input.scope,
      effect: input.effect,
      priority: input.priority ?? 5,
      version: 1,
      status: 'active',
      createdBy,
      ...(input.description ? { description: input.description } : {}),
      ...(input.action ? { action: input.action } : {}),
      ...(input.subjectType ? { subjectType: input.subjectType } : {}),
      ...(input.resourceType ? { resourceType: input.resourceType } : {}),
      ...(input.conditions ? { conditions: input.conditions } : {}),
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      ...(input.effectiveAt ? { effectiveAt: input.effectiveAt } : {}),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      ...(input.approvedBy ? { approvedBy: input.approvedBy } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await this.policies.put(policy);
    await this.audit(createdBy, 'policy.created', { id: policy.id, name: policy.name });
    await this.api.bus.emit(GovernanceEvents.PolicyCreated, { id: policy.id });
    return policy;
  }

  async getPolicy(id: string): Promise<Policy | undefined> { return this.policies.get(id); }

  async listPolicies(filter: { category?: string; scope?: string; organizationId?: string; status?: 'active' | 'inactive' } = {}): Promise<Policy[]> {
    let all = await this.policies.all();
    if (filter.category) all = all.filter((p) => p.category === filter.category);
    if (filter.scope) all = all.filter((p) => p.scope === filter.scope);
    if (filter.organizationId) all = all.filter((p) => p.organizationId === filter.organizationId);
    if (filter.status) all = all.filter((p) => p.status === filter.status);
    return all;
  }

  /** Update a policy → archives the prior version and writes a new version. */
  async updatePolicy(id: string, changes: Partial<CreatePolicyInput>, updatedBy: string): Promise<Policy> {
    const current = await this.policies.get(id);
    if (!current) throw new Error(`policy-governance: policy "${id}" not found`);
    await this.versions.put({ ...current, id: `${id}:v${current.version}` });
    const next: Policy = {
      ...current,
      ...changes,
      id,
      version: current.version + 1,
      updatedAt: Date.now(),
    };
    await this.policies.put(next);
    await this.audit(updatedBy, 'policy.updated', { id, version: next.version });
    await this.api.bus.emit(GovernanceEvents.PolicyUpdated, { id, version: next.version });
    return next;
  }

  async deactivatePolicy(id: string, by: string): Promise<Policy> {
    const current = await this.policies.get(id);
    if (!current) throw new Error(`policy-governance: policy "${id}" not found`);
    await this.versions.put({ ...current, id: `${id}:v${current.version}` });
    const inactive: Policy = { ...current, version: current.version + 1, status: 'inactive', updatedAt: Date.now() };
    await this.policies.put(inactive);
    await this.audit(by, 'policy.deactivated', { id });
    await this.api.bus.emit(GovernanceEvents.PolicyDeactivated, { id });
    return inactive;
  }

  /** Full version history for a policy (oldest → current). */
  async policyVersions(id: string): Promise<Policy[]> {
    const current = await this.policies.get(id);
    const all = await this.versions.all();
    const hist = all.filter((p) => p.id.startsWith(`${id}:v`)).sort((a, b) => a.version - b.version);
    return current ? [...hist, current] : hist;
  }

  // --- evaluation ----------------------------------------------------------

  async evaluate(subject: PolicySubject, action: string, context: PolicyContext = {}): Promise<EvaluationResult> {
    const t0 = Date.now();
    const policies = await this.policies.all();
    const overrides = await this.overrides.all();
    const result = evaluatePolicies(policies, overrides, subject, action, { ...context, mode: context.mode ?? 'ENFORCE' });
    result.durationMs = Date.now() - t0;

    // Observability: count every enforced decision by outcome.
    if (!result.simulated) {
      try {
        const metrics = this.api.getModule('metrics') as unknown as { registry: { counter: (n: string) => { inc: (n?: number, l?: Record<string, string>) => void } } } | undefined;
        metrics?.registry.counter('jataqi_governance_decisions_total').inc(1, { decision: result.decision });
      } catch { /* metrics optional */ }
    }

    if (result.simulated) return result; // dry-run: no side effects

    // Persist evaluation record + audit + targeted notifications.
    await this.evaluations.put({ ...result, id: result.evaluationId, actor: subject.userId, action });
    await this.audit(subject.userId, 'policy.evaluated', { action, decision: result.decision, evaluationId: result.evaluationId, durationMs: result.durationMs });

    if (result.decision === 'DENY') {
      await this.api.bus.emit(GovernanceEvents.PolicyDenied, { actor: subject.userId, action });
      await this.notify(subject.userId, 'policy', `Action "${action}" was denied`, result.reason);
    } else if (result.decision === 'REQUIRES_APPROVAL' || result.decision === 'REQUIRES_HUMAN_REVIEW') {
      await this.api.bus.emit(GovernanceEvents.PolicyApprovalRequired, { actor: subject.userId, action });
      await this.notify(subject.userId, 'approval', `Action "${action}" requires approval`, result.reason);
    }
    return result;
  }

  /** Dry-run alias. */
  simulate(subject: PolicySubject, action: string, context: PolicyContext = {}): Promise<EvaluationResult> {
    return this.evaluate(subject, action, { ...context, mode: 'SIMULATE' });
  }

  async evaluationHistory(actor?: string, limit = 50): Promise<(EvaluationResult & { id: string; actor: string; action: string })[]> {
    let all = await this.evaluations.all();
    if (actor) all = all.filter((e) => e.actor === actor);
    return all.sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  // --- overrides -----------------------------------------------------------

  async createOverride(input: Omit<PolicyOverride, 'id' | 'createdAt'>): Promise<PolicyOverride> {
    const override: PolicyOverride = { ...input, id: randomUUID(), createdAt: Date.now() };
    await this.overrides.put(override);
    await this.audit(input.who, 'policy.overridden', { scope: input.scope, decision: input.decision });
    await this.api.bus.emit(GovernanceEvents.PolicyOverridden, { id: override.id });
    return override;
  }
  async listOverrides(): Promise<PolicyOverride[]> { return this.overrides.all(); }

  // --- agent governance ----------------------------------------------------

  async setAgentGovernance(profile: Omit<AgentGovernance, 'id'> & { id?: string }): Promise<AgentGovernance> {
    const gov: AgentGovernance = { ...profile, id: profile.id ?? `agent:${profile.agentId}` };
    await this.agents.put(gov);
    return gov;
  }
  async getAgentGovernance(agentId: string): Promise<AgentGovernance | undefined> {
    return (await this.agents.all()).find((g) => g.agentId === agentId);
  }

  /** Evaluate an agent action against its governance profile. */
  async checkAgent(agentId: string, ctx: AgentCheckContext): Promise<AgentCheckResult> {
    const profile = await this.getAgentGovernance(agentId);
    const cap: AutonomyLevel = profile?.maxAutonomy ?? 'L3';
    if (ctx.toolId && profile?.blockedTools?.includes(ctx.toolId)) {
      return { allowed: false, reason: `tool "${ctx.toolId}" is blocked for agent`, autonomyCap: cap };
    }
    if (ctx.toolId && profile?.allowedTools?.length && !profile.allowedTools.includes(ctx.toolId)) {
      return { allowed: false, reason: `tool "${ctx.toolId}" is not in the agent's allow-list`, autonomyCap: cap };
    }
    if (ctx.action && profile?.blockedActions?.includes(ctx.action)) {
      return { allowed: false, reason: `action "${ctx.action}" is blocked for agent`, autonomyCap: cap };
    }
    if (ctx.autonomy && !autonomyAllowed(cap, ctx.autonomy)) {
      return { allowed: false, reason: `autonomy ${ctx.autonomy} exceeds agent cap ${cap}`, autonomyCap: cap };
    }
    if (profile?.maximumIterations !== undefined && ctx.iterations !== undefined && ctx.iterations > profile.maximumIterations) {
      return { allowed: false, reason: `iterations ${ctx.iterations} exceed cap ${profile.maximumIterations}`, autonomyCap: cap };
    }
    if (profile?.maximumBudget !== undefined && ctx.spent !== undefined && ctx.cost !== undefined && ctx.spent + ctx.cost > profile.maximumBudget) {
      return { allowed: false, reason: `cost would exceed agent budget ${profile.maximumBudget}`, autonomyCap: cap };
    }
    return { allowed: true, reason: 'within agent governance', autonomyCap: cap, humanApprovalRequired: profile?.humanApprovalRequired };
  }

  // --- integration helpers -------------------------------------------------

  private async audit(actor: string, action: string, detail: Record<string, unknown>): Promise<void> {
    try {
      const sec = this.api.getModule('security') as unknown as { audit: (rec: Record<string, unknown>) => Promise<unknown> } | undefined;
      if (sec && typeof sec.audit === 'function') await sec.audit({ actor, action: `governance.${action}`, result: 'success', detail });
    } catch { /* security optional */ }
  }

  private async notify(recipient: string, type: string, title: string, body: string): Promise<void> {
    try {
      const notifications = this.api.getModule('notifications') as unknown as { notify: (r: string, p: { type: string; title: string; body?: string }) => Promise<unknown> } | undefined;
      if (notifications && typeof notifications.notify === 'function') await notifications.notify(recipient, { type, title, body });
    } catch { /* notifications optional */ }
  }
}

export { AUTONOMY_ORDER };
