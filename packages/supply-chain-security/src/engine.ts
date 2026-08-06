// SupplyChainSecurityEngine — software supply chain governance.
//
// Validates source repositories, CI/CD pipelines, dependency integrity
// (lockfile hashing + CVE/license audits), SLSA-style artifact provenance
// with Ed25519 signatures, release signing, deployment verification, and
// continuous integrity monitoring. Pure engine (no kernel deps).

import { createHash, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import type {
  Advisory, ArtifactProvenance, CiPipelineCheck, CiPolicy, DependencyAuditResult,
  ProvenanceMaterial,
  DependencyRecord, DeploymentAttestation, DeploymentStatus, IntegrityCheck,
  LicensePolicy, LockfileAudit, ProvenanceStatus, ReleaseRecord, ReleaseStatus,
  RepositoryCheck, RepositoryPolicy,
} from './types.js';

export const DEFAULT_REPO_POLICY: RepositoryPolicy = {
  protectedBranches: ['main', 'production'],
  requireSignedCommits: true,
  requireCi: true,
  minReviewers: 1,
};

export const DEFAULT_CI_POLICY: CiPolicy = {
  requirePinnedSteps: true,
  forbidSecrets: true,
  requireApproval: true,
};

export const DEFAULT_LICENSE_POLICY: LicensePolicy = {
  allowed: ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'BSD-2-Clause', 'ISC', 'MPL-2.0', 'Unlicense'],
  denied: ['GPL-3.0', 'AGPL-3.0', 'BUSL-1.1'],
};

/** Small built-in advisory catalog (extensible via addAdvisory). */
export const DEFAULT_ADVISORIES: Advisory[] = [
  { package: 'lodash', versions: '<4.17.21', cveId: 'CVE-2021-23337', severity: 'high', summary: 'Command injection via template' },
  { package: 'minimist', versions: '<1.2.6', cveId: 'CVE-2021-44906', severity: 'critical', summary: 'Prototype pollution' },
  { package: 'axios', versions: '<0.21.2', cveId: 'CVE-2021-3749', severity: 'medium', summary: 'SSRF via redirect' },
  { package: 'log4js', versions: '<6.4.0', cveId: 'CVE-2022-21704', severity: 'medium', summary: 'Directory traversal' },
];

function versionLessThan(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  }
  return false;
}

/** Match a version against a simple constraint ('<x.y.z', 'x.y', 'x.y.z' exact). */
function versionMatches(constraint: string, version: string): boolean {
  const c = constraint.trim();
  if (c.startsWith('<')) return versionLessThan(version, c.slice(1).trim());
  if (c.startsWith('<=')) return versionLessThan(version, c.slice(2).trim()) || version === c.slice(2).trim();
  if (c.startsWith('>=')) return !versionLessThan(version, c.slice(2).trim());
  // Exact or major.minor prefix.
  return version === c || version.startsWith(c + '.');
}

export class SupplyChainSecurityEngine {
  private repositories = new Map<string, RepositoryCheck>();
  private pipelines = new Map<string, CiPipelineCheck>();
  private provenances: ArtifactProvenance[] = [];
  private releases: ReleaseRecord[] = [];
  private attestations: DeploymentAttestation[] = [];
  private integrityChecks: IntegrityCheck[] = [];
  private advisories: Advisory[] = [...DEFAULT_ADVISORIES];
  private licensePolicy: LicensePolicy = { ...DEFAULT_LICENSE_POLICY };
  private signKey = generateKeyPairSync('ed25519');

  /** Verify a signature with the engine's trusted public key. */
  verifyWithPublicKey(payload: string, signature: string, publicKey = this.signKey.publicKey): boolean {
    try {
      return verify(null, Buffer.from(payload), publicKey, Buffer.from(signature, 'base64'));
    } catch {
      return false;
    }
  }

  // ---- source repositories ---------------------------------------------------

  checkRepository(repo: string, facts: {
    branch: string; signedCommits: boolean; ciPassing: boolean; reviewers: number;
  }, policy: RepositoryPolicy = DEFAULT_REPO_POLICY): RepositoryCheck {
    const violations: string[] = [];
    if (policy.requireSignedCommits && policy.protectedBranches.includes(facts.branch) && !facts.signedCommits) {
      violations.push(`signed commits required on ${facts.branch}`);
    }
    if (policy.requireCi && !facts.ciPassing) violations.push('CI must pass before merge');
    if (policy.protectedBranches.includes(facts.branch) && facts.reviewers < policy.minReviewers) violations.push(`at least ${policy.minReviewers} reviewer(s) required`);
    const check: RepositoryCheck = {
      repo, policy, status: violations.length === 0 ? 'compliant' : 'non_compliant',
      violations, checkedAt: Date.now(),
    };
    this.repositories.set(repo, check);
    return check;
  }

  repositoryChecks(): RepositoryCheck[] {
    return [...this.repositories.values()];
  }

  // ---- CI/CD pipelines -----------------------------------------------------------

