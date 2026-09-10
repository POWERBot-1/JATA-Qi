export {
  PrincipalValidationError,
  UnauthenticatedRequestError,
  UnsupportedAuthenticationMethodError,
  isAuthenticationMethod,
  isCommercialActorRole,
  projectToActor,
  RECOGNIZED_AUTHENTICATION_METHODS,
  RECOGNIZED_COMMERCIAL_ACTOR_ROLES,
} from './types.js';
export type {
  AuthenticatedPrincipal,
  AuthenticationMethod,
  PresentedCredential,
  ServerAuthenticator,
} from './types.js';
export { AuthenticatorRegistry } from './authenticator-registry.js';
export {
  DeterministicTestAuthenticator,
  newRequestId,
  testCredential,
  tokenFor,
} from './deterministic-test-authenticator.js';
export type { TestPrincipalRecord } from './deterministic-test-authenticator.js';
export { StaticTokenAuthenticator, AutoLinkedStaticTokenAuthenticator } from './static-token-authenticator.js';
export type { StaticTokenAuthenticatorOptions, StaticTokenRecord } from './static-token-authenticator.js';

// R2 durable credential/session lifecycle (S-8/S-9): the ONLY session and
// static-credential substrates. Provenance and fingerprints only — no
// credential material is ever persisted through these repositories.
export {
  AuthenticationEventStore,
  AuthenticationStoreError,
  AUTHENTICATION_EVENTS_COLLECTION,
  AUTH_SESSION_CLOCK_SKEW_MS,
  DEFAULT_SESSION_CONCURRENCY_POLICY,
  DEFAULT_SESSION_LIFETIME_MS,
  MAX_SESSION_LIFETIME_MS,
  SessionTokenError,
  assertSessionDocumentShape,
  assertValidSessionLifetimeMs,
  assessSessionRow,
  isSessionExpired,
} from './authentication-event-store.js';
export type {
  AuthenticationEventDoc,
  AuthenticationEventStatus,
  RecordAuthenticationEventInput,
  RecordAuthenticationEventOptions,
  RotateSessionTokenInput,
  SessionAssessment,
  SessionConcurrencyPolicy,
  SessionTokenFailureCode,
} from './authentication-event-store.js';
export { TokenRegistryStore, TOKEN_REGISTRY_COLLECTION } from './token-registry.js';
export type {
  StaticTokenImportRecord,
  TokenImportResult,
  TokenRegistryDoc,
  TokenRegistryStatus,
} from './token-registry.js';

// T-03 authenticated work ingress support: explicit, fail-closed admission
// policy plus the production-facing boundary service and its kernel module.
export {
  AuthenticationPolicyError,
  PRINCIPAL_AUTHENTICATION_TEST_METHODS_GUARD,
  PRODUCTION_AUTHENTICATION_METHODS,
  assertMethodAdmitted,
  resolveAuthenticationPolicy,
} from './authentication-policy.js';
export type {
  AuthenticationMode,
  AuthenticationPolicyInput,
  ResolvedAuthenticationPolicy,
} from './authentication-policy.js';
export { PrincipalBoundary } from './principal-boundary.js';
export type {
  AuthenticatedRequest,
  AuthenticatedSession,
  AuthenticationProvenance,
  PrincipalBoundaryConfig,
} from './principal-boundary.js';
// P2-S2 — durable session/token lifecycle (spec §6): opaque 256-bit tokens
// over the S-8 rows (fingerprints only at rest), rotation, revocation, and
// the concurrent-session policy. Token MATERIAL is never persisted.
export {
  DEFAULT_MAX_SESSION_ROTATIONS,
  SESSION_TOKEN_BYTES,
  SessionTokenAuthenticator,
  SessionTokenService,
  fingerprintSessionToken,
  mintSessionTokenMaterial,
} from './session-tokens.js';
export type { MintedSession, SessionTokenServiceOptions } from './session-tokens.js';
export { AuthenticationModule } from './authentication-module.js';
export type {
  ProductionAuthenticatorContract,
  SessionLifecycleContract,
  TokenLifecycleContract,
  StepUpRequirement,
  StepUpCapableAuthenticator,
  IdentityProviderHealth,
  PrincipalLifecycleHooks,
  PrivilegedIdentityBoundary,
} from './contracts.js';
export type { AuthenticationDurableSessionsConfig, AuthenticationModuleConfig } from './authentication-module.js';

// P2-S1 — production identity core: types, state machine, and the durable
// repositories (principals, memberships, role-assignments, recovery,
// subject-bindings, jti-replay, identity events).
export {
  IDENTITY_PRINCIPALS_COLLECTION,
  IDENTITY_MEMBERSHIPS_COLLECTION,
  IDENTITY_ROLE_ASSIGNMENTS_COLLECTION,
  IDENTITY_RECOVERY_COLLECTION,
  IDENTITY_SUBJECT_BINDINGS_COLLECTION,
  IDENTITY_JTI_REPLAY_COLLECTION,
  IDENTITY_EVENTS_COLLECTION,
  P2_S1_IDENTITY_COLLECTIONS,
  RECOGNIZED_IDENTITY_STATES,
  IDENTITY_LIFECYCLE_TRANSITIONS,
  isIdentityState,
  isPermittedIdentityTransition,
  IdentityStoreError,
  IdentityLifecycleError,
  IdentityRebindRefusedError,
  JtiReplayError,
  assertIdentityDocumentShape,
  identityPairKey,
  subjectBindingKey,
} from './identity-types.js';
export type {
  IdentityState,
  IdentityMembershipStatus,
  IdentityPrincipalDoc,
  IdentityMembershipDoc,
  IdentityRoleAssignmentDoc,
  IdentityRoleAssignmentStatus,
  IdentityRecoveryDoc,
  IdentityRecoveryStatus,
  IdentitySubjectBindingDoc,
  IdentityJtiReplayDoc,
  IdentityEventKind,
  IdentityEventDoc,
  IdentityStateLookup,
  IdentityStateAuthority,
} from './identity-types.js';
export { RECOGNIZED_IDENTITY_EVENT_KINDS } from './identity-types.js';
export { IdentityStore } from './identity-store.js';
export type {
  EnrollIdentityInput,
  DeprovisionResult,
  AutoLinkResult,
  RecoveryCreateInput,
} from './identity-store.js';
export { JtiReplayStore, JTI_REPLAY_GC_GRACE_MS } from './jti-replay.js';

