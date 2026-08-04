// Source adapters for the Universal Search platform (Phase 6). Each adapter
// queries its native module and normalizes results into SearchHit shape with
// a 0..1 relevance score. All dependencies are optional — an adapter is only
// registered when its backing module is present on the kernel.

import type { KnowledgeService } from '@jataqi/knowledge-service';
import type { KnowledgeGraphModule } from '@jataqi/knowledge-graph';
import type { DigitalMemoryModule } from '@jataqi/memory';
import type { ConversationsModule } from '@jataqi/conversations';
import type { ToolIntelligenceModule } from '@jataqi/tool-intelligence';
import type { SearchAdapter, SearchHit, SearchOptions, SearchSuggestion, SearchSourceId } from './types.js';

const SNIPPET_LEN = 220;

/** Tokenize a query string into lowercase word tokens. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
}

/** Jaccard-ish overlap of query tokens against a token set, 0..1. */
export function tokenOverlap(queryTokens: string[], haystack: string): number {
  if (queryTokens.length === 0) return 0;
  const hay = new Set(tokenize(haystack));
  if (hay.size === 0) return 0;
  let matched = 0;
  for (const t of queryTokens) if (hay.has(t)) matched++;
  return matched / Math.max(queryTokens.length, 2);
}

// ---- knowledge ------------------------------------------------------------

export class KnowledgeAdapter implements SearchAdapter {
  readonly id = 'knowledge' as SearchSourceId;

  constructor(private readonly knowledge: KnowledgeService) {}

  async search(query: string, opts: SearchOptions): Promise<SearchHit[]> {
    const hits = await this.knowledge.retrieve(query, {
      topK: (opts.topK ?? 10) * 3,
      minScore: 0,
      expandContext: false,
    });
    const qTokens = tokenize(query);
    return hits.map((h) => {
      const relevance = Math.max(h.score, tokenOverlap(qTokens, h.chunk.text));
      return {
        source: 'knowledge',
        id: h.chunk.id,
        title: h.document.title ?? `Document ${h.document.id}`,
        snippet: h.chunk.text.slice(0, SNIPPET_LEN),
        score: 0,
        relevance,
        url: h.document.uri,
        ts: h.document.createdAt,
        metadata: {
          documentId: h.document.id,
          chunkId: h.chunk.id,
          retrieval: h.source,
          ...(h.document.metadata?.category ? { category: h.document.metadata.category } : {}),
        },
      };
    });
  }

  async suggest(prefix: string, limit: number): Promise<SearchSuggestion[]> {
    const hits = await this.knowledge.retrieve(prefix, { topK: limit, minScore: 0, expandContext: false });
    const seen = new Set<string>();
    const out: SearchSuggestion[] = [];
    for (const h of hits) {
      const title = h.document.title ?? h.chunk.text.slice(0, 40);
      if (seen.has(title)) continue;
      seen.add(title);
      out.push({ text: title, source: 'knowledge', score: h.score });
      if (out.length >= limit) break;
    }
    return out;
  }
}

// ---- memory ---------------------------------------------------------------

export class MemoryAdapter implements SearchAdapter {
  readonly id = 'memory' as SearchSourceId;

  constructor(private readonly memory: DigitalMemoryModule) {}

  async search(query: string, opts: SearchOptions): Promise<SearchHit[]> {
    const events = this.memory.query({
      text: query,
      ...(opts.orgId ? { orgId: opts.orgId } : {}),
      ...(opts.userId ? { userId: opts.userId } : {}),
      ...(opts.category ? { category: opts.category as never } : {}),
      ...(opts.fromTs ? { fromTs: opts.fromTs } : {}),
      ...(opts.toTs ? { toTs: opts.toTs } : {}),
      limit: (opts.topK ?? 10) * 3,
    });
    const qTokens = tokenize(query);
    return events.map((e) => ({
      source: 'memory' as SearchSourceId,
      id: e.id,
      title: e.summary.slice(0, 80),
      snippet: e.summary.slice(0, SNIPPET_LEN),
      score: 0,
      relevance: tokenOverlap(qTokens, e.summary),
      ts: e.ts,
      metadata: {
        category: e.category,
        ...(e.userId ? { userId: e.userId } : {}),
        ...(e.orgId ? { orgId: e.orgId } : {}),
        ...(e.sessionId ? { sessionId: e.sessionId } : {}),
        ...(e.tags ? { tags: e.tags } : {}),
      },
    }));
  }

  async suggest(prefix: string, limit: number): Promise<SearchSuggestion[]> {
    const events = this.memory.query({ text: prefix, limit: limit * 2 });
    const seen = new Set<string>();
    const out: SearchSuggestion[] = [];
    for (const e of events) {
      const text = e.summary.slice(0, 60);
      if (seen.has(text)) continue;
      seen.add(text);
      out.push({ text, source: 'memory', score: 0.5 });
      if (out.length >= limit) break;
    }
    return out;
  }
}

// ---- knowledge graph ------------------------------------------------------

export class GraphAdapter implements SearchAdapter {
  readonly id = 'graph' as SearchSourceId;

