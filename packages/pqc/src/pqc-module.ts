// PqcModule — Post-Quantum Readiness kernel module.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { PostQuantumEngine, workloadFingerprint, PHASE_ORDER } from './engine.js';
import { DemoPqProvider } from './demo-provider.js';
import { DEFAULT_PQ_ALGORITHMS } from './catalog.js';
import type {
  CryptoAgilityPolicy, KeyMaterial, MigrationPhase, PqAlgorithm, PqAlgorithmId,
  PqPurpose, PqStatus, SignatureEnvelope,
} from './types.js';

export const PqcEvents = Object.freeze({
  KeyGenerated: 'pqc.key.generated',
  Signed: 'pqc.signed',
  PhaseAdvanced: 'pqc.phase.advanced',
  AlgorithmDeprecated: 'pqc.algorithm.deprecated',
} as const);

/** Register the built-in demo providers (one per catalog algorithm). */
export function defaultProviders(): DemoPqProvider[] {
  return DEFAULT_PQ_ALGORITHMS.map((a) => new DemoPqProvider(a.id));
}

export class PqcModule implements IModule {
  readonly id = 'pqc';
  readonly tags = ['core', 'security', 'cryptography'] as const;
  readonly dependsOn = [] as const;

  readonly engine: PostQuantumEngine;
  private api!: KernelApi;

  constructor(providers?: ReturnType<typeof defaultProviders>) {
    this.engine = new PostQuantumEngine(providers ?? defaultProviders());
  }

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('pqc', this);
    kernel.logger.info('pqc module initialized (post-quantum readiness)');
  }
  async start(_kernel: KernelApi): Promise<void> { /* stateless */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  algorithms(filter?: { purpose?: PqPurpose; status?: PqStatus }) { return this.engine.algorithmsList(filter); }
  deprecate(id: PqAlgorithmId) {
    const algorithm = this.engine.deprecate(id);
    if (algorithm) try { void this.api?.bus.emit(PqcEvents.AlgorithmDeprecated, { id }); } catch { /* noop */ }
    return algorithm;
  }
  pendingDeprecations() { return this.engine.pendingDeprecations(); }

  generateKey(input: { algorithm: PqAlgorithmId; purpose: PqPurpose; hybridWith?: PqAlgorithmId }): KeyMaterial {
    const key = this.engine.generateKey(input);
    try { void this.api?.bus.emit(PqcEvents.KeyGenerated, { id: key.id, algorithm: key.algorithm, purpose: key.purpose }); } catch { /* noop */ }
    return key;
  }
  keys(filter?: { purpose?: PqPurpose; hybrid?: boolean }) { return this.engine.keysList(filter); }
  exportPublicKeys() { return this.engine.exportPublicKeys(); }

  sign(input: { workload: string; algorithm: PqAlgorithmId; payload: string; privateKey: string }): SignatureEnvelope {
    const envelope = this.engine.sign(input);
    try { void this.api?.bus.emit(PqcEvents.Signed, { id: envelope.id, workload: envelope.workload, hybrid: envelope.hybrid }); } catch { /* noop */ }
    return envelope;
  }
  verifyEnvelope(envelope: SignatureEnvelope, payload: string, publicKey: string) { return this.engine.verifyEnvelope(envelope, payload, publicKey); }
  signatures(filter?: { workload?: string; hybrid?: boolean }) { return this.engine.signaturesList(filter); }

  setPolicy(policy: Partial<CryptoAgilityPolicy>) { return this.engine.setPolicy(policy); }
  policy() { return this.engine.policyValue(); }
  phase() { return this.engine.currentPhase(); }
  advancePhase(workloads: string[], force = false) {
    const phase = this.engine.advancePhase(workloads, Date.now(), force);
    if (phase) try { void this.api?.bus.emit(PqcEvents.PhaseAdvanced, { phase, workloads }); } catch { /* noop */ }
    return phase;
  }
  completePhase(phase: MigrationPhase) { this.engine.completePhase(phase); }
  migrationHistory() { return this.engine.migrationHistory(); }

  stats() { return this.engine.stats(); }
}

export { PostQuantumEngine, workloadFingerprint, PHASE_ORDER, DEFAULT_AGILITY_POLICY } from './engine.js';
export { DemoPqProvider } from './demo-provider.js';
export { DEFAULT_PQ_ALGORITHMS } from './catalog.js';

export type { PqProvider } from './engine.js';
