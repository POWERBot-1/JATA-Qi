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
  A01_SESSION_AUDIT_STATUSES,
  isA01DataClassification,
  isA01ImpactLevel,
  isA01DenialReason,
  isA01SessionAuditStatus,
  isA01StoredAuditKind,
  isA01IdempotencyReceipt,
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
  A01CredentialAuditRecord,
  A01CredentialBinding,
  A01CredentialCheckView,
  A01CredentialIssueSpec,
  A01DataClassification,
  A01DecisionOutcome,
  A01DecisionRecord,
  A01DenialReason,
  A01GcAuditRecord,
  A01IdempotencyReceipt,
  A01ImpactLevel,
  A01PrincipalBinding,
  A01ProvenanceBinding,
  A01PolicyEngine,
  A01RunBinding,
  A01SessionAuditStatus,
  A01StoredAuditRecord,
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
  sanitizeRequestForEnvelope,
} from './envelope.js';
export type { BuildEnvelopeInput } from './envelope.js';

export {
  CapabilityManifestRegistry,
  compareVersion,
  isNarrowing,
  targetMatches,
  validateManifestShape,
} from './capability-manifests.js';

export { InMemoryCredentialBroker } from './credential-broker.js';

export {
  checkCredentialRow,
  credentialUseId,
  isCredentialExpired,
  assertCredentialDocumentShape,
  DurableCredentialBroker,
  InMemoryCredentialMaterialProvider,
  DEV_CREDENTIAL_MATERIAL_PROVIDER_IDS,
  isDevelopmentCredentialMaterialProvider,
} from './credential-store.js';
export type {
  CredentialDoc,
  CredentialStatus,
  CredentialUseDoc,
  CredentialMaterialProvider,
  CredentialMaterialProviderKind,
  DurableCredentialBrokerOptions,
  DurableIssueAttribution,
} from './credential-store.js';

export {
  consumeEnvelope,
  claimIdempotency,
  completeIdempotency,
  failIdempotency,
  extendIdempotencyLease,
  incrementRateWindow,
  consumeBudget,
  idempotencyId,
  rateWindowId,
  runBudgetId,
  IDEMPOTENCY_LEASE_MS,
  IDEMPOTENCY_HEARTBEAT_MS,
  FALLBACK_RATE_WINDOW_MS,
} from './consumption-stores.js';
export type {
  ConsumedEnvelopeDoc,
  IdempotencyDoc,
  IdempotencyResultRef,
  IdempotencyStatus,
  IdempotencyClaim,
  RateWindowDoc,
  RunBudgetDoc,
} from './consumption-stores.js';

export {
  SecurityStateStore,
  SecurityTxCollections,
  SecurityStateError,
  SecurityStateUnavailableError,
  ManifestDivergenceError,
  manifestVersionId,
  manifestPointerId,
  manifestRotationApprovalId,
  manifestDigest,
  assertManifestDocumentShape,
  pgCodeOf,
  isTenantScope,
  SECURITY_MANIFESTS_COLLECTION,
  SECURITY_CREDENTIALS_COLLECTION,
  SECURITY_CREDENTIAL_USES_COLLECTION,
  SECURITY_CONSUMED_ENVELOPES_COLLECTION,
  SECURITY_IDEMPOTENCY_COLLECTION,
  SECURITY_RATE_WINDOWS_COLLECTION,
  SECURITY_RUN_BUDGETS_COLLECTION,
  SECURITY_SYSTEM_TENANT,
  SECURITY_MAINTENANCE_PRINCIPAL,
  SECURITY_S4_RETENTION_MS,
  SECURITY_S5_COMPLETED_RETENTION_MS,
  SECURITY_S5_FAILED_RETENTION_MS,
  SECURITY_S5_ORPHAN_GRACE_MS,
  SECURITY_S6_GC_GRACE_MS,
  SECURITY_S7_RETENTION_MS,
  SECURITY_GC_DEFAULT_BATCH_SIZE,
  SECURITY_TX_MAX_ATTEMPTS,
  SECURITY_TX_BACKOFF_MS,
  SECURITY_CAS_MAX_ATTEMPTS,
  R2_SKEW_MS,
  MIN_DURABLE_MANIFEST_LIFETIME_MS,
  assertDurableManifestLifetime,
} from './security-state-store.js';
export type {
  ManifestVersionDoc,
  ManifestVersionStatus,
  ManifestPointerDoc,
  ManifestRotationApprovalDoc,
  ManifestDoc,
  ManifestRegistrar,
  RegisteredManifest,
  ActiveManifest,
  SecurityRetryStats,
  SecurityStateStoreOptions,
  TenantScope,
  GcSummary,
} from './security-state-store.js';

export { DurableDecider } from './durable-decider.js';
export type { DurableDeciderDeps } from './durable-decider.js';

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
  assertAllowedAuditShape,
  buildDecisionAuditRecord,
  buildConsumedAuditRecord,
} from './audit.js';

export {
  KernelInternalIdentity,
  KERNEL_INTERNAL_SCOPES,
  KERNEL_INTERNAL_TENANT,
  KERNEL_INTERNAL_PRINCIPAL_PREFIX,
  KERNEL_INTERNAL_IDENTITY_TOKEN,
  isKernelInternalScope,
} from './kernel-principal.js';
export type { KernelInternalScope, KernelInternalPrincipal } from './kernel-principal.js';

export { establishKernelWorkerAuthority } from './kernel-worker-authority.js';
export type { KernelWorkerCapabilitySpec, KernelWorkerAuthorization } from './kernel-worker-authority.js';

export { testCapabilityManifest, withTestManifests, testPrincipal } from './test-kernel.js';

export {
  requireAuthorizationBoundary,
  A01_MANDATORY_BOUNDARY_INVARIANT,
  AUTHORIZATION_BOUNDARY_MODULE_ID,
  AuthorizationBoundaryModule,
  AUTHORIZATION_GATE_TOKEN,
  AUTHORIZATION_MANIFESTS_TOKEN,
  AUTHORIZATION_BROKER_TOKEN,
  AUTHORIZATION_AUDIT_TOKEN,
  AUTHORIZATION_SECURITY_STORE_TOKEN,
  AUTHORIZATION_DURABLE_BROKER_TOKEN,
  AUTHORIZATION_DECISIONS_COLLECTION,
} from './module.js';
export type { AuthorizationBoundaryModuleConfig, AuthorizationDurableSecurityConfig } from './module.js';