// P2-S1 — pinned-JWKS JWT core (node:crypto; RS256/ES256 only; no new deps).
export {
  DEFAULT_OIDC_ALGORITHMS,
  OIDC_CLOCK_SKEW_MS,
  OIDC_CLOCK_SKEW_SECONDS,
  JwtError,
  decodeJwtSections,
  ecRawSignatureToDer,
  resolveJwksPin,
  verifyJwt,
  assessOidcClaims,
  assertStepUpRecency,
} from './jwt.js';
export type {
  JwtAlgorithm,
  JwtFailureCode,
  Jwk,
  JwksSource,
  ResolvedJwksPin,
  JwtVerifyOptions,
  OidcClaimOptions,
  OidcClaimFailureCode,
  OidcVerifiedClaims,
  OidcClaimAssessment,
} from './jwt.js';

// P2-S1 — the provider-neutral OIDC production authenticator (spec §5.1).
export { OidcAuthenticator, OidcAuthenticatorError } from './oidc-authenticator.js';
export type { OidcAuthenticatorOptions } from './oidc-authenticator.js';

// P2-S3 — the privileged access plane: closed plane vocabulary, the
// privileged-operation register, and the durable elevation store/authority.
export {
  PRIVILEGED_ELEVATIONS_COLLECTION,
  PRIVILEGE_PLATFORM_TENANT,
  RECOGNIZED_PRIVILEGE_ROLES,
  RECOGNIZED_PRIVILEGE_OPERATION_CLASSES,
  DEFAULT_ELEVATION_LIFETIME_MS,
  MAX_ELEVATION_LIFETIME_MS,
  PRIVILEGE_CLOCK_SKEW_MS,
  DEFAULT_STEP_UP_MAX_AGE_MS,
  isPrivilegeRole,
  isPrivilegeOperationClass,
  isElevationExpired,
  isStepUpStale,
  isPlaneRoleAcceptable,
  assessElevationRow,
  foldElevationAssessments,
  assertElevationDocumentShape,
  PrivilegeStoreError,
  PrivilegeRequiredError,
} from './privilege-types.js';
export type {
  PrivilegeRole,
  PrivilegeOperationClass,
  PrivilegeScope,
  PrivilegeElevationStatus,
  PrivilegeElevationDoc,
  GrantElevationInput,
  PrivilegeElevationAssessment,
  PrivilegeStateAuthority,
  PrivilegeEnforcer,
} from './privilege-types.js';
export {
  PRIVILEGED_OPERATION_REGISTER,
  REQUIRED_PO_COVERAGE,
  RECOGNIZED_OPERATION_CLASSES,
  requiredPlaneRole,
  resolvePrivilegeRequirement,
  classifyPrivilegedA01,
  assertRegisterIntegrity,
} from './privileged-operations.js';
export type { PrivilegedOperationEntry } from './privileged-operations.js';
export {
  PrivilegeStore,
  bootstrapElevationId,
  resolvePrivilegeEnforcerFromKernel,
} from './privilege-store.js';
export type {
  BootstrapElevationInput,
  RevokeElevationInput,
} from './privilege-store.js';

// P2-S4 — Delegation + Policy: the durable, tenant-bound delegation grants
// (`identity.delegations`), the grant model/lifecycle (§8), and the
// decision-time delegation authority surface (§7.2 / §24-S4).
export {
  DELEGATIONS_COLLECTION,
  DELEGATION_PLATFORM_TENANT,
  DELEGATION_CLOCK_SKEW_MS,
  MAX_DELEGATION_LIFETIME_MS,
  MAX_DELEGATION_CHAIN_DEPTH,
  isDelegationExpired,
  isDelegationChainDepthAllowed,
  delegationTargetMatches,
  delegationTargetScopeWithin,
  assessDelegationRow,
  assertDelegationDocumentShape,
  DelegationStoreError,
  DelegationRequiredError,
} from './delegation-types.js';
export type {
  DelegationStatus,
  DelegationScope,
  DelegationAction,
  DelegationTargetScope,
  DelegationConstraints,
  DelegationApprovalBinding,
  DelegationDoc,
  GrantDelegationInput,
  RevokeDelegationInput,
  DelegationAssessmentVerdict,
  DelegationAssessment,
  DelegationRequirement,
  DelegationPeek,
  DelegationStateAuthority,
} from './delegation-types.js';
export { DelegationStore } from './delegation-store.js';
