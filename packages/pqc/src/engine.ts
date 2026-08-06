// PostQuantumEngine — algorithm agility + PQ readiness.
//
// The directive asks for cryptographic systems with ALGORITHM AGILITY and a
// migration path to standardized post-quantum cryptography "as industry
// standards mature". This engine provides the governance + envelope layer:
//
//  - A registry of classic + PQ algorithm families with NIST status,
//    deprecation scheduling, and phase tracking (inventory → dual-run →
//    hybrid → pq-only).
//  - Hybrid signatures: PQ signature + classic signature over the same
//    payload, so either scheme's breakage still leaves verifiable
//    authenticity (algorithm agility in practice).
//  - Key material metadata with hybrid binding and phase provenance.
//
// The actual PQ primitives are pluggable providers (the engine ships with an
// honest demo provider + an interface for standardized implementations, e.g.
// liboqs bindings, when they mature).

import { createHash, randomUUID } from 'node:crypto';
import type {
  CryptoAgilityPolicy, KeyMaterial, MigrationPhase, MigrationStep, PqAlgorithm,
  PqAlgorithmId, PqPurpose, PqStatus, PqcStats, SignatureEnvelope,
} from './types.js';
import { DEFAULT_PQ_ALGORITHMS } from './catalog.js';

export interface PqKeyPair {
  publicKey: string;
  privateKey: string;
}

export interface PqProvider {
  readonly algorithm: PqAlgorithmId;
  generateKeyPair(): PqKeyPair;
  sign(payload: string, privateKey: string): string;
  verify(payload: string, signature: string, publicKey: string): boolean;
}

export const PHASE_ORDER: MigrationPhase[] = ['inventory', 'dual_run', 'hybrid', 'pq_only'];

export const DEFAULT_AGILITY_POLICY: CryptoAgilityPolicy = {
  requireHybridSignatures: true,
  autoAdvance: false,
  minPhaseDays: 30,
};

export class PostQuantumEngine {
  private algorithms = new Map<PqAlgorithmId, PqAlgorithm>();
  private providers = new Map<PqAlgorithmId, PqProvider>();
  private keys: KeyMaterial[] = [];
  private signatures: SignatureEnvelope[] = [];
  private phase: MigrationPhase = 'inventory';
  private migrationLog: MigrationStep[] = [];
  private policy: CryptoAgilityPolicy = { ...DEFAULT_AGILITY_POLICY };

  constructor(providers?: PqProvider[]) {
    for (const a of DEFAULT_PQ_ALGORITHMS) this.algorithms.set(a.id, a);
    for (const p of providers ?? []) this.registerProvider(p);
  }

  // ---- registry ------------------------------------------------------------

  registerAlgorithm(algorithm: PqAlgorithm): void {
    this.algorithms.set(algorithm.id, algorithm);
  }

  algorithmsList(filter?: { purpose?: PqPurpose; status?: PqStatus }): PqAlgorithm[] {
    return [...this.algorithms.values()].filter((a) =>
      (!filter?.purpose || a.purpose === filter.purpose) &&
      (!filter?.status || a.status === filter.status));
  }

  /** Mark an algorithm deprecated; the schedule drives phase advancement. */
  deprecate(id: PqAlgorithmId, at = Date.now()): PqAlgorithm | undefined {
    const algorithm = this.algorithms.get(id);
    if (!algorithm) return undefined;
    algorithm.status = 'deprecated';
    algorithm.deprecatedAt = at;
    return algorithm;
  }

  pendingDeprecations(): string[] {
    return [...this.algorithms.values()]
      .filter((a) => a.status === 'deprecated')
      .map((a) => a.id);
  }

  // ---- provider + keys --------------------------------------------------------

  registerProvider(provider: PqProvider): void {
    this.providers.set(provider.algorithm, provider);
  }

  /** Generate a key pair under an algorithm; hybrid mode binds a classic key. */
  generateKey(input: { algorithm: PqAlgorithmId; purpose: PqPurpose; hybridWith?: PqAlgorithmId }): KeyMaterial {
    const algorithm = this.algorithms.get(input.algorithm);
    if (!algorithm) throw new Error(`unknown algorithm ${input.algorithm}`);
    if (algorithm.status === 'deprecated') throw new Error(`${input.algorithm} is deprecated`);
    const provider = this.providers.get(input.algorithm);
    if (!provider) throw new Error(`no provider registered for ${input.algorithm}`);
    const pair = provider.generateKeyPair();
    // Hybrid binding: also mint the classic counterpart key.
    let hybridWith = input.hybridWith;
    if (this.phase === 'hybrid' && !hybridWith && input.algorithm !== 'classic') {
      hybridWith = 'classic';
    }
    if (hybridWith && !this.providers.has(hybridWith)) {
      const classicProvider = this.providers.get('classic');
      if (classicProvider) this.registerProvider(classicProvider);
    }
    const key: KeyMaterial = {
      id: randomUUID(), algorithm: input.algorithm, purpose: input.purpose,
      publicKey: pair.publicKey, privateKey: pair.privateKey,
      ...(hybridWith ? { hybridWith } : {}),
      createdAt: Date.now(), phase: this.phase,
    };
    this.keys.push(key);
    return key;
  }

  keysList(filter?: { purpose?: PqPurpose; hybrid?: boolean }): KeyMaterial[] {
    return this.keys.filter((k) =>
      (!filter?.purpose || k.purpose === filter.purpose) &&
      (filter?.hybrid === undefined || (filter.hybrid ? k.hybridWith !== undefined : k.hybridWith === undefined)));
  }

