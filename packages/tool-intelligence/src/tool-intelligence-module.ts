// ToolIntelligenceModule — the Universal AI Tool Intelligence Layer. Owns a
// persisted registry of Tool Entities, pluggable adapters, an evaluation store,
// a human-approval gate for high-risk tools, and a safe fallback invoker.

import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';
import type { MetricsModule } from '@jataqi/metrics';
import type { Counter, Gauge, Histogram } from '@jataqi/metrics';
import { ToolEvents } from './types.js';
import type {
  AgentToolDescriptor,
  ApprovalDecision,
  ApprovalRequest,
  GovernanceStats,
  InvocationContext,
  InvocationResult,
  ToolAdapter,
  ToolEntity,
  ToolEvaluation,
  ToolStatus,
} from './types.js';
import { needsApproval, suitability } from './risk.js';
import { AGENT_TOOL_CATALOG_BY_NAME } from './catalog.js';

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

/** Governance SLA thresholds for live alert evaluation. */
export interface SlaConfig {
  /** Max age of the oldest pending approval before an alert fires (default 10 min). */
  pendingApprovalMaxAgeMs?: number;
  /** Rolling window for the DENY-spike rule (default 5 min). */
  denySpikeWindowMs?: number;
  /** Max DENY decisions per window before an alert fires (default 5). */
  denySpikeMax?: number;
  /** Rolling window for the R4-invocation-rate rule (default 5 min). */
  r4RateWindowMs?: number;
  /** Max R4 invocations per window before an alert fires (default 20). */
  r4RateMax?: number;
}

export interface SlaAlert {
  id: string;
  severity: 'warning' | 'critical';
  state: 'firing' | 'ok';
  message: string;
  value: number;
  threshold: number;
  checkedAt: number;
}

export class ToolIntelligenceModule implements IModule {
  readonly id = 'tool-intelligence';
  readonly tags = ['core', 'tools'] as const;
  readonly dependsOn = ['storage'] as const;

  private readonly sla: Required<SlaConfig>;
  private readonly decisionHistory: Array<{ ts: number; decision: string }> = [];
  private readonly r4History: Array<{ ts: number }> = [];
  private lastSlaStates = new Map<string, 'firing' | 'ok'>();

  constructor(config: SlaConfig = {}) {
    this.sla = {
      pendingApprovalMaxAgeMs: config.pendingApprovalMaxAgeMs ?? 10 * 60_000,
      denySpikeWindowMs: config.denySpikeWindowMs ?? 5 * 60_000,
      denySpikeMax: config.denySpikeMax ?? 5,
      r4RateWindowMs: config.r4RateWindowMs ?? 5 * 60_000,
      r4RateMax: config.r4RateMax ?? 20,
    };
  }

  private api!: KernelApi;
  private tools!: ICollection<ToolEntity>;
  private evals!: ICollection<ToolEvaluation & { id: string }>;
  private readonly adapters = new Map<string, ToolAdapter>();
  private readonly approvals = new Map<string, ApprovalRequest>();
  private metrics?: MetricsModule;
  private mInvocations?: Counter;
  private mDecisions?: Counter;
  private mApprovals?: Counter;
  private mDuration?: Histogram;
  private mPending?: Gauge;

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

  // --- agent tool governance sync ------------------------------------------

