// A-01 module: kernel composition wiring (container tokens), durable
// privacy-safe audit on storage, and the fail-closed audit-sink latch.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';

import {
  AUTHORIZATION_AUDIT_TOKEN,
  AUTHORIZATION_BROKER_TOKEN,
  AUTHORIZATION_DECISIONS_COLLECTION,
  AUTHORIZATION_GATE_TOKEN,
  AUTHORIZATION_MANIFESTS_TOKEN,
  AuthorizationBoundaryModule,
  AuthorizationDeniedError,
  type AuthorizationGate,
  type A01AuditRecord,
  type A01AuditSink,
} from '../src/index.js';
import { T0, baseRequest, makeApproval, manifest } from './helpers.js';

function boot(options: { durableAudit?: boolean } = {}) {
  const kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(
    new AuthorizationBoundaryModule({
      policyVersion: 'test-policy',
      now: () => T0,
      ...(options.durableAudit !== undefined ? { durableAudit: options.durableAudit } : {}),
    }),
  );
  return kernel;
}

describe('A-01 module wiring', () => {
  it('installs the gate, manifests, and audit sink on container tokens', async () => {
    const kernel = boot();
    await kernel.boot();
    assert.equal(kernel.container.has(AUTHORIZATION_GATE_TOKEN), true);
    assert.equal(kernel.container.has(AUTHORIZATION_MANIFESTS_TOKEN), true);
    assert.equal(kernel.container.has(AUTHORIZATION_AUDIT_TOKEN), true);
    // No broker configured -> no broker token (the composition must not invent one).
    assert.equal(kernel.container.has(AUTHORIZATION_BROKER_TOKEN), false);
    const gate = kernel.container.resolveSync<AuthorizationGate>(AUTHORIZATION_GATE_TOKEN);
    const mod = kernel.getModule<AuthorizationBoundaryModule>('authorization-boundary');
    assert.equal(gate, mod.getService());
    await kernel.shutdown();
  });

  it('writes durable, privacy-safe audit records to storage and they survive the decision', async () => {
    const kernel = boot();
    await kernel.boot();
    const gate = kernel.container.resolveSync<AuthorizationGate>(AUTHORIZATION_GATE_TOKEN);
    gate.manifestsRegistry.register(manifest());
    gate.decide(baseRequest());
    gate.decide(baseRequest({ capability: { capabilityId: 'cap.unknown', capabilityVersion: '1' } }));
    // Durable audit writes are async; let them settle before reading back.
    await new Promise((resolve) => setTimeout(resolve, 25));

    const storage = kernel.getModule<StorageModule>('storage');
    const collection = await storage.collection<{ id: string }>(AUTHORIZATION_DECISIONS_COLLECTION);
    const records = (await collection.all()) as unknown as A01AuditRecord[];
    assert.equal(records.length, 2, 'every decision (ALLOW and DENY) is durably audited');
    const allow = records.find((r) => r.decision === 'ALLOW');
    assert.ok(allow, 'ALLOW record persisted');
    assert.equal(allow?.principalId, 'user:alice');
    assert.equal(allow?.tenantId, 'acme');
    assert.equal(allow?.agentId, 'agent-research');
    assert.equal(allow?.runId, 'run-1');
    assert.equal(allow?.capabilityId, 'cap.test');
    assert.equal(allow?.tool, 'test-tool');
    assert.equal(allow?.operation, 'do');
    assert.equal(allow?.targetSystem, 'test-system');
    assert.equal(allow?.targetResource, 'res-1');
    assert.equal(allow?.policyVersion, 'test-policy');
    assert.equal(allow?.decidedAt, T0);
    const denied = records.find((r) => r.decision === 'DENY');
    assert.ok(denied, 'DENY record persisted');
    assert.ok(denied?.reasonCodes.includes('UNKNOWN_CAPABILITY'));
    // Privacy-safe: no free-form fields, no secrets.
    for (const record of records) {
      assert.equal(JSON.stringify(record).includes('secret'), false);
    }
    await kernel.shutdown();
  });

  it('durableAudit: false keeps the decision path in-memory only', async () => {
    const kernel = boot({ durableAudit: false });
    await kernel.boot();
    const gate = kernel.container.resolveSync<AuthorizationGate>(AUTHORIZATION_GATE_TOKEN);
    gate.manifestsRegistry.register(manifest());
    const env = gate.decide(baseRequest());
    assert.equal(env.decision.decision, 'ALLOW');
    const storage = kernel.getModule<StorageModule>('storage');
    const collection = await storage.collection<{ id: string }>(AUTHORIZATION_DECISIONS_COLLECTION);
    assert.equal((await collection.all()).length, 0, 'no durable records without durable audit');
    await kernel.shutdown();
  });

  it('a failing durable audit sink fails the boundary CLOSED (no silent audit loss)', async () => {
    const { AuthorizationGate, InMemoryAuditSink } = await import('../src/index.js');
    class AsyncBrokenSink implements A01AuditSink {
      async record(_record: A01AuditRecord): Promise<void> {
        throw new Error('audit store unavailable');
      }
    }
    class SyncBrokenSink implements A01AuditSink {
      record(_record: A01AuditRecord): void {
        throw new Error('audit store unavailable (sync)');
      }
    }

    // Async-rejecting durable sink: the decision is sealed, but execution
    // must NOT run the side effect — the durable write is awaited and fails.
    const asyncGate = new AuthorizationGate({ now: () => T0, audit: new AsyncBrokenSink(), policyVersion: 'test' });
    asyncGate.manifestsRegistry.register(manifest());
    const env = asyncGate.decide(baseRequest());
    assert.equal(env.decision.decision, 'ALLOW', 'the sealed decision is produced');
    let sideEffectRuns = 0;
    const spy = async (): Promise<string> => {
      sideEffectRuns += 1;
      return 'should-never-run';
    };
    await assert.rejects(
      () => asyncGate.executeAuthorized(env, spy, { tool: 'test-tool', operation: 'do' }),
      (err: unknown) => err instanceof AuthorizationDeniedError && err.reasons.includes('AUDIT_UNAVAILABLE'),
    );
    assert.equal(sideEffectRuns, 0, 'no side effect without durable provenance');
    // The gate is latched closed for everything after it.
    const env2 = asyncGate.decide(baseRequest());
    await assert.rejects(
      () => asyncGate.executeAuthorized(env2, spy, { tool: 'test-tool', operation: 'do' }),
      (err: unknown) => err instanceof AuthorizationDeniedError && err.reasons.includes('AUDIT_UNAVAILABLE'),
    );
    assert.equal(sideEffectRuns, 0);

    // Synchronously-throwing sink: the decision itself fails closed.
    const syncGate = new AuthorizationGate({ now: () => T0, audit: new SyncBrokenSink(), policyVersion: 'test' });
    syncGate.manifestsRegistry.register(manifest());
    assert.throws(
      () => syncGate.decide(baseRequest()),
      (err: unknown) => err instanceof AuthorizationDeniedError && err.reasons.includes('AUDIT_UNAVAILABLE'),
    );

    // A healthy in-memory sink is unaffected (control).
    const healthy = new AuthorizationGate({ now: () => T0, audit: new InMemoryAuditSink(), policyVersion: 'test' });
    healthy.manifestsRegistry.register(manifest());
    const healthyEnv = healthy.decide(baseRequest());
    assert.equal(healthyEnv.decision.decision, 'ALLOW');
    const ok = await healthy.executeAuthorized(healthyEnv, async () => 'fine', { tool: 'test-tool', operation: 'do' });
    assert.equal(ok, 'fine');
  });

  it('module decision respects approval binding end-to-end', async () => {
    const kernel = boot();
    await kernel.boot();
    const gate = kernel.container.resolveSync<AuthorizationGate>(AUTHORIZATION_GATE_TOKEN);
    gate.manifestsRegistry.register(manifest({ requiresApproval: true }));
    const fields = {
      tenantId: 'acme',
      principalId: 'user:alice',
      agentId: 'agent-research',
      runId: 'run-1',
      capabilityId: 'cap.test',
      tool: 'test-tool',
      operation: 'do',
      targetSystem: 'test-system',
      targetResource: 'res-1',
      dataClassification: 'INTERNAL',
      impact: 'EXTERNAL_SIDE_EFFECT',
    };
    const ok = gate.decide(baseRequest({ approval: makeApproval(fields) }));
    assert.equal(ok.decision.decision, 'ALLOW');
    const without = gate.decide(baseRequest());
    assert.equal(without.decision.decision, 'DENY');
    assert.ok(without.decision.reasonCodes.includes('APPROVAL_MISSING'));
    await kernel.shutdown();
  });
});
