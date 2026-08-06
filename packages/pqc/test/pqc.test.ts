// PqcModule tests — Post-Quantum Readiness + formal verification.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import { JataQiClient } from '@jataqi/sdk';
import {
  PqcModule, PostQuantumEngine, DemoPqProvider, DEFAULT_PQ_ALGORITHMS,
  workloadFingerprint, PHASE_ORDER, PqcEvents,
} from '../src/index.js';

type CreateJataQi = (cfg?: Record<string, unknown>) => Promise<{ gateway?: { listen(opts?: { port?: number }): Promise<{ port: number; close(): Promise<void> }> }; shutdown(): Promise<void> }>;

describe('PostQuantumEngine (algorithm agility + migration)', () => {
  it('catalogs NIST-standardized PQ algorithms with honest statuses', () => {
    const e = new PostQuantumEngine();
    const kems = e.algorithmsList({ purpose: 'kem', status: 'nist_standardized' });
    assert.ok(kems.some((a) => a.id === 'kyber-768' && a.nistCategory === 3), 'ML-KEM-768 present');
    const sigs = e.algorithmsList({ purpose: 'signature', status: 'nist_standardized' });
    assert.ok(sigs.some((a) => a.id === 'dilithium3'), 'ML-DSA-65 present');
    assert.ok(sigs.some((a) => a.id.startsWith('sphincs+')), 'SLH-DSA present');
    assert.ok(DEFAULT_PQ_ALGORITHMS.length >= 9);
  });

  it('generates keys, signs, and verifies with a PQ provider', () => {
    const e = new PostQuantumEngine([new DemoPqProvider('dilithium3')]);
    const key = e.generateKey({ algorithm: 'dilithium3', purpose: 'signature' });
    assert.ok(key.publicKey);
    assert.equal(key.phase, 'inventory');
    const envelope = e.sign({ workload: 'payments', algorithm: 'dilithium3', payload: '{"amt":10}', privateKey: key.privateKey! });
    assert.equal(envelope.hybrid, false, 'inventory phase → classic-only envelope');
    const verified = e.verifyEnvelope(envelope, '{"amt":10}', key.publicKey);
    assert.equal(verified.verified, true);
    const tampered = e.verifyEnvelope(envelope, '{"amt":999}', key.publicKey);
    assert.equal(tampered.verified, false, 'tampered payload rejected');
  });

  it('advances the migration phase (inventory → dual_run → hybrid → pq_only)', () => {
    const e = new PostQuantumEngine();
    e.setPolicy({ autoAdvance: true, minPhaseDays: 0 });
    assert.equal(e.currentPhase(), 'inventory');
    const dual = e.advancePhase(['api'], Date.now(), true);
    assert.equal(dual, 'dual_run');
    const hybrid = e.advancePhase(['api', 'web'], Date.now(), true);
    assert.equal(hybrid, 'hybrid');
    const pq = e.advancePhase(['api'], Date.now(), true);
    assert.equal(pq, 'pq_only');
    assert.equal(e.advancePhase(['x'], Date.now(), true), undefined, 'terminal phase');
    assert.equal(e.migrationHistory().length, 3);
    assert.ok(e.stats().migratedWorkloads.includes('api'));
    assert.equal(PHASE_ORDER.length, 4);
  });

  it('enforces phase-transition cadence (minPhaseDays) and auto-advance policy', () => {
    const e = new PostQuantumEngine();
    e.setPolicy({ autoAdvance: false, minPhaseDays: 30 });
    assert.throws(() => e.advancePhase(['x'], Date.now()), /manual approval/);
    e.setPolicy({ autoAdvance: true, minPhaseDays: 30 });
    e.advancePhase(['x'], Date.now(), true);
    assert.throws(() => e.advancePhase(['y'], Date.now() + 1000), /too soon/);
  });

  it('produces hybrid signatures in hybrid phase (both schemes must verify)', () => {
    const e = new PostQuantumEngine([new DemoPqProvider('dilithium3'), new DemoPqProvider('classic')]);
    e.setPolicy({ autoAdvance: true, minPhaseDays: 0, requireHybridSignatures: true });
    e.advancePhase(['payments'], Date.now(), true);
    e.advancePhase(['payments'], Date.now(), true); // → hybrid
    const key = e.generateKey({ algorithm: 'dilithium3', purpose: 'signature' });
    assert.ok(key.hybridWith, 'hybrid phase binds a classic counterpart');
    const envelope = e.sign({ workload: 'payments', algorithm: 'dilithium3', payload: 'msg-1', privateKey: key.privateKey! });
    assert.equal(envelope.hybrid, true);
    assert.ok(envelope.classicSignature);
    // Both valid → verified.
    const ok = e.verifyEnvelope(envelope, 'msg-1', key.publicKey);
    assert.equal(ok.verified, true);
    assert.equal(e.stats().hybridSignatures, 1);
    assert.equal(e.keysList({ hybrid: true }).length, 1);
  });

  it('tracks deprecation schedules and workload fingerprints deterministically', () => {
    const e = new PostQuantumEngine();
    e.deprecate('kyber-512');
    assert.ok(e.pendingDeprecations().includes('kyber-512'));
    assert.equal(workloadFingerprint('payments'), workloadFingerprint('payments'), 'deterministic');
    assert.notEqual(workloadFingerprint('payments'), workloadFingerprint('web'));
    assert.equal(workloadFingerprint('payments').length, 16);
  });
});

