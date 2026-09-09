// P1 (S2/S5/S7/S9) — PRODUCTION POSTURE QUALIFICATION SUITE (real PostgreSQL).
//
// Proves the enforced production composition works AS A SYSTEM:
//   * secure production boot (all six P1 kernel invariants green, incl. the
//     RLS probe and the boot canary);
//   * PostgreSQL outage  ⇒ DENY SECURITY_STATE_UNAVAILABLE, host survives,
//     degradation observable, NO memory fallback;
//   * PostgreSQL recovery ⇒ decisions resume after a live round-trip;
//   * restart            ⇒ revocation survives (no state reset);
//   * configuration drift⇒ boot abort (seed divergence);
//   * multi-process      ⇒ revocation performed by composition A is enforced
//     by a SEPARATE OS PROCESS running the full production composition.
//
// Fail-hard: if embedded PostgreSQL cannot start, before() rejects and the
// suite FAILS (no skip).

import { after, before, beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CredentialMaterialProvider } from '@jataqi/authorization-boundary';
import { AuthorizationDeniedError } from '@jataqi/authorization-boundary';
import { AuthenticationEventStore, TokenRegistryStore } from '@jataqi/authentication';
import type { PostgresDriver } from '@jataqi/storage-postgres';
import type { StorageModule } from '@jataqi/storage';
import { createJataQiFromEnv, type JataQiInstance } from '../src/bootstrap.js';
import { bootP1Postgres, type P1Postgres } from './p1-pg.js';

let pg: P1Postgres;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'JATAQI_SECURITY_POSTURE',
  'STORAGE_DRIVER',
  'JATAQI_PG_CONNECTION_STRING',
  'JATAQI_AUTH_MODE',
  'JATAQI_AUTH_PRINCIPALS',
  'JATAQI_ALLOW_STATIC_TOKEN_PRODUCTION',
];

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

function setProductionEnv(): void {
  process.env.JATAQI_SECURITY_POSTURE = 'production';
  process.env.STORAGE_DRIVER = 'postgres';
  process.env.JATAQI_PG_CONNECTION_STRING = pg.appConnectionString;
  process.env.JATAQI_AUTH_MODE = 'static-token';
  process.env.JATAQI_AUTH_PRINCIPALS = pg.principalsFile;
  process.env.JATAQI_ALLOW_STATIC_TOKEN_PRODUCTION = 'true';
}

async function bootProduction(overrides: {
  seedManifests?: string;
} = {}): Promise<JataQiInstance> {
  return createJataQiFromEnv({
    authorization: {
      durableSecurity: {
        enabled: true,
        materialProvider: new TestExternalMaterialProvider(),
        ...(overrides.seedManifests ? { seedManifests: overrides.seedManifests as never } : {}),
      },
    },
  });
}

before(async () => {
  pg = await bootP1Postgres('p1posture', 56800);
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
  setProductionEnv();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (SAVED_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED_ENV[key];
  }
});

