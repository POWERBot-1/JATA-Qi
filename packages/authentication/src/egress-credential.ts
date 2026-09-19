// P3-B0 S0b (OD-7) — Governed egress-provider credential handle.
//
// This is the deliberate new purpose consumer of the S7 secret-material seam
// (`secret-material.ts`): a closed vocabulary whose contract addition is
// reviewed exactly as its header requires ("a new consumer must be added
// deliberately rather than reusing an existing binding"). It adds the single
// purpose `'egress-provider'` and the governed handle mechanism that re-homes
// a provider credential (e.g. an LLM/embedding provider API key) INSIDE the
// broker-held secret seam:
//
//   * the credential is sealed under purpose `'egress-provider'` and callers
//     receive a CREDENTIAL HANDLE — id/audience/scopes plus version/status,
//     NEVER material — mirroring the authorization-boundary envelope
//     precedent (A01CredentialBinding: id/audience/scopes, never material);
//   * material is re-acquired ONLY through a governed, audited, AAD-bound
//     open on the store, with the full explicit binding presented on every
//     operation (no ambient authority, no identifier oracle — both inherited
//     from the store and never re-implemented here);
//   * rotation retires the outgoing version and activates version+1
//     (CAS-serialized in the store); revocation is TERMINAL.
//
// SCOPE DISCIPLINE (P3-B0 S0b = OD-7 ONLY):
//
//   * This module is NOT an egress control plane. It performs no network I/O,
//     makes no destination decision, writes no egress audit record, and
//     authorizes nothing. The egress plane (S1), the adapter cutover (S2),
//     and the removal of the direct environment read are LATER, separately
//     authorized slices; none of them is implemented here.
//   * The sealed credential is consumed by NO runtime component yet. The
//     existing adapters continue to behave exactly as before this slice.
//   * `ALLOWED_AUDIT_FIELDS`, the matchers, `isNarrowing`, and every tested
//     P2 invariant are untouched; this slice's audit rides the store's
//     existing identifier-only access records (purpose is a pre-existing
//     field), so no audit-shape change is possible by construction.
//
// SECURITY PROPERTIES (inherited, not weakened):
//
//   * NO MATERIAL IN THE HANDLE — the handle is a durable, shareable
//     reference; serializing it (JSON, log, audit) cannot leak the key.
//   * NO AMBIENT AUTHORITY — every operation takes an explicit
//     `{ tenantId, actorPrincipalId, principalId }`; a handle alone cannot be
//     resolved.
//   * PURPOSE-BOUND, NO IDENTIFIER ORACLE — the purpose is fixed to
//     `'egress-provider'` by the module, so a `totp`/`break-glass-seal`
//     secret under the same credential id is `SECRET_UNKNOWN` to this broker
//     (indistinguishable from non-existent), and an egress credential cannot
//     be opened through another consumer's purpose.
//   * REVOCATION IS TERMINAL; ROTATION RETIRES — exactly the store's
//     lifecycle, re-exposed for the egress purpose.
//   * ACCESS IS AUDITED WITHOUT THE SECRET — the store writes the
//     identifier-only access record in the same transaction as the data
//     operation; this module adds no field in which material could ride.

import {
  SecretMaterialError,
  type SecretMaterialStore,
  type SecretStatus,
} from './secret-material.js';

/**
 * The single purpose this broker may seal or open. Exported so a future
 * consumer (the S1 enforcement path, when separately authorized) can cite the
 * binding without re-typing the literal.
 */
export const EGRESS_PROVIDER_PURPOSE = 'egress-provider' as const;

/** The version status a handle can carry (the store's secret status, unchanged). */
export type EgressCredentialStatus = SecretStatus;

/**
 * A broker-held CREDENTIAL HANDLE: a reference to a sealed egress-provider
 * credential, shaped on the authorization-boundary envelope precedent
 * (credentialId/audience/scopes — NEVER material), plus the version and
 * status of the sealed row it names.
 */
export interface EgressCredentialHandle {
  /** Durable credential identifier (the underlying secret id). */
  readonly credentialId: string;
  /** Audience the credential may be presented to; null = none declared. */
  readonly audience: string | null;
  /** Scopes the credential carries (declared, never material). */
  readonly scopes: readonly string[];
  /** The sealed version this handle names. */
  readonly version: number;
  readonly status: EgressCredentialStatus;
}

