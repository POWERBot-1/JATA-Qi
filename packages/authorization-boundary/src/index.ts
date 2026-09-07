// A-01 — Authoritative Agent Capability & Credential Boundary.
//
// Public surface: the policy decision point, the sealed authorization
// envelope, capability manifests, the credential broker, the enforcement
// gate, the worker/queue boundary, durable audit sinks, and the kernel
// module that installs the boundary at the composition root.

export {
  A01_CLASSIFICATION_ORDER,
  A01_IMPACT_ORDER,
  A01_DATA_CLASSIFICATIONS,
  A01_IMPACT_LEVELS,
  A01_DENIAL_REASONS,
  isA01DataClassification,
  isA01ImpactLevel,
  isA01DenialReason,
  PermissiveBaselinePolicyEngine,
  AuthorizationDeniedError,
  CredentialDeniedError,
  ManifestRejectedError,
  EnvelopeIntegrityError,
} from './types.js';
export type {
  A01ApprovalBinding,
  A01AgentBinding,
  A01AllowedOperation,
  A01AuditRecord,
  A01AuditSink,
  A01AuthorizationEnvelope,
  A01AuthorizationRequest,
  A01CapabilityBinding,
  A01CapabilityManifest,
  A01CredentialBinding,
  A01CredentialCheckView,
  A01CredentialIssueSpec,
  A01DataClassification,
  A01DecisionOutcome,
  A01DecisionRecord,
  A01DenialReason,
  A01ImpactLevel,
  A01PrincipalBinding,
  A01ProvenanceBinding,
  A01PolicyEngine,
  A01RunBinding,
  A01TargetBinding,
  CredentialBroker,
  ScopedCredential,
} from './types.js';

export { canonicalize, sha256Hex, sha256Of, a01ActionDigest, deepFreeze } from './canonical.js';
export type { A01ActionDigestFields } from './canonical.js';

export {
  sealEnvelope,
  assertEnvelopeIntegrity,
  isEnvelopeIntact,
  envelopeAcceptance,
  envelopeDigestValue,
} from './envelope.js';

export { CapabilityManifestRegistry, compareVersion, targetMatches } from './capability-manifests.js';

export { InMemoryCredentialBroker } from './credential-broker.js';

export { decideA01 } from './policy-engine.js';
export type { A01DecisionResult, A01PolicyContext } from './policy-engine.js';

export {
  AuthorizationGate,
  A01_DEFAULT_POLICY_VERSION,
} from './gate.js';
export type { A01GateConfig, ScopedExecutionContext } from './gate.js';

export { runUnderEnvelope, WorkerTask } from './worker-boundary.js';

export {
  InMemoryAuditSink,
  StorageAuditSink,
  CompositeAuditSink,
} from './audit.js';

export {
  AuthorizationBoundaryModule,
  AUTHORIZATION_GATE_TOKEN,
  AUTHORIZATION_MANIFESTS_TOKEN,
  AUTHORIZATION_BROKER_TOKEN,
  AUTHORIZATION_AUDIT_TOKEN,
  AUTHORIZATION_DECISIONS_COLLECTION,
} from './module.js';
export type { AuthorizationBoundaryModuleConfig } from './module.js';
