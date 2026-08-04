// SearchEngine — federates queries across source adapters and merges the
// results with deterministic, explainable scoring:
//
//   final = (relevance + recencyAdd + personalizationAdd) * sourceWeight
//
//   recencyAdd        = (1 - min(ageMs / 30d, 1)) * boosts.recency (default 0.1)
//   personalizationAdd= +boosts.personalization (default 0.15) per matched
//                       learned search-boost term for the user
//   sourceWeight      = boosts.source[source] ?? 1
//
// Hits are sorted by final score, capped at topK, and faceted by source +
// category. Suggestions are prefix-matched across adapters and deduped.

import type {
  SearchAdapter, SearchHit, SearchOptions, SearchResult, SearchSuggestion,
} from './types.js';
import { tokenize } from './adapters.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_TOP_K = 10;
const DEFAULT_MIN_SCORE = 0.05;

export class SearchEngine {
  private adapters = new Map<string, SearchAdapter>();
  private searches = 0;
  private suggestions = 0;
  private lastQuery?: string;
  private lastQueryAt?: number;

  constructor(adapters: SearchAdapter[] = []) {
    for (const a of adapters) this.register(a);
  }

  register(adapter: SearchAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  unregister(id: string): boolean {
    return this.adapters.delete(id);
  }

  adapterIds(): string[] {
    return [...this.adapters.keys()];
  }

  /** Federated search across all (or selected) registered sources. */
  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult> {
    const started = Date.now();
    const q = query.trim();
    if (!q) return { query: '', hits: [], total: 0, facets: { source: {}, category: {} }, tookMs: 0 };

    const topK = opts.topK ?? DEFAULT_TOP_K;
    const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
    const wanted = opts.sources?.length ? new Set(opts.sources) : null;
    const adapters = [...this.adapters.values()].filter((a) => !wanted || wanted.has(a.id));

    const results = await Promise.all(adapters.map((a) => a.search(q, opts)));
    const hits = results.flat();

    // Personalized boost terms from the learning module (passed by the module).
    const boostTerms = opts.boosts?.personalizationTerms ?? [];

    const qTokens = tokenize(q);
    for (const h of hits) {
      const recencyAdd = h.ts !== undefined
        ? (1 - Math.min(Math.max(Date.now() - h.ts, 0) / THIRTY_DAYS_MS, 1)) * (opts.boosts?.recency ?? 0.1)
        : 0;
      // Personalization boost applies per-hit: the hit must actually match
      // one of the user's learned boost terms (from @jataqi/learning).
      const hitText = `${h.title} ${h.snippet}`.toLowerCase();
      const personalizationAdd = boostTerms.some((t) => qTokens.includes(t) && hitText.includes(t))
        ? (opts.boosts?.personalization ?? 0.15)
        : 0;
      const sourceWeight = opts.boosts?.source?.[h.source] ?? 1;
      h.score = (h.relevance + recencyAdd + personalizationAdd) * sourceWeight;
    }

    const ranked = hits
      .filter((h) => h.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    const facets: SearchResult['facets'] = { source: {}, category: {} };
    for (const h of ranked) {
      facets.source[h.source] = (facets.source[h.source] ?? 0) + 1;
      const cat = typeof h.metadata.category === 'string' ? h.metadata.category : 'other';
      facets.category[cat] = (facets.category[cat] ?? 0) + 1;
    }

    this.searches++;
    this.lastQuery = q;
    this.lastQueryAt = Date.now();

    return { query: q, hits: ranked, total: ranked.length, facets, tookMs: Date.now() - started };
  }

  /** Prefix suggestions across adapters (deduped, best score first). */
  async suggest(prefix: string, opts: { sources?: string[]; limit?: number } = {}): Promise<SearchSuggestion[]> {
    const p = prefix.trim().toLowerCase();
    if (!p) return [];
    const limit = opts.limit ?? 8;
    const wanted = opts.sources?.length ? new Set(opts.sources) : null;
    const adapters = [...this.adapters.values()].filter((a) => !wanted || wanted.has(a.id));
    const lists = await Promise.all(adapters.map((a) => a.suggest(p, limit * 2)));
    const seen = new Set<string>();
    const out: SearchSuggestion[] = [];
    for (const s of lists.flat().sort((a, b) => b.score - a.score)) {
      const key = `${s.source}:${s.text.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
      if (out.length >= limit) break;
    }
    this.suggestions++;
    return out;
  }

  stats(): { adapters: number; searches: number; suggestions: number; lastQuery?: string; lastQueryAt?: number } {
    return {
      adapters: this.adapters.size,
      searches: this.searches,
      suggestions: this.suggestions,
      ...(this.lastQuery ? { lastQuery: this.lastQuery } : {}),
      ...(this.lastQueryAt ? { lastQueryAt: this.lastQueryAt } : {}),
    };
  }
}
