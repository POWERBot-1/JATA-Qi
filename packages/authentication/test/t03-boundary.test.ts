// T-03 authentication boundary tests.
//
// Covers the admission policy and the production-facing principal boundary:
// explicit configuration, fail-closed rejection, and the central rule that
// DETERMINISTIC_TEST authority can never become a production default.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import {
  AuthenticationModule,
  AuthenticationPolicyError,
  DeterministicTestAuthenticator,
  PRINCIPAL_AUTHENTICATION_TEST_METHODS_GUARD,
  PRODUCTION_AUTHENTICATION_METHODS,
  PrincipalBoundary,
  PrincipalValidationError,
  StaticTokenAuthenticator,
  UnauthenticatedRequestError,
  resolveAuthenticationPolicy,
  type AuthenticatedPrincipal,
  type ServerAuthenticator,
} from '../src/index.js';

const record = { id: 'svc-billing', tenantId: 'acme', roles: ['agent', 'operator'] as const };

function staticAuthenticator(token = 'tok-abc'): StaticTokenAuthenticator {
  return new StaticTokenAuthenticator([
    { token, principalId: record.id, tenantId: record.tenantId, roles: [...record.roles] },
  ]);
}

function testAuthenticator(): DeterministicTestAuthenticator {
  return new DeterministicTestAuthenticator([{ id: record.id, tenantId: record.tenantId, roles: [...record.roles] }]);
}

function staticCredential(token = 'tok-abc') {
  return { method: 'STATIC_TOKEN' as const, material: token };
}

describe('T-03 authentication policy resolution', () => {
  it('defaults to the production posture and never admits test authority', () => {
    const policy = resolveAuthenticationPolicy();
    assert.equal(policy.mode, 'production');
    assert.equal(policy.allowTestMethod, false);
    assert.deepEqual([...policy.allowedMethods], [...PRODUCTION_AUTHENTICATION_METHODS]);
    assert.ok(!policy.allowedMethods.includes('DETERMINISTIC_TEST'));
  });

  it('production methods exclude DETERMINISTIC_TEST and KERNEL_INTERNAL', () => {
    assert.ok(!PRODUCTION_AUTHENTICATION_METHODS.includes('DETERMINISTIC_TEST'));
    assert.ok(!PRODUCTION_AUTHENTICATION_METHODS.includes('KERNEL_INTERNAL'));
  });

  it('throws when allowTestMethod:true is requested under the production posture', () => {
    assert.throws(
      () => resolveAuthenticationPolicy({ allowTestMethod: true }),
      (error: unknown) => error instanceof AuthenticationPolicyError && /not permitted under the production/.test(error.message),
    );
  });

  it('throws when DETERMINISTIC_TEST is explicitly requested under production', () => {
    assert.throws(
      () => resolveAuthenticationPolicy({ allowedMethods: ['DETERMINISTIC_TEST'] }),
      (error: unknown) => error instanceof AuthenticationPolicyError && /test-only/.test(error.message),
    );
  });

  it('never admits KERNEL_INTERNAL at an ingress boundary', () => {
    assert.throws(
      () => resolveAuthenticationPolicy({ allowedMethods: ['KERNEL_INTERNAL'] }),
      /kernel-internal system actor/,
    );
  });

  it('requires a redundant explicit opt-in for test-only mode', () => {
    assert.throws(
      () => resolveAuthenticationPolicy({ mode: 'test-only' }),
      /requires an explicit allowTestMethod:true/,
    );
    const policy = resolveAuthenticationPolicy({ mode: 'test-only', allowTestMethod: true });
    assert.equal(policy.allowTestMethod, true);
    assert.deepEqual([...policy.allowedMethods], ['DETERMINISTIC_TEST']);
  });

  it('rejects an unknown mode and unknown methods (fail closed)', () => {
    assert.throws(
      () => resolveAuthenticationPolicy({ mode: 'permissive' as never }),
      /Unknown authentication mode/,
    );
    assert.throws(
      () => resolveAuthenticationPolicy({ allowedMethods: ['BEARER' as never] }),
      /not a recognized authentication method/,
    );
  });

  it('produces an auditable, secret-free description', () => {
    const described = resolveAuthenticationPolicy().describe();
    assert.match(described, /mode=production/);
    assert.match(described, /allowTestMethod=false/);
    assert.ok(!described.includes('token'));
  });
});