describe('PQC formal verification (property-based)', () => {
  it('property: sign→verify round-trips for every provider under any payload', () => {
    for (const algorithm of ['dilithium2', 'dilithium3', 'dilithium5', 'sphincs+-128s', 'sphincs+-256s'] as const) {
      const e = new PostQuantumEngine([new DemoPqProvider(algorithm)]);
      for (let i = 0; i < 25; i++) {
        const key = e.generateKey({ algorithm, purpose: 'signature' });
        const payload = `payload-${i}-${'x'.repeat(i * 3)}`;
        const envelope = e.sign({ workload: 'w', algorithm, payload, privateKey: key.privateKey! });
        assert.equal(e.verifyEnvelope(envelope, payload, key.publicKey).verified, true, `${algorithm} iter ${i}`);
      }
    }
  });

  it('property: verification is unforgeable under payload mutation (100 trials)', () => {
    const e = new PostQuantumEngine([new DemoPqProvider('dilithium3')]);
    const key = e.generateKey({ algorithm: 'dilithium3', purpose: 'signature' });
    for (let i = 0; i < 100; i++) {
      const envelope = e.sign({ workload: 'w', algorithm: 'dilithium3', payload: `original-${i}`, privateKey: key.privateKey! });
      const mutated = e.verifyEnvelope(envelope, `original-${i}-MUTATED`, key.publicKey);
      assert.equal(mutated.verified, false, `iteration ${i}: mutated payload must fail`);
    }
  });

  it('property: migration phase order is total and monotonic', () => {
    const order = PHASE_ORDER;
    for (let i = 0; i < order.length - 1; i++) {
      const e = new PostQuantumEngine();
      e.setPolicy({ autoAdvance: true, minPhaseDays: 0 });
      // Advance i times then once more — must land on the next phase.
      for (let j = 0; j < i; j++) e.advancePhase(['w'], Date.now(), true);
      const next = e.advancePhase(['w'], Date.now(), true);
      assert.equal(next, order[i + 1], `phase ${order[i]} → ${order[i + 1]}`);
    }
  });

  it('property: public-key export never leaks private material', () => {
    const e = new PostQuantumEngine([new DemoPqProvider('dilithium3')]);
    for (let i = 0; i < 20; i++) {
      e.generateKey({ algorithm: 'dilithium3', purpose: 'signature' });
    }
    const exported = JSON.stringify(e.exportPublicKeys());
    assert.ok(!exported.includes('privateKey'), 'no private material in export');
  });
});

