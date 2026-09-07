import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CredentialDeniedError, type A01CredentialIssueSpec } from '../src/index.js';
import { bootR2Postgres, type R2Postgres } from './r2-pg.js';
import {
  buildR2World,
  durableManifest,
  durableRequest,
  mintSession,
  registrar,
  uniqueCapability,
  type R2World,
} from './r2-fixtures.js';

// R2 S-2/S-3 durable credential lifecycle over real PostgreSQL. Fail-hard:
// if PostgreSQL cannot start, before() rejects and the suite FAILS (no skip).

let pg: R2Postgres;
let world: R2World;
const T0 = Date.now();
let credSeq = 0;

before(async () => {
  pg = await bootR2Postgres('r2creds', 57900);
  world = await buildR2World(pg.connectionString, T0);
});

after(async () => {
  await pg.stop();
});

function issueSpec(capabilityId: string, overrides: Partial<A01CredentialIssueSpec> = {}): A01CredentialIssueSpec {
  credSeq += 1;
  return {
    credentialId: `cred-${process.pid}-${credSeq}`,
    principalId: 'user:alice',
    tenantId: 'acme',
    capabilityId,
    tool: 'test-tool',
    operation: 'do',
    audience: 'aud-1',
    scopes: ['read'],
    lifetimeMs: 3_600_000,
    issuedBy: 'user:registrar',
    ...overrides,
  };
}

const ISSUER = { principalId: 'user:registrar', authenticationEventId: 'evt-registrar-1' };

describe('R2 S-2/S-3 durable credentials over real PostgreSQL', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg, 'R2 requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
  });

  it('issues material once while the S-2 row stays material-free', async () => {
    const capabilityId = uniqueCapability('cred.issue');
    const spec = issueSpec(capabilityId);
    const issued = await world.broker.issue(spec, ISSUER);
    assert.equal(issued.credentialId, spec.credentialId);
    assert.ok(issued.material.length > 0);
    assert.equal(issued.expiresAt, T0 + 3_600_000);
    const row = await world.broker.getRegistration(spec.credentialId, 'acme');
    assert.ok(row);
    assert.equal(row?.status, 'ACTIVE');
    const serialized = JSON.stringify(row);
    assert.ok(!serialized.includes(issued.material), 'S-2 row must not contain the material');
    assert.ok(!/material|secret|password|privatekey/i.test(Object.keys(row ?? {}).join(',')));
  });

  it('rejects duplicate credential ids and caller-supplied secret material', async () => {
    const capabilityId = uniqueCapability('cred.dup');
    const spec = issueSpec(capabilityId);
    await world.broker.issue(spec, ISSUER);
    await assert.rejects(world.broker.issue(spec, ISSUER), (error: unknown) => {
      assert.ok(error instanceof CredentialDeniedError);
      assert.ok(error.reasons.includes('CREDENTIAL_BINDING_MISMATCH'));
      return true;
    });
    await assert.rejects(
      world.broker.issue(issueSpec(capabilityId, { secretMaterial: 'smuggled' }), ISSUER),
      CredentialDeniedError,
    );
  });

  it('revokes durably: idempotent re-revoke, silent unknown ids, cross-tenant refusal', async () => {
    const capabilityId = uniqueCapability('cred.revoke');
    const spec = issueSpec(capabilityId);
    await world.broker.issue(spec, ISSUER);
    assert.deepEqual(await world.broker.revoke(spec.credentialId, 'acme', 'r2-test'), {
      revoked: true,
    });
    assert.deepEqual(await world.broker.revoke(spec.credentialId, 'acme', 'r2-test'), {
      revoked: false,
    });
    assert.deepEqual(await world.broker.revoke('cred-missing-1', 'acme', 'r2-test'), {
      revoked: false,
    });
    const row = await world.broker.getRegistration(spec.credentialId, 'acme');
    assert.equal(row?.status, 'REVOKED');
    assert.equal(row?.revocationReason, 'r2-test');

    const other = issueSpec(capabilityId);
    await world.broker.issue(other, ISSUER);
    await assert.rejects(
      () => world.broker.revoke(other.credentialId, 'other-tenant', 'hostile'),
      /cross-tenant|different tenant/i,
    );
    assert.equal((await world.broker.getRegistration(other.credentialId, 'acme'))?.status, 'ACTIVE');
    assert.equal(await world.broker.getRegistration(other.credentialId, 'other-tenant'), undefined);
  });

  it('expires deny-early and flips ACTIVE rows to EXPIRED on observation', async () => {
    const capabilityId = uniqueCapability('cred.expire');
    const spec = issueSpec(capabilityId);
    await world.broker.issue(spec, ISSUER);
    world.advance(3_600_000 - 300_000 + 1);
    try {
      const observed = await world.broker.readForCheck(spec.credentialId, 'acme', world.now());
      assert.equal(observed?.status, 'EXPIRED');
      assert.equal((await world.broker.getRegistration(spec.credentialId, 'acme'))?.status, 'EXPIRED');
    } finally {
      world.advance(-(3_600_000 - 300_000 + 1));
    }
  });

  it('binds credentials end-to-end: ALLOW + material at enforcement, DENY after revoke', async () => {
    const capabilityId = uniqueCapability('cred.e2e');
    await world.store.registerManifestVersion(
      durableManifest(capabilityId, { requiredCredentialScopes: ['read'] }),
      registrar(),
    );
    const session = await mintSession(world);
    const spec = issueSpec(capabilityId, { principalId: session.principalId });
    await world.broker.issue(spec, ISSUER);
    const request = durableRequest(capabilityId, session, {
      credential: { credentialId: spec.credentialId, audience: 'aud-1', scopes: ['read'] },
    });
    const envelope = await world.gate.decideAsync(request);
    assert.equal(envelope.decision.decision, 'ALLOW');
    assert.equal(envelope.credential?.credentialId, spec.credentialId);
    const seen = await world.gate.executeAuthorized(
      envelope,
      async (scoped) => ({
        credentialId: scoped.credential?.credentialId,
        hasMaterial: (scoped.credential?.material.length ?? 0) > 0,
      }),
      { tool: 'test-tool', operation: 'do' },
    );
    assert.equal(seen.credentialId, spec.credentialId);
    assert.equal(seen.hasMaterial, true);

    await world.broker.revoke(spec.credentialId, 'acme', 'r2-test');
    const denied = await world.gate.decideAsync(
      durableRequest(capabilityId, session, {
        credential: { credentialId: spec.credentialId, audience: 'aud-1', scopes: ['read'] },
      }),
    );
    assert.equal(denied.decision.decision, 'DENY');
    assert.ok(denied.decision.reasonCodes.includes('CREDENTIAL_REVOKED'));
  });
});
