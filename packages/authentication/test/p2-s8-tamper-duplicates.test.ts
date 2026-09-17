// P2-S8 — audit tamper + duplicate/idempotency consolidation (A-22/A-23,
// spec §15/§17) over real PostgreSQL. Fail-hard: embedded-PostgreSQL boot
// failure FAILS the suite (no skip).
//
// A-22 (tamper):
//   1. A direct row mutation (extra field; material-shaped field) via a raw
//      storage write is REFUSED at the next store re-read (closed-schema
//      detection) — the poisoned row is durable but unusable.
//   2. The stores' own write paths refuse (or provably drop) unexpected
//      fields — nothing unshaped is persisted through the API.
//   3. Terminal records are immutable in-app (revoked elevation stays
//      REVOKED; bootstrap re-use refused; consumed one-shot stays CONSUMED).
//   4. No known secret material (static token, session token, TOTP secret)
//      appears in ANY durable P2 row across all identity/privilege/
//      delegation/MFA/break-glass collections.
//   HONEST LIMITATION (documented, not claimed): a SHAPE-VALID direct
//   database mutation (e.g. flipping a status string with raw SQL) is not
//   cryptographically detected — the integrity story is closed schemas +
//   CAS + RLS + append-only events (the P1-GAP-12 class: unkeyed digests are
//   tamper-evidence, not origin authenticity). Database-layer protection
//   (roles, audit) is P7 territory.
//
// A-23 (duplicates):
//   5. Enrollment is one-shot (ALREADY_ENROLLED); token import is idempotent
//      ('skipped') with rebind refusal.
//   6. One-shot delegation consumes exactly once: sequential double-use is
//      denied (CONSUMED) and 8 concurrent consumers yield exactly 1 winner.
//   7. Concurrent-session policy bounds double-mint (3 mints resolve, the
//      4th is refused under the default N=3 refuse-new policy).
//   8. Break-glass sequential re-activation is refused (BG_ONE_SHOT).
//   DOCUMENTED (not invented): grant/elevation ISSUANCE carries no
//   caller-supplied idempotency key — double-submit of identical grant input
//   mints two independent rows, and double-execution prevention lives at USE
//   time (one-shot CAS + consumed-envelope dedup, proven above and by S4 A-25).

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { StorageModule } from '@jataqi/storage';
import { bootR2Postgres, bootR2StorageKernel, type R2Postgres } from './r2-pg.js';
import {
  AUTHENTICATION_EVENTS_COLLECTION,
  AuthenticationEventStore,
  AutoLinkedStaticTokenAuthenticator,
  BreakGlassStore,
  type ActivateBreakGlassInput,
  DELEGATIONS_COLLECTION,
  DelegationStore,
  DEV_SECRET_SEAM_KEY_ID,
  IDENTITY_EVENTS_COLLECTION,
  IDENTITY_MEMBERSHIPS_COLLECTION,
  IDENTITY_PRINCIPALS_COLLECTION,
  IDENTITY_ROLE_ASSIGNMENTS_COLLECTION,
  IdentityStore,
  InMemoryKeyManagementSeam,
  MFA_ASSURANCE_COLLECTION,
  MFA_EVENT_COLLECTION,
  MFA_FACTOR_COLLECTION,
  MfaFactorStore,
  PRIVILEGED_ELEVATIONS_COLLECTION,
  PrincipalBoundary,
  PrivilegeStore,
  SECRET_ACCESS_COLLECTION,
  SECRET_MATERIAL_COLLECTION,
  SecretMaterialStore,
  SessionTokenAuthenticator,
  SessionTokenService,
  StaticTokenAuthenticator,
  BREAK_GLASS_COLLECTION,
  TOKEN_REGISTRY_COLLECTION,
  TokenRegistryStore,
  base32Decode,
  totpAt,
} from '../src/index.js';

