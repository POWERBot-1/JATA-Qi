// P2-S4 — the durable Delegation + Policy plane: delegation store + A-01
// delegation stage + grant lifecycle + enforcement re-validation (spec §8,
// §14, §24-S4; A-08/A-09/A-16/A-24/A-25 delegation subset). Real
// PostgreSQL; fail-hard: if embedded PostgreSQL cannot start, before()
// rejects and the suite FAILS (no skip).
//
// Covered:
//   * a VALID delegation ALLOWs and the envelope cites delegationStatus
//     = 'VALID' (the durable grant is resolved from the reference);
//   * fail-closed: a gate WITHOUT a delegation authority ⇒
//     DELEGATION_CHECK_UNAVAILABLE (no ambient delegation authority);
//   * wrong delegatee ⇒ DELEGATION_NOT_DELEGATEE (no acting-as);
//   * cross-tenant: an `acme` grant is refused for an `other` request
//     (DELEGATION_UNKNOWN_GRANT — no grant-existence leak);
//   * subset enforcement: operation / target / classification outside the
//     grant ⇒ DELEGATION_SCOPE_* (the grant narrows the delegator's live
//     manifest, never widens it);
//   * expiry ⇒ DELEGATION_EXPIRED; revocation ⇒ DELEGATION_REVOKED;
//   * chain integrity (A-16): rotating the delegator's manifest after the
//     grant ⇒ DELEGATION_DELEGATOR_AUTHORITY_CHANGED;
//   * one-shot consumption: after enforcement consumes the grant, the next
//     decision denies DELEGATION_CONSUMED;
//   * enforcement re-validation: a revocation after decide denies BEFORE the
//     side effect (the side effect never runs).

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthenticationEventStore,
  DelegationStore,
  type DelegationDoc,
} from '@jataqi/authentication';
import {
  AuthorizationGate,
  DurableCredentialBroker,
  InMemoryAuditSink,
  InMemoryCredentialMaterialProvider,
  SecurityStateStore,
  type A01AuthorizationRequest,
} from '../src/index.js';
import { baseRequest } from './helpers.js';
import { bootR2Postgres, bootR2StorageKernel, type R2Postgres } from './r2-pg.js';
import { durableManifest, registrar } from './r2-fixtures.js';

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

let pg: R2Postgres;
let store: SecurityStateStore;
let sessions: AuthenticationEventStore;
let delegation: DelegationStore;
let audit: InMemoryAuditSink;
let gate: AuthorizationGate;

let now: number;
const T0 = Date.now();
let seq = 0;
const nextId = (prefix: string): string => `${prefix}-${process.pid}-${++seq}`;
const clock = (): number => now;

const TENANT = 'acme';
const OTHER = 'other';
const CAP = 'cap.p2s4.delegate';
const CAP_CHAIN = 'cap.p2s4.delegate.chain';
const OP = { tool: 'docs', operation: 'read' };
const OP_WRITE = { tool: 'docs', operation: 'write' };

/** The delegator's authority: the live ACTIVE manifest scope for CAP. */
function liveEvidence(digest: string) {
  return {
    manifestDigest: digest,
    actions: [OP, OP_WRITE],
    targets: [{ system: 'docs', resourcePattern: 'res-*' }],
    classificationCeiling: 'RESTRICTED',
    impactCeiling: 'EXTERNAL_SIDE_EFFECT',
    requiresApproval: false,
  };
}

async function mintSession(principalId: string, tenantId = TENANT): Promise<{ eventId: string; tenantId: string; principalId: string }> {
  const eventId = `evt-${nextId('s4')}`;
  await sessions.recordEvent(
    {
      eventId,
      tenantId,
      principalId,
      method: 'STATIC_TOKEN',
      verifiedAt: now,
      expiresAt: now + 3_600_000,
    },
    now,
  );
  return { eventId, tenantId, principalId };
}

