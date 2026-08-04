// JATA Qi Multimodal Intelligence Acquisition — types. A pluggable acquisition
// framework that normalizes every authorized input modality (documents, images,
// audio, video, code, device telemetry, enterprise knowledge, web content) into
// structured semantic knowledge. It COMPOSES the existing intelligence stack:
// memory, knowledge-graph, self-evolution, learning, link-intelligence, and
// governance — it does not duplicate them.

/** Input modality — drives which acquisition pipeline processes the input. */
export type Modality =
  | 'text'           // plain text, markdown, JSON, YAML, XML, HTML
  | 'document'       // PDF, DOCX, PPTX, XLSX, CSV
  | 'image'          // photos, screenshots, diagrams, charts, OCR
  | 'audio'          // meetings, podcasts, lectures, voice notes
  | 'video'          // recordings, demos, tutorials
  | 'code'           // source code, repos, API specs
  | 'web'            // websites, blogs, docs portals, RFCs
  | 'device'         // IoT telemetry, sensor data, device events
  | 'enterprise'     // wikis, tickets, CRM, ERP, project management
  | 'api'            // REST, GraphQL, gRPC, streaming, webhooks
  | 'link';          // URLs (delegates to link-intelligence)

/** Authorization scope for an acquisition source. */
export interface Authorization {
  /** The user or admin who granted access. */
  grantedBy: string;
  /** What data may be collected. */
  scope: string;
  /** When the authorization was granted. */
  grantedAt: number;
  /** Optional expiry. */
  expiresAt?: number;
  /** Legal basis (consent, contract, legitimate_interest, etc.). */
  legalBasis?: string;
}

/** An acquisition source descriptor. */
export interface AcquisitionSource {
  id: string;
  modality: Modality;
  /** Human-readable name (e.g. "Company Wiki", "GitHub Repo"). */
  name: string;
  /** Whether the source requires explicit authorization. */
  requiresAuth: boolean;
  /** Active authorization (if required and granted). */
  authorization?: Authorization;
  /** Source-specific metadata (URL, connection string, etc.). */
  config?: Record<string, unknown>;
}

/** Normalized semantic knowledge extracted from any modality. */
export interface SemanticKnowledge {
  id: string;
  sourceId: string;
  modality: Modality;
  /** Concepts extracted (normalized to lowercase). */
  concepts: string[];
  /** Relationships between concepts. */
  relationships: Array<{ from: string; relation: string; to: string; confidence: number }>;
  /** Facts (attribute-value pairs). */
  facts: Array<{ subject: string; predicate: string; object: string; confidence: number }>;
  /** Procedures / step-by-step processes. */
  procedures: Array<{ name: string; steps: string[] }>;
  /** Data models / schemas detected. */
  dataModels: string[];
  /** APIs detected. */
  apis: Array<{ name: string; method?: string; path?: string }>;
  /** Security patterns detected. */
  securityPatterns: string[];
  /** Performance optimizations. */
  optimizations: string[];
  /** Workflows / business logic. */
  workflows: string[];
  /** Code snippets (if applicable). */
  snippets: Array<{ language: string; content: string }>;
  /** Overall extraction confidence (0..1). */
  confidence: number;
  /** Source attribution (URL, filename, device id, etc.). */
  sourceRef: string;
  extractedAt: number;
}

/** Privacy classification of extracted knowledge. */
export type PrivacyLevel = 'public' | 'internal' | 'confidential' | 'restricted';

/** A processed acquisition result. */
export interface AcquisitionResult {
  sourceId: string;
  modality: Modality;
  knowledge: SemanticKnowledge;
  privacyLevel: PrivacyLevel;
  /** Whether the knowledge was stored in the graph + memory. */
  stored: boolean;
  /** Capability gaps detected (if any). */
  gaps: string[];
  /** Processing time in ms. */
  processingMs: number;
}

/** Configuration for the multimodal intelligence module. */
export interface MultimodalIntelConfig {
  /** Default retention in days for acquired knowledge. */
  retentionDays?: number;
  /** Minimum confidence for knowledge to be stored. */
  minConfidence?: number;
  /** Whether to auto-analyze gaps after acquisition. */
  autoAnalyzeGaps?: boolean;
  /** Whether to require authorization for all sources (secure-by-default). */
  requireAuth?: boolean;
}