let pg: R2Postgres;
let storage: StorageModule;
let sessions: AuthenticationEventStore;
let identity: IdentityStore;
let service: SessionTokenService;
let privileges: PrivilegeStore;
let delegation: DelegationStore;
let mfa: MfaFactorStore;
let bg: BreakGlassStore;
let registry: TokenRegistryStore;

const TENANT = `s8tamper-${process.pid}`;
const PRINCIPAL = 's8-user';

const STATIC_TOKEN = `s8-tamper-static-${process.pid}`;
let sessionToken = '';
let eventId = '';
let totpBase32 = '';
let elevationId = '';

function grantInput(tenantId: string, delegatee: string, oneShot: boolean, useCount?: number) {
  return {
    delegatorPrincipalId: PRINCIPAL,
    delegateePrincipalId: delegatee,
    tenantId,
    scope: 'tenant' as const,
    capability: { capabilityId: 'cap.p2s8.tamper', capabilityVersion: '1' },
    actions: [{ tool: 'docs', operation: 'read' }],
    targetScope: [{ system: 'docs', resourcePattern: 'res-*' }],
    constraints: { maxAgeMs: 3_600_000, classificationCeiling: 'INTERNAL', impactCeiling: 'EXTERNAL_SIDE_EFFECT' },
    chainDepth: 0,
    chain: ['sha256-delegator-manifest-live'],
    grantedBy: { principalId: PRINCIPAL, authenticationEventId: 'evt-s8-tamper' },
    oneShot,
    ...(useCount !== undefined ? { useCount } : {}),
    delegatorEvidence: {
      manifestDigest: 'sha256-delegator-manifest-live',
      actions: [{ tool: 'docs', operation: 'read' }],
      targets: [{ system: 'docs', resourcePattern: 'res-*' }],
      classificationCeiling: 'INTERNAL',
      impactCeiling: 'EXTERNAL_SIDE_EFFECT',
      requiresApproval: false,
    },
    correlationId: 's8-seed',
  };
}

before(async () => {
  pg = await bootR2Postgres('p2s8tamper', 61450);
  ({ storage } = await bootR2StorageKernel(pg.connectionString));
  sessions = await AuthenticationEventStore.open(storage);
  registry = await TokenRegistryStore.open(storage);
  identity = await IdentityStore.open(storage);
  service = new SessionTokenService({ eventStore: sessions, identityStore: identity, now: () => Date.now() });
  const seam = new InMemoryKeyManagementSeam();
  await seam.createKey(DEV_SECRET_SEAM_KEY_ID, 'encryption');
  const secrets = await SecretMaterialStore.open(storage, seam, DEV_SECRET_SEAM_KEY_ID);
  mfa = await MfaFactorStore.open(storage, secrets);
  privileges = await PrivilegeStore.open(storage, { stepUpVerifier: mfa, strictStepUp: true });
  delegation = await DelegationStore.open(storage);
  bg = await BreakGlassStore.open(storage, secrets, mfa, privileges);

  await registry.importRecords(
    [{ token: STATIC_TOKEN, tenantId: TENANT, principalId: PRINCIPAL, roles: ['agent'] }],
    'p2-s8-tamper',
    Date.now(),
  );
  const boundary = new PrincipalBoundary({
    authenticators: [
      new AutoLinkedStaticTokenAuthenticator(new StaticTokenAuthenticator([], { registry }), identity, 'p2-s8-tamper'),
      new SessionTokenAuthenticator(service),
    ],
    policy: { mode: 'production' },
    now: () => Date.now(),
    eventStore: sessions,
    sessionTokenService: service,
  });
  const minted = await boundary.authenticateWithSessionToken({ method: 'STATIC_TOKEN', material: STATIC_TOKEN });
  sessionToken = minted.sessionToken;
  eventId = minted.principal.authenticationEventId;

  const enrolled = await mfa.enroll({ tenantId: TENANT, principalId: PRINCIPAL, actorPrincipalId: PRINCIPAL, correlationId: 's8-seed' });
  totpBase32 = enrolled.sharedSecretBase32;
  const secret = base32Decode(totpBase32);
  await mfa.activate({
    tenantId: TENANT,
    principalId: PRINCIPAL,
    actorPrincipalId: PRINCIPAL,
    factorId: enrolled.factorId,
    code: totpAt(secret, Date.now(), enrolled.params),
    correlationId: 's8-seed',
  });
  await mfa.verify({
    tenantId: TENANT,
    principalId: PRINCIPAL,
    actorPrincipalId: PRINCIPAL,
    factorId: enrolled.factorId,
    code: totpAt(secret, Date.now() + 30_000, enrolled.params),
    sessionId: eventId,
    level: 'step-up',
    correlationId: 's8-seed',
  });

  const elevation = await privileges.bootstrapFirstElevation(
    { principalId: PRINCIPAL, tenantId: TENANT, reason: 'p2-s8 tamper seed' },
    Date.now(),
  );
  elevationId = elevation.id;
});

