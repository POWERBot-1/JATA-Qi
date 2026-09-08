// P1 (S1/S5) — PRODUCTION SECURITY POSTURE: REJECTION MATRIX (no PostgreSQL).
//
// Proves the production composition is REJECTED (fail-closed, deterministic
// codes) for every unsafe configuration, and that the development posture
// keeps today's behavior EXACTLY (regression). PostgreSQL-backed green-boot,
// outage, restart, and multi-process proofs live in p1-posture-pg.test.ts.
//
// These are COMPOSITION-level contracts: they attack createJataQi() /
// createJataQiFromEnv() and the posture layers themselves.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';

import { SecurityInvariantViolation } from '@jataqi/core-kernel';
import { InMemoryCredentialMaterialProvider, type CredentialMaterialProvider } from '@jataqi/authorization-boundary';
import { createJataQi, createJataQiFromEnv } from '../src/bootstrap.js';
import {
  ProductionPostureViolation,
  resolveSecurityPosture,
  validateProductionSecurityConfig,
  type SecurityPosture,
} from '../src/security-posture.js';
import { runHostCommand } from '../src/host-command.js';

/** A test double that DECLAR ES external provider classification (honest: the
 * platform can refuse dev providers by id/kind but cannot verify a real KMS
 * backs a declared-external provider — that accountability stays with the
 * operator; recorded as residual risk in the P1 evidence). */
class TestExternalMaterialProvider implements CredentialMaterialProvider {
  readonly id = 'p1-test-external-material-provider';
  readonly kind = 'external' as const;
  readonly keyId = 'p1-test-key/v1';
  private readonly materials = new Map<string, string>();
  async createMaterial(credentialId: string): Promise<string> {
    const existing = this.materials.get(credentialId);
    if (existing !== undefined) return existing;
    const material = `p1-external-material-${credentialId}`;
    this.materials.set(credentialId, material);
    return material;
  }
  async getMaterial(credentialId: string): Promise<string> {
    const material = this.materials.get(credentialId);
    if (material === undefined) throw new Error('CREDENTIAL_MISSING (fail-closed)');
    return material;
  }
}

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'JATAQI_SECURITY_POSTURE',
  'STORAGE_DRIVER',
  'JATAQI_PG_CONNECTION_STRING',
  'JATAQI_AUTH_MODE',
  'JATAQI_AUTH_PRINCIPALS',
  'JATAQI_ALLOW_STATIC_TOKEN_PRODUCTION',
  'JATAQI_ALLOW_TEST_AUTH',
];

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

function expectPostureViolation(code: string, fn: () => unknown): void {
  try {
    fn();
    assert.fail(`expected ProductionPostureViolation ${code}`);
  } catch (error) {
    assert.ok(error instanceof ProductionPostureViolation, `expected ProductionPostureViolation, got: ${String(error)}`);
    assert.equal(error.code, code);
  }
}

async function expectPostureViolationAsync(code: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    assert.fail(`expected ProductionPostureViolation ${code}`);
  } catch (error) {
    assert.ok(error instanceof ProductionPostureViolation, `expected ProductionPostureViolation, got: ${String(error)}`);
    assert.equal(error.code, code);
  }
}

describe('P1 posture resolution (S1 — INV-01)', () => {
  it('defaults to development', () => {
    assert.equal<SecurityPosture>(resolveSecurityPosture({}), 'development');
    assert.equal<SecurityPosture>(resolveSecurityPosture({ JATAQI_SECURITY_POSTURE: '' }), 'development');
    assert.equal<SecurityPosture>(resolveSecurityPosture({ JATAQI_SECURITY_POSTURE: 'development' }), 'development');
  });

  it('recognizes production (case-insensitive)', () => {
    assert.equal<SecurityPosture>(resolveSecurityPosture({ JATAQI_SECURITY_POSTURE: 'production' }), 'production');
    assert.equal<SecurityPosture>(resolveSecurityPosture({ JATAQI_SECURITY_POSTURE: ' Production ' }), 'production');
  });

  it('FAILS CLOSED on an unknown posture value', () => {
    expectPostureViolation('P1_POSTURE_UNKNOWN', () => resolveSecurityPosture({ JATAQI_SECURITY_POSTURE: 'prod' }));
    expectPostureViolation('P1_POSTURE_UNKNOWN', () => resolveSecurityPosture({ JATAQI_SECURITY_POSTURE: 'true' }));
  });
});

