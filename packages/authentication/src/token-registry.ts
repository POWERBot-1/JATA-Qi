// R2 — durable static-token registry (S-9).
//
// Static credentials are registered HERE, not in per-process memory:
// fingerprint (SHA-256, the document id) → principal, tenant, roles,
// expiry, status. Verification consults the shared row, so rotation and
// revocation are visible to every process without restart. No token
// MATERIAL is ever stored: the registry holds one-way fingerprints,
// and the closed field allow-list rejects material-shaped fields.

import { randomUUID } from 'node:crypto';
import type { CommercialActorRole } from '@jataqi/commercial-control-plane';
import { StorageModule, type ICollection, type SecurityCollectionSource } from '@jataqi/storage';
import {
  isCommercialActorRole,
  PrincipalValidationError,
  type AuthenticatedPrincipal,
} from './types.js';
import { AuthenticationEventStore, AuthenticationStoreError } from './authentication-event-store.js';

/** R2 S-9 collection: fingerprint → token registration (no material). */
export const TOKEN_REGISTRY_COLLECTION = 'authentication.token-registry';

export type TokenRegistryStatus = 'ACTIVE' | 'REVOKED';

export interface TokenRegistryDoc {
  /** SHA-256 fingerprint of the token material (one-way, never reversible). */
  readonly id: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly roles: readonly CommercialActorRole[];
  readonly status: TokenRegistryStatus;
  readonly expiresAt?: number;
  readonly label?: string;
  readonly revokedAt?: number;
  readonly revocationReason?: string;
  readonly importedBy?: string;
  readonly importedAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface StaticTokenImportRecord {
  /** The raw token material (fingerprinted in memory, NEVER persisted). */
  readonly token: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly roles: readonly CommercialActorRole[];
  readonly expiresAt?: number;
  readonly label?: string;
}

export interface TokenImportResult {
  readonly imported: number;
  readonly skipped: number;
}

const ALLOWED_TOKEN_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'tenantId',
  'principalId',
  'roles',
  'status',
  'expiresAt',
  'label',
  'revokedAt',
  'revocationReason',
  'importedBy',
  'importedAt',
  'createdAt',
  'updatedAt',
]);

const FORBIDDEN_TOKEN_FIELD_PATTERN = /(material|secret|token(?!registry)|password|privatekey)/i;

function assertTokenDocumentShape(doc: Record<string, unknown>): void {
  for (const key of Object.keys(doc)) {
    if (!ALLOWED_TOKEN_FIELDS.has(key)) {
      throw new AuthenticationStoreError(
        `tokenRegistry: unknown field "${key}" would be persisted (closed-schema violation, fail-closed).`,
      );
    }
    if (FORBIDDEN_TOKEN_FIELD_PATTERN.test(key)) {
      throw new AuthenticationStoreError(
        `tokenRegistry: field "${key}" is material-shaped and must never be persisted (fail-closed).`,
      );
    }
  }
}

function assertImportRecord(record: StaticTokenImportRecord): void {
  if (!record || typeof record !== 'object') {
    throw new AuthenticationStoreError('tokenRegistry.import requires a record (fail-closed).');
  }
  if (typeof record.token !== 'string' || record.token.length === 0) {
    throw new AuthenticationStoreError('tokenRegistry.import requires non-empty token material (fail-closed).');
  }
  StorageModule.validateTenantId(record.tenantId);
  if (typeof record.principalId !== 'string' || record.principalId.trim().length === 0) {
    throw new AuthenticationStoreError('tokenRegistry.import requires a non-empty principal id (fail-closed).');
  }
  if (!Array.isArray(record.roles) || record.roles.length === 0) {
    throw new AuthenticationStoreError('tokenRegistry.import requires at least one role (fail-closed).');
  }
  for (const role of record.roles) {
    if (!isCommercialActorRole(role)) {
      throw new AuthenticationStoreError('tokenRegistry.import requires normalized roles (fail-closed).');
    }
  }
  if (record.expiresAt !== undefined && (!Number.isInteger(record.expiresAt) || record.expiresAt <= 0)) {
    throw new AuthenticationStoreError('tokenRegistry.import requires a positive integer expiresAt when present (fail-closed).');
  }
}

/**
 * R2 S-9 repository over a transactional source. Fingerprint lookups are
 * inherently pre-tenant (the tenant is what the lookup reveals), so the
 * single-row reads in `verifyByMaterial` run in explicit SYSTEM scope —
 * the narrow documented exception (freeze §6) — then the resolved
 * principal/tenant is re-bound to the caller's request tenant by
 * `PrincipalBoundary` (T-17) before any authority flows.
 */
export class TokenRegistryStore {
  private constructor(
    private readonly source: SecurityCollectionSource,
    private readonly tokens: ICollection<TokenRegistryDoc>,
  ) {}

