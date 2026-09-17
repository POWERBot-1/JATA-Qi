// P2-S8 — P2-extended decisions under store outage (A-19, spec §15) over
// real PostgreSQL. Fail-hard: embedded-PostgreSQL boot failure FAILS the
// suite (no skip).
//
// R2 proved that a plain durable decision fails closed with
// SECURITY_STATE_UNAVAILABLE under outage. This suite proves the same
// contract for the P2-extended pipeline on the final artifact: decisions
// through the PRIVILEGE stage (elevation required) and the DELEGATION stage
// (grant reference) DENY with SECURITY_STATE_UNAVAILABLE while the store is
// unreachable (never ALLOW, never a privilege/delegation verdict from
// memory), a pre-outage ALLOW envelope executes no side effect, and all
// three decision classes ALLOW again after recovery.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthenticationEventStore,
  DelegationStore,
  IdentityStore,
  PrivilegeStore,
  type DelegationDoc,
  type PrivilegeElevationDoc,
} from '@jataqi/authentication';
import type { PostgresDriver } from '@jataqi/storage-postgres';
import {
  AuthorizationDeniedError,
  AuthorizationGate,
  DurableCredentialBroker,
  InMemoryAuditSink,
  InMemoryCredentialMaterialProvider,
  SecurityStateStore,
  type A01AuthorizationEnvelope,
  type A01AuthorizationRequest,
} from '../src/index.js';
import { baseRequest } from './helpers.js';
import { bootR2Postgres, bootR2StorageKernel, type R2Postgres } from './r2-pg.js';
import { durableManifest, registrar } from './r2-fixtures.js';

let pg: R2Postgres;
let driver: PostgresDriver;
let store: SecurityStateStore;
let sessions: AuthenticationEventStore;
let privilege: PrivilegeStore;
let delegation: DelegationStore;
let gate: AuthorizationGate;

let now: number;
const T0 = Date.now();
let seq = 0;
const nextId = (prefix: string): string => `${prefix}-${process.pid}-${++seq}`;
const clock = (): number => now;

const TENANT = `s8dec-${process.pid}`;
const CAP_PRIV = 'cap.p2s8.priv';
const CAP_DEL = 'cap.p2s8.delegate';
const TENANT_OP = { tool: 'billing', operation: 'plan.create' };
const DEL_OP = { tool: 'docs', operation: 'read' };
const DEL_OP_WRITE = { tool: 'docs', operation: 'write' };

let activeDigest = '';
let stashedEnvelope: A01AuthorizationEnvelope | undefined;

function deniedReasons(error: unknown): readonly string[] {
  assert.ok(
    error instanceof AuthorizationDeniedError,
    `expected AuthorizationDeniedError, got ${error instanceof Error ? error.message : String(error)}`,
  );
  return error.reasons;
}

/** Outage decisions must DENY (never ALLOW), and deny FAST: an unbounded
 *  hang during an outage is itself a fail-closed violation. */
async function deniesSoon(label: string, fn: () => Promise<unknown>): Promise<unknown> {
  const outcome = await Promise.race([
    fn().then(
      (value) => ({ resolved: true as const, value }),
      (error: unknown) => ({ resolved: false as const, error }),
    ),
    new Promise<'TIMEOUT'>((resolve) => setTimeout(() => resolve('TIMEOUT'), 15_000)),
  ]);
  assert.notEqual(outcome, 'TIMEOUT', `${label} must fail fast while the store is unreachable (no unbounded hang)`);
  assert.ok(outcome !== 'TIMEOUT' && !outcome.resolved, `${label} must not ALLOW while the store is unreachable`);
  return (outcome as { error: unknown }).error;
}

async function mintSession(principalId: string): Promise<{ eventId: string; tenantId: string; principalId: string }> {
  const eventId = `evt-${nextId('s8')}`;
  await sessions.recordEvent({ eventId, tenantId: TENANT, principalId, method: 'STATIC_TOKEN', verifiedAt: now, expiresAt: now + 3_600_000 }, now);
  return { eventId, tenantId: TENANT, principalId };
}

function privRequest(session: { eventId: string; tenantId: string; principalId: string }): A01AuthorizationRequest {
  return baseRequest({
    principal: {
      id: session.principalId,
      tenantId: session.tenantId,
      roles: ['operator'],
      authenticationMethod: 'STATIC_TOKEN',
      authenticationEventId: session.eventId,
    },
    tenantId: session.tenantId,
    capability: { capabilityId: CAP_PRIV, capabilityVersion: '1' },
    tool: TENANT_OP.tool,
    operation: TENANT_OP.operation,
    target: { system: 'billing', resource: `res-${nextId('t')}` },
  });
}

