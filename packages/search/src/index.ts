// @jataqi/search — JATA Qi Universal Search & Discovery (Phase 6). Public API.

export { SearchModule, SearchEvents } from './search-module.js';
export { SearchEngine } from './search-engine.js';
export {
  KnowledgeAdapter, MemoryAdapter, GraphAdapter, ConversationsAdapter, ToolsAdapter,
  buildAdapters, tokenize, tokenOverlap,
} from './adapters.js';
export type {
  SearchSourceId, SearchHit, SearchOptions, SearchFacets, SearchResult,
  SearchSuggestion, SearchStats, SearchAdapter,
} from './types.js';