/**
 * The explicit binding every operation requires. There is no ambient
 * authority: a handle without this context cannot be resolved.
 */
export interface EgressCredentialContext {
  readonly tenantId: string;
  /** The acting principal. Required — inherited from the S7 seam's stance. */
  readonly actorPrincipalId: string;
  /** The credential's owner principal (the caller's claim; the store binds it). */
  readonly principalId: string;
}

/**
 * Well-formedness guard for a credential handle. A handle is a pure
 * reference — this check is structural and secret-free.
 */
export function isEgressCredentialHandle(value: unknown): value is EgressCredentialHandle {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.credentialId === 'string' &&
    candidate.credentialId.length > 0 &&
    candidate.credentialId.length <= 256 &&
    (candidate.audience === null || typeof candidate.audience === 'string') &&
    Array.isArray(candidate.scopes) &&
    candidate.scopes.every((scope) => typeof scope === 'string') &&
    typeof candidate.version === 'number' &&
    Number.isInteger(candidate.version) &&
    candidate.version >= 1 &&
    (candidate.status === 'ACTIVE' || candidate.status === 'RETIRED' || candidate.status === 'REVOKED')
  );
}

function assertContext(ctx: EgressCredentialContext): EgressCredentialContext {
  // The store re-validates these in its own binding guard; this is a fail-fast
  // at the module boundary that names the egress purpose in the error.
  if (typeof ctx?.tenantId !== 'string' || ctx.tenantId.length === 0) {
    throw new SecretMaterialError('SECRET_INVALID_ARGUMENT', { purpose: EGRESS_PROVIDER_PURPOSE });
  }
  if (typeof ctx.actorPrincipalId !== 'string' || ctx.actorPrincipalId.length === 0) {
    throw new SecretMaterialError('SECRET_INVALID_ARGUMENT', { purpose: EGRESS_PROVIDER_PURPOSE });
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.length === 0) {
    throw new SecretMaterialError('SECRET_INVALID_ARGUMENT', { purpose: EGRESS_PROVIDER_PURPOSE });
  }
  return ctx;
}

function assertHandle(handle: EgressCredentialHandle): { readonly credentialId: string; readonly version: number } {
  if (!isEgressCredentialHandle(handle)) {
    throw new SecretMaterialError('SECRET_INVALID_ARGUMENT', { purpose: EGRESS_PROVIDER_PURPOSE });
  }
  return { credentialId: handle.credentialId, version: handle.version };
}

/**
 * Seal a non-empty egress-provider credential and return its handle. The
 * plaintext is consumed by the store and is never retained here.
 *
 * Re-issuing under an existing credential id conflicts (`SECRET_CONFLICT`) —
 * there is no silent overwrite; the lifecycle is rotate/revoke only.
 */
export interface IssueEgressCredentialInput extends EgressCredentialContext {
  readonly credentialId: string;
  readonly audience: string | null;
  readonly scopes: readonly string[];
  /** The provider credential material, consumed once. */
  readonly material: Uint8Array;
  readonly correlationId?: string;
}

/** New material for a rotation of the named handle. */
export interface RotateEgressCredentialInput extends EgressCredentialContext {
  readonly material: Uint8Array;
  readonly correlationId?: string;
}

/**
 * The governed egress-provider credential handle broker.
 *
 * Built ON the S7 secret-material store exactly as S5 (TOTP) and S6
 * (break-glass) are: it adds a purpose and a reference-shaped consumer, and
 * re-implements none of the store's security properties. It is not an
 * authorization engine — `actorPrincipalId` is recorded, never compared
 * against `principalId`, and this module imports no identity or
 * authorization authority.
 */
export class EgressCredentialBroker {
  constructor(
    private readonly store: SecretMaterialStore,
  ) {}