function delRequest(
  session: { eventId: string; tenantId: string; principalId: string },
  delegationId: string,
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
    capability: { capabilityId: CAP_DEL, capabilityVersion: '1' },
    tool: DEL_OP.tool,
    operation: DEL_OP.operation,
    target: { system: 'docs', resource: `res-${nextId('t')}` },
    dataClassification: 'INTERNAL',
    impact: 'REVERSIBLE_WRITE',
    delegation: { delegationId },
  });
}

async function grantTenantAdmin(principalId: string, sessionEventId: string): Promise<PrivilegeElevationDoc> {
  return privilege.grantElevation(
    {
      principalId,
      tenantId: TENANT,
      scope: 'tenant',
      planeRole: 'tenant-admin',
      operationClasses: ['tenant-admin'],
      sessionEventId,
      stepUpEventId: `stepup-${nextId('s8')}`,
      stepUpAt: now,
      grantedBy: 'kernel:bootstrap',
      grantorPrincipalId: 's8-decision-bootstrap',
      grantorSessionEventId: 'kernel:bootstrap',
      reason: 'p2-s8 decision outage seed',
    },
    now,
  );
}

async function grantDocsDelegation(delegateePrincipalId: string): Promise<DelegationDoc> {
  return delegation.grantDelegation(
    {
      delegatorPrincipalId: 'user:s8-delegator',
      delegateePrincipalId,
      tenantId: TENANT,
      scope: 'tenant',
      capability: { capabilityId: CAP_DEL, capabilityVersion: '1' },
      actions: [DEL_OP, DEL_OP_WRITE],
      targetScope: [{ system: 'docs', resourcePattern: 'res-*' }],
      constraints: { maxAgeMs: 3_600_000, classificationCeiling: 'INTERNAL', impactCeiling: 'EXTERNAL_SIDE_EFFECT' },
      chainDepth: 0,
      chain: [activeDigest],
      grantedBy: { principalId: 'user:s8-delegator', authenticationEventId: 'evt-s8-delegator' },
      oneShot: false,
      useCount: 50,
      delegatorEvidence: {
        manifestDigest: activeDigest,
        actions: [DEL_OP, DEL_OP_WRITE],
        targets: [{ system: 'docs', resourcePattern: 'res-*' }],
        classificationCeiling: 'RESTRICTED',
        impactCeiling: 'EXTERNAL_SIDE_EFFECT',
        requiresApproval: false,
      },
    },
    now,
  );
}

before(async () => {
  now = T0;
  pg = await bootR2Postgres('p2s8decout', 61200);
  const booted = await bootR2StorageKernel(pg.connectionString);
  driver = booted.driver;
  store = await SecurityStateStore.open(booted.storage, { now: clock });
  sessions = await AuthenticationEventStore.open(booted.storage);
  privilege = await PrivilegeStore.open(booted.storage);
  delegation = await DelegationStore.open(booted.storage);
  await IdentityStore.open(booted.storage);
  const audit = new InMemoryAuditSink();
  const provider = new InMemoryCredentialMaterialProvider();
  const broker = new DurableCredentialBroker(store, provider, { now: clock });
  gate = new AuthorizationGate({
    store,
    durableBroker: broker,
    audit,
    now: clock,
    privilegeAuthorityResolver: () => privilege.asStateAuthority(),
    delegationAuthorityResolver: () => delegation.asStateAuthority(),
  });
  await store.registerManifestVersion(
    durableManifest(CAP_PRIV, {
      allowedOperations: [TENANT_OP],
      allowedTargets: [{ system: 'billing', resourcePattern: 'res-*' }],
      tenantScopes: [TENANT],
    }),
    registrar(TENANT),
  );
  await store.registerManifestVersion(
    durableManifest(CAP_DEL, {
      allowedOperations: [DEL_OP, DEL_OP_WRITE],
      allowedTargets: [{ system: 'docs', resourcePattern: 'res-*' }],
      maxDataClassification: 'RESTRICTED',
      tenantScopes: [TENANT],
    }),
    registrar(TENANT),
  );
  const activeManifest = await store.getActiveManifest(CAP_DEL);
  assert.ok(activeManifest, 'CAP_DEL manifest registered');
  activeDigest = activeManifest.digest;
  await privilege.bootstrapFirstElevation(
    { principalId: 's8-decision-bootstrap', tenantId: TENANT, reason: 'p2-s8 decision bootstrap (test)' },
    now,
  );
});

