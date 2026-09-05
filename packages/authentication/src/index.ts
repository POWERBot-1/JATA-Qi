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
