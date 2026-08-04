// MultimodalIntelligenceModule — the Universal Multimodal Intelligence
// Acquisition & Autonomous Self-Evolution Framework. Orchestrates modality-
// specific acquisition pipelines, normalizes inputs into SemanticKnowledge,
// stores in knowledge-graph + memory, analyzes capability gaps, generates
// governed proposals, and drives validated self-evolution. COMPOSES the
// existing intelligence stack — does not duplicate any module.

import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { process } from './processor.js';
import type {
  AcquisitionResult, AcquisitionSource, Authorization, Modality,
  MultimodalIntelConfig, PrivacyLevel, SemanticKnowledge,
} from './types.js';

export const MultimodalIntelEvents = Object.freeze({
  Acquired: 'multimodal.acquired',
  Stored: 'multimodal.stored',
  GapsDetected: 'multimodal.gaps.detected',
  Unauthorized: 'multimodal.unauthorized',
} as const);

export class MultimodalIntelligenceModule implements IModule {
  readonly id = 'multimodal-intelligence';
  readonly tags = ['core', 'intelligence'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private cfg: Required<MultimodalIntelConfig>;
  private sources = new Map<string, AcquisitionSource>();
  private results: AcquisitionResult[] = [];

  constructor(config: MultimodalIntelConfig = {}) {
    this.cfg = {
      retentionDays: config.retentionDays ?? 90,
      minConfidence: config.minConfidence ?? 0.2,
      autoAnalyzeGaps: config.autoAnalyzeGaps ?? true,
      requireAuth: config.requireAuth ?? true,
    };
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('multimodal-intelligence', this);
    kernel.logger.info('multimodal-intelligence module initialized');
  }
  async start(_kernel: KernelApi): Promise<void> {}
  async stop(_kernel: KernelApi): Promise<void> {}

  // ---- source management --------------------------------------------------

  /** Register an acquisition source (optionally with authorization). */
  registerSource(source: Omit<AcquisitionSource, 'id'> & { id?: string }): AcquisitionSource {
    const full: AcquisitionSource = { ...source, id: source.id ?? randomUUID() };
    this.sources.set(full.id, full);
    return full;
  }

  /** Grant authorization for a source. */
  authorize(sourceId: string, auth: Omit<Authorization, 'grantedAt'>): AcquisitionSource | undefined {
    const s = this.sources.get(sourceId);
    if (!s) return undefined;
    s.authorization = { ...auth, grantedAt: Date.now() };
    return s;
  }

  /** Revoke authorization. */
  revoke(sourceId: string): boolean {
    const s = this.sources.get(sourceId);
    if (!s) return false;
    s.authorization = undefined;
    return true;
  }

  getSource(id: string): AcquisitionSource | undefined { return this.sources.get(id); }
  listSources(modality?: Modality): AcquisitionSource[] {
    const all = [...this.sources.values()];
    return modality ? all.filter((s) => s.modality === modality) : all;
  }

  // ---- core acquisition pipeline ------------------------------------------

  /**
   * Acquire intelligence from a registered source. The caller provides the raw
   * content (text, transcript, OCR, JSON, etc.); the module normalizes it into
   * SemanticKnowledge and stores it. Returns the acquisition result.
   */
  async acquire(sourceId: string, content: string): Promise<AcquisitionResult> {
    const source = this.sources.get(sourceId);
    if (!source) throw new Error(`source ${sourceId} not registered`);

    // Authorization gate (secure-by-default).
    if (source.requiresAuth && this.cfg.requireAuth) {
      const auth = source.authorization;
      if (!auth) {
        void this.api.bus.emit(MultimodalIntelEvents.Unauthorized, { sourceId });
        throw new Error(`source ${sourceId} requires authorization — use authorize() first`);
      }
      if (auth.expiresAt && auth.expiresAt < Date.now()) {
        throw new Error(`authorization for source ${sourceId} has expired`);
      }
    }

    const startMs = Date.now();
    const modality = source.modality;
    const sourceRef = String(source.config?.url ?? source.config?.path ?? source.name);

    // Phase 1-2: Normalize content into SemanticKnowledge.
    const knowledge = process(modality, content, sourceId, sourceRef);
    void this.api.bus.emit(MultimodalIntelEvents.Acquired, { sourceId, modality, concepts: knowledge.concepts.length });

    // Confidence gate.
    if (knowledge.confidence < this.cfg.minConfidence) {
      return {
        sourceId, modality, knowledge, privacyLevel: this.classifyPrivacy(knowledge, content),
        stored: false, gaps: [], processingMs: Date.now() - startMs,
      };
    }

    // Phase 3: Store in knowledge graph + memory.
    const stored = await this.storeKnowledge(source, knowledge);
    void this.api.bus.emit(MultimodalIntelEvents.Stored, { sourceId, knowledgeId: knowledge.id, stored });

    // Phase 4: Gap analysis (if enabled).
    let gaps: string[] = [];
    if (this.cfg.autoAnalyzeGaps) {
      gaps = this.detectGaps(knowledge, content);
      if (gaps.length > 0) void this.api.bus.emit(MultimodalIntelEvents.GapsDetected, { sourceId, count: gaps.length });
    }

    const result: AcquisitionResult = {
      sourceId, modality, knowledge,
      privacyLevel: this.classifyPrivacy(knowledge, content),
      stored, gaps, processingMs: Date.now() - startMs,
    };
    this.results.push(result);
    return result;
  }

  /** Acquire from a direct modality without pre-registering a source. */
  async acquireDirect(modality: Modality, content: string, name?: string): Promise<AcquisitionResult> {
    const source = this.registerSource({
      modality, name: name ?? `direct-${modality}`, requiresAuth: false,
    });
    return this.acquire(source.id, content);
  }

  /** Batch-acquire from multiple sources. */
  async acquireBatch(inputs: Array<{ sourceId: string; content: string }>): Promise<AcquisitionResult[]> {
    const results: AcquisitionResult[] = [];
    for (const { sourceId, content } of inputs) results.push(await this.acquire(sourceId, content));
    return results;
  }

  // ---- queries ------------------------------------------------------------

  getResults(sourceId?: string): AcquisitionResult[] {
    return sourceId ? this.results.filter((r) => r.sourceId === sourceId) : [...this.results];
  }

  summary(): {
    totalSources: number; totalAcquisitions: number; byModality: Record<string, number>;
    avgConfidence: number; totalConcepts: number; totalGaps: number;
  } {
    const byModality: Record<string, number> = {};
    let confidence = 0; let concepts = 0; let gaps = 0;
    for (const r of this.results) {
      byModality[r.modality] = (byModality[r.modality] ?? 0) + 1;
      confidence += r.knowledge.confidence;
      concepts += r.knowledge.concepts.length;
      gaps += r.gaps.length;
    }
    const n = this.results.length || 1;
    return {
      totalSources: this.sources.size, totalAcquisitions: this.results.length,
      byModality, avgConfidence: confidence / n, totalConcepts: concepts, totalGaps: gaps,
    };
  }

  // ---- Phase 3: Knowledge storage (delegates to existing modules) ---------

  private async storeKnowledge(source: AcquisitionSource, knowledge: SemanticKnowledge): Promise<boolean> {
    let stored = false;
    // Knowledge service.
    try {
      const ks = this.api.getModule('knowledge') as unknown as { ingest: (i: Record<string, unknown>) => Promise<unknown> } | undefined;
      if (ks && typeof ks.ingest === 'function') {
        await ks.ingest({
          documentId: `multimodal:${knowledge.id}`,
          title: `${source.modality}: ${source.name}`,
          content: JSON.stringify(knowledge),
          source: knowledge.sourceRef,
          metadata: { modality: source.modality, confidence: knowledge.confidence },
        });
        stored = true;
      }
    } catch { /* knowledge not registered */ }
    // Memory engine.
    try {
      const mem = this.api.getModule('memory') as unknown as { record: (i: Record<string, unknown>) => Promise<unknown> } | undefined;
      if (mem) {
        await mem.record({
          category: 'integration',
          summary: `Multimodal acquisition (${source.modality}): ${knowledge.concepts.slice(0, 5).join(', ')}`,
          data: { sourceId: source.id, modality: source.modality, conceptCount: knowledge.concepts.length, confidence: knowledge.confidence },
          tags: ['multimodal', source.modality],
          ...(source.authorization?.grantedBy ? { userId: source.authorization.grantedBy } : {}),
          ...(source.config?.orgId ? { orgId: source.config.orgId as string } : {}),
        });
        stored = true;
      }
    } catch { /* memory not registered */ }
    return stored;
  }

  // ---- Phase 4: Gap detection (lightweight — delegates deep analysis to link-intel/self-evolution) ----

  private GAP_KEYWORDS: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /oauth|oidc|saml/i, label: 'SSO/Federation' },
    { pattern: /abac|rebac/i, label: 'ABAC/ReBAC' },
    { pattern: /graphql/i, label: 'GraphQL' },
    { pattern: /mpesa|flutterwave|pesapal/i, label: 'African Payments' },
    { pattern: /blockchain|nft|web3/i, label: 'Blockchain' },
    { pattern: /data\s+lake|etl/i, label: 'Data Lake' },
    { pattern: /chaos\s+eng/i, label: 'Chaos Engineering' },
    { pattern: /service\s+mesh/i, label: 'Service Mesh' },
    { pattern: /lsp|language\s+server/i, label: 'LSP' },
    { pattern: /zero\s+trust/i, label: 'Zero Trust' },
  ];

  private detectGaps(knowledge: SemanticKnowledge, rawContent?: string): string[] {
    const text = (rawContent ?? '') + ' ' + knowledge.concepts.join(' ') + ' ' + knowledge.securityPatterns.join(' ') + ' ' + knowledge.workflows.join(' ');
    const gaps: string[] = [];
    for (const { pattern, label } of this.GAP_KEYWORDS) {
      if (pattern.test(text)) gaps.push(label);
    }
    return [...new Set(gaps)];
  }

  // ---- privacy classification ---------------------------------------------

  private classifyPrivacy(knowledge: SemanticKnowledge, rawContent?: string): PrivacyLevel {
    const text = (rawContent ?? '').toLowerCase() + ' ' + JSON.stringify(knowledge).toLowerCase();
    if (/password|secret|private\s+key|credit\s+card|ssn|national\s+id/.test(text)) return 'restricted';
    if (/personal|email|phone|address|user\s+data/.test(text)) return 'confidential';
    if (knowledge.concepts.length > 10) return 'internal';
    return 'public';
  }
}