after(async () => {
  if (pg) await pg.stop();
});

describe('P2-S8 tamper + duplicates (A-22/A-23, real PostgreSQL)', () => {
  it('seed complete: session, MFA, and elevation verify', async () => {
    assert.ok(pg, 'P2-S8 requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
    assert.equal((await service.verify(sessionToken, TENANT, Date.now())).id, PRINCIPAL);
    assert.ok(totpBase32.length > 0 && elevationId.length > 0);
  });

  it('A-22 direct row mutation (extra field) is refused at re-read (closed-schema detection)', async () => {
    const tenant = `s8tamper-extra-${process.pid}`;
    const grant = await delegation.grantDelegation(grantInput(tenant, 's8-peer', false, 5), Date.now());
    assert.equal((await delegation.getDelegation(tenant, grant.id))?.status, 'ACTIVE');
    // Direct mutation bypassing the store: the raw storage write succeeds
    // (the database cannot know the schema), but the row becomes UNUSABLE —
    // every store re-read refuses it.
    await storage.atomically(async (scope) => {
      const rows = await scope.collection<Record<string, unknown> & { id: string }>(DELEGATIONS_COLLECTION);
      const row = await rows.get(grant.id);
      assert.ok(row, 'grant row present for tampering');
      await rows.put({ ...row, injectedField: 'tampered' });
    }, { tenantId: tenant });
    await assert.rejects(() => delegation.getDelegation(tenant, grant.id), 're-read of a shape-violated row throws');
  });

  it('A-22 direct row mutation (material-shaped field) is refused at re-read', async () => {
    const tenant = `s8tamper-material-${process.pid}`;
    const grant = await delegation.grantDelegation(grantInput(tenant, 's8-peer', false, 5), Date.now());
    await storage.atomically(async (scope) => {
      const rows = await scope.collection<Record<string, unknown> & { id: string }>(DELEGATIONS_COLLECTION);
      const row = await rows.get(grant.id);
      assert.ok(row, 'grant row present for tampering');
      await rows.put({ ...row, sessionTokenMaterial: 'bogus-material-trying-to-persist' });
    }, { tenantId: tenant });
    await assert.rejects(() => delegation.getDelegation(tenant, grant.id), 'material-shaped mutation refused at re-read');
  });

  it('A-22 store write paths persist nothing unshaped (refuse or provably drop)', async () => {
    // recordEvent with an unexpected field: either the write is refused, or
    // the durable row provably lacks the field. Both are closed; silent
    // persistence would fail this test.
    const probeEventId = `evt-s8-unshaped-${process.pid}`;
    let recorded = false;
    try {
      await sessions.recordEvent(
        {
          eventId: probeEventId,
          tenantId: TENANT,
          principalId: PRINCIPAL,
          method: 'STATIC_TOKEN',
          verifiedAt: Date.now(),
          expiresAt: Date.now() + 3_600_000,
          smuggled: 'must-not-persist',
        } as never,
        Date.now(),
      );
      recorded = true;
    } catch {
      recorded = false;
    }
    if (recorded) {
      const row = (await sessions.getEvent(probeEventId, TENANT)) as unknown as Record<string, unknown>;
      assert.ok(row, 'recorded row readable');
      assert.equal('smuggled' in row, false, 'unexpected field provably absent from the durable row');
    }
    // grantDelegation with an unexpected field: same closed-union assertion.
    const grantTenant = `s8tamper-grant-${process.pid}`;
    let grantedId: string | undefined;
    try {
      const doc = await delegation.grantDelegation({ ...grantInput(grantTenant, 's8-peer', false, 5), smuggled: 'x' } as never, Date.now());
      grantedId = doc.id;
    } catch {
      grantedId = undefined;
    }
    if (grantedId) {
      const row = (await delegation.getDelegation(grantTenant, grantedId)) as unknown as Record<string, unknown>;
      assert.ok(row, 'granted row readable');
      assert.equal('smuggled' in row, false, 'unexpected field provably absent from the durable grant');
    } else {
      assert.ok(true, 'grant with unexpected field refused');
    }
  });

  it('A-22 terminal records are immutable in-app (revoked stays revoked; bootstrap one-shot)', async () => {
    const tenant = `s8tamper-terminal-${process.pid}`;
    await privileges.bootstrapFirstElevation({ principalId: 's8-term', tenantId: tenant, reason: 'terminal probe' }, Date.now());
    await assert.rejects(
      privileges.bootstrapFirstElevation({ principalId: 's8-term', tenantId: tenant, reason: 'second use' }, Date.now()),
      /BOOTSTRAP_ALREADY_USED/,
    );
    // Revoke via the bootstrap authority, then prove terminality at re-read.
    const target = await privileges.grantElevation(
      {
        principalId: 's8-term-target',
        tenantId: tenant,
        scope: 'tenant',
        planeRole: 'operator',
        operationClasses: ['operator'],
        sessionEventId: eventId,
        grantedBy: 'kernel:bootstrap',
        grantorPrincipalId: 's8-term',
        grantorSessionEventId: 'kernel:bootstrap',
        reason: 'terminal probe target',
      },
      Date.now(),
    );
    const revoked = await privileges.revokeElevation(
      {
        elevationId: target.id,
        tenantId: tenant,
        scope: 'tenant',
        revokedBy: 's8-term',
        revokerSessionEventId: 'kernel:bootstrap',
        reason: 'terminal probe revocation',
      },
      Date.now(),
    );
    assert.equal(revoked.status, 'REVOKED');
    // Re-revoke is idempotent (same terminal state, no resurrection path).
    const again = await privileges.revokeElevation(
      {
        elevationId: target.id,
        tenantId: tenant,
        scope: 'tenant',
        revokedBy: 's8-term',
        revokerSessionEventId: 'kernel:bootstrap',
        reason: 'terminal probe re-revocation',
      },
      Date.now(),
    );
    assert.equal(again.status, 'REVOKED');
    const assessment = await privileges.recheckElevation(
      target.id,
      tenant,
      { principalId: 's8-term-target', operationClass: 'operator', scope: 'tenant', stepUpRequired: false, stepUpMaxAgeMs: 600_000 },
      Date.now(),
    );
    assert.equal(assessment.verdict, 'REVOKED', 'durable re-read observes the terminal state');
  });

  it('A-22 no-material sweep: no known secret appears in any durable P2 row', async () => {
    // The fingerprint IS persisted (one-way); the material NEVER is.
    const fingerprint = createHash('sha256').update(STATIC_TOKEN, 'utf8').digest('hex');
    const registration = await registry.getRegistration(fingerprint, TENANT);
    assert.ok(registration, 'token-registry row exists by fingerprint');
    assert.equal(JSON.stringify(registration).includes(STATIC_TOKEN), false, 'static token material absent from its own row');
    const collections = [
      AUTHENTICATION_EVENTS_COLLECTION,
      TOKEN_REGISTRY_COLLECTION,
      IDENTITY_PRINCIPALS_COLLECTION,
      IDENTITY_MEMBERSHIPS_COLLECTION,
      IDENTITY_ROLE_ASSIGNMENTS_COLLECTION,
      IDENTITY_EVENTS_COLLECTION,
      DELEGATIONS_COLLECTION,
      MFA_FACTOR_COLLECTION,
      MFA_ASSURANCE_COLLECTION,
      MFA_EVENT_COLLECTION,
      PRIVILEGED_ELEVATIONS_COLLECTION,
      BREAK_GLASS_COLLECTION,
      SECRET_MATERIAL_COLLECTION,
      SECRET_ACCESS_COLLECTION,
    ];
    const needles = [STATIC_TOKEN, sessionToken, totpBase32];
    let rowsScanned = 0;
    for (const name of collections) {
      const rows = await storage.atomically(async (scope) => {
        const rows = await scope.collection<Record<string, unknown> & { id: string }>(name);
        return rows.query();
      }, { tenantId: TENANT });
      for (const row of rows) {
        rowsScanned += 1;
        const serialized = JSON.stringify(row);
        for (const needle of needles) {
          assert.equal(serialized.includes(needle), false, `collection ${name} row ${String(row.id)} carries no known secret`);
        }
      }
    }
    assert.ok(rowsScanned > 10, `sweep covered ${rowsScanned} durable rows (non-vacuous)`);
  });

  it('A-23 enrollment is one-shot (ALREADY_ENROLLED); exactly one identity row', async () => {
    const tenant = `s8dup-enroll-${process.pid}`;
    await identity.enroll({ principalId: 's8-dup', tenantId: tenant, roles: ['agent'], enrolledBy: 's8-admin', correlationId: 's8-dup' }, Date.now());
    await assert.rejects(
      identity.enroll({ principalId: 's8-dup', tenantId: tenant, roles: ['agent'], enrolledBy: 's8-admin', correlationId: 's8-dup-2' }, Date.now()),
      /ALREADY_ENROLLED/,
    );
    const doc = await identity.getPrincipal('s8-dup', tenant);
    assert.ok(doc, 'exactly one identity row readable');
    assert.equal(doc.state, 'ENROLLED');
  });

  it('A-23 token import is idempotent (skipped) and rebind is refused', async () => {
    const tenant = `s8dup-import-${process.pid}`;
    const token = `s8-dup-token-${process.pid}`;
    const first = await registry.importRecords(
      [{ token, tenantId: tenant, principalId: 's8-imp', roles: ['agent'] }],
      'p2-s8-dup',
      Date.now(),
    );
    assert.deepEqual(first, { imported: 1, skipped: 0 });
    const second = await registry.importRecords(
      [{ token, tenantId: tenant, principalId: 's8-imp', roles: ['agent'] }],
      'p2-s8-dup',
      Date.now(),
    );
    assert.deepEqual(second, { imported: 0, skipped: 1 }, 'identical re-import is an idempotent skip');
    await assert.rejects(
      registry.importRecords([{ token, tenantId: tenant, principalId: 's8-impostor', roles: ['admin'] }], 'p2-s8-dup', Date.now()),
      /refusing to rebind/,
    );
    const principal = await registry.verifyByMaterial(token, Date.now(), 'p2-s8-dup');
    assert.equal(principal.id, 's8-imp', 'original binding intact after rebind refusal');
  });

  it('A-23 one-shot delegation consumes exactly once (sequential + 8 concurrent)', async () => {
    const tenant = `s8dup-consume-${process.pid}`;
    const authority = delegation.asStateAuthority();
    const oneShot = await delegation.grantDelegation(grantInput(tenant, 's8-peer', true), Date.now());
    const consumed = await storage.atomically((scope) => authority.consumeInTx(scope, oneShot.id, Date.now()), { tenantId: tenant });
    assert.equal(consumed.status, 'CONSUMED');
    await assert.rejects(
      storage.atomically((scope) => authority.consumeInTx(scope, oneShot.id, Date.now()), { tenantId: tenant }),
      /CONSUMED/,
      'sequential double-use denied',
    );
    assert.equal((await delegation.getDelegation(tenant, oneShot.id))?.status, 'CONSUMED');
    // Concurrent double-execution: 8 racers, exactly 1 winner.
    const racer = await delegation.grantDelegation(grantInput(tenant, 's8-peer-2', true), Date.now());
    const attempts = await Promise.all(
      Array.from({ length: 8 }, async () =>
        storage
          .atomically((scope) => authority.consumeInTx(scope, racer.id, Date.now()), { tenantId: tenant })
          .then(
            () => 'won' as const,
            () => 'lost' as const,
          ),
      ),
    );
    assert.equal(attempts.filter((a) => a === 'won').length, 1, 'exactly one concurrent consumer wins');
    assert.equal(attempts.filter((a) => a === 'lost').length, 7);
    assert.equal((await delegation.getDelegation(tenant, racer.id))?.status, 'CONSUMED');
  });

  it('A-23 concurrent-session policy bounds double-mint (3 resolve, 4th refused)', async () => {
    const tenant = `s8dup-mint-${process.pid}`;
    const minted: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const session = await service.mintFor(
        {
          id: 's8-multi',
          tenantId: tenant,
          roles: ['agent'],
          authenticationMethod: 'STATIC_TOKEN',
          verifiedAt: Date.now(),
          authenticationEventId: `evt-s8-multi-${process.pid}-${i}`,
        },
        Date.now(),
      );
      minted.push(session.material);
    }
    assert.equal(minted.length, 3, 'three mints resolve (inputs valid; policy not yet engaged)');
    await assert.rejects(
      service.mintFor(
        {
          id: 's8-multi',
          tenantId: tenant,
          roles: ['agent'],
          authenticationMethod: 'STATIC_TOKEN',
          verifiedAt: Date.now(),
          authenticationEventId: `evt-s8-multi-${process.pid}-3`,
        },
        Date.now(),
      ),
      'the 4th concurrent mint is refused under the default N=3 refuse-new policy',
    );
  });

  it('A-23 break-glass sequential re-activation is refused (BG_ONE_SHOT)', async () => {
    const tenant = `s8dup-bg-${process.pid}`;
    const principal = 's8-bg-dup';
    const enrolled = await mfa.enroll({ tenantId: tenant, principalId: principal, actorPrincipalId: principal, correlationId: 's8-dup' });
    const secret = base32Decode(enrolled.sharedSecretBase32);
    await mfa.activate({
      tenantId: tenant,
      principalId: principal,
      actorPrincipalId: principal,
      factorId: enrolled.factorId,
      code: totpAt(secret, Date.now(), enrolled.params),
      correlationId: 's8-dup',
    });
    const stepUp = await mfa.verify({
      tenantId: tenant,
      principalId: principal,
      actorPrincipalId: principal,
      factorId: enrolled.factorId,
      code: totpAt(secret, Date.now() + 30_000, enrolled.params),
      sessionId: `sess-s8-dup-${process.pid}`,
      level: 'step-up',
      correlationId: 's8-dup',
    });
    const input: ActivateBreakGlassInput = {
      principalId: principal,
      tenantId: tenant,
      scope: 'tenant',
      operationClasses: ['operator'],
      sessionEventId: `sess-s8-dup-${process.pid}`,
      stepUpEventId: stepUp.assuranceId,
      stepUpAt: stepUp.satisfiedAt,
      reason: 'p2-s8 duplicate-activation probe',
      actorPrincipalId: principal,
    };
    await bg.activate(input);
    await assert.rejects(bg.activate(input), /BG_ONE_SHOT/);
  });
});
