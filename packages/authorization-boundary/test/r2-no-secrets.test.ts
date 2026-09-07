import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTHENTICATION_EVENTS_COLLECTION,
  DeterministicTestAuthenticator,
  PrincipalBoundary,
  testCredential,
  type TestPrincipalRecord,
} from '@jataqi/authentication';
import {
  AUTHORIZATION_DECISIONS_COLLECTION,
  SECURITY_CONSUMED_ENVELOPES_COLLECTION,
  SECURITY_CREDENTIAL_USES_COLLECTION,
  SECURITY_CREDENTIALS_COLLECTION,
  SECURITY_IDEMPOTENCY_COLLECTION,
  SECURITY_MANIFESTS_COLLECTION,
  SECURITY_RATE_WINDOWS_COLLECTION,
  SECURITY_RUN_BUDGETS_COLLECTION,
} from '../src/index.js';
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

// R2 S-10 extension: no secret/token material is persisted anywhere in the
// durable security state. Exercises the full world, dumps every security
// collection from PostgreSQL, and scans the dump. Fail-hard: if
// PostgreSQL cannot start, before() rejects and the suite FAILS (no skip).

let pg: R2Postgres;
let world: R2World;
const T0 = Date.now();

before(async () => {
  pg = await bootR2Postgres('r2nosecrets', 58800);
  world = await buildR2World(pg.connectionString, T0);
});

after(async () => {
  await pg.stop();
});

const SECRET_VALUE_MARKERS: string[] = [];
const SECRET_FIELD_PATTERN = /(material|secret|password|privatekey|bearer|sessionkey)/i;

async function dumpSecurityCollections(): Promise<Array<{ collection: string; row: unknown }>> {
  const names = [
    SECURITY_MANIFESTS_COLLECTION,
    SECURITY_CREDENTIALS_COLLECTION,
    SECURITY_CREDENTIAL_USES_COLLECTION,
    SECURITY_CONSUMED_ENVELOPES_COLLECTION,
    SECURITY_IDEMPOTENCY_COLLECTION,
    SECURITY_RATE_WINDOWS_COLLECTION,
    SECURITY_RUN_BUDGETS_COLLECTION,
    AUTHORIZATION_DECISIONS_COLLECTION,
    AUTHENTICATION_EVENTS_COLLECTION,
  ];
  return world.store.transact({ system: true }, async (collections) => {
    const out: Array<{ collection: string; row: unknown }> = [];
    for (const name of names) {
      const handle = await collections.scope.collection<Record<string, unknown> & { id: string }>(name);
      for (const row of await handle.query({})) {
        out.push({ collection: name, row });
      }
    }
    return out;
  });
}

function fieldNames(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const names: string[] = [];
  for (const key of Object.keys(value as Record<string, unknown>)) {
    names.push(prefix ? `${prefix}.${key}` : key);
    names.push(...fieldNames((value as Record<string, unknown>)[key], prefix ? `${prefix}.${key}` : key));
  }
  return names;
}

describe('R2 no persisted secrets over real PostgreSQL', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg, 'R2 requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
  });

  it('persists fingerprints and references only — the DB dump holds no secret material', async () => {
    const capabilityId = uniqueCapability('nosecrets.e2e');
    await world.store.registerManifestVersion(
      durableManifest(capabilityId, { requiredCredentialScopes: ['read'] }),
      registrar(),
    );

    // A real boundary authentication (test method, explicit test policy):
    // the presented token material must never reach durable state.
    const record: TestPrincipalRecord = {
      id: 'user:alice',
      tenantId: 'acme',
      roles: ['operator'],
    };
    const credential = testCredential(record);
    assert.ok(typeof credential.material === 'string');
    SECRET_VALUE_MARKERS.push(credential.material);
    const boundary = new PrincipalBoundary({
      policy: { mode: 'test-only', allowTestMethod: true },
      authenticators: [new DeterministicTestAuthenticator([record])],
      eventStore: world.sessions,
      sessionLifetimeMs: 3_600_000,
      now: world.now,
    });
    const authenticated = await boundary.authenticate(credential);

    // A credential issuance: the issued material must never reach the S-2 row.
    const issued = await world.broker.issue(
      {
        credentialId: `cred-nosecrets-${process.pid}`,
        principalId: authenticated.id,
        tenantId: authenticated.tenantId,
        capabilityId,
        tool: 'test-tool',
        operation: 'do',
        audience: 'aud-1',
        scopes: ['read'],
        lifetimeMs: 3_600_000,
        issuedBy: 'user:registrar',
      },
      { principalId: 'user:registrar', authenticationEventId: 'evt-registrar-1' },
    );
    SECRET_VALUE_MARKERS.push(issued.material);

    // A decision + execution so DECISION/CONSUMED/S-3/S-4/S-6/S-7 rows exist.
    const session = await mintSession(world);
    const envelope = await world.gate.decideAsync(
      durableRequest(capabilityId, session, {
        credential: { credentialId: issued.credentialId, audience: 'aud-1', scopes: ['read'] },
      }),
    );
    assert.equal(envelope.decision.decision, 'ALLOW');
    await world.gate.executeAuthorized(envelope, async () => 'nosecrets', {
      tool: 'test-tool',
      operation: 'do',
    });
    await world.store.runGarbageCollection(world.now());

    const dump = await dumpSecurityCollections();
    assert.ok(dump.length > 10, `expected a populated dump, got ${dump.length} rows`);
    const serialized = JSON.stringify(dump);
    for (const marker of SECRET_VALUE_MARKERS) {
      assert.ok(
        !serialized.includes(marker),
        'durable security state must not contain presented or issued secret material',
      );
    }
    const badFields: string[] = [];
    for (const entry of dump) {
      for (const name of fieldNames(entry.row)) {
        if (SECRET_FIELD_PATTERN.test(name)) {
          badFields.push(`${entry.collection}:${name}`);
        }
      }
    }
    assert.deepEqual(badFields, []);
  });
});
