// P2-S7 — production POSTURE INVARIANT qualification for the credential-material
// key seam (P2-INV-08; spec §12, §14).
//
// Fail-hard: if embedded PostgreSQL cannot start, before() rejects and the
// suite FAILS (no skip).
//
// P2-INV-08 is evaluated the way production evaluates it — at boot, on the same
// non-overridable kernel registry:
//   * DECLARED: the invariant exists on a production boot.
//   * VACUOUS-BY-DESIGN: with no seam attached it reports `true`, because
//     nothing in production consumes credential material yet (S5/S6 are
//     unimplemented) and `getKeySeam()` throws rather than defaulting to a dev
//     double — so absence cannot silently become an in-memory exposure.
//   * NEGATIVE: a production boot with a `dev-inmemory` seam attached renders a
//     fail-closed STRING, never `true`.
//   * POSITIVE: the same boot with an external seam attached renders `true`,
//     proving the check discriminates rather than always answering `true`.

import { after, before, beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import type { CredentialMaterialProvider } from '@jataqi/authorization-boundary';
import {
  ExternalKeyManagementSeam,
  InMemoryKeyManagementSeam,
  type AuthenticationModule,
  type ExternalKeyProviderAdapter,
} from '@jataqi/authentication';
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

const INV08 = 'p2.production.key-management-seam';
const DEV_KEY_ID = 'p2-s7-posture-dev-wrapping-key';
const EXTERNAL_KEY_ID = 'p2-s7-posture-external-wrapping-key';

class TestExternalMaterialProvider implements CredentialMaterialProvider {
  readonly id = 'p2-s7-test-external-material-provider';
  readonly kind = 'external' as const;
  readonly keyId = 'p2-s7-test-key/v1';
  private readonly materials = new Map<string, string>();
  async createMaterial(credentialId: string): Promise<string> {
    const existing = this.materials.get(credentialId);
    if (existing !== undefined) return existing;
    const material = `p2-s7-external-material-${credentialId}`;
    this.materials.set(credentialId, material);
    return material;
  }
  async getMaterial(credentialId: string): Promise<string> {
    const material = this.materials.get(credentialId);
    if (material === undefined) throw new Error('CREDENTIAL_MISSING (fail-closed)');
    return material;
  }
}

/** Stands in for a KMS/HSM/secret-manager integration. Supplies real key bytes. */
const externalAdapter: ExternalKeyProviderAdapter = {
  id: 'p2-s7-fake-kms',
  async fetchKeyMaterial(keyId: string, version: number, purpose: 'signing' | 'encryption'): Promise<Uint8Array> {
    if (purpose !== 'encryption') throw new Error('test adapter supplies encryption keys only');
    const buf = Buffer.alloc(32);
    Buffer.from(`${keyId}:${version}`).copy(buf);
    return new Uint8Array(buf);
  },
};

async function devSeam(): Promise<InMemoryKeyManagementSeam> {
  const seam = new InMemoryKeyManagementSeam();
  await seam.createKey(DEV_KEY_ID, 'encryption');
  return seam;
}

function externalSeam(): ExternalKeyManagementSeam {
  const seam = new ExternalKeyManagementSeam(externalAdapter);
  seam.registerKey({ keyId: EXTERNAL_KEY_ID, version: 1, purpose: 'encryption', status: 'ACTIVE', algorithm: 'A256GCM' });
  return seam;
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

async function bootProduction(credentialMaterial?: {
  readonly keySeam: InMemoryKeyManagementSeam | ExternalKeyManagementSeam;
  readonly encryptionKeyId: string;
}): Promise<JataQiInstance> {
  return createJataQiFromEnv({
    authorization: {
      durableSecurity: { enabled: true, materialProvider: new TestExternalMaterialProvider() },
    },
    // Supplying `authentication` REPLACES the env-derived config, so
    // durableSessions must be restated explicitly: the production posture
    // refuses process-local session authority (P1_CFG_DURABLE_SESSIONS_REQUIRED).
    ...(credentialMaterial
      ? { authentication: { durableSessions: { enabled: true as const }, credentialMaterial } }
      : {}),
  });
}

function getInvariant(jq: JataQiInstance, id: string) {
  const inv = jq.kernel.listSecurityInvariants().find((i) => i.id === id);
  assert.ok(inv, `invariant ${id} must be declared on the kernel registry`);
  return inv;
}

before(async () => {
  pg = await bootP1Postgres('p2s7posture', 56980);
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

describe('P2-S7 production posture invariant P2-INV-08 (real PostgreSQL)', () => {
  it('PostgreSQL backend started (no silent PG skip)', () => {
    assert.ok(pg, 'P2-S7 posture qualification requires a real PostgreSQL backend.');
  });

  it('P2-INV-08 is declared on a production boot and is satisfied when no seam is attached', async () => {
    setSealedStaticTokenEnv();
    const jq = await bootProduction();
    try {
      assert.equal(jq.kernel.container.resolveSync('security.posture'), 'production');
      const inv = getInvariant(jq, INV08);
      // Vacuously satisfied AND documented as such: with no seam attached,
      // `getKeySeam()` throws rather than defaulting to a dev double, so there
      // is no in-memory exposure to refuse.
      assert.equal(await inv.check(jq.kernel), true);
    } finally {
      await jq.shutdown();
    }
  });

  it('P2-INV-08 FAILS CLOSED when a dev-inmemory key seam is attached in production', async () => {
    setSealedStaticTokenEnv();
    const seam = await devSeam();
    // The invariant is MANDATORY, so the violation is not merely reported: the
    // production boot is REFUSED and no module is started. A dev seam can never
    // reach a running production process, and there is no fallback path.
    await assert.rejects(
      () => bootProduction({ keySeam: seam, encryptionKeyId: DEV_KEY_ID }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /MANDATORY SECURITY INVARIANT VIOLATED/);
        assert.match(message, /p2\.production\.key-management-seam/);
        assert.match(message, /development implementation/);
        assert.match(message, /kind="dev-inmemory"/);
        assert.match(message, /no dev fallback exists \(fail-closed\)/);
        assert.match(message, /Boot aborted/);
        // The message names the classification, never key material.
        assert.ok(!message.includes('BEGIN PRIVATE KEY'));
        return true;
      },
    );
  });

  it('P2-INV-08 is satisfied by an external key seam (the check discriminates)', async () => {
    setSealedStaticTokenEnv();
    const jq = await bootProduction({ keySeam: externalSeam(), encryptionKeyId: EXTERNAL_KEY_ID });
    try {
      const inv = getInvariant(jq, INV08);
      assert.equal(
        await inv.check(jq.kernel),
        true,
        'an external seam must satisfy P2-INV-08 — otherwise the check would be vacuous',
      );
      // And the seam is genuinely reachable through the module, not defaulted.
      const auth = jq.kernel.getModule<AuthenticationModule>('authentication');
      assert.equal(auth.getKeySeam().kind, 'external');
      assert.equal(auth.getKeySeam().id, 'external:p2-s7-fake-kms');
    } finally {
      await jq.shutdown();
    }
  });
});
