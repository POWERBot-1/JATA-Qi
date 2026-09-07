// A-01 credential-broker abstraction + in-memory implementation.
//
// Security contract:
//   * Credentials are bound at issue time to (principal, tenant, capability,
//     tool, operation, audience) and a lifetime.
//   * At acquire time the broker re-validates the binding against the
//     AUTHORITATIVE envelope: principal, tenant, capability, tool, operation,
//     audience, scope sufficiency, expiry, and single-use per envelope.
//   * Secret material is returned to the issuer exactly once at issue time and
//     is otherwise only ever delivered at the enforcement point (acquireFor),
//     immediately before the side effect. It is never persisted by this
//     package, never logged, and never placed in audit records (audit carries
//     credentialId/audience/scopes only).
//   * An unavailable broker is never treated as "no credential required":
//     the decision point maps `available() === false` to
//     CREDENTIAL_BROKER_UNAVAILABLE and fails the decision closed.
//
// Production secret-provider integrations implement the same
// `CredentialBroker` interface; A-01 ships the in-memory implementation and
// does not pretend any external infrastructure exists.

import { randomBytes } from 'node:crypto';
import type {
  A01AuthorizationEnvelope,
  A01CredentialCheckView,
  A01CredentialIssueSpec,
  A01DenialReason,
  CredentialBroker,
  ScopedCredential,
} from './types.js';
import { CredentialDeniedError } from './types.js';

interface IssuedCredential {
  readonly credentialId: string;
  readonly material: string;
  readonly principalId: string;
  readonly tenantId: string;
  readonly capabilityId: string;
  readonly tool: string;
  readonly operation: string;
  readonly audience: string;
  readonly scopes: readonly string[];
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly issuedBy: string;
  readonly revoked: boolean;
  readonly usedEnvelopeIds: ReadonlySet<string>;
}

export class InMemoryCredentialBroker implements CredentialBroker {
  readonly id: string;
  private readonly credentials = new Map<string, IssuedCredential>();
  private readonly now: () => number;
  private availableFlag = true;

  constructor(options?: { readonly id?: string; readonly now?: () => number }) {
    this.id = options?.id ?? 'a01-inmemory-credential-broker';
    this.now = options?.now ?? ((): number => Date.now());
  }

  /** Test/maintenance seam: simulate broker failure (fail-closed downstream). */
  setAvailable(available: boolean): void {
    this.availableFlag = available;
  }

  available(): boolean {
    return this.availableFlag;
  }

