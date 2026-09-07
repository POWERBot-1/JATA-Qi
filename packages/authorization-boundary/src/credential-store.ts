// R2 — S-2/S-3 durable credential authority.
//
// S-2 rows are credential BINDINGS (principal, tenant, capability, tool,
// operation, audience, scopes, lifetime, status) — NEVER material. Secret
// material lives ONLY in a `CredentialMaterialProvider` (in-memory
// dev/test implementation ships; production KMS/HSM is interface-only in
// R2) and is fetched ONLY at acquire time, after the enforcement
// transaction commits. S-3 rows are single-use proofs
// (`{credentialId}::{envelopeId}`, insert-if-absent).
//
// Credential IDs are permanent, never-rebound identities: issue against
// an existing ID (any status) is rejected, and history rows are never
// deleted (revocation evidence is permanent).

import { randomBytes } from 'node:crypto';
import { StorageModule, type ICollection } from '@jataqi/storage';
import {
  R2_SKEW_MS,
  SecurityStateError,
  SecurityStateStore,
  type SecurityTxCollections,
} from './security-state-store.js';
import {
  CredentialDeniedError,
  type A01AuthorizationEnvelope,
  type A01CredentialAuditRecord,
  type A01CredentialCheckView,
  type A01CredentialIssueSpec,
  type A01DenialReason,
} from './types.js';

export type CredentialStatus = 'ACTIVE' | 'REVOKED' | 'EXPIRED';

