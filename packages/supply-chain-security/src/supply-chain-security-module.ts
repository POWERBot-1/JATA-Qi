// SupplyChainSecurityModule — kernel module for software supply chain
// governance. Wraps the engine, emits bus events on compliance findings.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { SupplyChainSecurityEngine } from './engine.js';
import type {
  ArtifactProvenance, CiPipelineCheck, DeploymentAttestation, DeploymentStatus,
  IntegrityCheck, LicensePolicy, LockfileAudit, ProvenanceStatus, ReleaseRecord,
  ReleaseStatus, RepositoryCheck, RepositoryPolicy,
} from './types.js';

export const SupplyChainSecurityEvents = Object.freeze({
  RepoNonCompliant: 'supplychain.repo.non_compliant',
  PipelineNonCompliant: 'supplychain.pipeline.non_compliant',
  VulnerabilityFound: 'supplychain.dependency.vulnerable',
  LicenseDenied: 'supplychain.dependency.license_denied',
  IntegrityMismatch: 'supplychain.dependency.integrity_mismatch',
  ReleaseSigned: 'supplychain.release.signed',
  DeploymentMismatch: 'supplychain.deployment.mismatch',
  DriftDetected: 'supplychain.integrity.drift',
} as const);

export class SupplyChainSecurityModule implements IModule {
  readonly id = 'supply-chain-security';
  readonly tags = ['core', 'security', 'governance'] as const;
  readonly dependsOn = [] as const;

  readonly engine = new SupplyChainSecurityEngine();
  private api!: KernelApi;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('supply-chain-security', this);
    kernel.logger.info('supply-chain-security module initialized (software supply chain governance)');
  }
  async start(_kernel: KernelApi): Promise<void> { /* stateless */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  checkRepository(repo: string, facts: { branch: string; signedCommits: boolean; ciPassing: boolean; reviewers: number }, policy?: RepositoryPolicy): RepositoryCheck {
    const check = this.engine.checkRepository(repo, facts, policy);
    if (check.status === 'non_compliant') void this.api?.bus.emit(SupplyChainSecurityEvents.RepoNonCompliant, { repo, violations: check.violations });
    return check;
  }
  repositoryChecks(): RepositoryCheck[] { return this.engine.repositoryChecks(); }

  checkPipeline(pipeline: string, facts: { pinnedSteps: boolean; hasSecrets: boolean; hasApproval: boolean }, policy?: CiPipelineCheck['policy']): CiPipelineCheck {
    const check = this.engine.checkPipeline(pipeline, facts, policy);
    if (check.status === 'non_compliant') void this.api?.bus.emit(SupplyChainSecurityEvents.PipelineNonCompliant, { pipeline, violations: check.violations });
    return check;
  }
  pipelineChecks(): CiPipelineCheck[] { return this.engine.pipelineChecks(); }

  auditLockfile(records: Parameters<SupplyChainSecurityEngine['auditLockfile']>[0], computed: Map<string, string>): LockfileAudit {
    const audit = this.engine.recordAudit(this.engine.auditLockfile(records, computed));
    if (audit.vulnerable > 0) void this.api?.bus.emit(SupplyChainSecurityEvents.VulnerabilityFound, { count: audit.vulnerable });
    if (audit.licenseDenied > 0) void this.api?.bus.emit(SupplyChainSecurityEvents.LicenseDenied, { count: audit.licenseDenied });
    if (audit.mismatches > 0) void this.api?.bus.emit(SupplyChainSecurityEvents.IntegrityMismatch, { count: audit.mismatches });
    return audit;
  }
  addAdvisory(advisory: Parameters<SupplyChainSecurityEngine['addAdvisory']>[0]): void { this.engine.addAdvisory(advisory); }
  setLicensePolicy(policy: LicensePolicy): void { this.engine.setLicensePolicy(policy); }
  static hashPackage(bytes: Uint8Array): string { return SupplyChainSecurityEngine.hashPackage(bytes); }

  createProvenance(input: { artifactName: string; artifactSha256: string; builderId: string; buildId: string; materials: Array<{ uri: string; digest: string }> }): ArtifactProvenance {
    return this.engine.createProvenance(input);
  }
  listProvenances(): ArtifactProvenance[] { return this.engine.listProvenances(); }
  verifyProvenance(id: string): { status: ProvenanceStatus; reason?: string } { return this.engine.verifyProvenance(id); }

  signRelease(input: { release: string; artifactName: string; artifactSha256: string; notes?: string }): ReleaseRecord {
    const release = this.engine.signRelease(input);
    void this.api?.bus.emit(SupplyChainSecurityEvents.ReleaseSigned, { id: release.id, release: release.release });
    return release;
  }
  listReleases(): ReleaseRecord[] { return this.engine.listReleases(); }
  verifyRelease(id: string): { status: ReleaseStatus; reason?: string } { return this.engine.verifyRelease(id); }

  attestDeployment(input: { environment: string; artifactName: string; artifactSha256: string; deployer: string }): { attestation: DeploymentAttestation; status: DeploymentStatus } {
    const result = this.engine.attestDeployment(input);
    if (result.status === 'mismatch') void this.api?.bus.emit(SupplyChainSecurityEvents.DeploymentMismatch, { environment: input.environment, artifactName: input.artifactName });
    return result;
  }
  attestationsList(): DeploymentAttestation[] { return this.engine.attestationsList(); }

  checkIntegrity(input: { release: string; artifactName: string; artifactSha256: string; deployedSha256?: string }): IntegrityCheck {
    const check = this.engine.checkIntegrity(input);
    if (check.status === 'drift') void this.api?.bus.emit(SupplyChainSecurityEvents.DriftDetected, { release: input.release });
    return check;
  }
  integrityHistory(): IntegrityCheck[] { return this.engine.integrityHistory(); }
  monitor(): Array<{ release: string; status: IntegrityCheck['status'] }> { return this.engine.monitor(); }

  stats(): ReturnType<SupplyChainSecurityEngine['stats']> { return this.engine.stats(); }
}
