// ToolIntelligenceModule — the Universal AI Tool Intelligence Layer. Owns a
// persisted registry of Tool Entities, pluggable adapters, an evaluation store,
// a human-approval gate for high-risk tools, and a safe fallback invoker.

import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';
import { ToolEvents } from './types.js';
import type {
  ApprovalDecision,
  ApprovalRequest,
  InvocationContext,
  InvocationResult,
  ToolAdapter,
  ToolEntity,
  ToolEvaluation,
  ToolStatus,
} from './types.js';
import { needsApproval, suitability } from './risk.js';

const COL_TOOLS = 'tools.registry';
const COL_EVALS = 'tools.evaluations';
const APPROVAL_TTL_MS = 10 * 60_000;

export interface RegisterToolInput {
  canonicalName: string;
  displayName?: string;
  provider: string;
  version: string;
  category: string;
  capabilities: string[];
  protocol: ToolEntity['protocol'];
  riskClass: ToolEntity['riskClass'];
  privacyClass?: ToolEntity['privacyClass'];
  status?: ToolStatus;
  endpoint?: string;
  authMethod?: string;
  replacementCandidates?: string[];
  metadata?: Record<string, unknown>;
}

export class ToolIntelligenceModule implements IModule {
  readonly id = 'tool-intelligence';
  readonly tags = ['core', 'tools'] as const;
  readonly dependsOn = ['storage'] as const;

