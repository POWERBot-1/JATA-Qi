export {
  PrincipalValidationError,
  UnauthenticatedRequestError,
  UnsupportedAuthenticationMethodError,
  isAuthenticationMethod,
  projectToActor,
  RECOGNIZED_AUTHENTICATION_METHODS,
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
export type { StaticTokenRecord } from './static-token-authenticator.js';

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
export type { AuthenticationModuleConfig } from './authentication-module.js';