  issue(spec: A01CredentialIssueSpec): { credentialId: string; material: string; expiresAt: number } {
    if (!this.availableFlag) {
      throw new CredentialDeniedError(['CREDENTIAL_BROKER_UNAVAILABLE']);
    }
    if (!spec || typeof spec !== 'object') {
      throw new CredentialDeniedError(['CREDENTIAL_REQUIRED']);
    }
    const fields: Array<[string, unknown]> = [
      ['credentialId', spec.credentialId],
      ['principalId', spec.principalId],
      ['tenantId', spec.tenantId],
      ['capabilityId', spec.capabilityId],
      ['tool', spec.tool],
      ['operation', spec.operation],
      ['audience', spec.audience],
      ['issuedBy', spec.issuedBy],
    ];
    for (const [, value] of fields) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new CredentialDeniedError(['CREDENTIAL_REQUIRED']);
      }
    }
    if (!Array.isArray(spec.scopes) || spec.scopes.length === 0 || spec.scopes.some((s) => typeof s !== 'string' || s.trim().length === 0)) {
      throw new CredentialDeniedError(['CREDENTIAL_REQUIRED']);
    }
    if (!Number.isFinite(spec.lifetimeMs) || spec.lifetimeMs <= 0) {
      throw new CredentialDeniedError(['CREDENTIAL_REQUIRED']);
    }
    if (this.credentials.has(spec.credentialId)) {
      throw new CredentialDeniedError(['CREDENTIAL_BINDING_MISMATCH']);
    }
    const now = this.now();
    const material = spec.secretMaterial ?? `generated-${randomBytes(24).toString('hex')}`;
    this.credentials.set(spec.credentialId, {
      credentialId: spec.credentialId,
      material,
      principalId: spec.principalId,
      tenantId: spec.tenantId,
      capabilityId: spec.capabilityId,
      tool: spec.tool,
      operation: spec.operation,
      audience: spec.audience,
      scopes: Object.freeze([...spec.scopes]),
      issuedAt: now,
      expiresAt: now + spec.lifetimeMs,
      issuedBy: spec.issuedBy,
      revoked: false,
      usedEnvelopeIds: new Set<string>(),
    });
    return { credentialId: spec.credentialId, material, expiresAt: now + spec.lifetimeMs };
  }

  /**
   * Validate the credential bound to this envelope view WITHOUT consuming it.
   * Empty result means acquirable.
   */
  checkFor(view: A01CredentialCheckView, requiredScopes: readonly string[]): readonly A01DenialReason[] {
    if (!this.availableFlag) {
      return ['CREDENTIAL_BROKER_UNAVAILABLE'];
    }
    const binding = view.credential;
    if (!binding || typeof binding.credentialId !== 'string' || binding.credentialId.trim().length === 0) {
      return ['CREDENTIAL_MISSING'];
    }
    const issued = this.credentials.get(binding.credentialId);
    if (!issued) {
      return ['CREDENTIAL_MISSING'];
    }
    if (issued.revoked) {
      return ['CREDENTIAL_REVOKED'];
    }
    const now = this.now();
    if (now >= issued.expiresAt) {
      return ['CREDENTIAL_EXPIRED'];
    }
    const reasons: A01DenialReason[] = [];
    if (issued.principalId !== view.principal.id) reasons.push('CREDENTIAL_BINDING_MISMATCH');
    if (issued.tenantId !== view.tenantId) reasons.push('CREDENTIAL_BINDING_MISMATCH');
    if (issued.capabilityId !== view.capability.capabilityId) reasons.push('CREDENTIAL_BINDING_MISMATCH');
    if (issued.tool !== view.tool) reasons.push('CREDENTIAL_BINDING_MISMATCH');
    if (issued.operation !== view.operation) reasons.push('CREDENTIAL_BINDING_MISMATCH');
    const bindingAudience = binding.audience ?? '';
    if (bindingAudience !== issued.audience) reasons.push('CREDENTIAL_AUDIENCE_MISMATCH');
    if (bindingAudience !== view.target.audience && view.target.audience !== undefined) {
      reasons.push('CREDENTIAL_AUDIENCE_MISMATCH');
    }
    const required = new Set([...requiredScopes, ...binding.scopes]);
    for (const scope of required) {
      if (!issued.scopes.includes(scope)) {
        reasons.push('CREDENTIAL_SCOPE_INSUFFICIENT');
        break;
      }
    }
    if (issued.usedEnvelopeIds.has(view.envelopeId)) {
      reasons.push('CREDENTIAL_REPLAY');
    }
    return [...new Set(reasons)];
  }

  /**
   * Resolve the credential bound to this envelope. Every check fails closed:
   * any mismatch throws `CredentialDeniedError` with machine-readable codes.
   * The credential is consumed for this envelope (single-use per envelope).
   */
  acquireFor(envelope: A01AuthorizationEnvelope, requiredScopes: readonly string[]): ScopedCredential {
    if (!this.availableFlag) {
      throw new CredentialDeniedError(['CREDENTIAL_BROKER_UNAVAILABLE']);
    }
    const view: A01CredentialCheckView = {
      envelopeId: envelope.envelopeId,
      principal: { id: envelope.principal.id },
      tenantId: envelope.tenantId,
      capability: { capabilityId: envelope.capability.capabilityId },
      tool: envelope.tool,
      operation: envelope.operation,
      target: { audience: envelope.target.audience },
      credential: envelope.credential,
    };
    const reasons = this.checkFor(view, requiredScopes);
    if (reasons.length > 0) {
      throw new CredentialDeniedError(reasons);
    }
    const issued = this.credentials.get(view.credential!.credentialId)!;
    const used = new Set(issued.usedEnvelopeIds);
    used.add(envelope.envelopeId);
    this.credentials.set(issued.credentialId, { ...issued, usedEnvelopeIds: used });
    return {
      credentialId: issued.credentialId,
      audience: issued.audience,
      scopes: [...issued.scopes],
      expiresAt: issued.expiresAt,
      material: issued.material,
    };
  }

  revoke(credentialId: string): void {
    const issued = this.credentials.get(credentialId);
    if (issued) {
      this.credentials.set(credentialId, { ...issued, revoked: true });
    }
  }

  /** Diagnostics: count of non-revoked credentials (never exposes material). */
  liveCredentialCount(): number {
    let count = 0;
    for (const issued of this.credentials.values()) {
      if (!issued.revoked) count++;
    }
    return count;
  }
}
