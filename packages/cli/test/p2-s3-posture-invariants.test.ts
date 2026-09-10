// P2-S3 — production POSTURE INVARIANTS qualification (real PostgreSQL;
// spec §14, §24-S3). Fail-hard: if embedded PostgreSQL cannot start,
// before() rejects and the suite FAILS (no skip).
//
// Every P2-S3 invariant is evaluated the way production evaluates it — at
// boot, on the SAME append-only, non-overridable kernel registry:
//   * P2-INV-04 (positive): the privilege plane is attached AND the A-01
//     privilege stage is wired to a live authority (declared + check true).
//     (negative): an attached composition whose boundary reports NO live
//     privilege authority fails the check with a fail-closed string.
//   * P2-INV-05 (positive): every ACTIVE elevation satisfies the
//     bounded-window policy (fresh DB ⇒ vacuously true, check green).
//     (negative): a store whose ACTIVE-elevation scan throws a
//     WINDOW_POLICY_VIOLATION renders a fail-closed string (never `true`).
//   * P2-INV-10 (positive): the privileged-operation register is loaded and
//     internally consistent, covering PO-1…PO-8.

import { after, before, beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import type { CredentialMaterialProvider } from '@jataqi/authorization-boundary';
import { createJataQiFromEnv, type JataQiInstance } from '../src/bootstrap.js';
import { bootP1Postgres, type P1Postgres } from './p1-pg.js';

let pg: P1Postgres;
const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'JATAQI_SECURITY_POSTURE',
  'STORAGE_DRIVER',
  'JATAQI_PG_CONNECTION_STRING',
  'JATAQI_AUTH_MODE',
  'JATAQI_AUTH_PRINCIPALS',
  'JATAQI_ALLOW_STATIC_TOKEN_PRODUCTION',
  'JATAQI_STATIC_TOKEN_PRODUCTION_DEADLINE',
];

class TestExternalMaterialProvider implements CredentialMaterialProvider {
  readonly id = 'p2-s3-test-external-material-provider';
  readonly kind = 'external' as const;
  readonly keyId = 'p2-s3-test-key/v1';
  private readonly materials = new Map<string, string>();
  async createMaterial(credentialId: string): Promise<string> {
    const existing = this.materials.get(credentialId);
    if (existing !== undefined) return existing;
    const material = `p2-s3-external-material-${credentialId}`;
    this.materials.set(credentialId, material);
    return material;
  }
  async getMaterial(credentialId: string): Promise<string> {
    const material = this.materials.get(credentialId);
    if (material === undefined) throw new Error('CREDENTIAL_MISSING (fail-closed)');
    return material;
  }
}

function setProductionEnv(): void {
  process.env.JATAQI_SECURITY_POSTURE = 'production';
  process.env.STORAGE_DRIVER = 'postgres';
  process.env.JATAQI_PG_CONNECTION_STRING = pg.appConnectionString;
}

function setSealedStaticTokenEnv(): void {
  setProductionEnv();
  process.env.JATAQI_AUTH_MODE = 'static-token';
  process.env.JATAQI_AUTH_PRINCIPALS = pg.principalsFile;
  process.env.JATAQI_ALLOW_STATIC_TOKEN_PRODUCTION = 'true';
  process.env.JATAQI_STATIC_TOKEN_PRODUCTION_DEADLINE = String(Date.now() + 30 * 24 * 60 * 60 * 1000);
}

async function bootProduction(): Promise<JataQiInstance> {
  return createJataQiFromEnv({
    authorization: {
      durableSecurity: {
        enabled: true,
        materialProvider: new TestExternalMaterialProvider(),
      },
    },
  });
}

function getInvariant(jq: JataQiInstance, id: string) {
  const inv = jq.kernel.listSecurityInvariants().find((i) => i.id === id);
  assert.ok(inv, `invariant ${id} must be declared on the kernel registry`);
  return inv;
}

before(async () => {
  pg = await bootP1Postgres('p2s3posture', 56910);
});

after(async () => {
  if (pg) {
    fs.rmSync(pg.principalsFile, { force: true });
    await pg.stop();
  }
});

