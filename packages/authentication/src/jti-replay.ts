// P2-S1 — durable jti single-use replay set (spec §5.1.5, A-01).
//
// Replay resistance is DURABLE: the assertion's `jti` (taken from the
// VERIFIED signature domain — a forged token never reaches this store) is
// consumed in an explicit system-scope transaction (the enumerated, counted
// `transaction:system` exception, same class as the S-9 fingerprint read).
// The insert is one-shot (CAS insert-once): a second presentation of the
// same jti is a REPLAY and is refused, in every process, without restart.
//
// Retention: rows are TTL-GC'd after the assertion's `exp` plus the shared
// skew grace — a GC'd jti can only belong to an assertion that is itself
// past its `exp`, which the claims boundary rejects before the consume step
// (so GC can never open a replay window).

import { type SecurityCollectionSource } from '@jataqi/storage';
import { JtiReplayError, IDENTITY_JTI_REPLAY_COLLECTION, IdentityStoreError, type IdentityJtiReplayDoc } from './identity-types.js';

const JTI_REPLAY_FIELDS = new Set(['id', 'firstSeenAt', 'expiresAt', 'consumedAt']);

/** GC grace: a row is deletable only after `expiresAt + GRACE_MS < now`. */
export const JTI_REPLAY_GC_GRACE_MS = 300_000;

export class JtiReplayStore {
  private constructor(private readonly source: SecurityCollectionSource) {}

  static async open(source: SecurityCollectionSource): Promise<JtiReplayStore> {
    if (!source.supportsTransactions()) {
      throw new IdentityStoreError(
        'NON_TRANSACTIONAL_SOURCE',
        'JtiReplayStore requires a transactional storage driver (PostgreSQL); a non-transactional store is never authoritative replay state (fail-closed).',
      );
    }
    // Materialize the replay table at open — the production RLS contract
    // verifies the table before boot completes (see IdentityStore.open);
    // lazy creation would fail a fresh production boot.
    const driver = source.getDriver();
    if (typeof driver.ensureIndex === 'function') {
      await driver.ensureIndex(IDENTITY_JTI_REPLAY_COLLECTION, { name: 'by_expiry', keys: ['expiresAt'], includeTenant: true });
    }
    return new JtiReplayStore(source);
  }

  /**
   * Consume one jti (one-shot). Throws `JtiReplayError` when the jti was
   * already consumed (replay) — the caller rejects the assertion.
   */
  async consume(jti: string, now: number, assertionExpiresAt: number): Promise<void> {
    if (typeof jti !== 'string' || jti.length === 0) {
      throw new IdentityStoreError('INVALID_JTI', 'jti consume requires a non-empty jti (fail-closed).');
    }
    if (typeof now !== 'number' || !Number.isFinite(now) || now < 0) {
      throw new IdentityStoreError('INVALID_JTI', 'jti consume requires a valid now (fail-closed).');
    }
    if (typeof assertionExpiresAt !== 'number' || !Number.isFinite(assertionExpiresAt) || assertionExpiresAt <= 0) {
      throw new IdentityStoreError('INVALID_JTI', 'jti consume requires a valid assertion expiry (fail-closed).');
    }
    const doc: IdentityJtiReplayDoc = {
      id: jti,
      firstSeenAt: now,
      expiresAt: assertionExpiresAt,
      consumedAt: now,
    };
    for (const key of Object.keys(doc)) {
      if (!JTI_REPLAY_FIELDS.has(key)) {
        throw new IdentityStoreError('CLOSED_SCHEMA_VIOLATION', `jti replay: unknown field "${key}" (fail-closed).`);
      }
    }
    // Pre-tenant: the jti is a global replay identifier — the lookup cannot
    // be tenant-bound. Explicit system-scope transaction (counted).
    await this.source.atomically(async (scope) => {
      if (!scope.atomic) {
        throw new IdentityStoreError('NON_ATOMIC', 'jti consume requires an atomic transaction (fail-closed).');
      }
      const rows = await scope.collection<IdentityJtiReplayDoc>(IDENTITY_JTI_REPLAY_COLLECTION);
      const res = await rows.cas(jti, (cur) => cur === undefined, () => ({ ...doc }));
      if (!res.ok) {
        throw new JtiReplayError(jti);
      }
    });
  }

  /**
   * TTL GC: delete rows whose retention horizon (exp + grace) is past.
   * Returns the deleted count. Bounded, explicit, and safe (see module
   * header: a GC'd jti can only be re-presentation of a past-exp assertion,
   * which the claims boundary refuses first).
   */
  async gc(now: number): Promise<number> {
    if (typeof now !== 'number' || !Number.isFinite(now) || now < 0) {
      throw new IdentityStoreError('INVALID_GC', 'jti GC requires a valid now (fail-closed).');
    }
    let deleted = 0;
    await this.source.atomically(async (scope) => {
      if (!scope.atomic) {
        throw new IdentityStoreError('NON_ATOMIC', 'jti GC requires an atomic transaction (fail-closed).');
      }
      const rows = await scope.collection<IdentityJtiReplayDoc>(IDENTITY_JTI_REPLAY_COLLECTION);
      const stale = await rows.query({
        where: (row) => row.expiresAt + JTI_REPLAY_GC_GRACE_MS < now,
      });
      for (const row of stale) {
        const ok = await rows.delete(row.id);
        if (ok) deleted += 1;
      }
    });
    return deleted;
  }
}