/** S-2 row: issued credential binding. NO material field (closed schema). */
export interface CredentialDoc {
  readonly id: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly capabilityId: string;
  readonly tool: string;
  readonly operation: string;
  readonly audience: string;
  readonly scopes: readonly string[];
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly issuedBy: { readonly principalId: string; readonly authenticationEventId: string };
  readonly status: CredentialStatus;
  readonly revokedAt?: number;
  readonly revocationReason?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** S-3 row: single-use proof `id = {credentialId}::{envelopeId}`. */
export interface CredentialUseDoc {
  readonly id: string;
  readonly tenantId: string;
  readonly credentialId: string;
  readonly envelopeId: string;
  readonly acquiredAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const ALLOWED_CREDENTIAL_FIELDS: ReadonlySet<string> = new Set([
  'id', 'tenantId', 'principalId', 'capabilityId', 'tool', 'operation', 'audience', 'scopes',
  'issuedAt', 'expiresAt', 'issuedBy', 'status', 'revokedAt', 'revocationReason', 'createdAt', 'updatedAt',
]);

const ALLOWED_CREDENTIAL_USE_FIELDS: ReadonlySet<string> = new Set([
  'id', 'tenantId', 'credentialId', 'envelopeId', 'acquiredAt', 'createdAt', 'updatedAt',
]);

const FORBIDDEN_CREDENTIAL_FIELD_PATTERN = /(material|secret|token(?!registry)|password|privatekey)/i;

export function assertCredentialDocumentShape(doc: Record<string, unknown>, context: string): void {
  const allowed = 'envelopeId' in doc && !('capabilityId' in doc) ? ALLOWED_CREDENTIAL_USE_FIELDS : ALLOWED_CREDENTIAL_FIELDS;
  for (const key of Object.keys(doc)) {
    if (!allowed.has(key)) {
      throw new SecurityStateError(`${context}: unknown field "${key}" would be persisted (closed-schema violation, fail-closed).`);
    }
    if (FORBIDDEN_CREDENTIAL_FIELD_PATTERN.test(key)) {
      throw new SecurityStateError(`${context}: field "${key}" is material-shaped and must never be persisted (fail-closed).`);
    }
  }
}

/** Deterministic S-3 id (opaque PK; never parsed). */
export function credentialUseId(credentialId: string, envelopeId: string): string {
  if (typeof credentialId !== 'string' || credentialId.length === 0 || credentialId.includes('::')) {
    throw new SecurityStateError('credentialId must be a non-empty string without "::" (fail-closed).');
  }
  if (typeof envelopeId !== 'string' || envelopeId.length === 0) {
    throw new SecurityStateError('credential-use envelopeId must be non-empty (fail-closed).');
  }
  return `${credentialId}::${envelopeId}`;
}

/** Conservative credential expiry (deny-early by the skew bound). */
export function isCredentialExpired(expiresAt: number, now: number): boolean {
  return now + R2_SKEW_MS >= expiresAt;
}

/**
 * Pure credential check over a pre-loaded S-2 row. Mirrors the R1
 * `InMemoryCredentialBroker.checkFor` verdict order EXACTLY (missing →
 * revoked → expired → binding ×5 → audience ×2 → scopes → replay), with
 * deny-early expiry on the durable path. Single implementation shared by
 * the decide-time adapter and the enforcement re-check (no drift).
 */
export function checkCredentialRow(
  row: CredentialDoc | undefined,
  view: A01CredentialCheckView,
  requiredScopes: readonly string[],
  alreadyUsed: boolean,
  now: number,
): readonly A01DenialReason[] {
  const binding = view.credential;
  if (!binding || typeof binding.credentialId !== 'string' || binding.credentialId.trim().length === 0) {
    return ['CREDENTIAL_MISSING'];
  }
  if (!row) {
    return ['CREDENTIAL_MISSING'];
  }
  if (row.status === 'REVOKED') {
    return ['CREDENTIAL_REVOKED'];
  }
  if (row.status === 'EXPIRED' || isCredentialExpired(row.expiresAt, now)) {
    return ['CREDENTIAL_EXPIRED'];
  }
  const reasons: A01DenialReason[] = [];
  if (row.principalId !== view.principal.id) reasons.push('CREDENTIAL_BINDING_MISMATCH');
  if (row.tenantId !== view.tenantId) reasons.push('CREDENTIAL_BINDING_MISMATCH');
  if (row.capabilityId !== view.capability.capabilityId) reasons.push('CREDENTIAL_BINDING_MISMATCH');
  if (row.tool !== view.tool) reasons.push('CREDENTIAL_BINDING_MISMATCH');
  if (row.operation !== view.operation) reasons.push('CREDENTIAL_BINDING_MISMATCH');
  const bindingAudience = binding.audience ?? '';
  if (bindingAudience !== row.audience) reasons.push('CREDENTIAL_AUDIENCE_MISMATCH');
  if (bindingAudience !== view.target.audience && view.target.audience !== undefined) {
    reasons.push('CREDENTIAL_AUDIENCE_MISMATCH');
  }
  const required = new Set([...requiredScopes, ...binding.scopes]);
  for (const scope of required) {
    if (!row.scopes.includes(scope)) {
      reasons.push('CREDENTIAL_SCOPE_INSUFFICIENT');
      break;
    }
  }
  if (alreadyUsed) {
    reasons.push('CREDENTIAL_REPLAY');
  }
  return [...new Set(reasons)];
}

// ---------------------------------------------------------------------------
// Material provider seam
// ---------------------------------------------------------------------------

/**
 * R2 material-provider seam. Implementations hold secret material OUTSIDE
 * durable state and deliver it ONLY at acquire time. Production KMS/HSM
 * integrations implement this interface; R2 ships the in-memory dev/test
 * implementation only.
 *
 * Contract: `createMaterial` SHOULD be idempotent on credentialId (same id
 * ⇒ same material) so issuance retries after a crash between row-commit
 * and material-creation converge instead of stranding the credential.
 */
export interface CredentialMaterialProvider {
  readonly id: string;
  createMaterial(credentialId: string): Promise<string>;
  getMaterial(credentialId: string, envelopeId: string): Promise<string>;
}

/**
 * In-memory dev/test material provider. NEVER for production traffic:
 * material survives only in this process, and a restart strands issued
 * credentials (their S-2 rows persist; their material does not — acquires
 * then fail closed with CREDENTIAL_MISSING, which is the honest posture
 * for a dev seam).
 */
export class InMemoryCredentialMaterialProvider implements CredentialMaterialProvider {
  readonly id = 'r2-inmemory-material-provider';
  private readonly materials = new Map<string, string>();

  async createMaterial(credentialId: string): Promise<string> {
    if (typeof credentialId !== 'string' || credentialId.length === 0) {
      throw new CredentialDeniedError(['CREDENTIAL_REQUIRED']);
    }
    const existing = this.materials.get(credentialId);
    if (existing !== undefined) return existing;
    const material = `r2-material-${randomBytes(24).toString('hex')}`;
    this.materials.set(credentialId, material);
    return material;
  }

