import type { CommercialActor, CommercialProvenance } from '@jataqi/commercial-control-plane';

export type ReproducibilityKind = 'EXPERIMENT' | 'SIMULATION' | 'BENCHMARK' | 'ANALYSIS' | 'MODEL_EVALUATION';
export type ReproducibilityStatus = 'RECORDED' | 'REPRODUCIBLE' | 'MISMATCH' | 'INCOMPLETE';

export interface VersionedReference {
  id: string;
  version: string;
  contentHash?: string;
}

export interface ReproducibilityRecord {
  id: string;
  tenantId: string;
  projectId?: string;
  kind: ReproducibilityKind;
  datasetReferences: VersionedReference[];
  algorithm: VersionedReference;
  environment: VersionedReference;
  parameters: Record<string, unknown>;
  deterministic: boolean;
  randomSeed?: string;
  inputFingerprint: string;
  outputHash: string;
  benchmarkReference?: string;
  status: ReproducibilityStatus;
  provenance: CommercialProvenance;
  createdAt: number;
  updatedAt: number;
}

export interface RecordReproducibilityInput {
  projectId?: string;
  kind: ReproducibilityKind;
  datasetReferences: VersionedReference[];
  algorithm: VersionedReference;
  environment: VersionedReference;
  parameters: Record<string, unknown>;
  deterministic: boolean;
  randomSeed?: string;
  output: unknown;
  benchmarkReference?: string;
  provenance: CommercialProvenance;
}

export interface ReplicationAttempt {
  id: string;
  tenantId: string;
  recordId: string;
  inputFingerprint: string;
  outputHash: string;
  status: ReproducibilityStatus;
  reason?: string;
  provenance: CommercialProvenance;
  createdAt: number;
}

export interface VerifyReproducibilityInput {
  datasetReferences: VersionedReference[];
  algorithm: VersionedReference;
  environment: VersionedReference;
  parameters: Record<string, unknown>;
  deterministic: boolean;
  randomSeed?: string;
  output: unknown;
  provenance: CommercialProvenance;
}

export const ReproducibilityEvents = Object.freeze({
  Recorded: 'jqb.reproducibility.recorded',
  Verified: 'jqb.reproducibility.verified',
  Mismatch: 'jqb.reproducibility.mismatch',
} as const);

export type { CommercialActor };
