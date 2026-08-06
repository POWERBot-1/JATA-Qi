// SupplyChainSecurityModule tests — software supply chain governance.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import {
  SupplyChainSecurityModule, SupplyChainSecurityEngine, SupplyChainSecurityEvents,
  DEFAULT_ADVISORIES, DEFAULT_REPO_POLICY,
} from '../src/index.js';

describe('SupplyChainSecurityEngine', () => {
  it('validates source repositories against protection policy', () => {
    const e = new SupplyChainSecurityEngine();
    const ok = e.checkRepository('org/web', { branch: 'main', signedCommits: true, ciPassing: true, reviewers: 2 });
    assert.equal(ok.status, 'compliant');
    const bad = e.checkRepository('org/api', { branch: 'main', signedCommits: false, ciPassing: true, reviewers: 0 });
    assert.equal(bad.status, 'non_compliant');
    assert.ok(bad.violations.some((v) => v.includes('signed commits')));
    assert.ok(bad.violations.some((v) => v.includes('reviewer')));
    // Feature branches are not protected (signed commits/reviewers not required),
    // but the CI requirement still applies to all merges.
    const feature = e.checkRepository('org/web', { branch: 'feature/x', signedCommits: false, ciPassing: true, reviewers: 0 });
    assert.equal(feature.status, 'compliant');
  });

  it('validates CI/CD pipelines (pinned steps, secrets, approval gates)', () => {
    const e = new SupplyChainSecurityEngine();
    const ok = e.checkPipeline('ci/build.yml', { pinnedSteps: true, hasSecrets: false, hasApproval: true });
    assert.equal(ok.status, 'compliant');
    const bad = e.checkPipeline('ci/deploy.yml', { pinnedSteps: false, hasSecrets: true, hasApproval: false });
    assert.equal(bad.status, 'non_compliant');
    assert.equal(bad.violations.length, 3);
  });

  it('audits lockfiles: integrity, CVE advisories, and license policy', () => {
    const e = new SupplyChainSecurityEngine();
    const tarball = Buffer.from('lodash-4.17.21-tgz');
    const sha = SupplyChainSecurityEngine.hashPackage(tarball);
    const records = [
      { name: 'lodash@4.17.21', integritySha512: sha, license: 'MIT' },
      { name: 'axios@0.21.1', integritySha512: 'aa'.repeat(64), license: 'MIT' },
      { name: 'gpl-lib@2.0.0', integritySha512: 'bb'.repeat(64), license: 'GPL-3.0' },
    ];
    const computed = new Map([
      ['lodash@4.17.21', sha],
      ['axios@0.21.1', 'cc'.repeat(64)],
      ['gpl-lib@2.0.0', 'bb'.repeat(64)],
    ]);
    const audit = e.auditLockfile(records, computed);
    assert.equal(audit.ok, false);
    // lodash: verified (hash matches, no advisory at this version).
    const lodash = audit.results.find((r) => r.name === 'lodash@4.17.21')!;
    assert.equal(lodash.verdict, 'verified');
    // axios: known vulnerable (CVE-2021-3749 for <0.21.2) — but hash mismatched first.
    const axios = audit.results.find((r) => r.name === 'axios@0.21.1')!;
    assert.equal(axios.verdict, 'integrity_mismatch');
    // gpl-lib: license denied.
    const gpl = audit.results.find((r) => r.name === 'gpl-lib@2.0.0')!;
    assert.equal(gpl.verdict, 'license_denied');
    assert.equal(audit.licenseDenied, 1);
    assert.equal(audit.mismatches, 1);
  });

  it('flags vulnerable versions from the advisory catalog', () => {
    const e = new SupplyChainSecurityEngine();
    const records = [
      { name: 'minimist@1.2.5', integritySha512: 'aa'.repeat(64), license: 'MIT' },
    ];
    const audit = e.auditLockfile(records, new Map([['minimist@1.2.5', 'aa'.repeat(64)]]));
    const result = audit.results[0]!;
    assert.equal(result.verdict, 'known_vulnerable');
    assert.equal(result.cveId, 'CVE-2021-44906');
    assert.equal(result.severity, 'critical');
    assert.ok(DEFAULT_ADVISORIES.length >= 4);
  });

  it('creates SLSA-style provenance and verifies signatures', () => {
    const e = new SupplyChainSecurityEngine();
    const p = e.createProvenance({
      artifactName: 'web-app.tar.gz', artifactSha256: 'ab'.repeat(32),
      builderId: 'ci-builder-v1', buildId: 'build-123',
      materials: [{ uri: 'git+https://github.com/org/web', digest: 'sha256:feedface' }],
    });
    assert.ok(p.signature);
    assert.equal(e.verifyProvenance(p.id).status, 'verified');
    // Tamper: change the stored artifact hash → signature invalid.
    const tampered = { ...p, artifactSha256: 'cd'.repeat(32) };
    (e as unknown as { provenances: Array<{ artifactSha256: string }> }).provenances[0]!.artifactSha256 = 'cd'.repeat(32);
    assert.equal(e.verifyProvenance(p.id).status, 'signature_invalid');
    assert.equal(tampered.artifactSha256, 'cd'.repeat(32));
  });

  it('signs releases and verifies deployment attestations', () => {
    const e = new SupplyChainSecurityEngine();
    const release = e.signRelease({ release: 'v1.2.3', artifactName: 'api.bin', artifactSha256: '11'.repeat(32) });
    assert.equal(e.verifyRelease(release.id).status, 'signed');
    // Matching deployment → verified.
    const good = e.attestDeployment({ environment: 'production', artifactName: 'api.bin', artifactSha256: '11'.repeat(32), deployer: 'cicd' });
    assert.equal(good.status, 'verified');
    // Mismatched deployment → mismatch (and un-attested without a release).
    const bad = e.attestDeployment({ environment: 'production', artifactName: 'api.bin', artifactSha256: '22'.repeat(32), deployer: 'cicd' });
    assert.equal(bad.status, 'mismatch');
    const unattested = e.attestDeployment({ environment: 'staging', artifactName: 'other.bin', artifactSha256: '33'.repeat(32), deployer: 'cicd' });
    assert.equal(unattested.status, 'unattested');
    assert.equal(e.stats().verifiedDeployments, 1);
  });

  it('monitors deployment integrity continuously and detects drift', () => {
    const e = new SupplyChainSecurityEngine();
    const release = e.signRelease({ release: 'v2.0.0', artifactName: 'svc.bin', artifactSha256: 'aa'.repeat(32) });
    e.checkIntegrity({ release: 'v2.0.0', artifactName: 'svc.bin', artifactSha256: 'aa'.repeat(32), deployedSha256: 'aa'.repeat(32) });
    const drift = e.checkIntegrity({ release: 'v2.0.0', artifactName: 'svc.bin', artifactSha256: 'aa'.repeat(32), deployedSha256: 'ff'.repeat(32) });
    assert.equal(drift.status, 'drift');
    assert.equal(e.integrityHistory()[0]!.status, 'drift');
    const monitoring = e.monitor();
    assert.equal(monitoring.find((m) => m.release === release.release)!.status, 'drift');
    assert.equal(e.stats().drifts, 1);
  });

  it('aggregates governance stats', () => {
    const e = new SupplyChainSecurityEngine();
    e.checkRepository('org/x', { branch: 'main', signedCommits: false, ciPassing: false, reviewers: 0 });
    e.checkPipeline('ci/x.yml', { pinnedSteps: false, hasSecrets: false, hasApproval: false });
    const s = e.stats();
    assert.equal(s.nonCompliantRepos, 1);
    assert.equal(s.nonCompliantPipelines, 1);
  });
});

