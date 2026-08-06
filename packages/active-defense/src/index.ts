// @jataqi/active-defense — Active Defense & Adaptive Resilience Layer.
//
// Continuously defends JATA Qi by detecting, disrupting, containing, and
// neutralizing malicious activity while preserving evidence, protecting
// legitimate users, and maintaining service. Automated actions stay within
// authorized boundaries (high-impact containment requires human approval) and
// everything is auditable via findings, incidents, and the security report.

export { ActiveDefenseModule, DefenseEvents, WATCHED_EVENTS } from './active-defense-module.js';
export { AdaptiveDefenseEngine, APPROVAL_GATED_KINDS, RESOURCE_TIERS } from './defense.js';
export { DetectionEngine, DEFAULT_RULES } from './detection.js';
export type { DetectionRule, DetectionEvent } from './detection.js';
export { RiskEngine, SIGNAL_WEIGHTS, RISK_BANDS, riskLevel } from './risk.js';
export { DeceptionEngine } from './deception.js';
export type {
  RiskLevel, RiskSignal, RiskAssessment,
  Finding, FindingSeverity, FindingStatus,
  Honeytoken, DecoyService, DeceptionTouch,
  ContainmentAction, ContainmentKind, ContainmentStatus,
  BanRecord, BanScope,
  RecoveryRun, RecoveryStage,
  IncidentRecord, PlaybookVersion,
  DefenseStats, DefenseReport,
} from './types.js';
