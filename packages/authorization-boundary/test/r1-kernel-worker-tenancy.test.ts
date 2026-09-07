/**
 * R1 / D2 — the verified kernel-worker tenancy path is NOT a bypass.
 *
 * `establishKernelWorkerAuthority` mints a KERNEL_INTERNAL principal so that
 * in-process platform workers (payments, distribution, github, unified-loop,
 * ...) can drive the action runtime without a human principal. The policy
 * engine therefore contains ONE narrow tenancy exception: a principal that
 * the PROCESS ITSELF verifies, executing under a capability whose manifest is
 * explicitly system-scoped (`allowTenantWildcard: true`), does not trip
 * TENANT_SUBSTITUTION.
 *
 * This suite proves the exception is narrow in every direction:
 *   1. UNVERIFIED kernel principals get NO tenancy relief (forgery defence).
 *   2. A TENANT-PINNED manifest still denies a VERIFIED kernel worker that
 *      crosses tenants (the exception cannot widen a narrow manifest).
 *   3. A verified kernel worker outside its manifest's tool/operation/target
 *      is still denied.
 *   4. Absent any verifier, NO principal is ever treated as a kernel worker.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AuthorizationGate,
  CapabilityManifestRegistry,
  InMemoryAuditSink,
  KernelInternalIdentity,
  type A01AuthorizationEnvelope,
} from '../src/index.js';
import { baseRequest, manifest, T0 } from './helpers.js';

interface Built {
  gate: AuthorizationGate;
  manifests: CapabilityManifestRegistry;
  identity: KernelInternalIdentity;
}

/** A gate wired exactly as the real module wires it: verifier from the real identity. */
function build(opts: { withVerifier: boolean }): Built {
  const manifests = new CapabilityManifestRegistry();
  const identity = new KernelInternalIdentity();
  const gate = new AuthorizationGate({
    now: () => T0,
    manifests,
    audit: new InMemoryAuditSink(),
    policyVersion: 'test-policy',
    ...(opts.withVerifier
      ? { verifyKernelPrincipal: (p: unknown, scope: string) => identity.verify(p as never, scope as never) }
      : {}),
  });
  return { gate, manifests, identity };
}

/** A system-scoped worker manifest, as establishKernelWorkerAuthority creates. */
function workerManifest(overrides: Record<string, unknown> = {}) {
  return manifest({
    capabilityId: 'kernel.worker.suite',
    allowedOperations: [{ tool: 'worker-tool', operation: 'RUN' }],
    allowedTargets: [{ system: 'worker-system', resourcePattern: 'res-*' }],
    tenantScopes: [],
    allowTenantWildcard: true,
    ...overrides,
  });
}

function workerRequest(principal: unknown, overrides: Record<string, unknown> = {}) {
  return baseRequest({
    principal,
    capability: { capabilityId: 'kernel.worker.suite', capabilityVersion: '1' },
    tool: 'worker-tool',
    operation: 'RUN',
    target: { system: 'worker-system', resource: 'res-1' },
    ...overrides,
  });
}

function reasons(envelope: A01AuthorizationEnvelope): string[] {
  return [...envelope.decision.reasonCodes] as string[];
}

function outcome(envelope: A01AuthorizationEnvelope): string {
  return envelope.decision.decision;
}