describe('T-03 principal boundary — construction is fail-closed', () => {
  it('constructs with no authenticators and therefore admits nobody', async () => {
    const boundary = new PrincipalBoundary();
    assert.deepEqual(boundary.listAuthenticatorIds(), []);
    await assert.rejects(
      () => boundary.authenticate(staticCredential()),
      (error: unknown) => error instanceof PrincipalValidationError,
    );
  });

  it('refuses to register an authenticator whose method the policy does not admit', () => {
    // A test authenticator dropped into a production root is a startup error,
    // not a latent authority hole.
    assert.throws(
      () => new PrincipalBoundary({ authenticators: [testAuthenticator()] }),
      (error: unknown) => error instanceof PrincipalValidationError && /does not admit/.test(error.message),
    );
  });

  it('accepts a test authenticator only under the explicit test-only policy', () => {
    const boundary = new PrincipalBoundary({
      policy: { mode: 'test-only', allowTestMethod: true },
      authenticators: [testAuthenticator()],
    });
    assert.deepEqual(boundary.listAuthenticatorIds(), ['deterministic-test']);
  });
});

describe('T-03 principal boundary — authentication', () => {
  it('produces an AuthenticatedPrincipal from valid configured authentication', async () => {
    const boundary = new PrincipalBoundary({ authenticators: [staticAuthenticator()] });
    const principal = await boundary.authenticate(staticCredential());
    assert.equal(principal.id, record.id);
    assert.equal(principal.tenantId, record.tenantId);
    assert.deepEqual([...principal.roles], [...record.roles]);
    assert.equal(principal.authenticationMethod, 'STATIC_TOKEN');
    assert.ok(typeof principal.verifiedAt === 'number');
    assert.ok(principal.authenticationEventId.length > 0);
  });

  it('fails closed on a missing credential', async () => {
    const boundary = new PrincipalBoundary({ authenticators: [staticAuthenticator()] });
    for (const credential of [undefined, null]) {
      await assert.rejects(
        () => boundary.authenticate(credential),
        (error: unknown) => error instanceof UnauthenticatedRequestError,
      );
    }
  });

  it('fails closed on an unrecognized credential method', async () => {
    const boundary = new PrincipalBoundary({ authenticators: [staticAuthenticator()] });
    await assert.rejects(
      () => boundary.authenticate({ method: 'BEARER' as never, material: 'x' }),
      (error: unknown) => error instanceof UnauthenticatedRequestError,
    );
  });

  it('fails closed on invalid authentication material', async () => {
    const boundary = new PrincipalBoundary({ authenticators: [staticAuthenticator()] });
    await assert.rejects(
      () => boundary.authenticate(staticCredential('wrong-token')),
      (error: unknown) => error instanceof PrincipalValidationError,
    );
  });

  it('checks policy admission BEFORE consulting any authenticator', async () => {
    // Even with a STATIC_TOKEN authenticator registered, an OIDC credential is
    // refused by policy rather than being offered to an authenticator.
    const boundary = new PrincipalBoundary({
      policy: { allowedMethods: ['STATIC_TOKEN'] },
      authenticators: [staticAuthenticator()],
    });
    await assert.rejects(
      () => boundary.authenticate({ method: 'OIDC', material: 'anything' }),
      (error: unknown) => error instanceof AuthenticationPolicyError && /not admitted/.test(error.message),
    );
  });

  it('rejects a malformed principal returned by a hostile authenticator', async () => {
    const hostile: ServerAuthenticator = {
      id: 'hostile',
      supports: ['STATIC_TOKEN'],
      async verify(): Promise<AuthenticatedPrincipal> {
        return {
          id: 'x',
          tenantId: '   ', // blank tenant
          roles: ['agent'],
          authenticationMethod: 'STATIC_TOKEN',
          verifiedAt: Date.now(),
          authenticationEventId: 'e1',
        };
      },
    };
    const boundary = new PrincipalBoundary({ authenticators: [hostile] });
    await assert.rejects(
      () => boundary.authenticate(staticCredential()),
      (error: unknown) => error instanceof PrincipalValidationError && /blank tenant id/.test(error.message),
    );
  });

  it('rejects an authenticator that mislabels its method to smuggle test authority', async () => {
    const mislabeled: ServerAuthenticator = {
      id: 'mislabeled',
      supports: ['STATIC_TOKEN'],
      async verify(): Promise<AuthenticatedPrincipal> {
        return {
          id: 'x',
          tenantId: 'acme',
          roles: ['agent'],
          authenticationMethod: 'DETERMINISTIC_TEST', // claims test authority
          verifiedAt: Date.now(),
          authenticationEventId: 'e1',
        };
      },
    };
    const boundary = new PrincipalBoundary({
      policy: { allowedMethods: ['STATIC_TOKEN'] },
      authenticators: [mislabeled],
    });
    await assert.rejects(
      () => boundary.authenticate(staticCredential()),
      (error: unknown) => error instanceof PrincipalValidationError && /does not admit/.test(error.message),
    );
  });

  it('never returns a fallback principal: every rejection throws', async () => {
    const boundary = new PrincipalBoundary({ authenticators: [staticAuthenticator()] });
    const attempts = [
      boundary.authenticate(undefined),
      boundary.authenticate({ method: 'STATIC_TOKEN' as const, material: '' }),
      boundary.authenticate(staticCredential('nope')),
    ];
    const results = await Promise.allSettled(attempts);
    for (const result of results) assert.equal(result.status, 'rejected');
  });
});

