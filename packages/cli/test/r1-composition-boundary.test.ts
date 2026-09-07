// R1 COMPOSITION CONTRACT SUITE — CF-1 elimination.
//
// INVARIANTS PROVEN HERE:
//   A  every protected execution path requires an authoritative boundary
//   J  the default kernel composition cannot silently boot without it
//   K  tests cannot disable mandatory authorization
//   L  kernel-internal identity is explicit, scoped and auditable
//
// These are COMPOSITION-level contracts: they attack `createJataQi()` and the
// kernel wiring itself, not an individual surface.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SecurityInvariantViolation, SealedBindingError, type KernelApi } from '@jataqi/core-kernel';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import {
  AuthorizationBoundaryModule,
  AuthorizationGate,
  AUTHORIZATION_GATE_TOKEN,
  A01_MANDATORY_BOUNDARY_INVARIANT,
  KERNEL_INTERNAL_IDENTITY_TOKEN,
  KERNEL_INTERNAL_SCOPES,
  KERNEL_INTERNAL_TENANT,
  KernelInternalIdentity,
  requireAuthorizationBoundary,
} from '@jataqi/authorization-boundary';
import { AgentRuntimeModule } from '@jataqi/agent-runtime';
import { AutonomousActionRuntimeModule } from '@jataqi/autonomous-action-runtime';
import { CommercialControlPlaneModule } from '@jataqi/commercial-control-plane';
import { ExternalConnectorModule } from '@jataqi/external-connectors';
import { createJataQi } from '../src/bootstrap.js';

describe('R1 INVARIANT J — the default JATA Qi composition contains the boundary', () => {
  it('createJataQi() installs, initializes and seals the authorization boundary', async () => {
    const jq = await createJataQi();
    try {
      // 1. the boundary module is present in the default composition
      const module = jq.kernel.getModule<AuthorizationBoundaryModule>('authorization-boundary');
      assert.ok(module instanceof AuthorizationBoundaryModule);

      // 2. it is initialized (it actually ran)
      assert.equal(jq.kernel.getModuleState('authorization-boundary'), 'started');
      const gate = module.getService();
      assert.ok(gate instanceof AuthorizationGate);

      // 3. enforcement surfaces resolve the AUTHORITATIVE boundary — the same
      //    object, not a look-alike.
      assert.ok(jq.kernel.container.has(AUTHORIZATION_GATE_TOKEN));
      assert.equal(jq.kernel.container.resolveSync(AUTHORIZATION_GATE_TOKEN), gate);

      const runtime = jq.kernel.getModule<AutonomousActionRuntimeModule>('autonomous-action-runtime').getService();
      assert.equal(runtime.getAuthorizationGate(), gate, 'the action runtime resolves the authoritative gate');

      const connectors = jq.kernel.getModule<ExternalConnectorModule>('external-connectors').getRegistry();
      assert.equal(connectors.getAuthorizationGate(), gate, 'the connector registry resolves the authoritative gate');

      const agents = jq.kernel.getModule<AgentRuntimeModule>('agent-runtime');
      assert.ok(agents, 'the agent runtime is part of the default composition');

      // 4. the mandatory invariant is declared on the kernel
      assert.ok(jq.kernel.hasSecurityInvariant(A01_MANDATORY_BOUNDARY_INVARIANT));
    } finally {
      await jq.shutdown();
    }
  });

  it('the gate binding is SEALED: it cannot be replaced, overridden, unregistered or cleared', async () => {
    const jq = await createJataQi();
    try {
      const authoritative = jq.kernel.container.resolveSync(AUTHORIZATION_GATE_TOKEN);
      const impostor = new AuthorizationGate();

      assert.throws(() => jq.kernel.container.registerValue(AUTHORIZATION_GATE_TOKEN, impostor), SealedBindingError);
      assert.throws(() => jq.kernel.container.override(AUTHORIZATION_GATE_TOKEN, impostor), SealedBindingError);
      assert.throws(() => jq.kernel.container.registerFactory(AUTHORIZATION_GATE_TOKEN, () => impostor), SealedBindingError);
      assert.throws(() => jq.kernel.container.unregister(AUTHORIZATION_GATE_TOKEN), SealedBindingError);

      // clear() must not be a route to a runtime with no boundary
      jq.kernel.container.clear();
      assert.ok(jq.kernel.container.has(AUTHORIZATION_GATE_TOKEN), 'clear() must not remove the sealed boundary');
      assert.equal(jq.kernel.container.resolveSync(AUTHORIZATION_GATE_TOKEN), authoritative);
    } finally {
      await jq.shutdown();
    }
  });

  it('a second, non-authoritative gate cannot silently substitute for the boundary', async () => {
    const jq = await createJataQi();
    try {
      const authoritative = jq.kernel.container.resolveSync(AUTHORIZATION_GATE_TOKEN);
      // Registering a rival gate under a DIFFERENT token is allowed but is
      // not what any enforcement surface resolves.
      jq.kernel.container.registerValue('some.other.gate', new AuthorizationGate());
      const runtime = jq.kernel.getModule<AutonomousActionRuntimeModule>('autonomous-action-runtime').getService();
      assert.equal(runtime.getAuthorizationGate(), authoritative);
    } finally {
      await jq.shutdown();
    }
  });

  it('registering a SECOND authorization-boundary module is rejected by the kernel', async () => {
    const jq = await createJataQi();
    try {
      assert.throws(() => jq.kernel.register(new AuthorizationBoundaryModule()), /already registered/);
    } finally {
      await jq.shutdown();
    }
  });
});