describe('SupplyChainSecurityModule (kernel wiring)', () => {
  let kernel: Kernel;

  before(async () => {
    kernel = createTestKernel();
    kernel.register(new SupplyChainSecurityModule());
    await kernel.boot();
  });

  after(async () => { await kernel.shutdown(); });

  it('emits compliance events on the bus', async () => {
    const mod = kernel.getModule<SupplyChainSecurityModule>('supply-chain-security');
    const events: string[] = [];
    kernel.bus.on(SupplyChainSecurityEvents.RepoNonCompliant, () => { events.push(SupplyChainSecurityEvents.RepoNonCompliant); });
    kernel.bus.on(SupplyChainSecurityEvents.VulnerabilityFound, () => { events.push(SupplyChainSecurityEvents.VulnerabilityFound); });
    kernel.bus.on(SupplyChainSecurityEvents.ReleaseSigned, () => { events.push(SupplyChainSecurityEvents.ReleaseSigned); });
    mod.checkRepository('org/z', { branch: 'main', signedCommits: false, ciPassing: true, reviewers: 1 });
    mod.auditLockfile(
      [{ name: 'minimist@1.2.5', integritySha512: 'aa'.repeat(64), license: 'MIT' }],
      new Map([['minimist@1.2.5', 'aa'.repeat(64)]]),
    );
    mod.signRelease({ release: 'v1', artifactName: 'a.bin', artifactSha256: 'ab'.repeat(32) });
    assert.ok(events.includes(SupplyChainSecurityEvents.RepoNonCompliant));
    assert.ok(events.includes(SupplyChainSecurityEvents.VulnerabilityFound));
    assert.ok(events.includes(SupplyChainSecurityEvents.ReleaseSigned));
    assert.ok(mod.stats().releases === 1);
  });

  it('supports custom policy overrides (backward compatible defaults)', () => {
    const mod = kernel.getModule<SupplyChainSecurityModule>('supply-chain-security');
    const check = mod.checkRepository('org/custom', { branch: 'main', signedCommits: false, ciPassing: false, reviewers: 0 }, {
      ...DEFAULT_REPO_POLICY, requireSignedCommits: false, requireCi: false, minReviewers: 0,
    });
    assert.equal(check.status, 'compliant');
  });
});
