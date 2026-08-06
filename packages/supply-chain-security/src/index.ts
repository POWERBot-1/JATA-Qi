// @jataqi/supply-chain-security — Software Supply Chain Governance. Public API.

export { SupplyChainSecurityModule, SupplyChainSecurityEvents } from './supply-chain-security-module.js';
export { SupplyChainSecurityEngine, DEFAULT_REPO_POLICY, DEFAULT_CI_POLICY, DEFAULT_LICENSE_POLICY, DEFAULT_ADVISORIES } from './engine.js';
export type {
  RepoStatus, DepVerdict, ProvenanceStatus, ReleaseStatus, DeploymentStatus,
  RepositoryPolicy, RepositoryCheck, CiPolicy, CiPipelineCheck,
  DependencyRecord, Advisory, DependencyAuditResult, LockfileAudit, LicensePolicy,
  ProvenanceMaterial, ArtifactProvenance, ReleaseRecord, DeploymentAttestation, IntegrityCheck,
} from './types.js';