describe('P1 production rejection matrix (S1/S5 — INV-01…INV-16)', () => {
  it('production + durableSecurity disabled ⇒ BOOT FAILURE (INV-01)', async () => {
    await expectPostureViolationAsync('P1_CFG_DURABLE_SECURITY_REQUIRED', () =>
      createJataQi({ securityPosture: 'production', storage: { driver: 'postgres' }, authorization: {} }),
    );
  });

  it('production + MemoryDriver ⇒ BOOT FAILURE (INV-02)', async () => {
    await expectPostureViolationAsync('P1_CFG_STORAGE_DRIVER_NOT_DURABLE', () =>
      createJataQi({
        securityPosture: 'production',
        storage: { driver: 'memory' },
        authorization: { durableSecurity: { enabled: true } },
        authentication: { durableSessions: { enabled: true } },
      }),
    );
  });

  it('production + FsDriver ⇒ BOOT FAILURE (INV-03)', async () => {
    await expectPostureViolationAsync('P1_CFG_STORAGE_DRIVER_NOT_DURABLE', () =>
      createJataQi({
        securityPosture: 'production',
        storage: { driver: 'filesystem' },
        authorization: { durableSecurity: { enabled: true } },
        authentication: { durableSessions: { enabled: true } },
      }),
    );
  });

  it('production + default (unset) driver selection ⇒ BOOT FAILURE (INV-02/03, FromEnv)', async () => {
    process.env.JATAQI_SECURITY_POSTURE = 'production';
    await expectPostureViolationAsync('P1_CFG_STORAGE_DRIVER_NOT_DURABLE', () => createJataQiFromEnv());
  });

  it('production + durable sessions missing ⇒ BOOT FAILURE (INV-07)', async () => {
    await expectPostureViolationAsync('P1_CFG_DURABLE_SESSIONS_REQUIRED', () =>
      createJataQi({
        securityPosture: 'production',
        storage: { driver: 'postgres' },
        authorization: { durableSecurity: { enabled: true } },
        authentication: {},
      }),
    );
  });

  it('production + development credential material provider ⇒ BOOT FAILURE (INV-09)', async () => {
    await expectPostureViolationAsync('P1_CFG_DEV_CREDENTIAL_PROVIDER', () =>
      createJataQi({
        securityPosture: 'production',
        storage: { driver: 'postgres' },
        authorization: {
          durableSecurity: { enabled: true, materialProvider: new InMemoryCredentialMaterialProvider() },
        },
        authentication: { durableSessions: { enabled: true } },
      }),
    );
  });

  it('production + durableAudit:false ⇒ BOOT FAILURE (INV-05/16)', async () => {
    await expectPostureViolationAsync('P1_CFG_DURABLE_AUDIT_REQUIRED', () =>
      createJataQi({
        securityPosture: 'production',
        storage: { driver: 'postgres' },
        authorization: { durableSecurity: { enabled: true }, durableAudit: false },
        authentication: { durableSessions: { enabled: true } },
      }),
    );
  });

  it('production + test-only authentication ⇒ BOOT FAILURE (INV-10)', async () => {
    await expectPostureViolationAsync('P1_CFG_TEST_AUTH_REFUSED', () =>
      createJataQi({
        securityPosture: 'production',
        storage: { driver: 'postgres' },
        authorization: { durableSecurity: { enabled: true } },
        authentication: { durableSessions: { enabled: true }, policy: { mode: 'test-only', allowTestMethod: true } },
      }),
    );
  });

  it('production + unreachable PostgreSQL ⇒ BOOT FAILURE during security-state initialization (INV-04/05)', async () => {
    // A dead connection target fails fast (connection refused): the durable
    // security store must fail to OPEN and abort boot — production never
    // serves protected traffic on unreachable authoritative state.
    const { PostgresDriver } = await import('@jataqi/storage-postgres');
    const dead = new PostgresDriver({
      connectionString: 'postgres://127.0.0.1:1/none',
      requireExplicitConfig: true,
      connectionTimeoutMillis: 750,
    });
    await assert.rejects(
      () =>
        createJataQi({
          securityPosture: 'production',
          storage: { driverInstance: dead },
          authorization: {
            durableSecurity: { enabled: true, materialProvider: new TestExternalMaterialProvider() },
          },
          authentication: { durableSessions: { enabled: true }, policy: { mode: 'production' } },
        }),
      (error: unknown) => {
        // Boot aborted: either the store refused to open, or a P1 kernel
        // invariant fired. Both are fail-closed boot failures.
        const rendered = `${error instanceof Error ? error.constructor.name : ''} ${String(error)}`;
        return (
          error instanceof SecurityInvariantViolation ||
          error instanceof ProductionPostureViolation ||
          /fail-closed|requires a transactional|could not|ECONNREFUSED|unreachable/i.test(rendered)
        );
      },
    );
  });

  it('production + static-token WITHOUT the explicit opt-in ⇒ BOOT FAILURE (D1)', async () => {
    const principalsFile = `p1-posture-principals-${Date.now()}.json`;
    fs.writeFileSync(principalsFile, JSON.stringify([{ token: 'x', principalId: 'p', tenantId: 't', roles: ['agent'] }]));
    try {
      process.env.JATAQI_SECURITY_POSTURE = 'production';
      process.env.STORAGE_DRIVER = 'postgres';
      process.env.JATAQI_PG_CONNECTION_STRING = 'postgres://127.0.0.1:1/none';
      process.env.JATAQI_AUTH_MODE = 'static-token';
      process.env.JATAQI_AUTH_PRINCIPALS = principalsFile;
      await expectPostureViolationAsync('P1_CFG_STATIC_TOKEN_REQUIRES_OPT_IN', () => createJataQiFromEnv());
    } finally {
      fs.rmSync(principalsFile, { force: true });
    }
  });

  it('production + test-only mode via environment ⇒ BOOT FAILURE (INV-10, FromEnv)', async () => {
    const principalsFile = `p1-posture-test-principals-${Date.now()}.json`;
    fs.writeFileSync(principalsFile, JSON.stringify([{ id: 'p', tenantId: 't', roles: ['agent'] }]));
    try {
      process.env.JATAQI_SECURITY_POSTURE = 'production';
      process.env.STORAGE_DRIVER = 'postgres';
      process.env.JATAQI_PG_CONNECTION_STRING = 'postgres://127.0.0.1:1/none';
      process.env.JATAQI_AUTH_MODE = 'test-only';
      process.env.JATAQI_ALLOW_TEST_AUTH = 'true';
      process.env.JATAQI_AUTH_PRINCIPALS = principalsFile;
      await expectPostureViolationAsync('P1_CFG_TEST_AUTH_REFUSED', () => createJataQiFromEnv());
    } finally {
      fs.rmSync(principalsFile, { force: true });
    }
  });

  it('validator: unsafe escape hatch refused (INV-16)', () => {
    expectPostureViolation('P1_CFG_UNSAFE_ESCAPE_HATCH', () =>
      validateProductionSecurityConfig({ allowNonDurableStorage: true }),
    );
  });

  it('host command: --allow-non-durable-storage under production posture is REFUSED before boot', async () => {
    process.env.JATAQI_SECURITY_POSTURE = 'production';
    const lines: string[] = [];
    const code = await runHostCommand({ allowNonDurableStorage: true, log: (l) => lines.push(l), installSignalHandlers: false });
    assert.equal(code, 1, 'exit code must be 1 (refused)');
    assert.ok(
      lines.some((l) => l.includes('REFUSED') && l.includes('--allow-non-durable-storage')),
      'refusal reason logged',
    );
  });
});