  async getMaterial(credentialId: string, _envelopeId: string): Promise<string> {
    const material = this.materials.get(credentialId);
    if (material === undefined) {
      throw new CredentialDeniedError(['CREDENTIAL_MISSING']);
    }
    return material;
  }
}

// ---------------------------------------------------------------------------
// Durable broker
// ---------------------------------------------------------------------------

export interface DurableIssueAttribution {
  readonly principalId: string;
  readonly authenticationEventId: string;
}

export interface DurableCredentialBrokerOptions {
  /** Injectable clock (ms). Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * R2 durable credential broker. Validates bindings against S-2 + S-3
 * inside the enforcement transaction and fetches material ONLY at acquire
 * time via the provider. This broker is ASYNC by construction (durable
 * state cannot be consulted synchronously) and therefore does not
 * implement the sync `CredentialBroker` interface — the durable decider
 * calls it directly.
 */
export class DurableCredentialBroker {
  readonly id = 'r2-durable-credential-broker';
  private readonly store: SecurityStateStore;
  private readonly provider: CredentialMaterialProvider;
  private readonly now: () => number;

  constructor(store: SecurityStateStore, provider: CredentialMaterialProvider, options: DurableCredentialBrokerOptions = {}) {
    if (!store || typeof store.transact !== 'function') {
      throw new CredentialDeniedError(['CREDENTIAL_BROKER_UNAVAILABLE']);
    }
    if (!provider || typeof provider.createMaterial !== 'function' || typeof provider.getMaterial !== 'function') {
      throw new CredentialDeniedError(['CREDENTIAL_BROKER_UNAVAILABLE']);
    }
    this.store = store;
    this.provider = provider;
    this.now = options.now ?? Date.now;
  }

  get materialProvider(): CredentialMaterialProvider {
    return this.provider;
  }

  /**
   * Issue one credential binding (tenant tx: S-2 insert-if-absent +
   * CREDENTIAL_ISSUED receipt), then create its material via the provider.
   * The authoritative ROW commits first; material follows (provider create
   * SHOULD be idempotent so crash-retry converges). Duplicate id (any
   * status) ⇒ CREDENTIAL_BINDING_MISMATCH (permanent identity, R1 parity).
   */
  async issue(
    spec: A01CredentialIssueSpec,
    issuedBy: DurableIssueAttribution,
  ): Promise<{ credentialId: string; material: string; expiresAt: number }> {
    if (!spec || typeof spec !== 'object') {
      throw new CredentialDeniedError(['CREDENTIAL_REQUIRED']);
    }
    for (const value of [spec.credentialId, spec.principalId, spec.tenantId, spec.capabilityId, spec.tool, spec.operation, spec.audience, spec.issuedBy]) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new CredentialDeniedError(['CREDENTIAL_REQUIRED']);
      }
    }
    if (spec.credentialId.includes('::')) {
      throw new CredentialDeniedError(['CREDENTIAL_REQUIRED']);
    }
    if (!Array.isArray(spec.scopes) || spec.scopes.length === 0 || spec.scopes.some((s) => typeof s !== 'string' || s.trim().length === 0)) {
      throw new CredentialDeniedError(['CREDENTIAL_REQUIRED']);
    }
    if (!Number.isFinite(spec.lifetimeMs) || spec.lifetimeMs <= 0) {
      throw new CredentialDeniedError(['CREDENTIAL_REQUIRED']);
    }
    if (!issuedBy || typeof issuedBy.principalId !== 'string' || issuedBy.principalId.trim().length === 0) {
      throw new CredentialDeniedError(['CREDENTIAL_REQUIRED']);
    }
    if (typeof issuedBy.authenticationEventId !== 'string' || issuedBy.authenticationEventId.trim().length === 0) {
      throw new CredentialDeniedError(['CREDENTIAL_REQUIRED']);
    }
    if (spec.secretMaterial !== undefined) {
      // Caller-supplied issuance material cannot be adopted: the provider
      // is the ONLY material holder, and silently dropping the supplied
      // secret would strand the credential. Rejected BEFORE any write
      // (fail closed; explicit durable-path contract difference from R1).
      throw new CredentialDeniedError(['CREDENTIAL_BROKER_UNAVAILABLE']);
    }
    StorageModule.validateTenantId(spec.tenantId);
    const now = this.now();
    const expiresAt = now + spec.lifetimeMs;
    const doc: CredentialDoc = {
      id: spec.credentialId,
      tenantId: spec.tenantId,
      principalId: spec.principalId,
      capabilityId: spec.capabilityId,
      tool: spec.tool,
      operation: spec.operation,
      audience: spec.audience,
      scopes: [...spec.scopes],
      issuedAt: now,
      expiresAt,
      issuedBy: { principalId: issuedBy.principalId, authenticationEventId: issuedBy.authenticationEventId },
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    };
    assertCredentialDocumentShape(doc as unknown as Record<string, unknown>, 'durableIssue');
    await this.store.transact({ tenantId: spec.tenantId }, async (collections) => {
      const inserted = await collections.credentials.cas(doc.id, (cur) => cur === undefined, () => ({ ...doc }));
      if (!inserted.ok) {
        throw new CredentialDeniedError(['CREDENTIAL_BINDING_MISMATCH']);
      }
      const receipt: A01CredentialAuditRecord = {
        id: `credential-issued-${doc.id}`,
        kind: 'CREDENTIAL_ISSUED',
        credentialId: doc.id,
        principalId: doc.principalId,
        tenantId: doc.tenantId,
        capabilityId: doc.capabilityId,
        tool: doc.tool,
        operation: doc.operation,
        audience: doc.audience,
        scopes: [...doc.scopes],
        issuedBy: spec.issuedBy,
        issuedAt: now,
        expiresAt,
        recordedAt: now,
      };
      await SecurityStateStore.putAuditReceipt(collections.decisions, receipt, 'durableIssue', true);
    });
    const material = await this.provider.createMaterial(spec.credentialId);
    return { credentialId: spec.credentialId, material, expiresAt };
  }