beforeEach(() => {
  for (const key of ENV_KEYS) {
    SAVED_ENV[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (SAVED_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED_ENV[key];
  }
});

describe('P2-S3 production posture invariants (real PostgreSQL)', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg, 'P2-S3 requires a real PostgreSQL backend; embedded PostgreSQL failed to start.');
  });

  it('P2-INV-04/05/10 (positive): the production boot declares and satisfies the privilege invariants', async () => {
    setSealedStaticTokenEnv();
    const jq = await bootProduction();
    try {
      assert.equal(jq.kernel.container.resolveSync('security.posture'), 'production');

      // P2-INV-04 (privilege half): the plane is attached and the A-01
      // privilege stage is wired to a live authority.
      const inv04 = getInvariant(jq, 'p2.production.privilege-stage-registered');
      assert.equal(await inv04.check(jq.kernel), true, 'P2-INV-04 is satisfied (plane attached + stage wired)');

      // P2-INV-05 (bounded window): a fresh boot has no ACTIVE elevations,
      // so the bounded-window policy is vacuously satisfied.
      const inv05 = getInvariant(jq, 'p2.production.elevation-window-policy');
      assert.equal(await inv05.check(jq.kernel), true, 'P2-INV-05 is satisfied (no ACTIVE elevation violates the window)');

      // P2-INV-10 (register integrity): loaded and internally consistent.
      const inv10 = getInvariant(jq, 'p2.production.privilege-register-integrity');
      assert.equal(await inv10.check(jq.kernel), true, 'P2-INV-10 is satisfied (register consistent)');
    } finally {
      await jq.shutdown();
    }
  });

  it('P2-INV-04 (negative): a composition without the privilege plane fails closed', async () => {
    setSealedStaticTokenEnv();
    const jq = await bootProduction();
    try {
      const inv04 = getInvariant(jq, 'p2.production.privilege-stage-registered');
      const stubKernel = {
        getModule: (id: string) =>
          id === 'authentication'
            ? { getPrivilegeStore: () => { throw new Error('no privilege plane'); } }
            : { hasLivePrivilegeAuthority: async () => true },
      } as never;
      const outcome = await inv04.check(stubKernel);
      assert.equal(typeof outcome, 'string', 'a missing plane fails the invariant (a string is a failure reason)');
      assert.match(outcome as string, /NOT attached|fail-closed/i);
    } finally {
      await jq.shutdown();
    }
  });

  it('P2-INV-04 (negative): an unwired privilege stage fails closed', async () => {
    setSealedStaticTokenEnv();
    const jq = await bootProduction();
    try {
      const inv04 = getInvariant(jq, 'p2.production.privilege-stage-registered');
      const stubKernel = {
        getModule: (id: string) =>
          id === 'authentication'
            ? { getPrivilegeStore: () => ({}) }
            : { hasLivePrivilegeAuthority: async () => false },
      } as never;
      const outcome = await inv04.check(stubKernel);
      assert.equal(typeof outcome, 'string');
      assert.match(outcome as string, /not wired|fail-closed/i);
    } finally {
      await jq.shutdown();
    }
  });

  it('P2-INV-05 (negative): a window-policy violation renders a fail-closed string (never `true`)', async () => {
    setSealedStaticTokenEnv();
    const jq = await bootProduction();
    try {
      const inv05 = getInvariant(jq, 'p2.production.elevation-window-policy');
      const stubKernel = {
        getModule: () => ({
          getPrivilegeStore: () => ({
            assertActiveElevationsWithinBounds: async () => {
              throw new Error('WINDOW_POLICY_VIOLATION: an ACTIVE elevation exceeds the bounded window');
            },
          }),
        }),
      } as never;
      const outcome = await inv05.check(stubKernel);
      assert.equal(typeof outcome, 'string');
      assert.match(outcome as string, /WINDOW_POLICY_VIOLATION|fail-closed/i);
    } finally {
      await jq.shutdown();
    }
  });
});

describe('P2-S4 production posture invariants (real PostgreSQL)', () => {
  it('P2-INV-04 (delegation half, positive): the plane is attached and the A-01 delegation stage is wired', async () => {
    setSealedStaticTokenEnv();
    const jq = await bootProduction();
    try {
      const inv04 = getInvariant(jq, 'p2.production.delegation-stage-registered');
      assert.equal(await inv04.check(jq.kernel), true, 'P2-INV-04 delegation half is satisfied (plane attached + stage wired)');
    } finally {
      await jq.shutdown();
    }
  });

  it('P2-INV-04 (delegation half, negative): a composition without the delegation plane fails closed', async () => {
    setSealedStaticTokenEnv();
    const jq = await bootProduction();
    try {
      const inv04 = getInvariant(jq, 'p2.production.delegation-stage-registered');
      const stubKernel = {
        getModule: (id: string) =>
          id === 'authentication'
            ? { getDelegationStore: () => { throw new Error('no delegation plane'); } }
            : { hasLiveDelegationAuthority: async () => true },
      } as never;
      const outcome = await inv04.check(stubKernel);
      assert.equal(typeof outcome, 'string', 'a missing plane fails the invariant (a string is a failure reason)');
      assert.match(outcome as string, /NOT attached|fail-closed/i);
    } finally {
      await jq.shutdown();
    }
  });

  it('P2-INV-04 (delegation half, negative): an unwired delegation stage fails closed', async () => {
    setSealedStaticTokenEnv();
    const jq = await bootProduction();
    try {
      const inv04 = getInvariant(jq, 'p2.production.delegation-stage-registered');
      const stubKernel = {
        getModule: (id: string) =>
          id === 'authentication'
            ? { getDelegationStore: () => ({}) }
            : { hasLiveDelegationAuthority: async () => false },
      } as never;
      const outcome = await inv04.check(stubKernel);
      assert.equal(typeof outcome, 'string');
      assert.match(outcome as string, /not wired|fail-closed/i);
    } finally {
      await jq.shutdown();
    }
  });
});
