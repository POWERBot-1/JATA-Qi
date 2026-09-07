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
export { StaticTokenAuthenticator } from './static-token-authenticator.js';
export type { StaticTokenAuthenticatorOptions, StaticTokenRecord } from './static-token-authenticator.js';

// R2 durable credential/session lifecycle (S-8/S-9): the ONLY session and
// static-credential substrates. Provenance and fingerprints only — no
// credential material is ever persisted through these repositories.
export {
  AuthenticationEventStore,
  AuthenticationStoreError,
  AUTHENTICATION_EVENTS_COLLECTION,
  AUTH_SESSION_CLOCK_SKEW_MS,
  DEFAULT_SESSION_LIFETIME_MS,
  MAX_SESSION_LIFETIME_MS,
  assertSessionDocumentShape,
  assertValidSessionLifetimeMs,
  assessSessionRow,
  isSessionExpired,
} from './authentication-event-store.js';
export type {
  AuthenticationEventDoc,
  AuthenticationEventStatus,
  RecordAuthenticationEventInput,
  SessionAssessment,
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
  AuthenticationProvenance,
  PrincipalBoundaryConfig,
} from './principal-boundary.js';
export { AuthenticationModule } from './authentication-module.js';
export type { AuthenticationDurableSessionsConfig, AuthenticationModuleConfig } from './authentication-module.js';
