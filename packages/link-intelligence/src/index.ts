// @jataqi/link-intelligence — JATA Qi Universal Link Intelligence & Autonomous
// Self-Evolution Engine. Public API.

export { LinkIntelligenceModule, LinkIntelEvents } from './link-intelligence-module.js';
export { classify } from './classifier.js';
export { extract } from './extractor.js';
export { analyzeGaps } from './gap-analyzer.js';
export type {
  SourceType, Language, Classification, IntelligenceExtract, CapabilityGap,
  IntelligenceProposal, ValidationResult, LinkIntelligenceResult,
  LinkIntelligenceConfig,
} from './types.js';
