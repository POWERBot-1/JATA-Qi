// P2-S4 — the durable Delegation + Policy STORE over real PostgreSQL
// (spec §8, §13, §24-S4; A-08/A-09/A-16/A-24/A-25 delegation subset).
//
// Fail-hard: if embedded PostgreSQL cannot start, before() rejects and the
// suite FAILS (no skip — the delegation store is the S4 security substrate).
//
// Covered:
//   * non-transactional source refusal (memory is never delegation authority);
//   * grant validation: mandatory bounded lifetime, self-delegation refusal,
//     wildcard-operation refusal, chain-depth bound, grant ⊆ delegator
//     authority (subset), platform-scope requires recorded platform elevation
//     + bound digest approval, approval-mandatory when the delegator's
//     capability requires it;
//   * durable audit: DELEGATION_GRANTED / DELEGATION_REVOKED events land in
//     the SAME authoritative store, in-tx, secret-free (no material fields);
//   * closed schema + material-shaped-field refusal;
//   * cross-tenant invisibility: a grant is unreadable from another tenant
//     (RLS-bound) and the state authority refuses it as UNKNOWN_GRANT;
//   * lifecycle: ACTIVE ⇒ REVOKED (idempotent, reason-mandatory);
//   * consumption: one-shot ⇒ CONSUMED (CAS-guarded, exactly once); counted
//     grants decrement; a consumed/revoked grant is not consumable;
//   * concurrent consumption: exactly one of N racers wins.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StorageModule } from '@jataqi/storage';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import {
  DelegationStore,
  DelegationStoreError,
  IdentityStore,
  MAX_DELEGATION_CHAIN_DEPTH,
  MAX_DELEGATION_LIFETIME_MS,
  assertDelegationDocumentShape,
} from '../src/index.js';
import { bootR2Postgres, bootR2StorageKernel, type R2Postgres } from './r2-pg.js';

let pg: R2Postgres;
let storage: StorageModule;
let identity: IdentityStore;
let delegation: DelegationStore;

let now: number;
const T0 = Date.now();
let seq = 0;
const nextId = (prefix: string): string => `${prefix}-${process.pid}-${++seq}`;

const TENANT = 'acme';
const OTHER = 'other';
const CAP = 'cap.p2s4.delegate';

/** A delegatee/delegator evidence bundle standing for the delegator's LIVE manifest scope. */
function evidence(overrides: Record<string, unknown> = {}) {
  return {
    manifestDigest: 'sha256-delegator-manifest-live',
    actions: [{ tool: 'docs', operation: 'read' }],
    targets: [{ system: 'docs', resourcePattern: 'res-*' }],
    classificationCeiling: 'INTERNAL',
    impactCeiling: 'EXTERNAL_SIDE_EFFECT',
    requiresApproval: false,
    ...overrides,
  };
}

function grantInput(overrides: Record<string, unknown> = {}) {
  return {
    delegatorPrincipalId: nextId('delegator'),
    delegateePrincipalId: nextId('delegatee'),
    tenantId: TENANT,
    scope: 'tenant' as const,
    capability: { capabilityId: CAP, capabilityVersion: '1' },
    actions: [{ tool: 'docs', operation: 'read' }],
    targetScope: [{ system: 'docs', resourcePattern: 'res-*' }],
    constraints: { maxAgeMs: 3_600_000, classificationCeiling: 'INTERNAL', impactCeiling: 'EXTERNAL_SIDE_EFFECT' },
    chainDepth: 0,
    chain: ['sha256-delegator-manifest-live'],
    grantedBy: { principalId: nextId('delegator2'), authenticationEventId: 'evt-delegator' },
    oneShot: false,
    useCount: 5,
    delegatorEvidence: evidence(),
    ...overrides,
  };
}

before(async () => {
  now = T0;
  pg = await bootR2Postgres('p2s4store', 59450);
  ({ storage } = await bootR2StorageKernel(pg.connectionString));
  identity = await IdentityStore.open(storage);
  delegation = await DelegationStore.open(storage);
});

after(async () => {
  await pg.stop();
});

