// JATA Qi Link Intelligence — types. The Universal Link Intelligence engine
// classifies external content (repos, docs, APIs, papers, RFCs), extracts
// structured intelligence, stores it in the knowledge graph + memory, detects
// capability gaps vs the current platform, generates governed proposals, and
// drives validated self-evolution. This is a COMPOSITION layer over the existing
// intelligence stack — it does not duplicate any module.

/** Known source types the classifier can detect from a URL or content. */
export type SourceType =
  | 'github' | 'gitlab' | 'bitbucket' | 'npm' | 'pypi' | 'crates'
  | 'openapi' | 'graphql' | 'documentation' | 'blog' | 'paper'
  | 'rfc' | 'youtube' | 'pdf' | 'markdown' | 'html' | 'json'
  | 'xml' | 'rss' | 'dataset' | 'unknown';

/** Detected programming language from content. */
export type Language =
  | 'typescript' | 'javascript' | 'python' | 'rust' | 'go' | 'java'
  | 'csharp' | 'cpp' | 'c' | 'ruby' | 'php' | 'swift' | 'kotlin'
  | 'yaml' | 'json' | 'markdown' | 'html' | 'css' | 'sql' | 'unknown';

/** Classification result for a link or content payload. */
export interface Classification {
  sourceType: SourceType;
  language: Language;
  framework?: string;
  domain?: string;
  version?: string;
  license?: string;
  title?: string;
  description?: string;
  /** Dependencies detected (package names). */
  dependencies: string[];
  /** 0..1 confidence in the classification. */
  confidence: number;
  detectedAt: number;
}

/** Structured intelligence extracted from classified content. */
export interface IntelligenceExtract {
  /** Architectural patterns detected. */
  architectures: string[];
  designPatterns: string[];
  algorithms: string[];
  dataModels: string[];
  apis: Array<{ name: string; method?: string; path?: string; description?: string }>;
  services: string[];
  securityModels: string[];
  authMechanisms: string[];
  aiWorkflows: string[];
  uiSystems: string[];
  deploymentModels: string[];
  devOpsPractices: string[];
  performanceOptimizations: string[];
  testingMethodologies: string[];
  domainConcepts: string[];
  businessCapabilities: string[];
  infrastructurePatterns: string[];
  /** Key code/config snippets worth remembering. */
  snippets: Array<{ language: Language; content: string; description: string }>;
  /** Confidence in the extraction. */
  confidence: number;
  extractedAt: number;
}

/** A gap between the platform's current capabilities and extracted intelligence. */
export interface CapabilityGap {
  id: string;
  category: 'missing_module' | 'missing_api' | 'missing_ai' | 'missing_security'
    | 'missing_workflow' | 'missing_tooling' | 'missing_integration'
    | 'missing_optimization' | 'duplicate' | 'inferior' | 'inconsistency';
  description: string;
  /** The intelligence extract that revealed this gap. */
  sourceRef: string;
  /** Existing capability it conflicts with or improves (if any). */
  existingCapability?: string;
  severity: 'info' | 'warning' | 'critical';
  estimatedValue: 'low' | 'medium' | 'high' | 'strategic';
  detectedAt: number;
}

/** A generated implementation proposal from a gap. */
export interface IntelligenceProposal {
  id: string;
  title: string;
  category: CapabilityGap['category'];
  businessValue: string;
  technicalValue: string;
  complexity: 'low' | 'medium' | 'high';
  dependencies: string[];
  risk: 'low' | 'medium' | 'high';
  estimatedEffort: string;
  testStrategy: string;
  rollbackStrategy: string;
  gapIds: string[];
  sourceRef: string;
  status: 'proposed' | 'validating' | 'approved' | 'rejected' | 'implemented';
  createdAt: number;
}

/** Validation result for a proposal. */
export interface ValidationResult {
  proposalId: string;
  passed: boolean;
  checks: Array<{ name: string; status: 'pass' | 'fail' | 'skip'; detail?: string }>;
  qualityScore: number;
  costEstimate?: string;
  validatedAt: number;
}

/** A processed link — the full pipeline result. */
export interface LinkIntelligenceResult {
  url: string;
  classification: Classification;
  extract?: IntelligenceExtract;
  gaps: CapabilityGap[];
  proposals: IntelligenceProposal[];
  knowledgeStored: boolean;
  memoryStored: boolean;
  processedAt: number;
}

/** Configuration for the link intelligence engine. */
export interface LinkIntelligenceConfig {
  /** Whether to auto-generate proposals from detected gaps. */
  autoPropose?: boolean;
  /** Whether to auto-validate proposals. */
  autoValidate?: boolean;
  /** Minimum confidence for extraction to be stored. */
  minConfidence?: number;
  /** Maximum proposals per link. */
  maxProposals?: number;
}
