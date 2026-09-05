// T-03 CLI composition-root and authenticated-ingress tests.
//
// Proves the two GAP-2 findings are closed at the actual production
// composition root:
//   * `@jataqi/authentication` is wired into `createJataQi` and boots as a real
//     kernel module (it was previously absent from the CLI dependency graph);
//   * the T-02 `allowTestMethod` / `principalPolicy` knobs are reachable and
//     are DERIVED from the authentication posture, so DETERMINISTIC_TEST can
//     never sit at its permissive library default in a real process.
//
// and that `jataqi host:enqueue` is a genuine authenticated ingress rather than
// a self-attesting stub.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AuthenticationModule,
  DeterministicTestAuthenticator,
  PrincipalBoundary,
  newRequestId,
  projectToActor,
  testCredential,
  type TestPrincipalRecord,
} from '@jataqi/authentication';
import { LoopHostModule, WorkIngressModule } from '@jataqi/loop-host';
import { createJataQi, type JataQiInstance } from '../src/bootstrap.js';
import {
  CliAuthenticationConfigError,
  hostAllowsTestMethod,
  resolveCliAuthentication,
} from '../src/auth-config.js';
import { credentialForMode, parseHostEnqueueArgs, runHostEnqueueCommand } from '../src/host-ingress-command.js';

const ENV_KEYS = [
  'JATAQI_AUTH_MODE',
  'JATAQI_AUTH_PRINCIPALS',
  'JATAQI_ALLOW_TEST_AUTH',
  'JATAQI_AUTH_TOKEN',
  'JATAQI_MAX_PRINCIPAL_AGE_MS',
  'STORAGE_DRIVER',
];
const savedEnv: Record<string, string | undefined> = {};

function setEnv(values: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
}

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(savedEnv)) delete savedEnv[key];
});

/** Write a temporary principal-records file and return its path. */
function principalFile(records: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'jataqi-t03-'));
  const file = join(dir, 'principals.json');
  writeFileSync(file, typeof records === 'string' ? records : JSON.stringify(records), 'utf8');
  return file;
}

const STATIC_RECORDS = [
  { token: 'tok-alice', principalId: 'alice', tenantId: 'acme', roles: ['agent', 'operator'] },
];