  /**
   * Seal a non-empty egress-provider credential and return its handle. The
   * plaintext is consumed by the store and is never retained here.
   *
   * Re-issuing under an existing credential id conflicts (`SECRET_CONFLICT`)
   * — there is no silent overwrite; the lifecycle is rotate/revoke only.
   */
  async issue(input: IssueEgressCredentialInput): Promise<EgressCredentialHandle> {
    const ctx = assertContext(input);
    if (typeof input.credentialId !== 'string' || input.credentialId.length === 0 || input.credentialId.length > 256) {
      throw new SecretMaterialError('SECRET_INVALID_ARGUMENT', { purpose: EGRESS_PROVIDER_PURPOSE });
    }
    if (input.audience !== null && typeof input.audience !== 'string') {
      throw new SecretMaterialError('SECRET_INVALID_ARGUMENT', { purpose: EGRESS_PROVIDER_PURPOSE });
    }
    if (!Array.isArray(input.scopes) || !input.scopes.every((scope) => typeof scope === 'string')) {
      throw new SecretMaterialError('SECRET_INVALID_ARGUMENT', { purpose: EGRESS_PROVIDER_PURPOSE });
    }
    if (!(input.material instanceof Uint8Array) || input.material.length === 0) {
      throw new SecretMaterialError('SECRET_INVALID_ARGUMENT', { secretId: input.credentialId, purpose: EGRESS_PROVIDER_PURPOSE });
    }

    const ref = await this.store.seal({
      tenantId: ctx.tenantId,
      actorPrincipalId: ctx.actorPrincipalId,
      principalId: ctx.principalId,
      purpose: EGRESS_PROVIDER_PURPOSE,
      secretId: input.credentialId,
      material: input.material,
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });

    // A reference, never material: the store returned a SecretRef and nothing
    // here carries bytes of the credential.
    return {
      credentialId: input.credentialId,
      audience: input.audience,
      scopes: input.scopes,
      version: ref.version,
      status: ref.status,
    } satisfies EgressCredentialHandle;
  }

  /**
   * Governed handle access: re-acquire the material for the version the handle
   * names, ONLY through the store's audited, AAD-bound open. The caller must
   * present the full binding; a wrong tenant/principal/purpose or a revoked
   * version fails closed and indistinguishably, exactly as the store does.
   */
  async resolve(
    handle: EgressCredentialHandle,
    ctx: EgressCredentialContext,
    options: { readonly correlationId?: string } = {},
  ): Promise<Uint8Array> {
    const context = assertContext(ctx);
    const { credentialId, version } = assertHandle(handle);
    return this.store.open({
      tenantId: context.tenantId,
      actorPrincipalId: context.actorPrincipalId,
      principalId: context.principalId,
      purpose: EGRESS_PROVIDER_PURPOSE,
      secretId: credentialId,
      version,
      ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}),
    });
  }

  /**
   * Rotate the handle to a new version with new material. The outgoing version
   * is RETIRED (still openable until revoked — the store's rotation semantics,
   * unchanged) and the returned handle names the new ACTIVE version. Rotation
   * is CAS-serialized in the store: concurrent rotations cannot both win.
   */
  async rotate(handle: EgressCredentialHandle, input: RotateEgressCredentialInput): Promise<EgressCredentialHandle> {
    const ctx = assertContext(input);
    const { credentialId } = assertHandle(handle);
    if (!(input.material instanceof Uint8Array) || input.material.length === 0) {
      throw new SecretMaterialError('SECRET_INVALID_ARGUMENT', { secretId: credentialId, purpose: EGRESS_PROVIDER_PURPOSE });
    }

    const ref = await this.store.rotate({
      tenantId: ctx.tenantId,
      actorPrincipalId: ctx.actorPrincipalId,
      principalId: ctx.principalId,
      purpose: EGRESS_PROVIDER_PURPOSE,
      secretId: credentialId,
      material: input.material,
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });

    // The new handle inherits the declared binding metadata; only the version
    // and status change. The material is never in either handle.
    return {
      credentialId,
      audience: handle.audience,
      scopes: handle.scopes,
      version: ref.version,
      status: ref.status,
    } satisfies EgressCredentialHandle;
  }

  /**
   * Revoke the exact version the handle names. TERMINAL: the version can never
   * be opened again through any path, including this broker, and the refusal
   * is audited.
   */
  async revoke(
    handle: EgressCredentialHandle,
    ctx: EgressCredentialContext,
    options: { readonly correlationId?: string } = {},
  ): Promise<void> {
    const context = assertContext(ctx);
    const { credentialId, version } = assertHandle(handle);
    await this.store.revoke({
      tenantId: context.tenantId,
      actorPrincipalId: context.actorPrincipalId,
      principalId: context.principalId,
      purpose: EGRESS_PROVIDER_PURPOSE,
      secretId: credentialId,
      version,
      ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}),
    });
  }
}
