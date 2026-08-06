// Post-Quantum Readiness — types.

/** NIST / industry PQ algorithm families (standardization track). */
export type PqAlgorithmId =
  | 'kyber-512' | 'kyber-768' | 'kyber-1024'
  | 'dilithium2' | 'dilithium3' | 'dilithium5'
  | 'sphincs+-128s' | 'sphincs+-192s' | 'sphincs+-256s'
  | 'classic' // classic pre-quantum algorithm (RSA/ECDSA/Ed25519)
  | 'custom';

export type PqStatus = 'classic' | 'nist_standardized' | 'candidate' | 'deprecated' | 'research';
export type PqPurpose = 'kem' | 'signature';

export interface PqAlgorithm {
  id: PqAlgorithmId;
  name: string;
  family: 'lattice' | 'hash-based' | 'code-based' | 'classic';
  purpose: PqPurpose;
  status: PqStatus;
  /** NIST security category 1..5 (0 for classic). */
  nistCategory: number;
  /** Key size (bytes) for the primary key type. */
  keySizeBytes: number;
  /** When this algorithm was marked deprecated (for schedule). */
  deprecatedAt?: number;
  /** Notes (standardization references). */
  notes?: string;
}

export interface KeyMaterial {
  id: string;
  algorithm: PqAlgorithmId;
  purpose: PqPurpose;
  publicKey: string;   // base64
  privateKey?: string; // base64 (never exported)
  /** Hybrid: the classic counterpart key id. */
  hybridWith?: string;
  createdAt: number;
  /** Migration phase at creation. */
  phase: MigrationPhase;
}

export type MigrationPhase = 'inventory' | 'dual_run' | 'hybrid' | 'pq_only';

export interface MigrationStep {
  phase: MigrationPhase;
  startedAt: number;
  /** Workloads migrated in this phase. */
  migrated: string[];
  completed: boolean;
}

export interface CryptoAgilityPolicy {
  /** Require hybrid signatures (classic + PQ) for workloads in hybrid phase. */
  requireHybridSignatures: boolean;
  /** Automatically phase-advance when the schedule says so. */
  autoAdvance: boolean;
  /** Minimum days between phase transitions. */
  minPhaseDays: number;
}

export interface SignatureEnvelope {
  id: string;
  workload: string;
  algorithm: PqAlgorithmId;
  /** Base64 signature payload. */
  signature: string;
  /** When hybrid, the classic signature of the same payload. */
  classicSignature?: string;
  /** Classic verification key (hybrid envelopes carry their own). */
  classicPublicKey?: string;
  hybrid: boolean;
  signedAt: number;
  verified?: boolean;
}

export interface PqcStats {
  algorithms: number;
  pqAlgorithms: number;
  keys: number;
  hybridKeys: number;
  signatures: number;
  hybridSignatures: number;
  phase: MigrationPhase;
  migratedWorkloads: string[];
  pendingDeprecations: string[];
}