  constructor(private readonly graph: KnowledgeGraphModule) {}

  async search(query: string, opts: SearchOptions): Promise<SearchHit[]> {
    const hits = await this.graph.findEntities(query, { topK: (opts.topK ?? 10) * 3 });
    const qTokens = tokenize(query);
    return hits
      .filter((h) => h.entity.type !== 'Document') // docs surface via knowledge
      .map((h) => ({
        source: 'graph' as SearchSourceId,
        id: h.entity.id,
        title: h.entity.name,
        snippet: `${h.entity.type}: ${h.entity.name}`,
        score: 0,
        relevance: Math.max(h.score, tokenOverlap(qTokens, h.entity.name)),
        ts: h.entity.createdAt,
        metadata: { type: h.entity.type, properties: h.entity.properties ?? {} },
      }));
  }

  async suggest(prefix: string, limit: number): Promise<SearchSuggestion[]> {
    const hits = await this.graph.findEntities(prefix, { topK: limit });
    return hits.map((h) => ({ text: h.entity.name, source: 'graph', score: h.score }));
  }
}

// ---- conversations --------------------------------------------------------

export class ConversationsAdapter implements SearchAdapter {
  readonly id = 'conversations' as SearchSourceId;

  constructor(private readonly conversations: ConversationsModule) {}

  async search(query: string, opts: SearchOptions): Promise<SearchHit[]> {
    // Conversations are tenant- and user-scoped; without a userId there is
    // nothing meaningful (and privacy-safe) to federate.
    if (!opts.userId) return [];
    const { conversations: convs } = await this.conversations.list(opts.userId, {
      search: query,
      limit: (opts.topK ?? 10) * 2,
    });
    const qTokens = tokenize(query);
    const out: SearchHit[] = [];
    for (const c of convs) {
      const snippet = c.messages.map((m) => m.content).join(' ').slice(0, SNIPPET_LEN);
      const relevance = tokenOverlap(qTokens, `${c.title} ${snippet}`);
      if (relevance === 0) continue;
      out.push({
        source: 'conversations',
        id: c.id,
        title: c.title || 'Untitled conversation',
        snippet,
        score: 0,
        relevance,
        ts: c.updatedAt,
        metadata: { messageCount: c.messages.length, ...(c.folderId ? { folderId: c.folderId } : {}) },
      });
    }
    return out;
  }

  async suggest(prefix: string, limit: number): Promise<SearchSuggestion[]> {
    if (!prefix) return [];
    // Suggestions require a user; the module-level suggest passes userId via
    // opts only to search(). Keep this adapter's suggest best-effort empty.
    void limit;
    return [];
  }
}

// ---- tools ------------------------------------------------------------------

export class ToolsAdapter implements SearchAdapter {
  readonly id = 'tools' as SearchSourceId;

  constructor(private readonly tools: ToolIntelligenceModule) {}

  async search(query: string, opts: SearchOptions): Promise<SearchHit[]> {
    const all = await this.tools.list();
    const qTokens = tokenize(query);
    const out: SearchHit[] = [];
    for (const t of all) {
      const haystack = `${t.canonicalName} ${t.displayName} ${t.category} ${t.capabilities.join(' ')}`;
      const relevance = tokenOverlap(qTokens, haystack);
      if (relevance === 0) continue;
      out.push({
        source: 'tools',
        id: t.id,
        title: t.displayName,
        snippet: `${t.canonicalName} (${t.provider}) — ${t.capabilities.slice(0, 4).join(', ')}`,
        score: 0,
        relevance,
        metadata: { canonicalName: t.canonicalName, provider: t.provider, category: t.category, riskClass: t.riskClass },
      });
    }
    return out;
  }

  async suggest(prefix: string, limit: number): Promise<SearchSuggestion[]> {
    const all = await this.tools.list();
    const p = prefix.toLowerCase();
    const out: SearchSuggestion[] = [];
    for (const t of all) {
      if (t.displayName.toLowerCase().startsWith(p) || t.canonicalName.toLowerCase().startsWith(p)) {
        out.push({ text: t.displayName, source: 'tools', score: 0.7 });
        if (out.length >= limit) break;
      }
    }
    return out;
  }
}

/** Build the full adapter set from optional modules. */
export function buildAdapters(deps: {
  knowledge?: KnowledgeService;
  memory?: DigitalMemoryModule;
  graph?: KnowledgeGraphModule;
  conversations?: ConversationsModule;
  tools?: ToolIntelligenceModule;
}): SearchAdapter[] {
  const adapters: SearchAdapter[] = [];
  if (deps.knowledge) adapters.push(new KnowledgeAdapter(deps.knowledge));
  if (deps.memory) adapters.push(new MemoryAdapter(deps.memory));
  if (deps.graph) adapters.push(new GraphAdapter(deps.graph));
  if (deps.conversations) adapters.push(new ConversationsAdapter(deps.conversations));
  if (deps.tools) adapters.push(new ToolsAdapter(deps.tools));
  return adapters;
}