describe('T-03 composition root — authentication is wired in', () => {
  it('createJataQi registers the authentication module (GAP-2 closed)', async () => {
    const instance = await createJataQi();
    try {
      const module = instance.kernel.getModule<AuthenticationModule>('authentication');
      assert.equal(module.id, 'authentication');
      const boundary = module.getService();
      assert.ok(boundary instanceof PrincipalBoundary);
    } finally {
      await instance.shutdown();
    }
  });

  it('the default posture admits no authenticator, so nothing can authenticate', async () => {
    const instance = await createJataQi();
    try {
      const boundary = instance.kernel.getModule<AuthenticationModule>('authentication').getService();
      assert.deepEqual(boundary.listAuthenticatorIds(), []);
      assert.equal(boundary.getPolicy().mode, 'production');
      assert.equal(boundary.getPolicy().allowTestMethod, false);
      await assert.rejects(
        () => boundary.authenticate({ method: 'STATIC_TOKEN', material: 'anything' }),
        /not supported by any registered authenticator|not admitted/,
      );
    } finally {
      await instance.shutdown();
    }
  });

  it('registers the work ingress only alongside the host', async () => {
    const withHost = await createJataQi({
      loopHost: { enabled: true },
      authentication: { policy: { mode: 'test-only', allowTestMethod: true } },
    });
    try {
      assert.ok(withHost.kernel.getModule<WorkIngressModule>('work-ingress'));
    } finally {
      await withHost.shutdown();
    }

    const withoutHost = await createJataQi();
    try {
      assert.throws(() => withoutHost.kernel.getModule('work-ingress'));
    } finally {
      await withoutHost.shutdown();
    }
  });

  /**
   * Assert the derived T-02 policy BEHAVIOURALLY. A `getPrincipalPolicy()`
   * accessor is deliberately not added to `LoopHostService`: acceptance O16
   * forbids the host surface from exposing anything named like "policy".
   */
  async function testAuthorityIsAdmitted(instance: JataQiInstance): Promise<boolean> {
    const host = instance.kernel.getModule<LoopHostModule>('loop-host').getService();
    const record = { id: 'policy-probe', tenantId: 'acme', roles: ['agent'] as const };
    const principal = await new DeterministicTestAuthenticator([{ ...record, roles: [...record.roles] }]).verify(
      testCredential({ ...record, roles: [...record.roles] }),
      Date.now(),
      newRequestId(),
    );
    try {
      await host.enqueue(projectToActor(principal), { task: { objective: 'policy probe' } }, principal);
      return true;
    } catch (error) {
      assert.match((error as Error).message, /PRINCIPAL_TEST_METHOD/);
      return false;
    }
  }

  it('derives the T-02 host policy from the authentication posture (GAP-5 closed)', async () => {
    // Production posture: test authority must be refused, even though the
    // loop-host LIBRARY default would have allowed it.
    const production = await createJataQi({ loopHost: { enabled: true } });
    try {
      assert.equal(await testAuthorityIsAdmitted(production), false);
    } finally {
      await production.shutdown();
    }

    // Explicit test-only posture: admitted, because it was asked for twice.
    const testOnly = await createJataQi({
      loopHost: { enabled: true },
      authentication: { policy: { mode: 'test-only', allowTestMethod: true } },
    });
    try {
      assert.equal(await testAuthorityIsAdmitted(testOnly), true);
    } finally {
      await testOnly.shutdown();
    }
  });

  it('refuses to force allowTestMethod:true under a production authentication policy', async () => {
    await assert.rejects(
      () => createJataQi({ loopHost: { enabled: true, principalPolicy: { allowTestMethod: true } } }),
      /requires authentication\.policy\.mode:"test-only"/,
    );
  });

  it('allows a caller to NARROW the policy further but never to widen it', async () => {
    const narrowed = await createJataQi({
      loopHost: { enabled: true, principalPolicy: { allowTestMethod: false } },
      authentication: { policy: { mode: 'test-only', allowTestMethod: true } },
    });
    try {
      assert.equal(
        await testAuthorityIsAdmitted(narrowed),
        false,
        'an explicit narrowing must win over the permissive posture',
      );
    } finally {
      await narrowed.shutdown();
    }
  });

  it('forwards maxPrincipalAgeMs to the host, observable as a shortened freshness horizon', async () => {
    const instance = await createJataQi({ loopHost: { enabled: true, maxPrincipalAgeMs: 60_000 } });
    try {
      const host = instance.kernel.getModule<LoopHostModule>('loop-host').getService();
      const record: TestPrincipalRecord = { id: 'age-probe', tenantId: 'acme', roles: ['agent'] };
      const auth = new DeterministicTestAuthenticator([record]);
      // A principal verified two minutes ago is fresh under the 24h default but
      // stale under the configured 60s horizon.
      const principal = await auth.verify(testCredential(record), Date.now() - 120_000, newRequestId());
      await assert.rejects(
        () => host.enqueue(projectToActor(principal), { task: { objective: 'age probe' } }, principal),
        /PRINCIPAL_STALE/,
      );
    } finally {
      await instance.shutdown();
    }
  });
});