  /**
   * Decide-time read: load the S-2 row for the PDP adapter (tenant tx).
   * Pass the row to `checkCredentialRow` with `alreadyUsed: false` (no
   * envelope exists yet at decide time — the R1 decide-time replay check
   * is equally vacuous). Observed ACTIVE+expired rows are flipped to
   * EXPIRED in the same tx (lazy evidence hygiene; the verdict is
   * EXPIRED either way).
   */
  async readForCheck(credentialId: string, tenantId: string, now: number): Promise<CredentialDoc | undefined> {
    if (typeof credentialId !== 'string' || credentialId.length === 0) return undefined;
    StorageModule.validateTenantId(tenantId);
    return this.store.transact({ tenantId }, async (collections) => {
      const row = await collections.credentials.get(credentialId);
      if (!row || row.tenantId !== tenantId) return undefined;
      if (row.status === 'ACTIVE' && isCredentialExpired(row.expiresAt, now)) {
        await collections.credentials.cas(
          credentialId,
          (cur) => !!cur && cur.status === 'ACTIVE' && isCredentialExpired(cur.expiresAt, now),
          (cur) => ({ ...cur, status: 'EXPIRED' as const, updatedAt: now }),
        );
        return { ...row, status: 'EXPIRED' as const };
      }
      return { ...row };
    });
  }

