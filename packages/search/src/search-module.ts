// SearchModule (Phase 6) — the Universal Search & Discovery kernel module.
// Registers adapters for every searchable platform store that is present on
// the kernel (knowledge, memory, graph, conversations, tools), federates
// queries with personalized ranking (consuming @jataqi/learning adaptations),
// and records search history into the Digital Memory Engine when available.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { KnowledgeService } from '@jataqi/knowledge-service';
import type { KnowledgeGraphModule } from '@jataqi/knowledge-graph';
import type { DigitalMemoryModule } from '@jataqi/memory';
import type { ConversationsModule } from '@jataqi/conversations';
import type { ToolIntelligenceModule } from '@jataqi/tool-intelligence';
import type { ContinuousLearningModule } from '@jataqi/learning';
import { SearchEngine } from './search-engine.js';
import { buildAdapters } from './adapters.js';
import type {
  SearchOptions, SearchResult, SearchSuggestion, SearchSourceId, SearchStats,
} from './types.js';

export const SearchEvents = Object.freeze({
  SearchExecuted: 'search.executed',
  SearchRecorded: 'search.recorded',
} as const);

export class SearchModule implements IModule {
  readonly id = 'search';
  readonly tags = ['core', 'discovery'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private memory?: DigitalMemoryModule;
  private learning?: ContinuousLearningModule;
  readonly engine = new SearchEngine();
  private recordedSearches = 0;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('search', this);
    // Attach adapters for every searchable store present on the kernel.
    const adapters = buildAdapters({
      knowledge: this.tryModule<KnowledgeService>('knowledge'),
      memory: this.tryModule<DigitalMemoryModule>('memory'),
      graph: this.tryModule<KnowledgeGraphModule>('knowledge-graph'),
      conversations: this.tryModule<ConversationsModule>('conversations'),
      tools: this.tryModule<ToolIntelligenceModule>('tool-intelligence'),
    });
    for (const a of adapters) this.engine.register(a);
    this.memory = this.tryModule<DigitalMemoryModule>('memory');
    this.learning = this.tryModule<ContinuousLearningModule>('learning');
    kernel.logger.info(`search module initialized (${this.engine.adapterIds().length} sources: ${this.engine.adapterIds().join(', ') || 'none'})`);
  }
  async start(_kernel: KernelApi): Promise<void> { /* no background work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  /** Federated search across all registered sources. */
  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult> {
    // Personalization: fold the user's learned search-boost terms into ranking.
    let personalizationTerms: string[] | undefined;
    if (opts.userId && this.learning) {
      try {
        const adaptation = this.learning.adapt(opts.userId);
        personalizationTerms = adaptation?.searchBoost ?? [];
      } catch { /* learning unavailable */ }
    }
    const result = await this.engine.search(query, {
      ...opts,
      boosts: {
        ...(opts.boosts ?? {}),
        ...(personalizationTerms ? { personalizationTerms } : {}),
      },
    });
    void this.api.bus.emit(SearchEvents.SearchExecuted, {
      query: result.query, hits: result.total, sources: [...new Set(result.hits.map((h) => h.source))],
      ...(opts.userId ? { userId: opts.userId } : {}),
    });
    return result;
  }

  /** Prefix suggestions across sources. */
  async suggest(prefix: string, opts: { sources?: SearchSourceId[]; limit?: number } = {}): Promise<SearchSuggestion[]> {
    return this.engine.suggest(prefix, opts);
  }

  /** Record a search into history (Digital Memory Engine when present). */
  async recordSearch(userId: string, query: string, orgId?: string): Promise<boolean> {
    if (!this.memory || !query.trim()) return false;
    const res = await this.memory.record({
      category: 'search',
      summary: query.trim(),
      userId,
      ...(orgId ? { orgId } : {}),
      data: { source: 'unified-search' },
      tags: ['search', 'unified'],
    });
    if (res.recorded) {
      this.recordedSearches++;
      void this.api.bus.emit(SearchEvents.SearchRecorded, { userId, query: query.trim(), ...(orgId ? { orgId } : {}) });
    }
    return res.recorded;
  }

  /** Recent search history for a user (from memory). */
  recentSearches(userId: string, orgId?: string, limit = 20): Array<{ query: string; ts: number }> {
    if (!this.memory) return [];
    return this.memory.query({
      category: 'search',
      userId,
      ...(orgId ? { orgId } : {}),
      limit,
    }).map((e) => ({ query: e.summary, ts: e.ts }));
  }

  sources(): SearchSourceId[] {
    return this.engine.adapterIds() as SearchSourceId[];
  }

  stats(): SearchStats {
    const s = this.engine.stats();
    return {
      adapters: this.sources(),
      searches: s.searches,
      suggestions: s.suggestions,
      recordedSearches: this.recordedSearches,
      ...(s.lastQuery ? { lastQuery: s.lastQuery } : {}),
      ...(s.lastQueryAt ? { lastQueryAt: s.lastQueryAt } : {}),
    };
  }

  private tryModule<T extends IModule>(id: string): T | undefined {
    try { return this.api.getModule<T>(id); } catch { return undefined; }
  }
}