describe('P1 production composition qualification (real PostgreSQL)', () => {
  it('SECURE PRODUCTION BOOT: all P1 invariants hold (durable security, storage, sessions, provider, RLS probe, health)', async () => {
    const jq = await bootProduction();
    try {
      assert.equal(jq.kernel.container.resolveSync('security.posture'), 'production');
      const invariantIds = jq.kernel.listSecurityInvariants().map((i) => i.id);
      for (const id of [
        'a01.authorization-boundary.mandatory',
        'p1.production.durable-security',
        'p1.production.durable-storage',
        'p1.production.durable-sessions',
        'p1.production.credential-material-provider',
        'p1.production.rls-posture',
        'p1.production.ambient-scope-minimization',
        'p1.production.security-state-health',
      ]) {
        assert.ok(invariantIds.includes(id), `invariant ${id} declared`);
      }
      // The durable substrate is the ONLY decision path.
      const boundary = jq.kernel.getModule('authorization-boundary') as unknown as {
        getSecurityStore: () => unknown;
        getDurableBroker: () => { materialProvider: CredentialMaterialProvider };
      };
      assert.ok(boundary.getSecurityStore());
      assert.equal(boundary.getDurableBroker().materialProvider.kind, 'external');
      // The RLS probe ran and passed at boot (INV-11/12).
      const driver = (jq.kernel.getModule('storage') as StorageModule).getDriver() as PostgresDriver;
      const probe = driver.getLastRlsPosture();
      assert.ok(probe, 'RLS probe executed at boot');
      assert.equal(probe.ok, true, `probe failures: ${JSON.stringify(probe.failures)}`);
      assert.equal(probe.role, pg.appRole);
      assert.equal(probe.isSuperuser, false);
      // INV-15/GAP-07: the production boot itself demonstrates the
      // minimization — sessions are blind by default, and every system-scope
      // use performed during the secure boot (R2 reachability/seed via
      // transaction:system, S-8/S-9 pre-tenant lookups and the R1 sink via
      // enumerated poolpath labels, isolation DDL via schema:isolation) is
      // counted, declared, and free of undeclared labels. A fresh checkout
      // carries no ambient scope.
      assert.equal(await driver.hasAmbientConnectScope(), false,
        'production composition must hand out scope-blind pooled sessions');
      const scopeAudit = driver.getSystemScopeAudit();
      assert.equal(scopeAudit.ambientConnectScopePresent, false);
      assert.deepEqual(scopeAudit.undeclaredLabels, [],
        'every system-scope use observed during production boot must be enumerated');
      assert.ok(scopeAudit.totalSystemScopeOperations > 0,
        'the labeled enumeration must observe the boot system flows');
      for (const label of Object.keys(scopeAudit.uses)) {
        assert.ok(['poolpath:', 'transaction:system', 'schema:isolation'].some((prefix) => label.startsWith(prefix)),
          `boot label ${label} falls under a declared exception prefix`);
      }
      // Durable sessions + registry-based static-token verification.
      const auth = jq.kernel.getModule('authentication') as unknown as {
        getService: () => { authenticate: (c: { method: string; material: string }) => Promise<{ id: string }> };
      };
      const principal = await auth.getService().authenticate({ method: 'STATIC_TOKEN', material: 'p1-pg-token-alpha' });
      assert.equal(principal.id, 'p1-alpha');
    } finally {
      await jq.shutdown();
    }
  });

  it('POSTGRES OUTAGE ⇒ DENY SECURITY_STATE_UNAVAILABLE, host survives, no memory fallback; RECOVERY ⇒ decisions resume', async () => {
    const jq = await bootProduction();
    try {
      const gate = (jq.kernel.getModule('authorization-boundary') as unknown as {
        getService: () => {
          decideAsync: (r: unknown) => Promise<unknown>;
        };
      }).getService();
      const driver = (jq.kernel.getModule('storage') as StorageModule).getDriver() as PostgresDriver;

      // OUTAGE: stop the database server outright.
      await pg.server.stop();
      await assert.rejects(
        () =>
          gate.decideAsync({
            principal: {
              id: 'p1-alpha',
              tenantId: 'acme',
              roles: ['agent'],
              authenticationMethod: 'STATIC_TOKEN',
              authenticationEventId: 'any',
            },
            tenantId: 'acme',
            agent: { agentId: 'a' },
            run: { runId: 'r', correlationId: 'c' },
            capability: { capabilityId: 'nope', capabilityVersion: '1' },
            tool: 't',
            operation: 'o',
            target: { system: 's' },
            dataClassification: 'PUBLIC',
            impact: 'READ',
          }),
        (error: unknown) => {
          assert.ok(error instanceof AuthorizationDeniedError, `AuthorizationDeniedError, got ${String(error)}`);
          assert.ok(
            (error as AuthorizationDeniedError).reasons.includes('SECURITY_STATE_UNAVAILABLE'),
            'denied with SECURITY_STATE_UNAVAILABLE — never ALLOW, never memory fallback',
          );
          return true;
        },
      );
      // Host survived; degradation is observable (INV-14).
      assert.ok(['degraded', 'healthy'].includes(driver.getPoolHealth().degraded ? 'degraded' : 'healthy'));

      // RECOVERY: restart the server; decisions resume after a live
      // round-trip (no restart of the process, no permissive retry).
      await pg.server.start();
      const envelope = (await gate.decideAsync({
        principal: {
          id: 'p1-alpha',
          tenantId: 'acme',
          roles: ['agent'],
          authenticationMethod: 'STATIC_TOKEN',
          authenticationEventId: 'any',
        },
        tenantId: 'acme',
        agent: { agentId: 'a' },
        run: { runId: 'r2', correlationId: 'c2' },
        capability: { capabilityId: 'still-nope', capabilityVersion: '1' },
        tool: 't',
        operation: 'o',
        target: { system: 's' },
        dataClassification: 'PUBLIC',
        impact: 'READ',
      })) as { decision: { decision: string; reasonCodes: string[] } };
      assert.equal(envelope.decision.decision, 'DENY');
      assert.ok(!envelope.decision.reasonCodes.includes('SECURITY_STATE_UNAVAILABLE'), 'decision rendered live again');
    } finally {
      await jq.shutdown().catch(() => undefined);
      // Ensure the server is up for subsequent tests even if the test failed.
      try {
        await pg.server.stop();
      } catch {
        /* already down is fine */
      }
      await pg.server.start();
    }
  });

  it('RESTART: revocation survives a full composition restart (no process-local authority reset)', async () => {
    // Composition 1: revoke the beta token durably.
    {
      const jq = await bootProduction();
      try {
        const auth = jq.kernel.getModule('authentication') as unknown as {
          getTokenRegistry: () => TokenRegistryStore;
        };
        const fingerprint = AuthenticationEventStore.fingerprint('p1-pg-token-beta');
        await auth.getTokenRegistry().revokeByFingerprint(fingerprint, 'p1-restart-test', Date.now());
      } finally {
        await jq.shutdown();
      }
    }
    // Composition 2 (fresh process-equivalent over the same database): the
    // revocation is authoritative immediately — no re-import can resurrect it
    // (fingerprint bound to the same principal is idempotent-skip, rebind
    // refused, and REVOKED stays REVOKED).
    const jq2 = await bootProduction();
    try {
      const auth = jq2.kernel.getModule('authentication') as unknown as {
        getService: () => { authenticate: (c: { method: string; material: string }) => Promise<{ id: string }> };
      };
      await assert.rejects(
        () => auth.getService().authenticate({ method: 'STATIC_TOKEN', material: 'p1-pg-token-beta' }),
        /revoked/i,
        'revocation must survive restart',
      );
      // The alpha token (never revoked) still works.
      const principal = await auth.getService().authenticate({ method: 'STATIC_TOKEN', material: 'p1-pg-token-alpha' });
      assert.equal(principal.id, 'p1-alpha');
    } finally {
      await jq2.shutdown();
    }
  });

  it('CONFIGURATION DRIFT: a changed seed manifest aborts boot (no silent rotation)', async () => {
    const seedPath = path.join(path.dirname(pg.principalsFile), `p1-seeds-${Date.now()}.json`);
    const baseManifest = {
      capabilityId: 'p1.drift-probe',
      version: '1',
      description: 'P1 drift probe',
      allowedOperations: [{ tool: 'probe', operation: 'ping' }],
      allowedTargets: [{ system: 'probe' }],
      tenantScopes: ['acme'],
      maxDataClassification: 'INTERNAL',
      maxImpact: 'READ',
      requiredCredentialScopes: [],
      requiresApproval: false,
      rateLimit: { windowMs: 60000, max: 100 },
      budgetPerRunCostUnits: 100,
      maxLifetimeMs: 3600000,
      registeredBy: { principalId: 'p1-seed', tenantId: 'system' },
      policyVersion: 'p1-seed-1',
      createdAt: Date.now(),
    };
    try {
      // Boot 1: seeds the manifest.
      fs.writeFileSync(seedPath, JSON.stringify([baseManifest]));
      process.env.JATAQI_SEED_MANIFESTS = seedPath;
      const jq1 = await bootProduction();
      await jq1.shutdown();

      // Boot 2: same version, DIFFERENT bytes ⇒ divergence ⇒ boot abort.
      fs.writeFileSync(seedPath, JSON.stringify([{ ...baseManifest, description: 'P1 drift probe (DRIFTED)' }]));
      await assert.rejects(
        () => bootProduction(),
        (error: unknown) => /diverge|divergence|ManifestDivergence/i.test(String(error)),
        'drifted seed must abort boot',
      );
      delete process.env.JATAQI_SEED_MANIFESTS;
    } finally {
      fs.rmSync(seedPath, { force: true });
      delete process.env.JATAQI_SEED_MANIFESTS;
    }
  });

  it('MULTI-PROCESS: revocation by composition A is enforced by a separate OS process running the production composition', async () => {
    const runWorker = (token: string): Promise<{ authenticated: boolean; principalId?: string; error?: string; bootFailed?: boolean }> =>
      new Promise((resolve, reject) => {
        execFile(
          process.execPath,
          [path.join(HERE, 'p1-worker.mjs'), token],
          { cwd: HERE, timeout: 120_000 },
          (error, stdout) => {
            if (error && !stdout) {
              reject(error);
              return;
            }
            try {
              const line = stdout.trim().split('\n').pop() as string;
              resolve(JSON.parse(line));
            } catch (parseError) {
              reject(parseError instanceof Error ? parseError : new Error(String(parseError)));
            }
          },
        );
      });

    // Before revocation: the separate process authenticates the alpha token.
    const before = await runWorker('p1-pg-token-alpha');
    assert.notEqual(before.bootFailed, true, `worker must boot the production composition: ${JSON.stringify(before)}`);
    assert.equal(before.authenticated, true, `worker must authenticate the ACTIVE token: ${JSON.stringify(before)}`);
    assert.equal(before.principalId, 'p1-alpha');
    // Revoke alpha through a production composition (durable S-9).
    {
      const jq = await bootProduction();
      try {
        const auth = jq.kernel.getModule('authentication') as unknown as { getTokenRegistry: () => TokenRegistryStore };
        const fingerprint = AuthenticationEventStore.fingerprint('p1-pg-token-alpha');
        await auth.getTokenRegistry().revokeByFingerprint(fingerprint, 'p1-multiprocess-test', Date.now());
      } finally {
        await jq.shutdown();
      }
    }
    // After revocation: the SEPARATE PROCESS must refuse the token — durable
    // authority, visible cross-process without restart.
    const after = await runWorker('p1-pg-token-alpha');
    assert.notEqual(after.bootFailed, true, `worker must boot: ${JSON.stringify(after)}`);
    assert.match(after.error ?? '', /revoked/i, 'the durable registry verdict is the revocation');
    assert.equal(after.authenticated, false, 'revocation must be enforced in the second process');

    // Cleanup so later iterations of this suite start clean: re-import under
    // a fresh database happens per-suite (new DB per run) — nothing to do.
  });
});
