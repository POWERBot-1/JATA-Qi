// P2-S3 — the durable Privileged Access Plane: elevation store + A-01
// privilege stage + register classification + first-elevation bootstrap +
// enforcement re-validation (spec §9, §14, §24-S3; A-07/A-13/A-16/A-24/A-26
// privilege subset). Real PostgreSQL; fail-hard: if embedded PostgreSQL
// cannot start, before() rejects and the suite FAILS (no skip).
//
// Covered:
//   * A-07 (escalation): an ordinary principal attempting a register
//     operation with NO elevation ⇒ DENY PRIVILEGE_ELEVATION_REQUIRED; a
//     tenant-scoped elevation attempted on a platform op ⇒ DENY
//     PRIVILEGE_SCOPE_MISMATCH.
//   * A-13 (admin impersonation): a principal carrying the commercial
//     `admin` role string but NO elevation is denied — privilege derives
//     from durable state, never from a role string.
//   * A-26 (step-up staleness): a covering elevation whose step-up evidence
//     is stale ⇒ DENY STEP_UP_STALE; fresh ⇒ ALLOW (pair assertion).
//   * session binding: an elevation bound to session A presented with
//     session B ⇒ DENY PRIVILEGE_SESSION_MISMATCH.
//   * tenant isolation: an `acme` elevation is unusable for an `other`
//     request (the tenant-scoped re-read cannot see it ⇒ REQUIRED).
//   * revocation: a VALID decision, then durable revocation ⇒ the NEXT
//     decision denies PRIVILEGE_ELEVATION_REVOKED (no stale elevation); the
//     same revocation re-validated at enforcement denies before the side
//     effect.
//   * expiry: a covering elevation past its window ⇒ DENY
//     PRIVILEGE_ELEVATION_EXPIRED.
//   * fail-closed: a gate WITHOUT a privilege authority ⇒
//     PRIVILEGE_CHECK_UNAVAILABLE (no ambient authority).
//   * bootstrap exactly-one-winner: concurrent + cross-process activation
//     of the first elevation — exactly one wins, the rest fail closed.
//   * platform scope: a platform-admin elevation authorizes a platform op
//     (system-scope read); the envelope cites the durable elevation.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AuthenticationEventStore,
  PrivilegeStore,
  PRIVILEGED_OPERATION_REGISTER,
  assertRegisterIntegrity,
  type PrivilegeElevationDoc,
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
let privilege: PrivilegeStore;
let audit: InMemoryAuditSink;
let gate: AuthorizationGate;

let now: number;
const T0 = Date.now();
let seq = 0;
const nextId = (prefix: string): string => `${prefix}-${process.pid}-${++seq}`;
const clock = (): number => now;

const TENANT = 'acme';
const OTHER = 'other';
const PLATFORM_TENANT = 'system';
const CAP_TENANT = 'cap.p2s3.plan';
const CAP_OTHER = 'cap.p2s3.plan.other';
const CAP_PLATFORM = 'cap.p2s3.cross';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const TENANT_OP = { tool: 'billing', operation: 'plan.create' };
const PLATFORM_OP = { tool: 'billing', operation: 'read.cross-tenant' };