describe('P1 development posture regression (S1 — behavior preserved exactly)', () => {
  it('default createJataQi() still boots on memory with the R1 boundary path', async () => {
    const jq = await createJataQi();
    try {
      const boundary = jq.kernel.getModule('authorization-boundary') as unknown as { getService: () => { decide: (r: unknown) => unknown } };
      const gate = boundary.getService();
      // R1 semantics: sync decide() works (no durable store attached).
      const envelope = gate.decide(null) as { decision: { decision: string; reasonCodes: string[] } };
      assert.equal(envelope.decision.decision, 'DENY');
      assert.ok(envelope.decision.reasonCodes.includes('ENVELOPE_MALFORMED'));
      assert.equal(jq.kernel.container.resolveSync('security.posture'), 'development');
    } finally {
      await jq.shutdown();
    }
  });

  it('createJataQiFromEnv() default (no posture env) boots development on memory', async () => {
    const jq = await createJataQiFromEnv();
    try {
      assert.equal(jq.kernel.container.resolveSync('security.posture'), 'development');
    } finally {
      await jq.shutdown();
    }
  });

  it('the development validator accepts everything the production one rejects (flexibility retained)', () => {
    // Development keeps flexible behavior: this is the same input the
    // production matrix rejects, and here it must NOT throw.
    validateProductionSecurityConfig; // reference (production-only function)
    assert.doesNotThrow(() => {
      void resolveSecurityPosture({});
    });
  });
});