  static async open(source: SecurityCollectionSource): Promise<TokenRegistryStore> {
    if (!source.supportsTransactions()) {
      throw new AuthenticationStoreError(
        'TokenRegistryStore requires a transactional storage driver (PostgreSQL); ' +
          'a non-transactional store is never authoritative credential state (fail-closed).',
      );
    }
    const driver = source.getDriver();
    if (typeof driver.ensureIndex === 'function') {
      await driver.ensureIndex(TOKEN_REGISTRY_COLLECTION, {
        name: 'by_principal',
        keys: ['principalId'],
        includeTenant: true,
      });
      await driver.ensureIndex(TOKEN_REGISTRY_COLLECTION, {
        name: 'by_status',
        keys: ['status'],
        includeTenant: true,
      });
    }
    const tokens = await source.collection<TokenRegistryDoc>(TOKEN_REGISTRY_COLLECTION);
    return new TokenRegistryStore(source, tokens);
  }

  get collectionName(): string {
    return TOKEN_REGISTRY_COLLECTION;
  }

  private async inTenant<T>(tenantId: string, fn: (tokens: ICollection<TokenRegistryDoc>) => Promise<T>): Promise<T> {
    StorageModule.validateTenantId(tenantId);
    return this.source.atomically(async (scope) => {
      if (!scope.atomic) {
        throw new AuthenticationStoreError('Token registry write requires an atomic transaction (fail-closed).');
      }
      const tokens = await scope.collection<TokenRegistryDoc>(TOKEN_REGISTRY_COLLECTION);
      return fn(tokens);
    }, { tenantId });
  }