  /**
   * Enforcement re-check + single-use claim INSIDE Tx-1 (no material is
   * touched here): fresh-row checks, enforcement-lock no-op CAS (takes
   * the row lock, serializing concurrent revokes), then S-3
   * insert-if-absent. Returns the material-free binding; the decider
   * fetches material post-commit via the provider.
   */
  async acquireInTx(
    collections: SecurityTxCollections,
    envelope: A01AuthorizationEnvelope,
    requiredScopes: readonly string[],
    now: number,
  ): Promise<{ credentialId: string; audience: string; scopes: readonly string[]; expiresAt: number }> {
    const binding = envelope.credential;
    if (!binding || typeof binding.credentialId !== 'string' || binding.credentialId.length === 0) {
      throw new CredentialDeniedError(['CREDENTIAL_MISSING']);
    }
    const row = await collections.credentials.get(binding.credentialId);
    if (!row || row.tenantId !== envelope.tenantId) {
      throw new CredentialDeniedError(['CREDENTIAL_MISSING']);
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
    const codes = checkCredentialRow(row, view, requiredScopes, false, now);
    if (codes.length > 0) {
      if (codes.includes('CREDENTIAL_EXPIRED') && row.status === 'ACTIVE') {
        await collections.credentials.cas(
          row.id,
          (cur) => !!cur && cur.status === 'ACTIVE',
          (cur) => ({ ...cur, status: 'EXPIRED' as const, updatedAt: now }),
        );
      }
      throw new CredentialDeniedError([...codes]);
    }
    // Enforcement lock: no-op CAS takes the row lock so a revoke that
    // commits before this point denies, and one arriving during Tx-1 waits
    // (non-retroactive, documented).
    const locked = await collections.credentials.cas(
      row.id,
      (cur) => !!cur && cur.status === 'ACTIVE',
      (cur) => cur,
    );
    if (!locked.ok) {
      const fresh = await collections.credentials.get(row.id);
      if (!fresh) throw new CredentialDeniedError(['CREDENTIAL_MISSING']);
      if (fresh.status === 'REVOKED') throw new CredentialDeniedError(['CREDENTIAL_REVOKED']);
      throw new CredentialDeniedError(['CREDENTIAL_EXPIRED']);
    }
    const useId = credentialUseId(row.id, envelope.envelopeId);
    const use: CredentialUseDoc = {
      id: useId,
      tenantId: envelope.tenantId,
      credentialId: row.id,
      envelopeId: envelope.envelopeId,
      acquiredAt: now,
      createdAt: now,
      updatedAt: now,
    };
    assertCredentialDocumentShape(use as unknown as Record<string, unknown>, 'durableAcquire');
    const claimed = await collections.credentialUses.cas(useId, (cur) => cur === undefined, () => ({ ...use }));
    if (!claimed.ok) {
      throw new CredentialDeniedError(['CREDENTIAL_REPLAY']);
    }
    return { credentialId: row.id, audience: row.audience, scopes: [...row.scopes], expiresAt: row.expiresAt };
  }

  /**
   * Fetch issued material AFTER Tx-1 commits (the only material touch
   * point). The row checks already passed in-tx; a missing provider entry
   * (e.g. dev-provider restart) fails closed with CREDENTIAL_MISSING.
   */
  async fetchMaterial(credentialId: string, envelopeId: string): Promise<string> {
    return this.provider.getMaterial(credentialId, envelopeId);
  }

  /**
   * Revoke one credential (ACTIVE → REVOKED, CAS) + CREDENTIAL_REVOKED
   * receipt in ONE tenant tx. Unknown ids are a silent no-op (R1 parity);
   * re-revoking is idempotent. EXPIRED rows are left EXPIRED.
   */
  async revoke(credentialId: string, tenantId: string, reason: string): Promise<{ revoked: boolean }> {
    if (typeof credentialId !== 'string' || credentialId.length === 0) {
      throw new CredentialDeniedError(['CREDENTIAL_REQUIRED']);
    }
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new CredentialDeniedError(['CREDENTIAL_REQUIRED']);
    }
    StorageModule.validateTenantId(tenantId);
    const now = this.now();
    return this.store.transact({ tenantId }, async (collections) => {
      const res = await collections.credentials.cas(
        credentialId,
        (cur) => !!cur && cur.tenantId === tenantId && cur.status === 'ACTIVE',
        (cur) => ({ ...cur, status: 'REVOKED' as const, revokedAt: now, revocationReason: reason.trim(), updatedAt: now }),
      );
      if (!res.ok) return { revoked: false };
      const row = await collections.credentials.get(credentialId);
      if (!row) {
        throw new SecurityStateError('revoked credential row vanished mid-transaction (fail-closed).');
      }
      const receipt: A01CredentialAuditRecord = {
        id: `credential-revoked-${credentialId}-${now}`,
        kind: 'CREDENTIAL_REVOKED',
        credentialId,
        principalId: row.principalId,
        tenantId,
        capabilityId: row.capabilityId,
        tool: row.tool,
        operation: row.operation,
        audience: row.audience,
        scopes: [...row.scopes],
        issuedBy: row.issuedBy.principalId,
        issuedAt: row.issuedAt,
        expiresAt: row.expiresAt,
        revokedAt: now,
        revocationReason: reason.trim(),
        recordedAt: now,
      };
      await SecurityStateStore.putAuditReceipt(collections.decisions, receipt, 'durableRevoke', true);
      return { revoked: true };
    });
  }

  /** Tenant-scoped binding read (operator diagnostics; rows never hold material). */
  async getRegistration(credentialId: string, tenantId: string): Promise<CredentialDoc | undefined> {
    if (typeof credentialId !== 'string' || credentialId.length === 0) return undefined;
    StorageModule.validateTenantId(tenantId);
    return this.store.transact({ tenantId }, async (collections) => {
      const row = await collections.credentials.get(credentialId);
      return row && row.tenantId === tenantId ? { ...row } : undefined;
    });
  }
}