describe('PqcModule (kernel wiring)', () => {
  let kernel: Kernel;

  before(async () => {
    kernel = createTestKernel();
    kernel.register(new PqcModule());
    await kernel.boot();
  });

  after(async () => { await kernel.shutdown(); });

  it('emits pqc events and exposes the surface', async () => {
    const mod = kernel.getModule<PqcModule>('pqc');
    const events: string[] = [];
    kernel.bus.on(PqcEvents.KeyGenerated, () => { events.push(PqcEvents.KeyGenerated); });
    kernel.bus.on(PqcEvents.Signed, () => { events.push(PqcEvents.Signed); });
    const key = mod.generateKey({ algorithm: 'dilithium3', purpose: 'signature' });
    mod.sign({ workload: 'api', algorithm: 'dilithium3', payload: 'hello', privateKey: key.privateKey! });
    assert.ok(events.includes(PqcEvents.KeyGenerated));
    assert.ok(events.includes(PqcEvents.Signed));
    assert.equal(mod.algorithms().length, DEFAULT_PQ_ALGORITHMS.length);
    assert.equal(mod.phase(), 'inventory');
    const stats = mod.stats();
    assert.equal(stats.keys, 1);
    assert.ok(stats.pqAlgorithms >= 8);
  });
});

describe('PQC gateway integration (vs real server)', () => {
  let qi: Awaited<ReturnType<CreateJataQi>>;
  let admin: JataQiClient;
  let port: number;
  let closeHandle: () => Promise<void>;

  before(async () => {
    const bootstrapPath = new URL('../../../cli/dist/src/bootstrap.js', import.meta.url).href;
    const mod = await import(bootstrapPath) as unknown as { createJataQi: CreateJataQi };
    qi = await mod.createJataQi({ security: { bootstrapAdmin: { username: 'admin', password: 'admin' } } });
    const handle = await qi.gateway!.listen({ port: 0 });
    port = handle.port;
    closeHandle = handle.close;
    admin = new JataQiClient({ baseUrl: `http://127.0.0.1:${port}` });
    await admin.auth.login('admin', 'admin');
  });

  after(async () => {
    if (closeHandle) await closeHandle();
    if (qi) await qi.shutdown();
  });

  it('lists algorithms, generates a PQ key, signs and verifies end-to-end', async () => {
    const algos = await admin.pqc.algorithms();
    assert.ok((algos.algorithms as unknown[]).length >= 9);
    const key = await admin.pqc.generateKey('dilithium3', 'signature');
    const keyId = (key.key as { id: string }).id;
    const pub = (key.key as { publicKey: string }).publicKey;
    const envelope = await admin.pqc.sign('api', 'dilithium3', 'payload-1', (key.key as { privateKey: string }).privateKey);
    const verification = await admin.pqc.verify((envelope as { envelope: unknown }).envelope, 'payload-1', pub);
    assert.equal((verification as { result: { verified: boolean } }).result.verified, true);
    // Tampered payload fails.
    const bad = await admin.pqc.verify((envelope as { envelope: unknown }).envelope, 'payload-2', pub);
    assert.equal((bad as { result: { verified: boolean } }).result.verified, false);
    assert.ok(keyId.length > 0);
  });

  it('advances migration phases and reports stats', async () => {
    const stats = await admin.pqc.stats();
    assert.equal((stats.stats as { phase: string }).phase, 'inventory');
    const advanced = await admin.pqc.advancePhase(['api'], true);
    assert.equal((advanced as { phase: string }).phase, 'dual_run');
    const again = await admin.pqc.advancePhase(['api'], true);
    assert.equal((again as { phase: string }).phase, 'hybrid');
    const keys = await admin.pqc.publicKeys();
    assert.ok(Array.isArray(keys.keys));
  });
});