  private api!: KernelApi;
  private tools!: ICollection<ToolEntity>;
  private evals!: ICollection<ToolEvaluation & { id: string }>;
  private readonly adapters = new Map<string, ToolAdapter>();
  private readonly approvals = new Map<string, ApprovalRequest>();

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as {
      collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>>;
    };
    this.tools = await storage.collection<ToolEntity>(COL_TOOLS);
    this.evals = await storage.collection<ToolEvaluation & { id: string }>(COL_EVALS);
    kernel.container.registerValue('tool-intelligence', this);
    kernel.logger.info('tool intelligence module initialized');
  }

  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { this.adapters.clear(); this.approvals.clear(); }

  // --- registry ------------------------------------------------------------

  async register(input: RegisterToolInput): Promise<ToolEntity> {
    if (!input.canonicalName || !input.provider) throw new Error('tool-intelligence: canonicalName and provider are required');
    const now = Date.now();
    const tool: ToolEntity = {
      id: randomUUID(),
      canonicalName: input.canonicalName,
      displayName: input.displayName ?? input.canonicalName,
      provider: input.provider,
      version: input.version,
      category: input.category,
      capabilities: input.capabilities,
      protocol: input.protocol,
      riskClass: input.riskClass,
      privacyClass: input.privacyClass ?? 'INTERNAL',
      status: input.status ?? 'DISCOVERED',
      createdAt: now,
      ...(input.endpoint ? { endpoint: input.endpoint } : {}),
      ...(input.authMethod ? { authMethod: input.authMethod } : {}),
      ...(input.replacementCandidates ? { replacementCandidates: input.replacementCandidates } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    await this.tools.put(tool);
    await this.api.bus.emit(ToolEvents.ToolRegistered, { id: tool.id, name: tool.canonicalName });
    return tool;
  }

  async get(id: string): Promise<ToolEntity | undefined> {
    return this.tools.get(id);
  }

  async list(category?: string, status?: ToolStatus): Promise<ToolEntity[]> {
    let all = await this.tools.all();
    if (category) all = all.filter((t) => t.category === category);
    if (status) all = all.filter((t) => t.status === status);
    return all;
  }

  async byCapability(capability: string): Promise<ToolEntity[]> {
    const all = await this.tools.all();
    return all.filter((t) => t.capabilities.includes(capability));
  }

  async setStatus(id: string, status: ToolStatus): Promise<ToolEntity> {
    const t = await this.tools.get(id);
    if (!t) throw new Error(`tool-intelligence: tool "${id}" not found`);
    const updated: ToolEntity = { ...t, status };
    if (status === 'VERIFIED' || status === 'ACTIVE') updated.lastVerified = Date.now();
    await this.tools.put(updated);
    if (status === 'DEPRECATED') await this.api.bus.emit(ToolEvents.ToolDeprecated, { id });
    return updated;
  }

  /** Register an executable adapter for a tool (adapters are in-memory / not persisted). */
  registerAdapter(adapter: ToolAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  // --- evaluation ----------------------------------------------------------

  async recordEvaluation(toolId: string, metric: string, value: number): Promise<ToolEntity> {
    const rec: ToolEvaluation & { id: string } = { id: randomUUID(), toolId, metric, value, ts: Date.now() };
    await this.evals.put(rec);
    const t = await this.tools.get(toolId);
    if (!t) throw new Error(`tool-intelligence: tool "${toolId}" not found`);
    // 'quality'/'accuracy'/'score' metrics update the headline evaluationScore.
    if (metric === 'quality' || metric === 'accuracy' || metric === 'score') {
      const updated: ToolEntity = { ...t, evaluationScore: Math.max(0, Math.min(100, value)) };
      await this.tools.put(updated);
      return updated;
    }
    if (metric === 'reliability') {
      const updated: ToolEntity = { ...t, reliabilityScore: Math.max(0, Math.min(100, value)) };
      await this.tools.put(updated);
      return updated;
    }
    return t;
  }

  // --- approvals (high-risk gating) ---------------------------------------

  requestApproval(toolId: string, principalId: string, action: string, reason?: string): ApprovalRequest {
    const now = Date.now();
    const req: ApprovalRequest = {
      id: randomUUID(),
      toolId,
      principalId,
      action,
      reason,
      status: 'pending',
      createdAt: now,
      expiresAt: now + APPROVAL_TTL_MS,
    };
    this.approvals.set(req.id, req);
    void this.api.bus.emit(ToolEvents.ApprovalRequested, { id: req.id, toolId });
    return req;
  }

  decideApproval(requestId: string, decision: ApprovalDecision, decidedBy: string): ApprovalRequest {
    const req = this.approvals.get(requestId);
    if (!req) throw new Error(`tool-intelligence: approval request "${requestId}" not found`);
    if (req.status !== 'pending') throw new Error(`tool-intelligence: request already ${req.status}`);
    if (req.expiresAt < Date.now()) {
      req.status = 'expired';
      throw new Error('tool-intelligence: approval request expired');
    }
    req.status = decision;
    req.decidedAt = Date.now();
    req.decidedBy = decidedBy;
    void this.api.bus.emit(ToolEvents.ApprovalDecided, { id: requestId, decision });
    return req;
  }

  getApproval(requestId: string): ApprovalRequest | undefined {
    return this.approvals.get(requestId);
  }

  listPendingApprovals(): ApprovalRequest[] {
    return [...this.approvals.values()].filter((a) => a.status === 'pending');
  }

  // --- routing / fallback --------------------------------------------------

  /** Rank tools for a capability by suitability (best first). */
  async rankForCapability(capability: string): Promise<ToolEntity[]> {
    const candidates = await this.byCapability(capability);
    return candidates
      .map((t) => ({ t, score: suitability(t) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.t);
  }

  /**
   * Invoke the best available tool for a capability, falling back through the
   * ranked list on failure. Only low/medium-risk tools (no approval required)
   * are used for automated fallback — high-risk tools require explicit approval.
   */
  async invokeWithFallback(capability: string, input: unknown, principal?: InvocationContext['principal']): Promise<InvocationResult> {
    const ranked = await this.rankForCapability(capability);
    const failures: { toolId: string; error: string }[] = [];
    for (const tool of ranked) {
      if (needsApproval(tool)) continue; // never auto-invoke high-risk tools
      if (!this.adapters.has(tool.id)) continue;
      try {
        return await this.invoke(tool.id, input, principal);
      } catch (err) {
        failures.push({ toolId: tool.id, error: (err as Error).message });
      }
    }
    const result: InvocationResult = {
      requestId: randomUUID(),
      toolId: '',
      status: 'failure',
      error: `no tool succeeded for capability "${capability}"`,
      durationMs: 0,
    };
    void failures;
    void this.api.bus.emit(ToolEvents.ToolFailed, { capability, failures });
    return result;
  }

  // --- single-tool invocation pipeline ------------------------------------

  async invoke(toolId: string, input: unknown, principal?: InvocationContext['principal'], approvalRequestId?: string): Promise<InvocationResult> {
    const t0 = Date.now();
    const tool = await this.tools.get(toolId);
    if (!tool) throw new Error(`tool-intelligence: tool "${toolId}" not found`);
    const adapter = this.adapters.get(toolId);
    if (!adapter) throw new Error(`tool-intelligence: no adapter bound to tool "${toolId}"`);

    // Input validation.
    if (adapter.validateInput) {
      const err = adapter.validateInput(input);
      if (err) throw new Error(`tool-intelligence: invalid input — ${err}`);
    }

    // High-risk gating (tool directive #10/#17/#19).
    if (needsApproval(tool)) {
      const req = approvalRequestId ? this.approvals.get(approvalRequestId) : undefined;
      if (!req || req.toolId !== toolId || req.status !== 'approved') {
        const result: InvocationResult = {
          requestId: randomUUID(),
          toolId,
          status: 'pending_approval',
          error: `tool "${tool.canonicalName}" is ${tool.riskClass} and requires human approval`,
          durationMs: Date.now() - t0,
        };
        return result;
      }
    }

    const ctx: InvocationContext = { toolId, principal, requestId: randomUUID() };
    let output: unknown;
    try {
      output = await adapter.invoke(input, ctx);
    } catch (err) {
      const result: InvocationResult = { requestId: ctx.requestId, toolId, status: 'failure', error: (err as Error).message, durationMs: Date.now() - t0 };
      void this.api.bus.emit(ToolEvents.ToolFailed, { toolId });
      return result;
    }

    if (adapter.validateOutput) {
      const err = adapter.validateOutput(output);
      if (err) {
        const result: InvocationResult = { requestId: ctx.requestId, toolId, status: 'failure', error: `invalid output — ${err}`, durationMs: Date.now() - t0 };
        return result;
      }
    }

    const cost = adapter.estimateCost ? adapter.estimateCost(input) : undefined;

    // Audit (when the security module is present).
    let auditRecordId: string | undefined;
    const sec = this.trySecurity();
    if (sec) {
      const rec = await sec.audit({
        actor: principal?.userId ?? 'anonymous',
        action: 'tool.invoke',
        resource: tool.canonicalName,
        result: 'success',
        detail: { toolId, capability: tool.capabilities[0], cost },
      });
      auditRecordId = rec.id;
    }

    const result: InvocationResult = {
      requestId: ctx.requestId,
      toolId,
      status: 'success',
      output,
      cost,
      durationMs: Date.now() - t0,
      ...(auditRecordId ? { auditRecordId } : {}),
    };
    await this.api.bus.emit(ToolEvents.ToolInvoked, { toolId, status: 'success' });
    return result;
  }

  private trySecurity(): { audit: (rec: Record<string, unknown>) => Promise<{ id: string }> } | undefined {
    try {
      return this.api.getModule('security') as unknown as { audit: (rec: Record<string, unknown>) => Promise<{ id: string }> };
    } catch {
      return undefined;
    }
  }
}