async function mintSession(principalId: string, tenantId = TENANT): Promise<{ eventId: string; tenantId: string; principalId: string }> {
  const eventId = `evt-${nextId('s3')}`;
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

function privRequest(
  capabilityId: string,
  session: { eventId: string; tenantId: string; principalId: string },
  tool: string,
  operation: string,
  overrides: Record<string, unknown> = {},
): A01AuthorizationRequest {
  return baseRequest({
    principal: {
      id: session.principalId,
      tenantId: session.tenantId,
      roles: overrides.roles ?? ['operator'],
      authenticationMethod: 'STATIC_TOKEN',
      authenticationEventId: session.eventId,
    },
    tenantId: session.tenantId,
    capability: { capabilityId, capabilityVersion: '1' },
    tool,
    operation,
    target: { system: 'billing', resource: `res-${nextId('t')}` },
    ...overrides,
  });
}

/** Grant a tenant-admin elevation for `principalId` bound to `session`. */
async function grantTenantAdmin(
  principalId: string,
  sessionEventId: string,
  tenantId: string,
  opts: { stepUpAt?: number; lifetimeMs?: number } = {},
): Promise<PrivilegeElevationDoc> {
  return privilege.grantElevation(
    {
      principalId,
      tenantId,
      scope: 'tenant',
      planeRole: 'tenant-admin',
      operationClasses: ['tenant-admin'],
      sessionEventId,
      stepUpEventId: `stepup-${nextId('s3')}`,
      stepUpAt: opts.stepUpAt ?? now,
      grantedBy: 'kernel:bootstrap',
      grantorPrincipalId: 's3-tenant-admin-bootstrap',
      grantorSessionEventId: 'kernel:bootstrap',
      reason: 'p2-s3 tenant-admin elevation under test',
      ...(opts.lifetimeMs !== undefined ? { lifetimeMs: opts.lifetimeMs } : {}),
    },
    now,
  );
}

/** Grant a platform-admin elevation for `principalId` bound to `session`. */
async function grantPlatformAdmin(principalId: string, sessionEventId: string): Promise<PrivilegeElevationDoc> {
  return privilege.grantElevation(
    {
      principalId,
      tenantId: PLATFORM_TENANT,
      scope: 'platform',
      planeRole: 'platform-admin',
      operationClasses: ['platform-admin'],
      sessionEventId,
      stepUpEventId: `stepup-${nextId('s3')}`,
      stepUpAt: now,
      grantedBy: 'kernel:bootstrap',
      grantorPrincipalId: 's3-platform-admin-bootstrap',
      grantorSessionEventId: 'kernel:bootstrap',
      reason: 'p2-s3 platform-admin elevation under test',
    },
    now,
  );
}

before(async () => {
  now = T0;
  pg = await bootR2Postgres('p2s3priv', 58600);
  const { storage } = await bootR2StorageKernel(pg.connectionString);
  store = await SecurityStateStore.open(storage, { now: clock });
  sessions = await AuthenticationEventStore.open(storage);
  privilege = await PrivilegeStore.open(storage);
  audit = new InMemoryAuditSink();
  const provider = new InMemoryCredentialMaterialProvider();
  const broker = new DurableCredentialBroker(store, provider, { now: clock });
  gate = new AuthorizationGate({
    store,
    durableBroker: broker,
    audit,
    now: clock,
    privilegeAuthorityResolver: () => privilege.asStateAuthority(),
  });
  await store.registerManifestVersion(
    durableManifest(CAP_TENANT, {
      allowedOperations: [TENANT_OP],
      allowedTargets: [{ system: 'billing', resourcePattern: 'res-*' }],
    }),
    registrar(TENANT),
  );
  await store.registerManifestVersion(
    durableManifest(CAP_OTHER, {
      allowedOperations: [TENANT_OP],
      allowedTargets: [{ system: 'billing', resourcePattern: 'res-*' }],
      tenantScopes: [OTHER],
    }),
    registrar(OTHER),
  );
  await store.registerManifestVersion(
    durableManifest(CAP_PLATFORM, {
      allowedOperations: [PLATFORM_OP],
      allowedTargets: [{ system: 'billing', resourcePattern: 'res-*' }],
    }),
    registrar(TENANT),
  );
  // One-time bootstraps: the acme tenant security-admin and the platform
  // security-admin (the cutover runbook provisions both — spec §21.4).
  await privilege.bootstrapFirstElevation(
    { principalId: 's3-tenant-admin-bootstrap', tenantId: TENANT, reason: 'p2-s3 tenant bootstrap (test)' },
    now,
  );
  await privilege.bootstrapFirstElevation(
    { principalId: 's3-platform-admin-bootstrap', tenantId: PLATFORM_TENANT, scope: 'platform', reason: 'p2-s3 platform bootstrap (test)' },
    now,
  );
});

after(async () => {
  await pg.stop();
});

function runBootstrapWorker(principalId: string, tenantId: string, scope?: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [
        path.join(HERE, 'p2-s3-bootstrap-worker.mjs'),
        pg.connectionString,
        principalId,
        tenantId,
        ...(scope ? [scope] : []),
      ],
      { timeout: 60_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`bootstrap worker failed: ${error.message} :: ${stderr}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>);
        } catch {
          reject(new Error(`bootstrap worker printed non-JSON: ${stdout} :: ${stderr}`));
        }
      },
    );
  });
}

describe('P2-S3 privileged access plane (real PostgreSQL)', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg, 'P2-S3 requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
  });

  it('A-07: an ordinary principal with NO elevation is denied PRIVILEGE_ELEVATION_REQUIRED', async () => {
    const alice = nextId('alice');
    const session = await mintSession(alice);
    const env = await gate.decideAsync(privRequest(CAP_TENANT, session, TENANT_OP.tool, TENANT_OP.operation));
    assert.equal(env.decision.decision, 'DENY');
    assert.deepEqual(env.decision.reasonCodes, ['PRIVILEGE_ELEVATION_REQUIRED'], 'the privilege stage denies before the PDP');
  });

  it('A-13: a commercial `admin` role string confers NO privilege (no elevation ⇒ deny)', async () => {
    const mallory = nextId('mallory');
    const session = await mintSession(mallory);
    const env = await gate.decideAsync(
      privRequest(CAP_TENANT, session, TENANT_OP.tool, TENANT_OP.operation, { roles: ['admin', 'global_admin'] }),
    );
    assert.equal(env.decision.decision, 'DENY');
    assert.deepEqual(env.decision.reasonCodes, ['PRIVILEGE_ELEVATION_REQUIRED'], 'a role string is never durable authority');
  });

  it('a VALID tenant-admin elevation ALLOWs and the envelope cites the durable elevation', async () => {
    const bob = nextId('bob');
    const session = await mintSession(bob);
    const elevation = await grantTenantAdmin(bob, session.eventId, TENANT);
    const env = await gate.decideAsync(privRequest(CAP_TENANT, session, TENANT_OP.tool, TENANT_OP.operation));
    assert.equal(env.decision.decision, 'ALLOW', `expected ALLOW, got [${[...env.decision.reasonCodes].join(', ')}]`);
    assert.equal(env.privilegeElevationId, elevation.id, 'the sealed envelope cites the elevation id');
    assert.equal(env.privilegeOperationClass, 'tenant-admin');
    assert.equal(env.privilegeStatus, 'ACTIVE');
  });

  it('session binding: an elevation bound to session A denies with PRIVILEGE_SESSION_MISMATCH for session B', async () => {
    const carol = nextId('carol');
    const sessionA = await mintSession(carol);
    await grantTenantAdmin(carol, sessionA.eventId, TENANT);
    // A SECOND, distinct live session for the same principal.
    const sessionB = await mintSession(carol);
    const env = await gate.decideAsync(privRequest(CAP_TENANT, sessionB, TENANT_OP.tool, TENANT_OP.operation));
    assert.equal(env.decision.decision, 'DENY');
    assert.deepEqual(env.decision.reasonCodes, ['PRIVILEGE_SESSION_MISMATCH']);
  });

  it('tenant isolation: an acme elevation is unusable for an `other` request (denied, never cross-tenant)', async () => {
    const dave = nextId('dave');
    const acmeSession = await mintSession(dave, TENANT);
    await grantTenantAdmin(dave, acmeSession.eventId, TENANT);
    const otherSession = await mintSession(dave, OTHER);
    const env = await gate.decideAsync(privRequest(CAP_OTHER, otherSession, TENANT_OP.tool, TENANT_OP.operation));
    assert.equal(env.decision.decision, 'DENY');
    assert.deepEqual(
      env.decision.reasonCodes,
      ['PRIVILEGE_ELEVATION_REQUIRED'],
      'the acme elevation is invisible to the other-tenant re-read (RLS-bound)',
    );
  });

  it('A-07 scope: a tenant-scoped platform-admin elevation for a platform op denies PRIVILEGE_SCOPE_MISMATCH', async () => {
    const eve = nextId('eve');
    const session = await mintSession(eve);
    // A platform-admin role held at TENANT scope (spec §9.1: a platform-admin
    // acting inside a tenant holds a tenant elevation) must NOT satisfy a
    // PLATFORM-scoped requirement.
    await privilege.grantElevation(
      {
        principalId: eve,
        tenantId: TENANT,
        scope: 'tenant',
        planeRole: 'platform-admin',
        operationClasses: ['platform-admin'],
        sessionEventId: session.eventId,
        stepUpEventId: `stepup-${nextId('s3')}`,
        stepUpAt: now,
        grantedBy: 'kernel:bootstrap',
        grantorPrincipalId: 's3-tenant-admin-bootstrap',
        grantorSessionEventId: 'kernel:bootstrap',
        reason: 'p2-s3 tenant-scoped platform-admin (scope mismatch probe)',
      },
      now,
    );
    const env = await gate.decideAsync(privRequest(CAP_PLATFORM, session, PLATFORM_OP.tool, PLATFORM_OP.operation));
    assert.equal(env.decision.decision, 'DENY');
    assert.deepEqual(env.decision.reasonCodes, ['PRIVILEGE_SCOPE_MISMATCH']);
  });

  it('a VALID platform-admin elevation ALLOWs a platform operation (system-scope read)', async () => {
    const frank = nextId('frank');
    const session = await mintSession(frank);
    const elevation = await grantPlatformAdmin(frank, session.eventId);
    const env = await gate.decideAsync(privRequest(CAP_PLATFORM, session, PLATFORM_OP.tool, PLATFORM_OP.operation));
    assert.equal(env.decision.decision, 'ALLOW', `expected ALLOW, got [${[...env.decision.reasonCodes].join(', ')}]`);
    assert.equal(env.privilegeElevationId, elevation.id);
    assert.equal(env.privilegeOperationClass, 'platform-admin');
    assert.equal(env.privilegeStatus, 'ACTIVE');
  });

  it('A-26: a covering elevation with stale step-up evidence denies STEP_UP_STALE; fresh ALLOWs', async () => {
    const grace = nextId('grace');
    const session = await mintSession(grace);
    // Stale step-up evidence (age > DEFAULT_STEP_UP_MAX_AGE_MS) — the grant
    // itself only refuses FUTURE step-up, so this is admit-at-grant/deny-at-use.
    await grantTenantAdmin(grace, session.eventId, TENANT, { stepUpAt: now - 16 * 60_000 });
    const stale = await gate.decideAsync(privRequest(CAP_TENANT, session, TENANT_OP.tool, TENANT_OP.operation));
    assert.equal(stale.decision.decision, 'DENY');
    assert.deepEqual(stale.decision.reasonCodes, ['STEP_UP_STALE']);

    // Fresh step-up for the same principal: a new elevation reads VALID.
    const heidi = nextId('heidi');
    const session2 = await mintSession(heidi);
    await grantTenantAdmin(heidi, session2.eventId, TENANT, { stepUpAt: now });
    const fresh = await gate.decideAsync(privRequest(CAP_TENANT, session2, TENANT_OP.tool, TENANT_OP.operation));
    assert.equal(fresh.decision.decision, 'ALLOW');
  });

  it('revocation: the NEXT decision denies PRIVILEGE_ELEVATION_REVOKED (no stale elevation)', async () => {
    const ivan = nextId('ivan');
    const session = await mintSession(ivan);
    const elevation = await grantTenantAdmin(ivan, session.eventId, TENANT);
    const before = await gate.decideAsync(privRequest(CAP_TENANT, session, TENANT_OP.tool, TENANT_OP.operation));
    assert.equal(before.decision.decision, 'ALLOW');

    await privilege.revokeElevation(
      {
        elevationId: elevation.id,
        tenantId: TENANT,
        scope: 'tenant',
        revokedBy: 's3-tenant-admin-bootstrap',
        revokerSessionEventId: 'kernel:bootstrap',
        reason: 'p2-s3 revocation probe',
      },
      now,
    );
    const after = await gate.decideAsync(privRequest(CAP_TENANT, session, TENANT_OP.tool, TENANT_OP.operation));
    assert.equal(after.decision.decision, 'DENY');
    assert.deepEqual(after.decision.reasonCodes, ['PRIVILEGE_ELEVATION_REVOKED']);
  });

  it('enforcement re-validation: a revocation after decide denies BEFORE the side effect', async () => {
    const judy = nextId('judy');
    const session = await mintSession(judy);
    const elevation = await grantTenantAdmin(judy, session.eventId, TENANT);
    const envelope = await gate.decideAsync(privRequest(CAP_TENANT, session, TENANT_OP.tool, TENANT_OP.operation));
    assert.equal(envelope.decision.decision, 'ALLOW');

    await privilege.revokeElevation(
      {
        elevationId: elevation.id,
        tenantId: TENANT,
        scope: 'tenant',
        revokedBy: 's3-tenant-admin-bootstrap',
        revokerSessionEventId: 'kernel:bootstrap',
        reason: 'p2-s3 enforcement re-validation probe',
      },
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
          { tool: TENANT_OP.tool, operation: TENANT_OP.operation },
        ),
      (error: unknown) => {
        const reasons = (error as { reasons?: readonly string[] } | undefined)?.reasons;
        assert.ok(reasons?.includes('PRIVILEGE_ELEVATION_REVOKED'), `revocation re-validation must cite REVOKED, got ${String(reasons)}`);
        return true;
      },
    );
    assert.equal(ran, false, 'the side effect never ran after the revocation');
  });

  it('expiry: a covering elevation past its window denies PRIVILEGE_ELEVATION_EXPIRED', async () => {
    const kurt = nextId('kurt');
    const session = await mintSession(kurt);
    await grantTenantAdmin(kurt, session.eventId, TENANT, { lifetimeMs: 5_000 });
    now += 6_000; // advance past the 5s window (deny-early skew applies)
    const env = await gate.decideAsync(privRequest(CAP_TENANT, session, TENANT_OP.tool, TENANT_OP.operation));
    assert.equal(env.decision.decision, 'DENY');
    assert.deepEqual(env.decision.reasonCodes, ['PRIVILEGE_ELEVATION_EXPIRED']);
  });

  it('fail-closed: a gate WITHOUT a privilege authority denies PRIVILEGE_CHECK_UNAVAILABLE', async () => {
    const provider = new InMemoryCredentialMaterialProvider();
    const broker = new DurableCredentialBroker(store, provider, { now: clock });
    const bareGate = new AuthorizationGate({ store, durableBroker: broker, audit, now: clock });
    const lana = nextId('lana');
    const session = await mintSession(lana);
    const env = await bareGate.decideAsync(privRequest(CAP_TENANT, session, TENANT_OP.tool, TENANT_OP.operation));
    assert.equal(env.decision.decision, 'DENY');
    assert.deepEqual(env.decision.reasonCodes, ['PRIVILEGE_CHECK_UNAVAILABLE'], 'no ambient authority may satisfy a privileged operation');
  });

  it('bootstrap exactly-one-winner: concurrent activation for the same (tenant, scope) yields ONE winner', async () => {
    const tenant = `boot-${process.pid}-${++seq}`;
    const principal = nextId('boot-admin');
    const [a, b] = await Promise.allSettled([
      privilege.bootstrapFirstElevation({ principalId: principal, tenantId: tenant, reason: 'race-a' }, now),
      privilege.bootstrapFirstElevation({ principalId: principal, tenantId: tenant, reason: 'race-b' }, now),
    ]);
    const winners = [a, b].filter((r) => r.status === 'fulfilled');
    const losers = [a, b].filter((r) => r.status === 'rejected');
    assert.equal(winners.length, 1, 'exactly one concurrent activation wins');
    assert.equal(losers.length, 1);
    const loserError = losers[0] as PromiseRejectedResult;
    assert.match(String(loserError.reason), /BOOTSTRAP_ALREADY_USED/);
  });

  it('bootstrap exactly-one-winner across SEPARATE processes (real PostgreSQL)', async () => {
    const tenant = `bootmp-${process.pid}-${++seq}`;
    const principal = nextId('boot-mp');
    const results = await Promise.all([
      runBootstrapWorker(principal, tenant),
      runBootstrapWorker(principal, tenant),
    ]);
    const winners = results.filter((r) => r.ok === true);
    const losers = results.filter((r) => r.ok === false);
    assert.equal(winners.length, 1, 'exactly one process wins the first-elevation bootstrap');
    assert.equal(losers.length, 1);
    const loser = losers[0];
    assert.equal(loser?.code, 'BOOTSTRAP_ALREADY_USED');
  });

  it('platform + tenant bootstraps are distinct one-shots (scope separates the winners)', async () => {
    const tenant = `bootscope-${process.pid}-${++seq}`;
    const principal = nextId('boot-scope');
    // Tenant bootstrap + platform bootstrap for the SAME tenant string are
    // independent single-winner slots (the marker keys on scope + tenant).
    const tenantBootstrap = await privilege.bootstrapFirstElevation({ principalId: principal, tenantId: tenant, reason: 'tenant scope' }, now);
    const platformBootstrap = await privilege.bootstrapFirstElevation({ principalId: principal, tenantId: tenant, scope: 'platform', reason: 'platform scope' }, now);
    assert.equal(tenantBootstrap.scope, 'tenant');
    assert.equal(platformBootstrap.scope, 'platform');
    assert.equal(tenantBootstrap.tenantId, tenant);
    assert.equal(platformBootstrap.tenantId, PLATFORM_TENANT);
    assert.notEqual(tenantBootstrap.id, platformBootstrap.id);
  });

  it('restart re-read: a second store over the SAME PostgreSQL reads the same durable elevation', async () => {
    const nina = nextId('nina');
    const session = await mintSession(nina);
    const elevation = await grantTenantAdmin(nina, session.eventId, TENANT);
    // "Restart": a brand-new PrivilegeStore + gate over the same durable
    // substrate (no process-local state carried over).
    const { storage } = await bootR2StorageKernel(pg.connectionString);
    const store2 = await PrivilegeStore.open(storage);
    const store2sec = await SecurityStateStore.open(storage, { now: clock });
    const broker = new DurableCredentialBroker(store2sec, new InMemoryCredentialMaterialProvider(), { now: clock });
    const gate2 = new AuthorizationGate({
      store: store2sec,
      durableBroker: broker,
      audit: new InMemoryAuditSink(),
      now: clock,
      privilegeAuthorityResolver: () => store2.asStateAuthority(),
    });
    const capabilityId = `${CAP_TENANT}.restart.${++seq}`;
    await store2sec.registerManifestVersion(
      durableManifest(capabilityId, {
        allowedOperations: [TENANT_OP],
        allowedTargets: [{ system: 'billing', resourcePattern: 'res-*' }],
      }),
      registrar(TENANT),
    );
    const env = await gate2.decideAsync(privRequest(capabilityId, session, TENANT_OP.tool, TENANT_OP.operation));
    assert.equal(env.decision.decision, 'ALLOW', 'the restarted store still honors the durable elevation');
    assert.equal(env.privilegeElevationId, elevation.id);
  });

  it('register integrity: the register covers PO-1…PO-8 and is internally consistent (P2-INV-10)', () => {
    const result = assertRegisterIntegrity();
    assert.equal(result.ok, true);
    const pos = PRIVILEGED_OPERATION_REGISTER.map((entry) => entry.po);
    for (const po of ['PO-1', 'PO-2', 'PO-3', 'PO-4', 'PO-5', 'PO-6', 'PO-7', 'PO-8']) {
      assert.ok(pos.includes(po), `PO coverage ${po} present in the register`);
    }
  });
});
