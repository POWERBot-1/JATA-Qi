// JATA Qi Digital Memory Engine — types. A unified, governed store for
// structured platform knowledge: every meaningful platform event (commands,
// prompts, AI responses, workflows, API traffic, navigation, search, dashboard
// interactions, auth, billing, security, errors, …) is normalized into a
// MemoryEvent, tenant-isolated, indexed, retained per policy, and retrievable
// by keyword or semantic search. This is the substrate for Continuous Learning,
// Personalization, AI Learning, and the governed Self-Evolution framework.

/** The canonical memory categories (extensible — arbitrary strings allowed). */
export type MemoryCategory =
  | 'command' | 'prompt' | 'ai_response' | 'workflow' | 'api_request' | 'api_response'
  | 'feature_usage' | 'navigation' | 'search' | 'dashboard' | 'widget' | 'notification'
  | 'auth' | 'config_change' | 'plugin' | 'marketplace' | 'billing' | 'security'
  | 'collaboration' | 'file' | 'integration' | 'performance' | 'error' | 'exception'
  | 'incident' | 'operational' | (string & {});

/** Data-sensitivity classification (drives retention + access). */
export type Sensitivity = 'public' | 'internal' | 'confidential' | 'restricted';

/** A normalized, governed memory record. */
export interface MemoryEvent {
  id: string;
  category: MemoryCategory;
  ts: number;
  userId?: string;
  /** Tenant / organization scope (enforced on every query). */
  orgId?: string;
  sessionId?: string;
  /** Links related events across a flow (request→response, prompt→response). */
  correlationId?: string;
  /** Human-readable summary (indexed for search). */
  summary: string;
  /** Structured payload (metadata-extracted, JSON-safe). */
  data?: Record<string, unknown>;
  tags?: string[];
  sensitivity: Sensitivity;
  /** Per-event retention override (days); undefined = use org policy. */
  retentionDays?: number;
  /** Revision number (versioning — bumps when the same logical event is re-recorded). */
  version: number;
  /** Content fingerprint (SHA-256) for dedup/versioning. */
  hash: string;
  /** Tokenized searchable text (built from summary + tags + data keys). */
  tokens: string[];
  createdAt: number;
}

/** Input to record() — the engine normalizes + enriches it. */
export interface RecordInput {
  category: MemoryCategory;
  summary: string;
  userId?: string;
  orgId?: string;
  sessionId?: string;
  correlationId?: string;
  data?: Record<string, unknown>;
  tags?: string[];
  sensitivity?: Sensitivity;
  retentionDays?: number;
  /** Override timestamp (else Date.now()). */
  ts?: number;
}

/** Query filter — always tenant-scoped by orgId. */
export interface MemoryQuery {
  orgId?: string;
  category?: MemoryCategory | MemoryCategory[];
  userId?: string;
  sessionId?: string;
  correlationId?: string;
  tags?: string[];
  fromTs?: number;
  toTs?: number;
  /** Free-text keyword (matched against the token index). */
  text?: string;
  limit?: number;
}

/** Per-organization memory governance policy. */
export interface OrgMemoryPolicy {
  orgId: string;
  /** Categories permitted to be recorded (allow-list). Empty = all allowed. */
  allowedCategories?: MemoryCategory[];
  /** Categories explicitly blocked. */
  blockedCategories?: MemoryCategory[];
  /** Require explicit user consent for these categories. */
  consentRequiredCategories?: MemoryCategory[];
  /** Default retention in days per category (or a global default). */
  retentionDays?: number;
  retentionByCategory?: Partial<Record<MemoryCategory, number>>;
  /** Disable memory entirely for the org (opt-out). */
  disabled?: boolean;
}

/** Consent record (delegates to @jataqi/privacy in production). */
export interface ConsentState {
  /** userId|orgId -> set of categories the subject consented to. */
  granted: Map<string, Set<MemoryCategory>>;
}

export interface MemoryStats {
  total: number;
  byCategory: Record<string, number>;
  byOrg: Record<string, number>;
}

/** A recorded-memory outcome (includes whether retention/consent dropped it). */
export interface RecordResult {
  recorded: boolean;
  event?: MemoryEvent;
  reason?: 'category-blocked' | 'org-disabled' | 'consent-required' | 'retained';
}