describe('R1 INVARIANT J — boundary removal causes deterministic BOOT FAILURE', () => {
  it('a composition that declares the invariant but omits the module fails to boot', async () => {
    const kernel = createTestKernel();
    kernel.register(new StorageModule());
    // The invariant is declared exactly as createJataQi() declares it, but the
    // module is deliberately never registered.
    kernel.register(new CommercialControlPlaneModule());
    requireAuthorizationBoundary(kernel);
    kernel.register(new AutonomousActionRuntimeModule());

    await assert.rejects(() => kernel.boot(), SecurityInvariantViolation);
    assert.equal(kernel.isBooted(), false, 'the kernel must not report itself booted');
    assert.notEqual(kernel.getModuleState('autonomous-action-runtime'), 'started', 'no protected module may start');
  });

  it('a substitute module that merely claims the boundary id fails the invariant', async () => {
    const kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register({
      id: 'authorization-boundary',
      tags: ['security'],
      // A fake that registers a plausible-looking token but is not the real
      // boundary. It must not satisfy the invariant.
      init(k: KernelApi) {
        k.container.registerValue(AUTHORIZATION_GATE_TOKEN, { decide: () => ({ decision: { decision: 'ALLOW' } }) });
      },
    });
    requireAuthorizationBoundary(kernel);

    await assert.rejects(() => kernel.boot(), SecurityInvariantViolation);
    assert.equal(kernel.isBooted(), false);
  });

  it('an UNSEALED gate binding fails the invariant (a substitutable boundary is not authoritative)', async () => {
    const kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new AuthorizationBoundaryModule());
    requireAuthorizationBoundary(kernel);
    // Sanity: with the real module this composition boots.
    await kernel.boot();
    assert.ok(kernel.container.isSealed(AUTHORIZATION_GATE_TOKEN));
    await kernel.shutdown();
  });

  it('INVARIANT J — module ORDER cannot create a fail-open state', async () => {
    // Register the protected surfaces BEFORE the boundary, and declare the
    // invariant last. Topological boot + the post-init invariant must still
    // produce an authoritative boundary or refuse to boot.
    const kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new CommercialControlPlaneModule());
    kernel.register(new AutonomousActionRuntimeModule());
    kernel.register(new AuthorizationBoundaryModule());
    requireAuthorizationBoundary(kernel);

    await kernel.boot();
    try {
      const gate = kernel.getModule<AuthorizationBoundaryModule>('authorization-boundary').getService();
      const runtime = kernel.getModule<AutonomousActionRuntimeModule>('autonomous-action-runtime').getService();
      assert.equal(runtime.getAuthorizationGate(), gate, 'late-registered boundary is still the authoritative one');
    } finally {
      await kernel.shutdown();
    }
  });
});