  /**
   * Synchronize the agent runtime's tool surface into the governance registry.
   *
   * Every descriptor (tool) is upserted by canonicalName with the risk/privacy
   * classification from the agent tool catalog (AGENT_TOOL_CATALOG), and an
   * adapter is bound that executes the tool via its own `execute` — so the
   * full invocation pipeline (governance gate → risk gate → approval → audit)
   * applies to agent tools exactly like any other registered tool.
   *
   * Tools absent from the catalog are still registered with a conservative
   * default classification (R3 / INTERNAL / DISCOVERED) so nothing runs
   * ungoverned.
   */
  async syncAgentTools(
    tools: AgentToolDescriptor[],
    opts: { provider?: string; version?: string } = {},
  ): Promise<{ synced: ToolEntity[]; created: number; updated: number }> {
    const synced: ToolEntity[] = [];
    let created = 0;
    let updated = 0;
    for (const descriptor of tools) {
      const existing = await this.byCanonicalName(descriptor.name);
      const entry = AGENT_TOOL_CATALOG_BY_NAME.get(descriptor.name);
      const classification = entry
        ? { riskClass: entry.riskClass, privacyClass: entry.privacyClass, category: entry.category, capabilities: entry.capabilities }
        : { riskClass: 'R3' as const, privacyClass: 'INTERNAL' as const, category: 'agent', capabilities: [descriptor.name] };

      let tool: ToolEntity;
      if (existing) {
        tool = {
          ...existing,
          displayName: entry?.displayName ?? existing.displayName,
          category: classification.category,
          capabilities: classification.capabilities,
          riskClass: classification.riskClass,
          privacyClass: classification.privacyClass,
          status: 'ACTIVE',
          metadata: { ...(existing.metadata ?? {}), agentTool: true, description: descriptor.description, governedBy: 'agent-catalog' },
        };
        await this.tools.put(tool);
        updated++;
      } else {
        tool = await this.register({
          canonicalName: descriptor.name,
          displayName: entry?.displayName ?? descriptor.name,
          provider: opts.provider ?? 'agent-runtime',
          version: opts.version ?? '1.0.0',
          category: classification.category,
          capabilities: classification.capabilities,
          protocol: 'function',
          riskClass: classification.riskClass,
          privacyClass: classification.privacyClass,
          status: 'ACTIVE',
          metadata: { agentTool: true, description: descriptor.description, governedBy: 'agent-catalog' },
        });
        created++;
      }

      // Bind (or refresh) the adapter that executes through the descriptor.
      this.registerAdapter(this.descriptorAdapter(tool, descriptor));
      synced.push(tool);
    }
    return { synced, created, updated };
  }

  /** Tools known to the registry that are governed agent tools. */
  async listAgentTools(): Promise<ToolEntity[]> {
    const all = await this.tools.all();
    return all.filter((t) => t.metadata?.agentTool === true);
  }

  private async byCanonicalName(canonicalName: string): Promise<ToolEntity | undefined> {
    const all = await this.tools.all();
    return all.find((t) => t.canonicalName === canonicalName);
  }

  private descriptorAdapter(tool: ToolEntity, descriptor: AgentToolDescriptor): ToolAdapter {
    return {
      id: tool.id,
      capabilities: () => tool.capabilities,
      validateInput: (input: unknown) => {
        // Enforce the tool's JSON-schema-ish shape when required fields exist.
        const schema = descriptor.inputSchema as { required?: string[]; properties?: Record<string, unknown> } | undefined;
        if (schema?.required && input && typeof input === 'object') {
          const record = input as Record<string, unknown>;
          for (const field of schema.required) {
            if (record[field] === undefined) return `missing required field "${field}"`;
          }
        }
        return undefined;
      },
      async invoke(input: unknown, ctx: InvocationContext): Promise<unknown> {
        return descriptor.execute(input, {
          runId: ctx.requestId,
          logger: {
            info: () => undefined,
            debug: () => undefined,
            error: () => undefined,
          },
          metadata: { toolId: tool.id, principal: ctx.principal, governedBy: 'tool-intelligence' },
        });
      },
    };
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
    this.ensureMetrics();
    this.mApprovals?.inc(1, { decision: 'requested' });
    this.mPending?.set([...this.approvals.values()].filter((a) => a.status === 'pending').length);
    void this.api.bus.emit(ToolEvents.ApprovalRequested, { id: req.id, toolId });
    // Immutable audit trail (best-effort; skipped when security is absent).
    void this.auditApproval({
      actor: principalId,
      action: 'tool.approval.requested',
      resource: toolId,
      result: 'success',
      detail: { requestId: req.id, action, ...(reason ? { reason } : {}) },
    });
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
    this.ensureMetrics();
    this.mApprovals?.inc(1, { decision });
    this.mPending?.set([...this.approvals.values()].filter((a) => a.status === 'pending').length);
    this.decisionHistory.push({ ts: Date.now(), decision });
    void this.api.bus.emit(ToolEvents.ApprovalDecided, { id: requestId, decision });
    // Immutable audit trail (best-effort; skipped when security is absent).
    void this.auditApproval({
      actor: decidedBy,
      action: 'tool.approval.decided',
      resource: req.toolId,
      result: decision === 'approved' ? 'success' : 'denied',
      detail: { requestId, decision, requester: req.principalId, ...(req.reason ? { reason: req.reason } : {}) },
    });
    return req;
  }

  getApproval(requestId: string): ApprovalRequest | undefined {
    return this.approvals.get(requestId);
  }

  listPendingApprovals(): ApprovalRequest[] {
    return [...this.approvals.values()].filter((a) => a.status === 'pending');
  }