  checkPipeline(pipeline: string, facts: {
    pinnedSteps: boolean; hasSecrets: boolean; hasApproval: boolean;
  }, policy: CiPolicy = DEFAULT_CI_POLICY): CiPipelineCheck {
    const violations: string[] = [];
    if (policy.requirePinnedSteps && !facts.pinnedSteps) violations.push('build steps must be pinned (sha/tag)');
    if (policy.forbidSecrets && facts.hasSecrets) violations.push('secrets detected in pipeline config');
    if (policy.requireApproval && !facts.hasApproval) violations.push('approval gate required for protected pipeline');
    const check: CiPipelineCheck = {
      pipeline, policy, status: violations.length === 0 ? 'compliant' : 'non_compliant',
      violations, checkedAt: Date.now(),
    };
    this.pipelines.set(pipeline, check);
    return check;
  }

  pipelineChecks(): CiPipelineCheck[] {
    return [...this.pipelines.values()];
  }

  // ---- dependency integrity -----------------------------------------------------------

  addAdvisory(advisory: Advisory): void {
    this.advisories.push(advisory);
  }

  setLicensePolicy(policy: LicensePolicy): void {
    this.licensePolicy = policy;
  }

  /**
   * Audit a lockfile: verify each dependency's declared SHA-512 against a
   * computed hash, check the advisory catalog, and validate licenses.
   */
  auditLockfile(records: DependencyRecord[], computed: Map<string, string>): LockfileAudit {
    const results: DependencyAuditResult[] = [];
    let vulnerable = 0, licenseDenied = 0, mismatches = 0, verified = 0;
    for (const dep of records) {
      const [name, version] = dep.name.split('@');
      const actual = computed.get(dep.name);
      if (!actual) {
        results.push({ name: dep.name, verdict: 'unknown', reason: 'no computed hash provided' });
        continue;
      }
      if (actual !== dep.integritySha512) {
        mismatches += 1;
        results.push({ name: dep.name, verdict: 'integrity_mismatch', reason: 'computed hash differs from lockfile' });
        continue;
      }
      // Advisory check.
      const advisory = this.advisories.find((a) =>
        name?.startsWith(a.package) && versionMatches(a.versions, version ?? ''));
      if (advisory) {
        vulnerable += 1;
        results.push({
          name: dep.name, verdict: 'known_vulnerable', cveId: advisory.cveId,
          severity: advisory.severity, advisory: advisory.summary,
          reason: `${advisory.cveId}: ${advisory.summary}`,
        });
        continue;
      }
      // License check.
      const license = dep.license ?? 'UNKNOWN';
      if (this.licensePolicy.denied.includes(license)) {
        licenseDenied += 1;
        results.push({ name: dep.name, verdict: 'license_denied', license, reason: `license ${license} is denied` });
        continue;
      }
      if (!this.licensePolicy.allowed.includes(license) && license !== 'UNKNOWN') {
        licenseDenied += 1;
        results.push({ name: dep.name, verdict: 'license_denied', license, reason: `license ${license} not in allowlist` });
        continue;
      }
      verified += 1;
      results.push({ name: dep.name, verdict: 'verified', license });
    }
    return {
      checkedAt: Date.now(), results, verified, vulnerable, licenseDenied, mismatches,
      ok: vulnerable === 0 && licenseDenied === 0 && mismatches === 0,
    };
  }

  /** Compute the SHA-512 of a package tarball and register it. */
  static hashPackage(bytes: Uint8Array): string {
    return createHash('sha512').update(bytes).digest('hex');
  }

  // ---- artifact provenance (SLSA-aligned) ------------------------------------------------

  createProvenance(input: {
    artifactName: string; artifactSha256: string; builderId: string; buildId: string;
    materials: ProvenanceMaterial[];
  }): ArtifactProvenance {
    const payload = provenancePayload(input);
    const provenance: ArtifactProvenance = {
      id: randomUUID(), ...input,
      signature: sign(null, Buffer.from(payload), this.signKey.privateKey).toString('base64'),
      createdAt: Date.now(),
    };
    this.provenances.push(provenance);
    return provenance;
  }

  listProvenances(): ArtifactProvenance[] {
    return [...this.provenances].reverse();
  }

  /** Verify provenance integrity + signature with the trusted key. */
  verifyProvenance(id: string, publicKey = this.signKey.publicKey): { status: ProvenanceStatus; reason?: string } {
    const p = this.provenances.find((x) => x.id === id);
    if (!p) return { status: 'unverified', reason: 'not found' };
    const payload = provenancePayload({
      artifactName: p.artifactName, artifactSha256: p.artifactSha256,
      builderId: p.builderId, buildId: p.buildId, materials: p.materials,
    });
    const valid = this.verifyWithPublicKey(payload, p.signature ?? '', publicKey);
    return valid ? { status: 'verified' } : { status: 'signature_invalid', reason: 'signature does not match provenance' };
  }

  // ---- release signing ------------------------------------------------------------

  signRelease(input: { release: string; artifactName: string; artifactSha256: string; notes?: string }): ReleaseRecord {
    const payload = JSON.stringify({ release: input.release, artifactName: input.artifactName, artifactSha256: input.artifactSha256 });
    const record: ReleaseRecord = {
      id: randomUUID(), ...input,
      signature: sign(null, Buffer.from(payload), this.signKey.privateKey).toString('base64'),
      signedAt: Date.now(), verified: true,
    };
    this.releases.unshift(record);
    return record;
  }

