// P2-S6 — P2-INV-06 / P2-INV-07 posture qualification (real PostgreSQL).

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
  readonly id = 'p2-s6-test-external-material-provider';
  readonly kind = 'external' as const;
  readonly keyId = 'p2-s6-test-key/v1';
  private readonly materials = new Map<string, string>();
  async createMaterial(credentialId: string): Promise<string> {
    const existing = this.materials.get(credentialId);
    if (existing !== undefined) return existing;
    const material = `p2-s6-external-material-${credentialId}`;
    this.materials.set(credentialId, material);
    return material;
  }
  async getMaterial(credentialId: string): Promise<string> {
    const material = this.materials.get(credentialId);
    if (material === undefined) throw new Error('CREDENTIAL_MISSING (fail-closed)');
    return material;
  }
}

function setSealedStaticTokenEnv(): void {
  process.env.JATAQI_SECURITY_POSTURE = 'production';
  process.env.STORAGE_DRIVER = 'postgres';
  process.env.JATAQI_PG_CONNECTION_STRING = pg.appConnectionString;
  process.env.JATAQI_AUTH_MODE = 'static-token';
  process.env.JATAQI_AUTH_PRINCIPALS = pg.principalsFile;
  process.env.JATAQI_ALLOW_STATIC_TOKEN_PRODUCTION = 'true';
  process.env.JATAQI_STATIC_TOKEN_PRODUCTION_DEADLINE = String(Date.now() + 30 * 24 * 60 * 60 * 1000);
}

async function bootProduction(): Promise<JataQiInstance> {
  return createJataQiFromEnv({
    authorization: {
      durableSecurity: { enabled: true, materialProvider: new TestExternalMaterialProvider() },
    },
  });
}

function getInvariant(jq: JataQiInstance, id: string) {
  const inv = jq.kernel.listSecurityInvariants().find((i) => i.id === id);
  assert.ok(inv, `invariant ${id} must be declared`);
  return inv;
}

before(async () => {
  pg = await bootP1Postgres('p2s6posture', 57300);
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

describe('P2-S6 production posture invariants (real PostgreSQL)', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg);
  });

  it('P2-INV-06/07 are declared and satisfied when no break-glass store is attached', async () => {
    setSealedStaticTokenEnv();
    const jq = await bootProduction();
    try {
      assert.equal(await getInvariant(jq, 'p2.production.break-glass-window').check(jq.kernel), true);
      assert.equal(await getInvariant(jq, 'p2.production.break-glass-review').check(jq.kernel), true);
    } finally {
      await jq.shutdown();
    }
  });

  it('P2-INV-06 (negative): window-policy throw renders a fail-closed string', async () => {
    setSealedStaticTokenEnv();
    const jq = await bootProduction();
    try {
      const inv = getInvariant(jq, 'p2.production.break-glass-window');
      const stubKernel = {
        getModule: () => ({
          getBreakGlassStore: () => ({
            assertNoStandingOrOverlong: async () => {
              throw new Error('ACTIVE break-glass exceeds the 60 min hard cap');
            },
          }),
        }),
      } as never;
      const outcome = await inv.check(stubKernel);
      assert.equal(typeof outcome, 'string');
      assert.match(outcome as string, /P2-INV-06|fail-closed|hard cap/i);
    } finally {
      await jq.shutdown();
    }
  });

  it('P2-INV-07 (negative): overdue review throw renders a fail-closed string', async () => {
    setSealedStaticTokenEnv();
    const jq = await bootProduction();
    try {
      const inv = getInvariant(jq, 'p2.production.break-glass-review');
      const stubKernel = {
        getModule: () => ({
          getBreakGlassStore: () => ({
            assertNoOverdueUnreviewed: async () => {
              throw new Error('overdue unreviewed break-glass');
            },
          }),
        }),
      } as never;
      const outcome = await inv.check(stubKernel);
      assert.equal(typeof outcome, 'string');
      assert.match(outcome as string, /P2-INV-07|fail-closed|overdue/i);
    } finally {
      await jq.shutdown();
    }
  });
});