  /**
   * Full approval-request history, newest first. `status` filters by
   * 'pending' | 'approved' | 'denied' | 'expired' (or omit for everything).
   */
  listApprovals(status?: ApprovalRequest['status']): ApprovalRequest[] {
    const all = [...this.approvals.values()];
    const filtered = status ? all.filter((a) => a.status === status) : all;
    return filtered.sort((a, b) => b.createdAt - a.createdAt);
  }

  // --- governance SLA alerts -------------------------------------------------

  /**
   * Evaluate governance SLA rules against live state:
   *   approval-queue-age — oldest pending approval older than the threshold
   *   deny-spike — DENY decisions in the rolling window above the cap
   *   r4-invocation-rate — R4/R5 invocations in the rolling window above the cap
   * Emits governance.alert.fired / governance.alert.cleared bus events on
   * state transitions.
   */
  async evaluateSlaRules(): Promise<{ checkedAt: number; alerts: SlaAlert[] }> {
    const checkedAt = Date.now();
    const now = checkedAt;
    const stats = await this.governanceStats();
    const alerts: SlaAlert[] = [];

    // 1. Approval queue age.
    const pending = [...this.approvals.values()].filter((a) => a.status === 'pending');
    const oldest = pending.length ? Math.min(...pending.map((a) => a.createdAt)) : undefined;
    const ageMs = oldest !== undefined ? now - oldest : 0;
    const queueAlert: SlaAlert = {
      id: 'approval-queue-age',
      severity: 'warning',
      state: oldest !== undefined && ageMs > this.sla.pendingApprovalMaxAgeMs ? 'firing' : 'ok',
      message: oldest !== undefined && ageMs > this.sla.pendingApprovalMaxAgeMs
        ? `Oldest pending approval is ${Math.round(ageMs / 1000)}s old (limit ${Math.round(this.sla.pendingApprovalMaxAgeMs / 1000)}s)`
        : 'Pending approval queue within SLA',
      value: Math.round(ageMs / 1000),
      threshold: Math.round(this.sla.pendingApprovalMaxAgeMs / 1000),
      checkedAt,
    };
    alerts.push(queueAlert);

    // 2. DENY spike (rolling window).
    const sinceDeny = now - this.sla.denySpikeWindowMs;
    const denials = this.decisionHistory.filter((d) => d.decision === 'denied' && d.ts >= sinceDeny).length;
    const denyAlert: SlaAlert = {
      id: 'deny-spike',
      severity: 'critical',
      state: denials > this.sla.denySpikeMax ? 'firing' : 'ok',
      message: denials > this.sla.denySpikeMax
        ? `${denials} governance DENY decisions in the last ${Math.round(this.sla.denySpikeWindowMs / 60_000)}m (limit ${this.sla.denySpikeMax})`
        : 'Governance DENY rate within SLA',
      value: denials,
      threshold: this.sla.denySpikeMax,
      checkedAt,
    };
    alerts.push(denyAlert);

    // 3. R4/R5 invocation rate (rolling window).
    const sinceR4 = now - this.sla.r4RateWindowMs;
    const r4Count = this.r4History.filter((r) => r.ts >= sinceR4).length;
    const r4Alert: SlaAlert = {
      id: 'r4-invocation-rate',
      severity: 'warning',
      state: r4Count > this.sla.r4RateMax ? 'firing' : 'ok',
      message: r4Count > this.sla.r4RateMax
        ? `${r4Count} high-risk (R4/R5) invocations in the last ${Math.round(this.sla.r4RateWindowMs / 60_000)}m (limit ${this.sla.r4RateMax})`
        : 'High-risk invocation rate within SLA',
      value: r4Count,
      threshold: this.sla.r4RateMax,
      checkedAt,
    };
    alerts.push(r4Alert);

    // State transitions → bus events.
    for (const a of alerts) {
      const prev = this.lastSlaStates.get(a.id);
      if (prev !== a.state) {
        this.lastSlaStates.set(a.id, a.state);
        if (a.state === 'firing') {
          void this.api.bus.emit('governance.alert.fired', { alertId: a.id, severity: a.severity, message: a.message });
        } else if (prev === 'firing') {
          void this.api.bus.emit('governance.alert.cleared', { alertId: a.id });
        }
      }
    }
    void stats;
    return { checkedAt, alerts };
  }

  // --- governance observability -------------------------------------------