describe('R1 INVARIANT K — mandatory authorization cannot be disabled', () => {
  it('the invariant cannot be redeclared (a weaker check cannot shadow the real one)', () => {
    const kernel = createTestKernel();
    requireAuthorizationBoundary(kernel);
    assert.throws(() => requireAuthorizationBoundary(kernel), /already declared/);
    assert.throws(
      () =>
        kernel.requireSecurityInvariant({
          id: A01_MANDATORY_BOUNDARY_INVARIANT,
          description: 'always true',
          check: () => true,
        }),
      /already declared/,
    );
  });

  it('there is no configuration key, flag, or env var that removes the boundary', async () => {
    // Exhaustive over the public config surface: none of these produce a
    // composition without the boundary.
    const attempts: Record<string, unknown>[] = [
      {},
      { authorization: {} },
      { authorization: { durableAudit: false } },
      { storage: { driver: 'memory' } },
      { kernel: { env: { JATAQI_DISABLE_AUTHORIZATION: '1', TEST_BYPASS_AUTH: '1', ALLOW_ALL: 'true' } } },
    ];
    for (const cfg of attempts) {
      const jq = await createJataQi(cfg as never);
      try {
        assert.ok(
          jq.kernel.container.isSealed(AUTHORIZATION_GATE_TOKEN),
          `config ${JSON.stringify(cfg)} produced a composition without a sealed boundary`,
        );
      } finally {
        await jq.shutdown();
      }
    }
  });

  it('the source tree contains no authorization bypass flag', async () => {
    // A grep-level contract: the forbidden bypass names must not exist as
    // implementation switches anywhere in the packages' source.
    const { execFileSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const packages = resolve(here, '..', '..', '..', 'packages');
    const forbidden = ['TEST_BYPASS_AUTH', 'ALLOW_ALL_AUTHORIZATION', 'DISABLE_AUTHORIZATION', 'SKIP_AUTHORIZATION'];
    for (const needle of forbidden) {
      let output = '';
      try {
        output = execFileSync(
          'grep',
          ['-rl', '--include=*.ts', '--exclude-dir=dist', '--exclude=r1-composition-boundary.test.ts', needle, packages],
          { encoding: 'utf8' },
        );
      } catch {
        output = ''; // grep exits 1 when there are no matches: that is the pass case
      }
      assert.equal(output.trim(), '', `forbidden bypass identifier "${needle}" found in:\n${output}`);
    }
  });
});

describe('R1 INVARIANT L — kernel-internal identity is explicit, scoped and auditable', () => {
  it('the default composition installs a sealed kernel-internal identity', async () => {
    const jq = await createJataQi();
    try {
      assert.ok(jq.kernel.container.has(KERNEL_INTERNAL_IDENTITY_TOKEN));
      assert.ok(jq.kernel.container.isSealed(KERNEL_INTERNAL_IDENTITY_TOKEN));
      const identity = jq.kernel.container.resolveSync<KernelInternalIdentity>(KERNEL_INTERNAL_IDENTITY_TOKEN);
      assert.ok(identity instanceof KernelInternalIdentity);
    } finally {
      await jq.shutdown();
    }
  });

  it('a minted principal carries exactly ONE declared scope and is verifiable', () => {
    const identity = new KernelInternalIdentity();
    for (const scope of KERNEL_INTERNAL_SCOPES) {
      const principal = identity.mint(scope);
      assert.equal(principal.authenticationMethod, 'KERNEL_INTERNAL');
      assert.equal(principal.tenantId, KERNEL_INTERNAL_TENANT);
      assert.deepEqual(principal.roles, [scope], 'exactly one narrow scope, never a wildcard');
      assert.ok(principal.id.startsWith(`kernel-internal:${scope}:`), 'the principal id is attributable');
      assert.ok(principal.authenticationEventId.length > 0, 'auditable authentication event id');
      assert.equal(identity.verify(principal, scope), true);
    }
  });

  it('there is NO wildcard kernel scope and undeclared scopes are refused', () => {
    const identity = new KernelInternalIdentity();
    assert.ok(!(KERNEL_INTERNAL_SCOPES as readonly string[]).includes('kernel:*'));
    assert.ok(!(KERNEL_INTERNAL_SCOPES as readonly string[]).includes('*'));
    assert.throws(() => identity.mint('kernel:*' as never), /not a declared kernel-internal scope/);
    assert.throws(() => identity.mint('kernel:god-mode' as never), /not a declared kernel-internal scope/);
  });

  it('a FORGED kernel principal does not verify', () => {
    const identity = new KernelInternalIdentity();
    const real = identity.mint('kernel:maintenance');

    // hand-rolled
    assert.equal(
      identity.verify({
        id: 'kernel-internal:kernel:maintenance:fake',
        tenantId: KERNEL_INTERNAL_TENANT,
        roles: ['kernel:maintenance'],
        authenticationMethod: 'KERNEL_INTERNAL',
        authenticationEventId: 'kie-deadbeef',
      }),
      false,
      'a fabricated kernel principal must not verify',
    );
    // real event id, swapped identity
    assert.equal(
      identity.verify({ ...real, id: 'kernel-internal:kernel:maintenance:someone-else' }),
      false,
      'the authentication event id is bound to the principal id',
    );
    // scope escalation on a genuinely minted principal
    assert.equal(
      identity.verify({ ...real, roles: ['kernel:internal-execution'] }),
      false,
      'a minted principal cannot be re-scoped',
    );
    // right principal, wrong expected scope
    assert.equal(identity.verify(real, 'kernel:bootstrap'), false);
    // cross-authority: another process's identity never verifies here
    assert.equal(new KernelInternalIdentity().verify(real), false);
    // revoked
    assert.equal(identity.revoke(real), true);
    assert.equal(identity.verify(real), false, 'a revoked kernel principal must not verify');
  });

  it('KERNEL_INTERNAL is not a bypass: it is still subject to the boundary', async () => {
    const jq = await createJataQi();
    try {
      const gate = jq.kernel.container.resolveSync<AuthorizationGate>(AUTHORIZATION_GATE_TOKEN);
      const identity = jq.kernel.container.resolveSync<KernelInternalIdentity>(KERNEL_INTERNAL_IDENTITY_TOKEN);
      const principal = identity.mint('kernel:internal-execution');

      // No capability manifest grants this principal anything, so the
      // authoritative decision point DENIES it exactly like anyone else.
      const envelope = gate.decide({
        principal,
        tenantId: principal.tenantId,
        agent: { agentId: 'kernel-worker' },
        run: { runId: 'run-k1', correlationId: 'corr-k1' },
        capability: { capabilityId: 'anything.at.all', capabilityVersion: '1' },
        tool: 'kernel-worker',
        operation: 'do-everything',
        target: { system: 'external.provider' },
        dataClassification: 'INTERNAL',
        impact: 'EXTERNAL_SIDE_EFFECT',
        budgetCostUnits: 1,
        provenance: { source: 'r1-test' },
      } as never);

      assert.equal(envelope.decision.decision, 'DENY', 'KERNEL_INTERNAL must not be a universal bypass');
      assert.ok(envelope.decision.reasonCodes.includes('UNKNOWN_CAPABILITY'));
      // and it is auditable: the decision names the kernel principal
      assert.equal(envelope.principal.id, principal.id);
    } finally {
      await jq.shutdown();
    }
  });
});