describe('R1/D2 verified kernel-worker tenancy is narrow, not a bypass', () => {
  it('positive control: a VERIFIED kernel worker under a system-scoped manifest is allowed', () => {
    const { gate, manifests, identity } = build({ withVerifier: true });
    manifests.register(workerManifest());
    const principal = identity.mint('kernel:internal-execution');
    const decision = gate.decide(workerRequest(principal));
    assert.equal(outcome(decision), 'ALLOW', `expected ALLOW, got ${JSON.stringify(reasons(decision))}`);
  });

  it('a FORGED kernel principal this process never minted gets NO tenancy relief', () => {
    const { gate, manifests, identity } = build({ withVerifier: true });
    manifests.register(workerManifest());
    // Same shape, different (foreign) process authority.
    const forged = new KernelInternalIdentity().mint('kernel:internal-execution');
    assert.equal(identity.verify(forged, 'kernel:internal-execution'), false, 'precondition: forgery does not verify');
    const decision = gate.decide(workerRequest(forged));
    assert.notEqual(outcome(decision), 'ALLOW', 'a forged kernel principal must never be allowed');
    assert.ok(reasons(decision).includes('TENANT_SUBSTITUTION'), `expected TENANT_SUBSTITUTION, got ${JSON.stringify(reasons(decision))}`);
  });

  it('a REVOKED kernel principal loses the exception immediately', () => {
    const { gate, manifests, identity } = build({ withVerifier: true });
    manifests.register(workerManifest());
    const principal = identity.mint('kernel:internal-execution');
    identity.revoke(principal);
    const decision = gate.decide(workerRequest(principal));
    assert.notEqual(outcome(decision), 'ALLOW', 'a revoked kernel principal must not be allowed');
  });

  it('a TENANT-PINNED manifest still denies a VERIFIED kernel worker crossing tenants', () => {
    const { gate, manifests, identity } = build({ withVerifier: true });
    // Narrow manifest: pinned to one tenant, wildcard explicitly refused.
    manifests.register(workerManifest({ tenantScopes: ['acme'], allowTenantWildcard: false }));
    const principal = identity.mint('kernel:internal-execution');
    const decision = gate.decide(workerRequest(principal, { tenantId: 'other-tenant' }));
    assert.notEqual(outcome(decision), 'ALLOW', 'the exception must never widen a tenant-pinned manifest');
    assert.ok(
      reasons(decision).some((r) => r === 'TENANT_SUBSTITUTION' || r === 'TENANT_SCOPE_VIOLATION'),
      `expected a tenancy denial, got ${JSON.stringify(reasons(decision))}`,
    );
  });

  it('a VERIFIED kernel worker outside its manifest tool/operation/target is still denied', () => {
    const { gate, manifests, identity } = build({ withVerifier: true });
    manifests.register(workerManifest());
    const principal = identity.mint('kernel:internal-execution');

    const wrongTool = gate.decide(workerRequest(principal, { tool: 'other-tool' }));
    assert.notEqual(outcome(wrongTool), 'ALLOW', 'a different tool is out of scope');

    const wrongOperation = gate.decide(workerRequest(principal, { operation: 'DELETE_EVERYTHING' }));
    assert.notEqual(outcome(wrongOperation), 'ALLOW', 'a different operation is out of scope');

    const wrongTarget = gate.decide(
      workerRequest(principal, { target: { system: 'production-banking', resource: 'res-1' } }),
    );
    assert.notEqual(outcome(wrongTarget), 'ALLOW', 'a different target system is out of scope');
  });

  it('a VERIFIED kernel principal with NO matching manifest is denied UNKNOWN_CAPABILITY', () => {
    const { gate, identity } = build({ withVerifier: true });
    const principal = identity.mint('kernel:internal-execution');
    const decision = gate.decide(workerRequest(principal));
    assert.notEqual(outcome(decision), 'ALLOW');
    assert.ok(reasons(decision).includes('UNKNOWN_CAPABILITY'), JSON.stringify(reasons(decision)));
  });

  it('DEFAULT (no verifier configured): NO principal is ever treated as a kernel worker', () => {
    const { gate, manifests, identity } = build({ withVerifier: false });
    manifests.register(workerManifest());
    // Even a genuinely minted principal gets no relief when the gate was given
    // no way to verify it. The default is strictly the stricter one.
    const principal = identity.mint('kernel:internal-execution');
    const decision = gate.decide(workerRequest(principal));
    assert.notEqual(outcome(decision), 'ALLOW', 'without a verifier the tenancy exception must not engage');
    assert.ok(reasons(decision).includes('TENANT_SUBSTITUTION'), JSON.stringify(reasons(decision)));
  });

  it('the exception is scope-specific: a principal minted for another scope does not qualify', () => {
    const manifests = new CapabilityManifestRegistry();
    const identity = new KernelInternalIdentity();
    const gate = new AuthorizationGate({
      now: () => T0,
      manifests,
      audit: new InMemoryAuditSink(),
      policyVersion: 'test-policy',
      // Verifier demands the internal-execution scope specifically.
      verifyKernelPrincipal: (p: unknown) => identity.verify(p as never, 'kernel:internal-execution'),
    });
    manifests.register(workerManifest());
    const bootstrapOnly = identity.mint('kernel:bootstrap');
    const decision = gate.decide(workerRequest(bootstrapOnly));
    assert.notEqual(outcome(decision), 'ALLOW', 'a bootstrap-scoped principal cannot execute worker actions');
  });
});