  /**
   * Aggregate governance state: registry posture, approval flow, and
   * invocation/governance metrics (when the metrics module is registered).
   */
  async governanceStats(): Promise<GovernanceStats> {
    const all = await this.tools.all();
    const byRisk: Record<string, number> = {};
    for (const t of all) byRisk[t.riskClass] = (byRisk[t.riskClass] ?? 0) + 1;
    const active = all.filter((t) => t.status === 'ACTIVE').length;
    const approvalGated = all.filter((t) => needsApproval(t)).length;
    const agentTools = all.filter((t) => t.metadata?.agentTool === true).length;

    const approvals = [...this.approvals.values()];
    const byApprovalDecision: Record<string, number> = {};
    for (const a of approvals) byApprovalDecision[a.status] = (byApprovalDecision[a.status] ?? 0) + 1;

    const invocationsByRisk: Record<string, number> = {};
    const invocationsByStatus: Record<string, number> = {};
    const decisions: Record<string, number> = {};
    let invocationsTotal = 0;
    let durationSum = 0;
    let durationCount = 0;

    this.ensureMetrics();
    if (this.metrics) {
      for (const s of this.mInvocations?.samples() ?? []) {
        invocationsTotal += s.value;
        if (s.labels?.risk) invocationsByRisk[s.labels.risk] = (invocationsByRisk[s.labels.risk] ?? 0) + s.value;
        if (s.labels?.status) invocationsByStatus[s.labels.status] = (invocationsByStatus[s.labels.status] ?? 0) + s.value;
      }
      for (const s of this.mDecisions?.samples() ?? []) {
        if (s.labels?.decision) decisions[s.labels.decision] = (decisions[s.labels.decision] ?? 0) + s.value;
      }
      // Aggregate duration across every label series (durations are labeled by risk class).
      for (const s of this.mDuration?.samples() ?? []) {
        if (s.histogram) { durationSum += s.histogram.sum; durationCount += s.histogram.count; }
      }
    }

    return {
      tools: { total: all.length, active, byRisk, approvalGated, agentTools },
      approvals: {
        pending: byApprovalDecision.pending ?? 0,
        requested: approvals.length,
        approved: byApprovalDecision.approved ?? 0,
        denied: byApprovalDecision.denied ?? 0,
        expired: byApprovalDecision.expired ?? 0,
      },
      invocations: {
        total: invocationsTotal,
        byRisk: invocationsByRisk,
        byStatus: invocationsByStatus,
      },
      decisions: { total: Object.values(decisions).reduce((n, v) => n + v, 0), byDecision: decisions },
      avgDurationMs: durationCount > 0 ? Math.round((durationSum / durationCount) * 10) / 10 : undefined,
    };
  }

  /** Lazily resolve the metrics module and create the governance instruments. */
  private ensureMetrics(): void {
    if (this.metrics) return;
    try {
      this.metrics = this.api.getModule<MetricsModule>('metrics');
    } catch {
      return;
    }
    const r = this.metrics.registry;
    this.mInvocations = r.counter('jataqi_tool_invocations_total', 'Tool invocations by risk class and outcome');
    this.mDecisions = r.counter('jataqi_tool_governance_decisions_total', 'Governance gate decisions (ALLOW/DENY/REQUIRES_*)');
    this.mApprovals = r.counter('jataqi_tool_approval_requests_total', 'Tool approval requests by decision');
    this.mDuration = r.histogram('jataqi_tool_invocation_duration_ms', 'Tool invocation duration in ms');
    this.mPending = r.gauge('jataqi_tool_pending_approvals', 'Currently pending tool approval requests');
  }