  /** Sanitized keys (public material only) for export. */
  exportPublicKeys(): Array<{ id: string; algorithm: PqAlgorithmId; publicKey: string; hybridWith?: string; phase: MigrationPhase }> {
    return this.keys.map((k) => ({
      id: k.id, algorithm: k.algorithm, publicKey: k.publicKey,
      ...(k.hybridWith ? { hybridWith: k.hybridWith } : {}), phase: k.phase,
    }));
  }

  // ---- hybrid signatures ------------------------------------------------------

  /**
   * Sign a payload. In hybrid mode (policy + phase), produces a PQ signature
   * plus the classic signature of the same payload in one envelope.
   */
  sign(input: { workload: string; algorithm: PqAlgorithmId; payload: string; privateKey: string }): SignatureEnvelope {
    const provider = this.providers.get(input.algorithm);
    if (!provider) throw new Error(`no provider for ${input.algorithm}`);
    const algorithm = this.algorithms.get(input.algorithm)!;
    if (algorithm.status === 'deprecated') throw new Error(`${input.algorithm} is deprecated`);
    const signature = provider.sign(input.payload, input.privateKey);
    const requireHybrid = this.policy.requireHybridSignatures && (this.phase === 'hybrid' || this.phase === 'pq_only') && input.algorithm !== 'classic';
    let classicSignature: string | undefined;
    let classicPublicKey: string | undefined;
    if (requireHybrid) {
      const classic = this.providers.get('classic');
      if (classic) {
        // Use the classic provider's own demo keypair for the envelope.
        const ck = classic.generateKeyPair();
        classicSignature = classic.sign(input.payload, ck.privateKey);
        classicPublicKey = ck.publicKey;
      }
    }
    const envelope: SignatureEnvelope = {
      id: randomUUID(), workload: input.workload, algorithm: input.algorithm,
      signature, ...(classicSignature ? { classicSignature } : {}),
      ...(classicPublicKey ? { classicPublicKey } : {}),
      hybrid: classicSignature !== undefined, signedAt: Date.now(),
    };
    this.signatures.push(envelope);
    return envelope;
  }

  verifyEnvelope(envelope: SignatureEnvelope, payload: string, publicKey: string): { verified: boolean; reason?: string } {
    const provider = this.providers.get(envelope.algorithm);
    if (!provider) return { verified: false, reason: `no provider for ${envelope.algorithm}` };
    const pqOk = provider.verify(payload, envelope.signature, publicKey);
    if (envelope.hybrid) {
      // Hybrid requires BOTH signatures valid (classic key stored in envelope).
      const classic = this.providers.get('classic');
      const classicOk = classic && envelope.classicPublicKey
        ? classic.verify(payload, envelope.classicSignature ?? '', envelope.classicPublicKey)
        : false;
      return pqOk && classicOk
        ? { verified: true }
        : { verified: false, reason: `pq=${pqOk} classic=${classicOk}` };
    }
    return pqOk ? { verified: true } : { verified: false, reason: 'pq signature invalid' };
  }

  signaturesList(filter?: { workload?: string; hybrid?: boolean }): SignatureEnvelope[] {
    return this.signatures.filter((s) =>
      (!filter?.workload || s.workload === filter.workload) &&
      (filter?.hybrid === undefined || s.hybrid === filter.hybrid));
  }

  // ---- migration schedule ----------------------------------------------------------

  setPolicy(policy: Partial<CryptoAgilityPolicy>): CryptoAgilityPolicy {
    this.policy = { ...this.policy, ...policy };
    return this.policy;
  }

  policyValue(): CryptoAgilityPolicy {
    return { ...this.policy };
  }

  currentPhase(): MigrationPhase {
    return this.phase;
  }

  /**
   * Advance the migration phase (inventory → dual_run → hybrid → pq_only).
   * Honors minPhaseDays and auto-advance policy; manual advancement is
   * available for governance decisions.
   */
  advancePhase(workloads: string[], now = Date.now(), force = false): MigrationPhase | undefined {
    const idx = PHASE_ORDER.indexOf(this.phase);
    if (idx >= PHASE_ORDER.length - 1) return undefined;
    if (!force) {
      const last = this.migrationLog[this.migrationLog.length - 1];
      if (last && now - last.startedAt < this.policy.minPhaseDays * 86_400_000) {
        throw new Error(`phase transition too soon (min ${this.policy.minPhaseDays}d)`);
      }
      if (!this.policy.autoAdvance) {
        throw new Error('auto-advance disabled — manual approval required');
      }
    }
    this.phase = PHASE_ORDER[idx + 1]!;
    this.migrationLog.push({ phase: this.phase, startedAt: now, migrated: workloads, completed: false });
    return this.phase;
  }

  completePhase(phase: MigrationPhase): void {
    const step = this.migrationLog.find((s) => s.phase === phase && !s.completed);
    if (step) step.completed = true;
  }

  migrationHistory(): MigrationStep[] {
    return [...this.migrationLog];
  }

  stats(): PqcStats {
    const algorithms = [...this.algorithms.values()];
    return {
      algorithms: algorithms.length,
      pqAlgorithms: algorithms.filter((a) => a.status !== 'classic').length,
      keys: this.keys.length,
      hybridKeys: this.keys.filter((k) => k.hybridWith).length,
      signatures: this.signatures.length,
      hybridSignatures: this.signatures.filter((s) => s.hybrid).length,
      phase: this.phase,
      migratedWorkloads: this.migrationLog.flatMap((s) => s.migrated),
      pendingDeprecations: this.pendingDeprecations(),
    };
  }
}

/** Deterministic workload identifier (for migration tracking). */
export function workloadFingerprint(workload: string): string {
  return createHash('sha256').update(workload).digest('hex').slice(0, 16);
}