after(async () => {
  if (pg) await pg.stop();
});

describe('P2-S8 P2-extended decisions under outage (A-19, real PostgreSQL)', () => {
  it('healthy baseline: privilege, delegation, and plain decisions all ALLOW', async () => {
    assert.ok(pg, 'P2-S8 requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
    const session = await mintSession('user:s8-dec');
    await grantTenantAdmin('user:s8-dec', session.eventId);
    const priv = await gate.decideAsync(privRequest(session));
    assert.equal(priv.decision.decision, 'ALLOW', `expected ALLOW, got [${[...priv.decision.reasonCodes].join(', ')}]`);
    const grant = await grantDocsDelegation('user:s8-dec');
    const del = await gate.decideAsync(delRequest(session, grant.id));
    assert.equal(del.decision.decision, 'ALLOW');
    stashedEnvelope = priv;
    assert.ok(driver.getPoolHealth().degraded === false);
  });

  it('A-19 outage: privilege/delegation/plain decisions DENY SECURITY_STATE_UNAVAILABLE (never ALLOW)', async () => {
    assert.ok(stashedEnvelope, 'baseline must stash an ALLOW envelope first');
    await pg.server.stop();
    try {
      // Privilege-stage decision.
      const privError = await deniesSoon('privilege decision', () =>
        gate.decideAsync(privRequest({ eventId: 'evt-s8-out-2', tenantId: TENANT, principalId: 'user:s8-dec' })),
      );
      assert.ok(deniedReasons(privError).includes('SECURITY_STATE_UNAVAILABLE'));
      // Delegation-stage decision.
      const delError = await deniesSoon('delegation decision', () =>
        gate.decideAsync(delRequest({ eventId: 'evt-s8-out-3', tenantId: TENANT, principalId: 'user:s8-dec' }, 'delegation-s8-outage')),
      );
      assert.ok(deniedReasons(delError).includes('SECURITY_STATE_UNAVAILABLE'));
      // A pre-outage ALLOW envelope executes no side effect.
      let effects = 0;
      const execError = await deniesSoon('pre-outage envelope execution', () =>
        gate.executeAuthorized(
          stashedEnvelope as A01AuthorizationEnvelope,
          async () => {
            effects += 1;
            return 'must-not-run';
          },
          { ...TENANT_OP },
        ),
      );
      assert.ok(deniedReasons(execError).includes('SECURITY_STATE_UNAVAILABLE'));
      assert.equal(effects, 0, 'no side effect may run while the authoritative store is unreachable');
      // No memory fallback: the gate stays durably attached.
      assert.ok(gate.securityStore, 'gate must remain durably attached during an outage (no silent R1 downgrade)');
    } finally {
      try {
        await pg.server.stop();
      } catch {
        /* already down is fine */
      }
      await pg.server.start();
    }
  });

  it('A-19 recovery: privilege and delegation decisions ALLOW again (no restart)', async () => {
    const deadline = Date.now() + 30_000;
    let priv: A01AuthorizationEnvelope | undefined;
    let del: A01AuthorizationEnvelope | undefined;
    for (;;) {
      try {
        const session = await mintSession('user:s8-rec');
        await grantTenantAdmin('user:s8-rec', session.eventId);
        const privCandidate = await gate.decideAsync(privRequest(session));
        const grant = await grantDocsDelegation('user:s8-rec');
        const delCandidate = await gate.decideAsync(delRequest(session, grant.id));
        if (privCandidate.decision.decision === 'ALLOW' && delCandidate.decision.decision === 'ALLOW') {
          priv = privCandidate;
          del = delCandidate;
          break;
        }
      } catch {
        // Still recovering — retry until the deadline (fail-hard below).
      }
      if (Date.now() >= deadline) assert.fail('store recovered but P2 decisions never ALLOWed again (fail-hard)');
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(priv, 'privilege decision recovered to ALLOW');
    assert.ok(del, 'delegation decision recovered to ALLOW');
    assert.equal(priv.decision.decision, 'ALLOW');
    assert.equal(del.decision.decision, 'ALLOW');
  });
});
