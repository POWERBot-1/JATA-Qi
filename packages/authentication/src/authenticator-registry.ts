// Server-side principal boundary: authenticator registry.
//
// The boundary is the single object request handlers interact with. It
// dispatches a `PresentedCredential` to the appropriate `ServerAuthenticator`
// and returns an `AuthenticatedPrincipal` (or throws).
//
// A request that bypasses this boundary and reaches the unified loop /
// commercial control plane with a caller-supplied `CommercialActor` is a
// T-01 acceptance-criteria violation: the boundary is mandatory for
// production request paths.

import {
  PrincipalValidationError,
  UnauthenticatedRequestError,
  UnsupportedAuthenticationMethodError,
  type AuthenticatedPrincipal,
  type PresentedCredential,
  type ServerAuthenticator,
} from './types.js';

export class AuthenticatorRegistry {
  private readonly byId = new Map<string, ServerAuthenticator>();
  private readonly byMethod = new Map<string, ServerAuthenticator[]>();

  /** Register an authenticator. Fails closed on duplicate id. */
  register(authenticator: ServerAuthenticator): void {
    if (this.byId.has(authenticator.id)) {
      throw new PrincipalValidationError(`Authenticator "${authenticator.id}" is already registered.`);
    }
    this.byId.set(authenticator.id, authenticator);
    for (const method of authenticator.supports) {
      const list = this.byMethod.get(method) ?? [];
      list.push(authenticator);
      this.byMethod.set(method, list);
    }
  }

  /** List registered authenticators (audit/diagnostics). */
  list(): readonly ServerAuthenticator[] {
    return [...this.byId.values()];
  }

  /**
   * Verify a presented credential against the registered authenticators.
   * Returns the first successful principal. Returns `undefined` only when no
   * authenticator matched the method (a structural rejection); per-credential
   * failures throw `PrincipalValidationError` so callers can distinguish
   * "you sent me the wrong thing" from "I have nothing that can verify this".
   */
  async authenticate(credential: PresentedCredential, now: number, requestId: string): Promise<AuthenticatedPrincipal> {
    if (!credential) throw new UnauthenticatedRequestError('no credential was presented.');
    if (!credential.method) throw new UnauthenticatedRequestError('credential is missing an authentication method.');
    const candidates = this.byMethod.get(credential.method) ?? [];
    if (candidates.length === 0) {
      throw new UnsupportedAuthenticationMethodError(credential.method);
    }
    let lastError: Error | undefined;
    for (const authenticator of candidates) {
      try {
        return await authenticator.verify(credential, now, requestId);
      } catch (err) {
        if (!(err instanceof PrincipalValidationError)) throw err;
        lastError = err;
      }
    }
    throw new UnauthenticatedRequestError(
      `All ${candidates.length} authenticator(s) for method "${credential.method}" rejected the credential${
        lastError ? `: ${lastError.message}` : '.'
      }`,
    );
  }
}