describe('P2-S4 durable delegation store (real PostgreSQL)', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg, 'P2-S4 requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
  });

  it('refuses a non-transactional source at open (memory is never delegation authority)', async () => {
    const memory = new StorageModule();
    const kernel = createTestKernel();
    kernel.register(memory);
    await kernel.boot();
    await assert.rejects(() => DelegationStore.open(memory), DelegationStoreError);
    await kernel.shutdown();
  });

  it('grant emits a durable DELEGATION_GRANTED event in the same store (secret-free)', async () => {
    const doc = await delegation.grantDelegation(
      grantInput({ correlationId: 'corr-grant-probe', delegateePrincipalId: nextId('grantee') }),
      now,
    );
    assert.equal(doc.status, 'ACTIVE');
    assert.equal(doc.tenantId, TENANT);
    assert.equal(doc.expiresAt, now + 3_600_000);

    const events = await identity.queryEvents(TENANT, 'DELEGATION_GRANTED');
    const event = events.find((e) => e.correlationId === 'corr-grant-probe');
    assert.ok(event, 'the grant is audited durably (DELEGATION_GRANTED)');
    assert.equal(event.decision, 'ALLOW');
    assert.equal(event.resource, 'identity.delegations');
    for (const key of Object.keys(event)) {
      assert.doesNotMatch(key, /material|secret|token|password|privatekey|jwks/i);
    }
    assert.doesNotMatch(String(event.detail ?? ''), /token|secret|material|password/i);
  });

  it('revoke emits a durable DELEGATION_REVOKED event and is idempotent + reason-mandatory', async () => {
    const doc = await delegation.grantDelegation(grantInput({ correlationId: 'corr-revoke-probe-a' }), now);
    await assert.rejects(
      () => delegation.revokeDelegation({ delegationId: doc.id, tenantId: TENANT, scope: 'tenant', revokedBy: 'user:admin', reason: '   ' }, now),
      /INVALID_INPUT/,
    );
    const first = await delegation.revokeDelegation(
      { delegationId: doc.id, tenantId: TENANT, scope: 'tenant', revokedBy: 'user:admin', reason: 'revoke once', correlationId: 'corr-revoke-probe' },
      now,
    );
    assert.equal(first.status, 'REVOKED');
    const second = await delegation.revokeDelegation(
      { delegationId: doc.id, tenantId: TENANT, scope: 'tenant', revokedBy: 'user:admin', reason: 'revoke again' },
      now,
    );
    assert.equal(second.status, 'REVOKED');

    const events = await identity.queryEvents(TENANT, 'DELEGATION_REVOKED');
    assert.ok(events.some((e) => e.correlationId === 'corr-revoke-probe'), 'the revocation is audited durably (DELEGATION_REVOKED)');
  });

  it('refuses self-delegation (a principal cannot delegate to itself)', async () => {
    const self = nextId('self');
    await assert.rejects(
      () => delegation.grantDelegation(grantInput({ delegatorPrincipalId: self, delegateePrincipalId: self }), now),
      /SELF_DELEGATION_REFUSED/,
    );
  });

  it('bounds the grant lifetime to (0, 24h] (mandatory maxAgeMs)', async () => {
    await assert.rejects(
      () => delegation.grantDelegation(grantInput({ constraints: { maxAgeMs: MAX_DELEGATION_LIFETIME_MS + 1 } }), now),
      /INVALID_LIFETIME/,
    );
    await assert.rejects(
      () => delegation.grantDelegation(grantInput({ constraints: { maxAgeMs: 0 } }), now),
      /INVALID_LIFETIME/,
    );
  });

  it('refuses wildcard operations and empty scopes (no grant-all; fail-closed)', async () => {
    await assert.rejects(
      () => delegation.grantDelegation(grantInput({ actions: [{ tool: 'docs', operation: '*' }] }), now),
      /WILDCARD_REFUSED/,
    );
    await assert.rejects(() => delegation.grantDelegation(grantInput({ actions: [] }), now), /INVALID_INPUT/);
    await assert.rejects(() => delegation.grantDelegation(grantInput({ targetScope: [] }), now), /INVALID_INPUT/);
  });

  it('bounds the chain depth (spec §8.2.6: ≤ 2)', async () => {
    await assert.rejects(
      () => delegation.grantDelegation(grantInput({ chainDepth: MAX_DELEGATION_CHAIN_DEPTH + 1 }), now),
      /CHAIN_DEPTH_EXCEEDED/,
    );
  });

  it('refuses a grant that EXCEEDS the delegator\'s authority (subset; A-16 defense-in-depth)', async () => {
    await assert.rejects(
      () =>
        delegation.grantDelegation(
          grantInput({ actions: [{ tool: 'billing', operation: 'plan.create' }] }), // not in evidence.actions
          now,
        ),
      /DELEGATOR_AUTHORITY_EXCEEDED/,
    );
    await assert.rejects(
      () =>
        delegation.grantDelegation(
          grantInput({ targetScope: [{ system: 'billing', resourcePattern: 'res-*' }] }), // not in evidence.targets
          now,
        ),
      /DELEGATOR_AUTHORITY_EXCEEDED/,
    );
  });

  it('refuses a platform-scoped grant without a recorded platform elevation + bound approval', async () => {
    await assert.rejects(
      () =>
        delegation.grantDelegation(
          grantInput({
            scope: 'platform',
            tenantId: 'system',
            chain: ['sha256-delegator-manifest-live'],
            grantedBy: { principalId: nextId('p'), authenticationEventId: 'evt-p', platformElevationId: 'elev-p' },
            // no approval
          }),
          now,
        ),
      /APPROVAL_REQUIRED/,
    );
  });

  it('requires a bound digest approval when the delegator\'s capability requires one', async () => {
    await assert.rejects(
      () => delegation.grantDelegation(grantInput({ delegatorEvidence: evidence({ requiresApproval: true }) }), now),
      /APPROVAL_REQUIRED/,
    );
  });

  it('cross-tenant invisibility: a grant is unreadable and unassessable from another tenant (RLS-bound)', async () => {
    const delegatee = nextId('xt-delegatee');
    const doc = await delegation.grantDelegation(grantInput({ delegateePrincipalId: delegatee }), now);

    const fromOther = await delegation.getDelegation(OTHER, doc.id);
    assert.equal(fromOther, undefined, 'a foreign tenant cannot read the grant');

    const authority = delegation.asStateAuthority();
    const peek = await authority.peek(doc.id);
    assert.deepEqual(peek, { scope: 'tenant', tenantId: TENANT });

    const requirement = {
      delegationId: doc.id,
      principalId: delegatee,
      tenantId: OTHER,
      capabilityId: CAP,
      capabilityVersion: '1',
      tool: 'docs',
      operation: 'read',
      targetSystem: 'docs',
      targetResource: 'res-1',
      classification: 'INTERNAL',
      impact: 'READ',
      requestIsPlatformScoped: false,
      liveManifest: {
        digest: 'sha256-delegator-manifest-live',
        actions: [{ tool: 'docs', operation: 'read' }],
        targets: [{ system: 'docs', resourcePattern: 'res-*' }],
        classificationCeiling: 'INTERNAL',
        impactCeiling: 'EXTERNAL_SIDE_EFFECT',
        requiresApproval: false,
      },
    };
    // A tenant-scoped read inside the OTHER tenant cannot see the grant.
    const assessment = await storage.atomically(
      (scope) => delegation.asStateAuthority().assessInTx(scope, requirement, now),
      { tenantId: OTHER },
    );
    assert.equal(assessment.verdict, 'UNKNOWN_GRANT');
  });

  it('one-shot consumption is CAS-guarded: exactly one of N concurrent consumers wins', async () => {
    const delegatee = nextId('oneshot');
    const doc = await delegation.grantDelegation(
      grantInput({ delegateePrincipalId: delegatee, oneShot: true, useCount: undefined }),
      now,
    );
    const authority = delegation.asStateAuthority();
    const results = await Promise.allSettled([
      authority.consumePlatform(doc.id, now),
      authority.consumePlatform(doc.id, now),
      authority.consumePlatform(doc.id, now),
    ]);
    const winners = results.filter((r) => r.status === 'fulfilled');
    const losers = results.filter((r) => r.status === 'rejected');
    assert.equal(winners.length, 1, 'exactly one concurrent consume wins');
    assert.equal(losers.length, 2);
    const loserError = losers[0] as PromiseRejectedResult;
    assert.match(String(loserError.reason), /CONSUMED/);

    // The surviving row is CONSUMED and cannot be consumed again.
    const after = await delegation.getDelegation(TENANT, doc.id);
    assert.equal(after?.status, 'CONSUMED');
    assert.ok(after?.consumedAt !== undefined);
  });

  it('counted grants decrement and become CONSUMED at zero', async () => {
    const delegatee = nextId('counted');
    const doc = await delegation.grantDelegation(
      grantInput({ delegateePrincipalId: delegatee, oneShot: false, useCount: 2 }),
      now,
    );
    const authority = delegation.asStateAuthority();
    await authority.consumePlatform(doc.id, now);
    let after = await delegation.getDelegation(TENANT, doc.id);
    assert.equal(after?.status, 'ACTIVE');
    assert.equal(after?.useCount, 1);
    await authority.consumePlatform(doc.id, now);
    after = await delegation.getDelegation(TENANT, doc.id);
    assert.equal(after?.status, 'CONSUMED');
    assert.equal(after?.useCount, 0);
  });

  it('a revoked grant cannot be consumed (REVOKED, fail-closed)', async () => {
    const doc = await delegation.grantDelegation(grantInput({ oneShot: true, useCount: undefined }), now);
    await delegation.revokeDelegation({ delegationId: doc.id, tenantId: TENANT, scope: 'tenant', revokedBy: 'user:admin', reason: 'probe' }, now);
    await assert.rejects(() => delegation.asStateAuthority().consumePlatform(doc.id, now), /REVOKED/);
  });

  it('closed schema + material-shaped-field refusal (A-22)', () => {
    assert.throws(
      () => assertDelegationDocumentShape({ accessToken: 'x' } as never, new Set(['id', 'accessToken']), 'probe'),
      /MATERIAL_FIELD_REFUSED/,
    );
    assert.throws(
      () => assertDelegationDocumentShape({ unknownField: 1 } as never, new Set(['id']), 'probe'),
      /CLOSED_SCHEMA_VIOLATION/,
    );
  });

  // -- REMEDIATION D: budget/rate constraints are never silently stored -------

  it('rejects unmodeled grant-level budget/rate constraints (UNSUPPORTED_CONSTRAINT, fail-closed)', async () => {
    await assert.rejects(
      () => delegation.grantDelegation(grantInput({ constraints: { maxAgeMs: 3_600_000, budgetCeiling: 500 } }), now),
      /UNSUPPORTED_CONSTRAINT/,
    );
    await assert.rejects(
      () => delegation.grantDelegation(grantInput({ constraints: { maxAgeMs: 3_600_000, budget: 500 } }), now),
      /UNSUPPORTED_CONSTRAINT/,
    );
    await assert.rejects(
      () => delegation.grantDelegation(grantInput({ constraints: { maxAgeMs: 3_600_000, rate: 10 } }), now),
      /UNSUPPORTED_CONSTRAINT/,
    );
    await assert.rejects(
      () => delegation.grantDelegation(grantInput({ constraints: { maxAgeMs: 3_600_000, rateLimit: { windowMs: 60_000, max: 10 } } }), now),
      /UNSUPPORTED_CONSTRAINT/,
    );
    // A grant without budget/rate still persists its enforced ceilings.
    const ok = await delegation.grantDelegation(
      grantInput({ constraints: { maxAgeMs: 3_600_000, classificationCeiling: 'INTERNAL', impactCeiling: 'REVERSIBLE_WRITE' } }),
      now,
    );
    assert.equal(ok.status, 'ACTIVE');
    const persisted = await delegation.getDelegation(TENANT, ok.id);
    assert.deepEqual(persisted?.constraints, {
      maxAgeMs: 3_600_000,
      classificationCeiling: 'INTERNAL',
      impactCeiling: 'REVERSIBLE_WRITE',
    });
  });

  // -- REMEDIATION A: durable DELEGATION_USED emission -------------------------

  it('consume emits a durable DELEGATION_USED event (secret-free, attributable)', async () => {
    const delegatee = nextId('used');
    const doc = await delegation.grantDelegation(
      grantInput({ delegateePrincipalId: delegatee, oneShot: true, useCount: undefined }),
      now,
    );
    await delegation.asStateAuthority().consumePlatform(doc.id, now);

    const used = await identity.queryEvents(TENANT, 'DELEGATION_USED');
    const event = used.find((e) => e.principalId === delegatee);
    assert.ok(event, 'DELEGATION_USED is emitted durably on consumption');
    assert.equal(event.resource, 'identity.delegations');
    assert.equal(event.decision, 'ALLOW');
    for (const key of Object.keys(event)) {
      assert.doesNotMatch(key, /material|secret|token|password|privatekey|jwks/i);
    }
  });

  // -- REMEDIATION B: §8.2.7 disablement cascade ------------------------------

  it('§8.2.7 cascade: suspending an identity revokes its ACTIVE grants as delegator AND delegatee', async () => {
    const delegator = nextId('cascade-del');
    const peer = nextId('cascade-peer');
    await identity.enroll({ principalId: delegator, tenantId: TENANT, roles: ['operator'], enrolledBy: 'user:admin' }, now);
    await identity.activate(delegator, TENANT, { authenticationEventId: 'evt-cascade-activate', method: 'STATIC_TOKEN' }, now);

    const asDelegator = await delegation.grantDelegation(
      grantInput({ delegatorPrincipalId: delegator, delegateePrincipalId: peer }),
      now,
    );
    const asDelegatee = await delegation.grantDelegation(
      grantInput({ delegatorPrincipalId: peer, delegateePrincipalId: delegator }),
      now,
    );
    assert.equal((await delegation.getDelegation(TENANT, asDelegator.id))?.status, 'ACTIVE');
    assert.equal((await delegation.getDelegation(TENANT, asDelegatee.id))?.status, 'ACTIVE');

    await identity.suspend(delegator, TENANT, 'cascade probe', now);

    const delegatorSide = await delegation.getDelegation(TENANT, asDelegator.id);
    const delegateeSide = await delegation.getDelegation(TENANT, asDelegatee.id);
    assert.equal(delegatorSide?.status, 'REVOKED', 'the delegator-side grant is revoked by the cascade');
    assert.equal(delegateeSide?.status, 'REVOKED', 'the delegatee-side grant is revoked by the cascade');
    assert.match(delegatorSide?.revocationReason ?? '', /cascade probe/);
    assert.match(delegateeSide?.revocationReason ?? '', /cascade probe/);

    const revoked = await identity.queryEvents(TENANT, 'DELEGATION_REVOKED');
    assert.ok(
      revoked.filter((e) => e.principalId === peer || e.principalId === delegator).length >= 2,
      'the cascade emits durable DELEGATION_REVOKED events',
    );
  });

  it('§8.2.7 cascade (deprovision): revokes grants still ACTIVE after suspension and is idempotent for already-revoked grants', async () => {
    const delegator = nextId('deprov-del');
    const peer = nextId('deprov-peer');
    await identity.enroll({ principalId: delegator, tenantId: TENANT, roles: ['operator'], enrolledBy: 'user:admin' }, now);
    await identity.activate(delegator, TENANT, { authenticationEventId: 'evt-deprov-activate', method: 'STATIC_TOKEN' }, now);

    const before = await delegation.grantDelegation(
      grantInput({ delegatorPrincipalId: delegator, delegateePrincipalId: peer }),
      now,
    );
    await identity.suspend(delegator, TENANT, 'deprov step 1', now);
    assert.equal((await delegation.getDelegation(TENANT, before.id))?.status, 'REVOKED', 'suspension already revoked the first grant');

    // A grant minted while SUSPENDED (grant-time does not re-read identity state).
    const whileSuspended = await delegation.grantDelegation(
      grantInput({ delegatorPrincipalId: delegator, delegateePrincipalId: peer }),
      now,
    );
    assert.equal((await delegation.getDelegation(TENANT, whileSuspended.id))?.status, 'ACTIVE');

    await identity.deactivate(delegator, TENANT, 'deprov step 2', now);
    const result = await identity.deprovision(delegator, TENANT, 'deprov step 3', now);

    assert.equal(result.delegationsRevoked, 1, 'deprovision revoked exactly the one grant still ACTIVE (idempotent for the already-revoked grant)');
    assert.equal((await delegation.getDelegation(TENANT, whileSuspended.id))?.status, 'REVOKED');
    assert.equal((await delegation.getDelegation(TENANT, before.id))?.status, 'REVOKED', 'the already-revoked grant stays revoked');
  });

  it('§8.2.7 cascade is tenant-scoped: suspension does not touch another tenant\'s grants', async () => {
    const delegator = nextId('xt-cascade-del');
    const peer = nextId('xt-cascade-peer');
    await identity.enroll({ principalId: delegator, tenantId: TENANT, roles: ['operator'], enrolledBy: 'user:admin' }, now);
    await identity.activate(delegator, TENANT, { authenticationEventId: 'evt-xt-cascade', method: 'STATIC_TOKEN' }, now);

    // A grant in a DIFFERENT tenant that happens to name the same principal.
    const foreign = await delegation.grantDelegation(
      grantInput({ tenantId: OTHER, delegatorPrincipalId: delegator, delegateePrincipalId: peer }),
      now,
    );
    const local = await delegation.grantDelegation(
      grantInput({ delegatorPrincipalId: delegator, delegateePrincipalId: peer }),
      now,
    );

    await identity.suspend(delegator, TENANT, 'cross-tenant cascade probe', now);

    assert.equal((await delegation.getDelegation(TENANT, local.id))?.status, 'REVOKED', 'the local grant is revoked');
    assert.equal((await delegation.getDelegation(OTHER, foreign.id))?.status, 'ACTIVE', 'the foreign-tenant grant is untouched (tenant isolation)');
  });
});
