// JATA Qi Universal Search & Discovery (Phase 6) — types.
//
// The search platform federates queries across the platform's intelligence
// stores (knowledge, memory, graph, conversations, tools) through pluggable
// adapters, merges + ranks the results with deterministic, explainable
// scoring (relevance + recency decay + personalization boost + per-source
// weights), and exposes facets, suggestions, and search history.

/** Adapter identifiers for the federated search sources. */
export type SearchSourceId = 'knowledge' | 'memory' | 'graph' | 'conversations' | 'tools';

/** A normalized, source-agnostic search hit. */
export interface SearchHit {
  source: SearchSourceId;
  id: string;
  title: string;
  /** Truncated content/description snippet. */
  snippet: string;
  /** Final merged score (0..1+ after boosts). */
  score: number;
  /** Raw relevance from the source adapter (0..1) before boosts. */
  relevance: number;
  /** Optional stable URL/URI. */
  url?: string;
  /** When the underlying item was created/updated (for recency decay). */
  ts?: number;
  metadata: Record<string, unknown>;
}

export interface SearchOptions {
  /** Restrict to specific sources (default: all registered). */
  sources?: SearchSourceId[];
  /** Max hits returned (default 10). */
  topK?: number;
  /** Minimum final score (default 0.05). */
  minScore?: number;
  /** Personalize ranking with this user's learned search boost. */
  userId?: string;
  /** Tenant scope for tenant-aware sources. */
  orgId?: string;
  /** Restrict memory/conversation hits to this window. */
  fromTs?: number;
  toTs?: number;
  /** Optional category filter (applied to memory events + knowledge metadata). */
  category?: string;
  /** Ranking knobs. */
  boosts?: {
    /** Recency weight (0..1) applied as (1 - age/30d) * weight. */
    recency?: number;
    /** Boost per personalized search-boost term match (default 0.15). */
    personalization?: number;
    /** Per-source score multipliers. */
    source?: Partial<Record<SearchSourceId, number>>;
    /** Learned boost terms (from @jataqi/learning personalization). */
    personalizationTerms?: string[];
  };
}

export interface SearchFacets {
  source: Partial<Record<SearchSourceId, number>>;
  category: Record<string, number>;
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
  total: number;
  facets: SearchFacets;
  tookMs: number;
}

export interface SearchSuggestion {
  text: string;
  source: SearchSourceId;
  score: number;
}

export interface SearchStats {
  adapters: SearchSourceId[];
  searches: number;
  suggestions: number;
  recordedSearches: number;
  lastQuery?: string;
  lastQueryAt?: number;
}

/**
 * A pluggable source adapter. Each adapter knows how to query its native
 * store and normalize results into SearchHit shape with a 0..1 relevance.
 */
export interface SearchAdapter {
  readonly id: SearchSourceId;
  /** Federated query over this source. */
  search(query: string, opts: SearchOptions): Promise<SearchHit[]>;
  /** Completion-style suggestions from this source's titles/names. */
  suggest(prefix: string, limit: number): Promise<SearchSuggestion[]>;
}