describe('T-03 principal boundary — actor projection', () => {
  it('projects the authenticated tenant and identity into the actor', async () => {
    const boundary = new PrincipalBoundary({ authenticators: [staticAuthenticator()] });
    const { principal, actor } = await boundary.authenticateAndProject(staticCredential());
    assert.equal(actor.id, principal.id);
    assert.equal(actor.tenantId, principal.tenantId);
    assert.deepEqual(actor.roles, [...principal.roles]);
  });

  it('narrows roles but never widens them', async () => {
    const boundary = new PrincipalBoundary({ authenticators: [staticAuthenticator()] });
    const narrowed = await boundary.authenticateAndProject(staticCredential(), ['agent']);
    assert.deepEqual(narrowed.actor.roles, ['agent']);
    await assert.rejects(
      () => boundary.authenticateAndProject(staticCredential(), ['admin']),
      /widening is not permitted/,
    );
  });
});

describe('T-03 authentication module — kernel composition', () => {
  it('registers as a kernel module and publishes the boundary', async () => {
    const kernel = createTestKernel();
    kernel.register(new AuthenticationModule({ authenticators: [staticAuthenticator()] }));
    await kernel.boot();
    try {
      const module = kernel.getModule<AuthenticationModule>('authentication');
      assert.equal(module.id, 'authentication');
      const boundary = module.getService();
      assert.ok(boundary instanceof PrincipalBoundary);
      const principal = await boundary.authenticate(staticCredential());
      assert.equal(principal.tenantId, record.tenantId);
      assert.equal(await kernel.container.resolve<PrincipalBoundary>('authentication'), boundary);
    } finally {
      await kernel.shutdown();
    }
  });

  it('throws at boot when an authenticator is inadmissible, so a bad root never starts', async () => {
    const kernel = createTestKernel();
    kernel.register(new AuthenticationModule({ authenticators: [testAuthenticator()] }));
    await assert.rejects(() => kernel.boot(), /does not admit/);
  });

  it('getService() before init fails closed', () => {
    assert.throws(() => new AuthenticationModule().getService(), /not initialized/);
  });
});

describe('T-03 guard against silent test-authority defaults', () => {
  it('the guard constant documents that test authority needs two explicit acts', () => {
    // Requirement: production must never silently obtain DETERMINISTIC_TEST.
    assert.equal(PRINCIPAL_AUTHENTICATION_TEST_METHODS_GUARD.requiresExplicitMode, true);
    assert.equal(PRINCIPAL_AUTHENTICATION_TEST_METHODS_GUARD.requiresExplicitAllowFlag, true);
    assert.equal(PRINCIPAL_AUTHENTICATION_TEST_METHODS_GUARD.productionDefault, false);
  });
});
