// Software Supply Chain Governance — types.

export type RepoStatus = 'compliant' | 'non_compliant';
export type DepVerdict = 'verified' | 'unknown' | 'known_vulnerable' | 'license_denied' | 'integrity_mismatch';
export type ProvenanceStatus = 'verified' | 'unverified' | 'signature_invalid';
export type ReleaseStatus = 'signed' | 'unsigned' | 'signature_invalid';
export type DeploymentStatus = 'verified' | 'mismatch' | 'unattested';

export interface RepositoryPolicy {
  /** Branches that must be protected (no direct pushes). */
  protectedBranches: string[];
  /** Require signed commits on protected branches. */
  requireSignedCommits: boolean;
  /** Require a passing CI check before merge. */
  requireCi: boolean;
  /** Min reviewers for a merge. */
  minReviewers: number;
}

export interface RepositoryCheck {
  repo: string;
  policy: RepositoryPolicy;
  status: RepoStatus;
  violations: string[];
  checkedAt: number;
}

export interface CiPolicy {
  /** Build steps must be pinned to immutable references (sha or tag). */
  requirePinnedSteps: boolean;
  /** Steps must not contain secret material. */
  forbidSecrets: boolean;
  /** Approvals required for protected pipelines. */
  requireApproval: boolean;
}

export interface CiPipelineCheck {
  pipeline: string;
  policy: CiPolicy;
  status: RepoStatus;
  violations: string[];
  checkedAt: number;
}

export interface DependencyRecord {
  /** e.g. 'lodash@4.17.21'. */
  name: string;
  /** Expected SHA-512 of the resolved tarball/package. */
  integritySha512: string;
  /** Declared license identifier. */
  license?: string;
}

export interface Advisory {
  /** Package name pattern (exact or prefix). */
  package: string;
  /** Affected version constraint, e.g. '4.17.x' or '<5'. */
  versions: string;
  cveId: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  summary: string;
}

export interface DependencyAuditResult {
  name: string;
  verdict: DepVerdict;
  reason?: string;
  cveId?: string;
  severity?: string;
  license?: string;
  advisory?: string;
}

export interface LockfileAudit {
  checkedAt: number;
  results: DependencyAuditResult[];
  verified: number;
  vulnerable: number;
  licenseDenied: number;
  mismatches: number;
  ok: boolean;
}

export interface LicensePolicy {
  /** License IDs allowed for production dependencies. */
  allowed: string[];
  /** License IDs that are forbidden outright. */
  denied: string[];
}

export interface ProvenanceMaterial {
  /** Repository or source reference. */
  uri: string;
  /** Commit or tag digest. */
  digest: string;
}

export interface ArtifactProvenance {
  id: string;
  artifactName: string;
  /** SHA-256 of the artifact bytes. */
  artifactSha256: string;
  builderId: string;
  buildId: string;
  materials: ProvenanceMaterial[];
  /** Ed25519 signature over the provenance payload. */
  signature?: string;
  createdAt: number;
}

export interface ReleaseRecord {
  id: string;
  release: string;
  artifactName: string;
  artifactSha256: string;
  notes?: string;
  /** Ed25519 signature over the release payload. */
  signature?: string;
  signedAt?: number;
  verified?: boolean;
}

export interface DeploymentAttestation {
  id: string;
  environment: string;
  artifactName: string;
  artifactSha256: string;
  deployer: string;
  verified: boolean;
  attestedAt: number;
}

export interface IntegrityCheck {
  checkedAt: number;
  release: string;
  artifactSha256: string;
  deployedSha256?: string;
  status: 'match' | 'drift' | 'missing';
}