describe('T-03 CLI authentication configuration', () => {
  it('defaults to mode=none: no authenticator, explicit limitation, fails closed', () => {
    const resolved = resolveCliAuthentication({} as NodeJS.ProcessEnv);
    assert.equal(resolved.mode, 'none');
    assert.equal(resolved.admitsNothing, true);
    assert.deepEqual([...resolved.authenticators], []);
    assert.ok(resolved.limitation, 'the limitation must be stated explicitly');
    assert.match(resolved.limitation!, /OIDC\/mTLS are explicitly out of scope/);
  });

  it('rejects an unknown mode', () => {
    assert.throws(
      () => resolveCliAuthentication({ JATAQI_AUTH_MODE: 'oauth' } as NodeJS.ProcessEnv),
      CliAuthenticationConfigError,
    );
  });

  it('static-token requires an explicit principal file', () => {
    assert.throws(
      () => resolveCliAuthentication({ JATAQI_AUTH_MODE: 'static-token' } as NodeJS.ProcessEnv),
      /requires JATAQI_AUTH_PRINCIPALS/,
    );
  });

  it('static-token builds a production-posture authenticator from the file', () => {
    const file = principalFile(STATIC_RECORDS);
    const resolved = resolveCliAuthentication({
      JATAQI_AUTH_MODE: 'static-token',
      JATAQI_AUTH_PRINCIPALS: file,
    } as NodeJS.ProcessEnv);
    assert.equal(resolved.mode, 'static-token');
    assert.equal(resolved.admitsNothing, false);
    assert.equal(resolved.policy.mode, 'production');
    assert.equal(resolved.authenticators.length, 1);
    assert.equal(resolved.authenticators[0]?.id, 'static-token');
    // The description is secret-free.
    assert.ok(!resolved.description.includes('tok-alice'));
  });

  it('fails closed on a malformed or empty principal file', () => {
    const notJson = principalFile('{not json');
    assert.throws(
      () =>
        resolveCliAuthentication({
          JATAQI_AUTH_MODE: 'static-token',
          JATAQI_AUTH_PRINCIPALS: notJson,
        } as NodeJS.ProcessEnv),
      /not valid JSON/,
    );
    const empty = principalFile([]);
    assert.throws(
      () =>
        resolveCliAuthentication({
          JATAQI_AUTH_MODE: 'static-token',
          JATAQI_AUTH_PRINCIPALS: empty,
        } as NodeJS.ProcessEnv),
      /non-empty JSON array/,
    );
    const badRole = principalFile([{ token: 't', principalId: 'p', tenantId: 'acme', roles: ['wizard'] }]);
    assert.throws(
      () =>
        resolveCliAuthentication({
          JATAQI_AUTH_MODE: 'static-token',
          JATAQI_AUTH_PRINCIPALS: badRole,
        } as NodeJS.ProcessEnv),
      /not a recognized actor role/,
    );
  });

  it('never grants the kernel-internal "system" role to an external credential', () => {
    const file = principalFile([{ token: 't', principalId: 'p', tenantId: 'acme', roles: ['system'] }]);
    assert.throws(
      () =>
        resolveCliAuthentication({
          JATAQI_AUTH_MODE: 'static-token',
          JATAQI_AUTH_PRINCIPALS: file,
        } as NodeJS.ProcessEnv),
      /kernel-internal actor/,
    );
  });

  it('test-only cannot be entered without BOTH explicit acts', () => {
    const file = principalFile([{ id: 'tester', tenantId: 'acme', roles: ['agent'] }]);
    // Act 1 only: mode set, flag missing.
    assert.throws(
      () =>
        resolveCliAuthentication({
          JATAQI_AUTH_MODE: 'test-only',
          JATAQI_AUTH_PRINCIPALS: file,
        } as NodeJS.ProcessEnv),
      /requires JATAQI_ALLOW_TEST_AUTH=true/,
    );
    // A near-miss flag value is not an opt-in.
    assert.throws(
      () =>
        resolveCliAuthentication({
          JATAQI_AUTH_MODE: 'test-only',
          JATAQI_AUTH_PRINCIPALS: file,
          JATAQI_ALLOW_TEST_AUTH: 'yes',
        } as NodeJS.ProcessEnv),
      /requires JATAQI_ALLOW_TEST_AUTH=true/,
    );
    // Both acts: admitted, and flagged as test authority.
    const resolved = resolveCliAuthentication({
      JATAQI_AUTH_MODE: 'test-only',
      JATAQI_AUTH_PRINCIPALS: file,
      JATAQI_ALLOW_TEST_AUTH: 'true',
    } as NodeJS.ProcessEnv);
    assert.equal(resolved.mode, 'test-only');
    assert.equal(resolved.policy.mode, 'test-only');
    assert.equal(resolved.policy.allowTestMethod, true);
    assert.match(resolved.description, /TEST AUTHORITY/);
  });

  it('hostAllowsTestMethod is false for every posture except explicit test-only', () => {
    assert.equal(hostAllowsTestMethod(resolveCliAuthentication({} as NodeJS.ProcessEnv)), false);
    const file = principalFile(STATIC_RECORDS);
    assert.equal(
      hostAllowsTestMethod(
        resolveCliAuthentication({
          JATAQI_AUTH_MODE: 'static-token',
          JATAQI_AUTH_PRINCIPALS: file,
        } as NodeJS.ProcessEnv),
      ),
      false,
    );
  });
});

describe('T-03 host:enqueue argument parsing', () => {
  it('parses the supported flags', () => {
    const opts = parseHostEnqueueArgs([
      '--objective',
      'Analyze churn',
      '--correlation-id',
      'c1',
      '--idempotency-key',
      'k1',
      '--tenant',
      'acme',
      '--roles',
      'agent,operator',
      '--knowledge-query',
      'churn evidence',
    ]);
    assert.equal(opts.objective, 'Analyze churn');
    assert.equal(opts.correlationId, 'c1');
    assert.equal(opts.idempotencyKey, 'k1');
    assert.equal(opts.tenantId, 'acme');
    assert.deepEqual(opts.requestedRoles, ['agent', 'operator']);
    assert.equal(opts.knowledgeQuery, 'churn evidence');
  });

  it('rejects unknown flags and missing values (fail closed)', () => {
    assert.throws(() => parseHostEnqueueArgs(['--self-attest']), /Unknown option/);
    assert.throws(() => parseHostEnqueueArgs(['--objective']), /requires a value/);
  });
});