/** Grant a tenant-scoped delegation from `delegator` to `delegatee` for a capability. */
async function grantDelegation(
  delegateePrincipalId: string,
  digest: string,
  overrides: Record<string, unknown> = {},
): Promise<DelegationDoc> {
  const capabilityId = (overrides.capabilityId as string | undefined) ?? CAP;
  return delegation.grantDelegation(
    {
      delegatorPrincipalId: 'user:delegator',
      delegateePrincipalId,
      tenantId: TENANT,
      scope: 'tenant',
      capability: { capabilityId, capabilityVersion: '1' },
      actions: [{ tool: OP.tool, operation: OP.operation }],
      targetScope: [{ system: 'docs', resourcePattern: 'res-*' }],
      constraints: { maxAgeMs: 3_600_000, classificationCeiling: 'INTERNAL', impactCeiling: 'EXTERNAL_SIDE_EFFECT' },
      chainDepth: 0,
      chain: [digest],
      grantedBy: { principalId: 'user:delegator', authenticationEventId: 'evt-delegator' },
      oneShot: false,
      useCount: 5,
      delegatorEvidence: liveEvidence(digest),
      ...overrides,
    },
    now,
  );
}

function delRequest(
  session: { eventId: string; tenantId: string; principalId: string },
  delegationId: string,
  overrides: Record<string, unknown> = {},
): A01AuthorizationRequest {
  return baseRequest({
    principal: {
      id: session.principalId,
      tenantId: session.tenantId,
      roles: ['operator'],
      authenticationMethod: 'STATIC_TOKEN',
      authenticationEventId: session.eventId,
    },
    tenantId: session.tenantId,
    capability: { capabilityId: CAP, capabilityVersion: '1' },
    tool: OP.tool,
    operation: OP.operation,
    target: { system: 'docs', resource: `res-${nextId('t')}` },
    dataClassification: 'INTERNAL',
    // Non-READ so the durable enforcement path consumes the envelope and the
    // grant (READ envelopes are never consumed — R1 parity).
    impact: 'REVERSIBLE_WRITE',
    delegation: { delegationId },
    ...overrides,
  });
}

let activeDigest = '';
let chainDigest = '';

before(async () => {
  now = T0;
  pg = await bootR2Postgres('p2s4del', 58700);
  const { storage } = await bootR2StorageKernel(pg.connectionString);
  store = await SecurityStateStore.open(storage, { now: clock });
  sessions = await AuthenticationEventStore.open(storage);
  delegation = await DelegationStore.open(storage);
  audit = new InMemoryAuditSink();
  const provider = new InMemoryCredentialMaterialProvider();
  const broker = new DurableCredentialBroker(store, provider, { now: clock });
  gate = new AuthorizationGate({
    store,
    durableBroker: broker,
    audit,
    now: clock,
    delegationAuthorityResolver: () => delegation.asStateAuthority(),
  });
  // A NON-privileged capability (docs.read / docs.write) so the S4 delegation
  // stage is the only gate under test (the S3 privilege register does not
  // classify these operations). maxDataClassification is RESTRICTED so the
  // classification-ceiling subset test has headroom.
  await store.registerManifestVersion(
    durableManifest(CAP, {
      allowedOperations: [OP, OP_WRITE],
      allowedTargets: [{ system: 'docs', resourcePattern: 'res-*' }],
      maxDataClassification: 'RESTRICTED',
    }),
    registrar(TENANT),
  );
  // A SEPARATE capability for the chain-integrity (A-16) rotation test, so
  // its manifest rotation cannot poison the shared CAP digest used elsewhere.
  await store.registerManifestVersion(
    durableManifest(CAP_CHAIN, {
      allowedOperations: [OP, OP_WRITE],
      allowedTargets: [{ system: 'docs', resourcePattern: 'res-*' }],
      maxDataClassification: 'RESTRICTED',
    }),
    registrar(TENANT),
  );
  const active = await store.getActiveManifest(CAP);
  const chain = await store.getActiveManifest(CAP_CHAIN);
  assert.ok(active && chain, 'the ACTIVE manifests must resolve before grants are minted');
  activeDigest = active.digest;
  chainDigest = chain.digest;
});

after(async () => {
  await pg.stop();
});