  private recordInvocation(tool: ToolEntity, status: InvocationResult['status'], durationMs: number, decision?: string): void {
    this.ensureMetrics();
    if (tool.riskClass === 'R4' || tool.riskClass === 'R5') this.r4History.push({ ts: Date.now() });
    if (!this.metrics) return;
    this.mInvocations?.inc(1, { risk: tool.riskClass, status });
    this.mDuration?.observe(durationMs, { risk: tool.riskClass });
    if (decision) this.mDecisions?.inc(1, { decision });
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
        const res = await this.invoke(tool.id, input, principal);
        if (res.status === 'success') return res;
        // Governance denials / pending approvals / failures → try next tool.
        failures.push({ toolId: tool.id, error: res.error ?? res.status });
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

    // MANDATORY governance gate (policy-governance). Enforced when registered;
    // skipped gracefully when absent. Sits before the risk-class security gate.
    const gate = await this.governanceGate(tool, principal);
    if (gate && !gate.allowed) {
      const status: InvocationResult['status'] = gate.decision === 'REQUIRES_APPROVAL' || gate.decision === 'REQUIRES_HUMAN_REVIEW' ? 'pending_approval' : 'denied';
      const result: InvocationResult = {
        requestId: randomUUID(),
        toolId,
        status,
        error: `governance ${gate.decision}: ${gate.reason}`,
        durationMs: Date.now() - t0,
        ...(gate.evaluationId ? { governance: { decision: gate.decision, evaluationId: gate.evaluationId } } : {}),
      };
      this.recordInvocation(tool, result.status, result.durationMs, gate.decision);
      return result;
    }

    // High-risk gating (tool directive #10/#17/#19) — preserved security layer.
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
        this.recordInvocation(tool, result.status, result.durationMs);
        // Audit the denied high-risk invocation attempt (best-effort).
        void this.auditApproval({
          actor: principal?.userId ?? 'anonymous',
          action: 'tool.approval.required',
          resource: tool.canonicalName,
          result: 'denied',
          detail: { toolId, riskClass: tool.riskClass, ...(req ? { approvalRequestId: req.id, approvalStatus: req.status } : {}) },
        });
        return result;
      }
    }

    const ctx: InvocationContext = { toolId, principal, requestId: randomUUID() };
    let output: unknown;
    try {
      output = await adapter.invoke(input, ctx);
    } catch (err) {
      const result: InvocationResult = { requestId: ctx.requestId, toolId, status: 'failure', error: (err as Error).message, durationMs: Date.now() - t0 };
      this.recordInvocation(tool, result.status, result.durationMs);
      void this.api.bus.emit(ToolEvents.ToolFailed, { toolId });
      return result;
    }

    if (adapter.validateOutput) {
      const err = adapter.validateOutput(output);
      if (err) {
        const result: InvocationResult = { requestId: ctx.requestId, toolId, status: 'failure', error: `invalid output — ${err}`, durationMs: Date.now() - t0 };
        this.recordInvocation(tool, result.status, result.durationMs);
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
      ...(gate ? { governance: { decision: gate.decision, ...(gate.evaluationId ? { evaluationId: gate.evaluationId } : {}) } } : {}),
    };
    this.recordInvocation(tool, result.status, result.durationMs, gate?.decision);
    await this.api.bus.emit(ToolEvents.ToolInvoked, { toolId, status: 'success' });
    return result;
  }

  /**
   * Mandatory governance gate. Evaluates 'tool.invoke' (with the tool's risk
   * level) via policy-governance when registered. Returns undefined when
   * governance is absent (gate skipped), or a decision object.
   */
  private async governanceGate(tool: ToolEntity, principal?: InvocationContext['principal']): Promise<{ allowed: boolean; decision: string; reason: string; evaluationId?: string } | undefined> {
    let gov: { evaluate: (s: { userId: string; roles?: string[] }, a: string, c: Record<string, unknown>) => Promise<{ decision: string; reason: string; evaluationId: string }> };
    try {
      gov = this.api.getModule('policy-governance') as unknown as typeof gov;
    } catch {
      return undefined;
    }
    const risk = Number.parseInt((tool.riskClass ?? 'R0').replace('R', ''), 10) || 0;
    const subject = { userId: principal?.userId ?? 'anonymous', roles: principal?.roles };
    try {
      const res = await gov.evaluate(subject, 'tool.invoke', { toolId: tool.id, risk });
      // The decision is recorded by recordInvocation on every invoke outcome
      // (denied / pending_approval / success) so it is never double-counted.
      return { allowed: res.decision === 'ALLOW', decision: res.decision, reason: res.reason, evaluationId: res.evaluationId };
    } catch (err) {
      return { allowed: true, decision: 'ALLOW', reason: `governance eval error: ${(err as Error).message}` };
    }
  }

  private trySecurity(): { audit: (rec: Record<string, unknown>) => Promise<{ id: string }> } | undefined {
    try {
      return this.api.getModule('security') as unknown as { audit: (rec: Record<string, unknown>) => Promise<{ id: string }> };
    } catch {
      return undefined;
    }
  }

  /** Write an approval-lifecycle record to the immutable audit ledger. */
  private async auditApproval(rec: { actor: string; action: string; resource: string; result: string; detail: Record<string, unknown> }): Promise<void> {
    const sec = this.trySecurity();
    if (!sec) return;
    try {
      await sec.audit({ actor: rec.actor, action: rec.action, resource: rec.resource, result: rec.result, detail: rec.detail });
    } catch { /* audit is best-effort */ }
  }
}