  listReleases(): ReleaseRecord[] {
    return [...this.releases];
  }

  verifyRelease(id: string, publicKey = this.signKey.publicKey): { status: ReleaseStatus; reason?: string } {
    const release = this.releases.find((r) => r.id === id);
    if (!release) return { status: 'unsigned', reason: 'not found' };
    if (!release.signature) return { status: 'unsigned', reason: 'no signature' };
    const payload = JSON.stringify({ release: release.release, artifactName: release.artifactName, artifactSha256: release.artifactSha256 });
    const valid = this.verifyWithPublicKey(payload, release.signature, publicKey);
    release.verified = valid;
    return valid ? { status: 'signed' } : { status: 'signature_invalid', reason: 'bad signature' };
  }

  // ---- deployment verification --------------------------------------------------------

  /** Attest a deployment; verified when the deployed hash matches the signed release. */
  attestDeployment(input: {
    environment: string; artifactName: string; artifactSha256: string; deployer: string;
  }): { attestation: DeploymentAttestation; status: DeploymentStatus } {
    const release = this.releases.find((r) => r.artifactName === input.artifactName);
    const matches = release !== undefined && release.artifactSha256 === input.artifactSha256;
    const attestation: DeploymentAttestation = {
      id: randomUUID(), ...input, verified: matches, attestedAt: Date.now(),
    };
    this.attestations.push(attestation);
    return {
      attestation,
      status: release ? (matches ? 'verified' : 'mismatch') : 'unattested',
    };
  }

  attestationsList(): DeploymentAttestation[] {
    return [...this.attestations].reverse();
  }

  // ---- continuous integrity monitoring -----------------------------------------------------

  /**
   * Periodic integrity check: compare the deployed artifact hash against the
   * signed release. Drift is a finding for the SOC.
   */
  checkIntegrity(input: { release: string; artifactName: string; artifactSha256: string; deployedSha256?: string }): IntegrityCheck {
    const check: IntegrityCheck = {
      checkedAt: Date.now(), release: input.release, artifactSha256: input.artifactSha256,
      ...(input.deployedSha256 ? { deployedSha256: input.deployedSha256 } : {}),
      status: input.deployedSha256 === undefined ? 'missing'
        : input.deployedSha256 === input.artifactSha256 ? 'match' : 'drift',
    };
    this.integrityChecks.push(check);
    return check;
  }

  integrityHistory(): IntegrityCheck[] {
    return [...this.integrityChecks].reverse();
  }

  /** Continuous monitoring sweep: flag any drift/missing since last check. */
  monitor(): Array<{ release: string; status: IntegrityCheck['status'] }> {
    const latest = new Map<string, IntegrityCheck>();
    for (const c of this.integrityChecks) latest.set(c.release, c);
    return [...latest.values()].map((c) => ({ release: c.release, status: c.status }));
  }

  stats(): {
    repositories: number; nonCompliantRepos: number; pipelines: number; nonCompliantPipelines: number;
    dependenciesVerified: number; dependenciesVulnerable: number; dependenciesLicenseDenied: number; dependenciesMismatched: number;
    provenances: number; releases: number; attestations: number; verifiedDeployments: number;
    integrityChecks: number; drifts: number;
  } {
    let verified = 0, vulnerable = 0, licenseDenied = 0, mismatched = 0;
    for (const a of this.lastAudits) {
      verified += a.verified; vulnerable += a.vulnerable; licenseDenied += a.licenseDenied; mismatched += a.mismatches;
    }
    return {
      repositories: this.repositories.size,
      nonCompliantRepos: [...this.repositories.values()].filter((r) => r.status === 'non_compliant').length,
      pipelines: this.pipelines.size,
      nonCompliantPipelines: [...this.pipelines.values()].filter((p) => p.status === 'non_compliant').length,
      dependenciesVerified: verified, dependenciesVulnerable: vulnerable,
      dependenciesLicenseDenied: licenseDenied, dependenciesMismatched: mismatched,
      provenances: this.provenances.length,
      releases: this.releases.length,
      attestations: this.attestations.length,
      verifiedDeployments: this.attestations.filter((a) => a.verified).length,
      integrityChecks: this.integrityChecks.length,
      drifts: this.integrityChecks.filter((c) => c.status === 'drift').length,
    };
  }

  private lastAudits: LockfileAudit[] = [];

  /** Track audit history for stats. */
  recordAudit(audit: LockfileAudit): LockfileAudit {
    this.lastAudits.push(audit);
    return audit;
  }
}

function provenancePayload(input: { artifactName: string; artifactSha256: string; builderId: string; buildId: string; materials: ProvenanceMaterial[] }): string {
  return JSON.stringify({
    artifactName: input.artifactName, artifactSha256: input.artifactSha256,
    builderId: input.builderId, buildId: input.buildId,
    materials: input.materials.map((m) => ({ uri: m.uri, digest: m.digest })),
  });
}