  /**
   * ONE-shot import of static token records (deployment/bootstrap path).
   * Material is fingerprinted in memory and never persisted. Each
   * fingerprint is insert-once: an identical re-import is skipped
   * (idempotent); a fingerprint bound to a DIFFERENT principal or
   * tenant throws (no silent credential rebind, fail closed).
   */
  async importRecords(
    records: readonly StaticTokenImportRecord[],
    importedBy: string,
    now: number,
  ): Promise<TokenImportResult> {
    if (!Array.isArray(records)) {
      throw new AuthenticationStoreError('tokenRegistry.import requires a record array (fail-closed).');
    }
    if (typeof importedBy !== 'string' || importedBy.trim().length === 0) {
      throw new AuthenticationStoreError('tokenRegistry.import requires an importing actor (fail-closed).');
    }
    let imported = 0;
    let skipped = 0;
    for (const record of records) {
      assertImportRecord(record);
      const fingerprint = AuthenticationEventStore.fingerprint(record.token);
      const doc: TokenRegistryDoc = {
        id: fingerprint,
        tenantId: record.tenantId,
        principalId: record.principalId,
        roles: [...record.roles],
        status: 'ACTIVE',
        ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
        ...(record.label !== undefined ? { label: record.label } : {}),
        importedBy: importedBy.trim(),
        importedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      assertTokenDocumentShape(doc as unknown as Record<string, unknown>);
      const outcome = await this.inTenant(record.tenantId, async (tokens) => {
        const res = await tokens.cas(fingerprint, (cur) => cur === undefined, () => ({ ...doc }));
        if (res.ok) return 'imported' as const;
        const current = await tokens.get(fingerprint);
        if (
          current &&
          current.tenantId === record.tenantId &&
          current.principalId === record.principalId &&
          current.roles.length === record.roles.length &&
          current.roles.every((role, index) => role === record.roles[index]) &&
          current.expiresAt === record.expiresAt
        ) {
          return 'skipped' as const;
        }
        throw new AuthenticationStoreError(
          'tokenRegistry.import: fingerprint collision with a different binding — refusing to rebind credentials (fail-closed).',
        );
      });
      if (outcome === 'imported') imported += 1;
      else skipped += 1;
    }
    return { imported, skipped };
  }

  /** System-scope single-row read (see class doc for the exception rationale). */
  private async getSystem(fingerprint: string): Promise<TokenRegistryDoc | undefined> {
    return this.source.atomically(async (scope) => {
      if (!scope.atomic) {
        throw new AuthenticationStoreError('Token registry read requires an atomic transaction (fail-closed).');
      }
      const tokens = await scope.collection<TokenRegistryDoc>(TOKEN_REGISTRY_COLLECTION);
      const row = await tokens.get(fingerprint);
      return row ? { ...row } : undefined;
    });
  }

  /**
   * Verify raw token material against the durable registry. Returns the
   * verified principal binding (a NEW object per call) or rejects with
   * `PrincipalValidationError` — never null/undefined ambiguity.
   * Material is fingerprinted in memory; only the fingerprint is read.
   */
  async verifyByMaterial(
    material: string,
    now: number,
    _requestId: string,
  ): Promise<AuthenticatedPrincipal> {
    if (typeof material !== 'string' || material.length === 0) {
      throw new PrincipalValidationError('A non-empty token is required.');
    }
    const fingerprint = AuthenticationEventStore.fingerprint(material);
    const row = await this.getSystem(fingerprint);
    if (!row || typeof row !== 'object' || row.id !== fingerprint) {
      throw new PrincipalValidationError('Presented token is not recognised.');
    }
    if (row.status !== 'ACTIVE') {
      throw new PrincipalValidationError('Presented token has been revoked.');
    }
    if (row.expiresAt !== undefined && row.expiresAt <= now) {
      throw new PrincipalValidationError('Presented token has expired.');
    }
    if (
      typeof row.tenantId !== 'string' || row.tenantId.length === 0 ||
      typeof row.principalId !== 'string' || row.principalId.length === 0 ||
      !Array.isArray(row.roles) || row.roles.length === 0 ||
      !row.roles.every(isCommercialActorRole)
    ) {
      throw new PrincipalValidationError('Static token registration is malformed (fail-closed).');
    }
    return {
      id: row.principalId,
      tenantId: row.tenantId,
      roles: [...row.roles],
      authenticationMethod: 'STATIC_TOKEN',
      verifiedAt: now,
      // P2-S2 fixation defense: the session identity is server-minted
      // random (never derived from request material). Rows recorded under
      // the old `${requestId}:${hash16}` derivation stay valid (the row id
      // is opaque to every reader) — they simply stop being minted.
      authenticationEventId: randomUUID(),
      ...(row.expiresAt !== undefined ? { credentialExpiresAt: row.expiresAt } : {}),
    };
  }

  /** Revoke one registration by fingerprint (operator path; idempotent). */
  async revokeByFingerprint(fingerprint: string, reason: string, now: number): Promise<TokenRegistryDoc> {
    if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
      throw new AuthenticationStoreError('revokeByFingerprint requires a fingerprint (fail-closed).');
    }
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new AuthenticationStoreError('revokeByFingerprint requires a revocation reason (fail-closed).');
    }
    return this.source.atomically(async (scope) => {
      if (!scope.atomic) {
        throw new AuthenticationStoreError('Token registry revocation requires an atomic transaction (fail-closed).');
      }
      const tokens = await scope.collection<TokenRegistryDoc>(TOKEN_REGISTRY_COLLECTION);
      const res = await tokens.cas(
        fingerprint,
        (cur) => !!cur && cur.status === 'ACTIVE',
        (cur) => ({ ...cur, status: 'REVOKED' as const, revokedAt: now, revocationReason: reason.trim(), updatedAt: now }),
      );
      if (!res.ok) {
        const current = await tokens.get(fingerprint);
        if (!current) {
          throw new AuthenticationStoreError('Token registration does not exist (fail-closed).');
        }
        return { ...current };
      }
      return { ...(res.doc as TokenRegistryDoc) };
    });
  }

  /**
   * Revoke every ACTIVE registration for a principal in a tenant
   * (principal-compromise path). Returns the revoked count.
   */
  async revokeByPrincipal(principalId: string, tenantId: string, reason: string, now: number): Promise<number> {
    if (typeof principalId !== 'string' || principalId.trim().length === 0) {
      throw new AuthenticationStoreError('revokeByPrincipal requires a principal id (fail-closed).');
    }
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new AuthenticationStoreError('revokeByPrincipal requires a revocation reason (fail-closed).');
    }
    return this.inTenant(tenantId, async (tokens) => {
      const rows = await tokens.query({
        where: (row) => row.principalId === principalId && row.status === 'ACTIVE',
      });
      let revoked = 0;
      for (const row of rows) {
        if (row.principalId !== principalId || row.status !== 'ACTIVE') continue;
        const res = await tokens.cas(
          row.id,
          (cur) => !!cur && cur.status === 'ACTIVE' && cur.principalId === principalId,
          (cur) => ({ ...cur, status: 'REVOKED' as const, revokedAt: now, revocationReason: reason.trim(), updatedAt: now }),
        );
        if (res.ok) revoked += 1;
      }
      return revoked;
    });
  }

  /** Tenant-scoped read of one registration (operator diagnostics). */
  async getRegistration(fingerprint: string, tenantId: string): Promise<TokenRegistryDoc | undefined> {
    if (typeof fingerprint !== 'string' || fingerprint.length === 0) return undefined;
    return this.inTenant(tenantId, async (tokens) => {
      const row = await tokens.get(fingerprint);
      return row && row.tenantId === tenantId ? { ...row } : undefined;
    });
  }
}