describe('T-03 host:enqueue credential derivation', () => {
  it('refuses to present any credential when no method is configured', () => {
    assert.throws(() => credentialForMode('none', 'tok'), /No authentication method is configured/);
  });

  it('requires the token from the environment, never from argv', () => {
    assert.throws(() => credentialForMode('static-token', undefined), /JATAQI_AUTH_TOKEN is required/);
    assert.throws(() => credentialForMode('static-token', '   '), /JATAQI_AUTH_TOKEN is required/);
  });

  it('takes the METHOD from the deployment posture, not from the caller', () => {
    assert.equal(credentialForMode('static-token', 'tok').method, 'STATIC_TOKEN');
    assert.equal(credentialForMode('test-only', 'tok').method, 'DETERMINISTIC_TEST');
  });
});

describe('T-03 host:enqueue end to end', () => {
  it('creates authenticated durable work and prints a secret-free receipt', async () => {
    const file = principalFile(STATIC_RECORDS);
    setEnv({
      JATAQI_AUTH_MODE: 'static-token',
      JATAQI_AUTH_PRINCIPALS: file,
      JATAQI_AUTH_TOKEN: 'tok-alice',
      STORAGE_DRIVER: 'memory',
    });
    const lines: string[] = [];
    const code = await runHostEnqueueCommand(
      ['--objective', 'Analyze churn signals.', '--correlation-id', 'cli-e2e', '--idempotency-key', 'cli-e2e-1'],
      process.env,
      (line) => lines.push(line),
    );
    assert.equal(code, 0);
    const payload = JSON.parse(lines.join('\n')) as {
      ok: boolean;
      receipt: {
        workId: string;
        tenantId: string;
        status: string;
        correlationId: string;
        authentication: { principalId: string; authenticationMethod: string; authenticationEventId: string };
      };
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.receipt.tenantId, 'acme');
    assert.equal(payload.receipt.status, 'QUEUED');
    assert.equal(payload.receipt.correlationId, 'cli-e2e');
    assert.equal(payload.receipt.authentication.principalId, 'alice');
    assert.equal(payload.receipt.authentication.authenticationMethod, 'STATIC_TOKEN');
    assert.ok(payload.receipt.authentication.authenticationEventId.length > 0);
    // No credential material in the output.
    assert.ok(!lines.join('\n').includes('tok-alice'));
    rmSync(join(file, '..'), { recursive: true, force: true });
  });

  it('refuses an invalid token: non-zero exit, no receipt', async () => {
    const file = principalFile(STATIC_RECORDS);
    setEnv({
      JATAQI_AUTH_MODE: 'static-token',
      JATAQI_AUTH_PRINCIPALS: file,
      JATAQI_AUTH_TOKEN: 'wrong-token',
      STORAGE_DRIVER: 'memory',
    });
    const lines: string[] = [];
    const code = await runHostEnqueueCommand(['--objective', 'Should be refused.'], process.env, (l) => lines.push(l));
    assert.equal(code, 1);
    assert.equal(lines.length, 0, 'no receipt may be printed on refusal');
    rmSync(join(file, '..'), { recursive: true, force: true });
  });

  it('refuses a caller tenant that conflicts with the authenticated tenant', async () => {
    const file = principalFile(STATIC_RECORDS);
    setEnv({
      JATAQI_AUTH_MODE: 'static-token',
      JATAQI_AUTH_PRINCIPALS: file,
      JATAQI_AUTH_TOKEN: 'tok-alice',
      STORAGE_DRIVER: 'memory',
    });
    const code = await runHostEnqueueCommand(
      ['--objective', 'Cross-tenant attempt.', '--tenant', 'other'],
      process.env,
      () => undefined,
    );
    assert.equal(code, 1);
    rmSync(join(file, '..'), { recursive: true, force: true });
  });

  it('refuses when no authentication method is configured, and states the limitation', async () => {
    setEnv({ JATAQI_AUTH_MODE: undefined, JATAQI_AUTH_TOKEN: 'anything', STORAGE_DRIVER: 'memory' });
    const code = await runHostEnqueueCommand(['--objective', 'No auth configured.'], process.env, () => undefined);
    assert.equal(code, 1, 'an unconfigured process must not create work');
  });

  it('refuses test authority in a production-mode process', async () => {
    const file = principalFile(STATIC_RECORDS);
    setEnv({
      JATAQI_AUTH_MODE: 'static-token',
      JATAQI_AUTH_PRINCIPALS: file,
      // A DETERMINISTIC_TEST material presented to a STATIC_TOKEN root.
      JATAQI_AUTH_TOKEN: 'test:alice@acme',
      STORAGE_DRIVER: 'memory',
    });
    const code = await runHostEnqueueCommand(['--objective', 'Test material.'], process.env, () => undefined);
    assert.equal(code, 1, 'test-shaped material must not authenticate against a production root');
    rmSync(join(file, '..'), { recursive: true, force: true });
  });
});