describe('P2-S4 durable delegation plane (real PostgreSQL)', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg, 'P2-S4 requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
  });

  it('a VALID delegation ALLOWs and the envelope cites delegationStatus = VALID', async () => {
    const delegatee = nextId('delegatee');
    const session = await mintSession(delegatee);
    const grant = await grantDelegation(delegatee, activeDigest);
    const env = await gate.decideAsync(delRequest(session, grant.id));
    assert.equal(env.decision.decision, 'ALLOW', `expected ALLOW, got [${[...env.decision.reasonCodes].join(', ')}]`);
    assert.equal(env.delegationStatus, 'VALID', 'the sealed envelope cites the verified delegation');
  });

  it('without a delegation reference the capability is invokable directly (pre-P2-S4 behavior unchanged)', async () => {
    const principal = nextId('direct');
    const session = await mintSession(principal);
    const req = delRequest(session, 'unused-grant-id');
    delete (req as { delegation?: unknown }).delegation;
    const env = await gate.decideAsync(req);
    assert.equal(env.decision.decision, 'ALLOW', `direct invocation ALLOWs, got [${[...env.decision.reasonCodes].join(', ')}]`);
    assert.equal(env.delegationStatus, undefined, 'no delegation citation without a delegation reference');
  });

  it('fail-closed: a gate WITHOUT a delegation authority denies DELEGATION_CHECK_UNAVAILABLE', async () => {
    const provider = new InMemoryCredentialMaterialProvider();
    const broker = new DurableCredentialBroker(store, provider, { now: clock });
    const bareGate = new AuthorizationGate({ store, durableBroker: broker, audit, now: clock });
    const delegatee = nextId('noauth');
    const session = await mintSession(delegatee);
    const env = await bareGate.decideAsync(delRequest(session, 'any-grant-id'));
    assert.equal(env.decision.decision, 'DENY');
    assert.deepEqual(env.decision.reasonCodes, ['DELEGATION_CHECK_UNAVAILABLE'], 'no ambient delegation authority may satisfy a delegation reference');
  });

  it('an unknown grant id denies DELEGATION_UNKNOWN_GRANT (no grant-existence detail)', async () => {
    const delegatee = nextId('unknown');
    const session = await mintSession(delegatee);
    const env = await gate.decideAsync(delRequest(session, `missing-${nextId('g')}`));
    assert.equal(env.decision.decision, 'DENY');
    assert.deepEqual(env.decision.reasonCodes, ['DELEGATION_UNKNOWN_GRANT']);
  });

  it('wrong delegatee denies DELEGATION_NOT_DELEGATEE (no acting-as)', async () => {
    const grantee = nextId('grantee');
    const grant = await grantDelegation(grantee, activeDigest);
    const impostor = nextId('impostor');
    const session = await mintSession(impostor);
    const env = await gate.decideAsync(delRequest(session, grant.id));
    assert.equal(env.decision.decision, 'DENY');
    assert.deepEqual(env.decision.reasonCodes, ['DELEGATION_NOT_DELEGATEE']);
  });

  it('cross-tenant: an acme grant is refused for an other-tenant request (A-09)', async () => {
    const delegatee = nextId('xtee');
    const grant = await grantDelegation(delegatee, activeDigest);
    const otherSession = await mintSession(delegatee, OTHER);
    const env = await gate.decideAsync(delRequest(otherSession, grant.id));
    assert.equal(env.decision.decision, 'DENY');
    assert.deepEqual(
      env.decision.reasonCodes,
      ['DELEGATION_UNKNOWN_GRANT'],
      'a foreign-tenant grant is indistinguishable from an unknown grant (no existence leak)',
    );
  });

  it('operation subset: a grant for docs/read does not cover docs/write (DELEGATION_SCOPE_OPERATION)', async () => {
    const delegatee = nextId('op');
    const session = await mintSession(delegatee);
    const grant = await grantDelegation(delegatee, activeDigest);
    const env = await gate.decideAsync(
      delRequest(session, grant.id, { tool: OP_WRITE.tool, operation: OP_WRITE.operation }),
    );
    assert.equal(env.decision.decision, 'DENY');
    assert.deepEqual(env.decision.reasonCodes, ['DELEGATION_SCOPE_OPERATION']);
  });

  it('target subset: a grant covering system `docs` does not cover a `crm` target (DELEGATION_SCOPE_TARGET)', async () => {
    const delegatee = nextId('tgt');
    const session = await mintSession(delegatee);
    // The grant's target scope is an exact copy of the delegator's registered
    // `docs` target (the store only accepts exact-or-`*` target subsets at
    // grant time — conservative narrowing; glob re-narrowing is not inferred).
    const grant = await grantDelegation(delegatee, activeDigest);
    const env = await gate.decideAsync(
      delRequest(session, grant.id, { target: { system: 'crm', resource: 'res-1' } }),
    );
    assert.equal(env.decision.decision, 'DENY');
    assert.deepEqual(env.decision.reasonCodes, ['DELEGATION_SCOPE_TARGET']);
  });

  it('classification ceiling: a CONFIDENTIAL request under an INTERNAL grant denies (DELEGATION_SCOPE_CLASSIFICATION)', async () => {
    const delegatee = nextId('cls');
    const session = await mintSession(delegatee);
    const grant = await grantDelegation(delegatee, activeDigest);
    const env = await gate.decideAsync(delRequest(session, grant.id, { dataClassification: 'CONFIDENTIAL' }));
    assert.equal(env.decision.decision, 'DENY');
    assert.deepEqual(env.decision.reasonCodes, ['DELEGATION_SCOPE_CLASSIFICATION']);
  });

  it('expiry: a grant past its window denies DELEGATION_EXPIRED', async () => {
    const delegatee = nextId('exp');
    const session = await mintSession(delegatee);
    const grant = await grantDelegation(delegatee, activeDigest, { constraints: { maxAgeMs: 5_000 } });
    now += 6_000;
    const env = await gate.decideAsync(delRequest(session, grant.id));
    assert.equal(env.decision.decision, 'DENY');
    assert.deepEqual(env.decision.reasonCodes, ['DELEGATION_EXPIRED']);
  });

  it('revocation: the NEXT decision denies DELEGATION_REVOKED (no stale grant)', async () => {
    const delegatee = nextId('rev');
    const session = await mintSession(delegatee);
    const grant = await grantDelegation(delegatee, activeDigest);
    const before = await gate.decideAsync(delRequest(session, grant.id));
    assert.equal(before.decision.decision, 'ALLOW');

    await delegation.revokeDelegation(
      { delegationId: grant.id, tenantId: TENANT, scope: 'tenant', revokedBy: 'user:admin', reason: 'p2-s4 revocation probe' },
      now,
    );
    const after = await gate.decideAsync(delRequest(session, grant.id));
    assert.equal(after.decision.decision, 'DENY');
    assert.deepEqual(after.decision.reasonCodes, ['DELEGATION_REVOKED']);
  });

  it('chain integrity (A-16): rotating the delegator manifest after the grant denies DELEGATION_DELEGATOR_AUTHORITY_CHANGED', async () => {
    const delegatee = nextId('chain');
    const session = await mintSession(delegatee);
    const grant = await grantDelegation(delegatee, chainDigest, { capabilityId: CAP_CHAIN });
    const before = await gate.decideAsync(
      delRequest(session, grant.id, { capability: { capabilityId: CAP_CHAIN, capabilityVersion: '1' } }),
    );
    assert.equal(before.decision.decision, 'ALLOW');

    // Rotate: version 2 (same shape) becomes ACTIVE; the cited v1 digest is
    // no longer live ⇒ the grant's chain[0] no longer matches.
    await store.registerManifestVersion(
      durableManifest(CAP_CHAIN, {
        version: '2',
        allowedOperations: [OP, OP_WRITE],
        allowedTargets: [{ system: 'docs', resourcePattern: 'res-*' }],
        maxDataClassification: 'RESTRICTED',
      }),
      registrar(TENANT),
    );
    const env = await gate.decideAsync(
      delRequest(session, grant.id, { capability: { capabilityId: CAP_CHAIN, capabilityVersion: '2' } }),
    );
    assert.equal(env.decision.decision, 'DENY');
    assert.deepEqual(env.decision.reasonCodes, ['DELEGATION_DELEGATOR_AUTHORITY_CHANGED']);
  });

  it('one-shot: after enforcement consumes the grant, the NEXT decision denies DELEGATION_CONSUMED', async () => {
    const delegatee = nextId('oneshot');
    const session = await mintSession(delegatee);
    const grant = await grantDelegation(delegatee, activeDigest, { oneShot: true, useCount: undefined });

    const req = delRequest(session, grant.id);
    const envelope = await gate.decideAsync(req);
    assert.equal(envelope.decision.decision, 'ALLOW');

    let ran = false;
    await gate.executeAuthorized(
      envelope,
      async () => {
        ran = true;
        return 'side-effect';
      },
      { tool: OP.tool, operation: OP.operation, targetResource: req.target.resource },
    );
    assert.equal(ran, true, 'the side effect ran once');

    const next = await gate.decideAsync(delRequest(session, grant.id));
    assert.equal(next.decision.decision, 'DENY');
    assert.deepEqual(next.decision.reasonCodes, ['DELEGATION_CONSUMED']);
  });

  it('replay: executing the SAME envelope twice fails closed (no duplicate side effect)', async () => {
    const delegatee = nextId('replay');
    const session = await mintSession(delegatee);
    const grant = await grantDelegation(delegatee, activeDigest);

    const req = delRequest(session, grant.id);
    const envelope = await gate.decideAsync(req);
    assert.equal(envelope.decision.decision, 'ALLOW');

    let calls = 0;
    await gate.executeAuthorized(
      envelope,
      async () => {
        calls += 1;
        return 'first';
      },
      { tool: OP.tool, operation: OP.operation, targetResource: req.target.resource },
    );
    assert.equal(calls, 1);
    await assert.rejects(
      () =>
        gate.executeAuthorized(
          envelope,
          async () => {
            calls += 1;
            return 'second';
          },
          { tool: OP.tool, operation: OP.operation, targetResource: req.target.resource },
        ),
    );
    assert.equal(calls, 1, 'the duplicate envelope never re-executed the side effect');
  });

  it('enforcement re-validation: a revocation after decide denies BEFORE the side effect', async () => {
    const delegatee = nextId('enf');
    const session = await mintSession(delegatee);
    const grant = await grantDelegation(delegatee, activeDigest);

    const req = delRequest(session, grant.id);
    const envelope = await gate.decideAsync(req);
    assert.equal(envelope.decision.decision, 'ALLOW');

    await delegation.revokeDelegation(
      { delegationId: grant.id, tenantId: TENANT, scope: 'tenant', revokedBy: 'user:admin', reason: 'p2-s4 enforcement re-validation probe' },
      now,
    );

    let ran = false;
    await assert.rejects(
      () =>
        gate.executeAuthorized(
          envelope,
          async () => {
            ran = true;
            return 'side-effect';
          },
          { tool: OP.tool, operation: OP.operation, targetResource: req.target.resource },
        ),
      (error: unknown) => {
        const reasons = (error as { reasons?: readonly string[] } | undefined)?.reasons;
        assert.ok(reasons?.includes('DELEGATION_REVOKED'), `revocation re-validation must cite REVOKED, got ${String(reasons)}`);
        return true;
      },
    );
    assert.equal(ran, false, 'the side effect never ran after the revocation');
  });

  it('restart re-read: a second gate over the SAME PostgreSQL reads the same durable grant', async () => {
    const delegatee = nextId('restart');
    const session = await mintSession(delegatee);
    const grant = await grantDelegation(delegatee, activeDigest);

    const { storage } = await bootR2StorageKernel(pg.connectionString);
    const store2 = await SecurityStateStore.open(storage, { now: clock });
    const delegation2 = await DelegationStore.open(storage);
    const broker = new DurableCredentialBroker(store2, new InMemoryCredentialMaterialProvider(), { now: clock });
    const gate2 = new AuthorizationGate({
      store: store2,
      durableBroker: broker,
      audit: new InMemoryAuditSink(),
      now: clock,
      delegationAuthorityResolver: () => delegation2.asStateAuthority(),
    });
    const env = await gate2.decideAsync(delRequest(session, grant.id));
    assert.equal(env.decision.decision, 'ALLOW', 'the grant is authoritative durable state, not process-local');
    assert.equal(env.delegationStatus, 'VALID');
  });
});
