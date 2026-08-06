// InfrastructureGovernanceModule tests — secure infrastructure governance.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import type { Kernel } from '@jataqi/core-kernel';
import { InfrastructureGovernanceModule, InfrastructureGovernanceEngine, InfraGovernanceEvents, HARDENING_BASELINE } from '../src/index.js';

describe('InfrastructureGovernanceEngine', () => {
  it('manages the hardware lifecycle (provisioned → active → EOL → decommissioned)', () => {
    const e = new InfrastructureGovernanceEngine();
    const asset = e.registerAsset({
      serial: 'SN-001', model: 'PowerEdge R740', role: 'server',
      firmwareVersion: '2.9.1', firmwareSha256: 'aa'.repeat(32),
      purchasedAt: Date.now() - 5 * 365 * 86_400_000, eolAt: Date.now() - 30 * 86_400_000,
    });
    assert.equal(asset.status, 'provisioned');
    e.setStatus(asset.serial, 'active');
    assert.equal(e.getAsset(asset.serial)!.status, 'active');
    // EOL exposure detected.
    assert.equal(e.listAssets({ eol: true }).length, 1);
    e.setStatus(asset.serial, 'decommissioned');
    assert.ok(e.getAsset(asset.serial)!.decommissionedAt);
    assert.equal(e.lifecycleAnalytics().byStatus.decommissioned, 1);
    assert.throws(() => e.registerAsset({ serial: 'SN-001', model: 'x', role: 'server', firmwareVersion: '1' }), /already registered/);
  });

  it('enrolls trusted provisioning with one-time token hashes and approval', () => {
    const e = new InfrastructureGovernanceEngine();
    e.registerAsset({ serial: 'SN-002', model: 'RPi4', role: 'edge', firmwareVersion: '1.0' });
    const record = e.enrollProvisioning({ serial: 'SN-002', token: 'one-time-token-xyz', enrolledBy: 'ops-1', method: 'tpm' });
    assert.notEqual(record.tokenHash, 'one-time-token-xyz', 'plaintext never stored');
    assert.equal(record.tokenHash, InfrastructureGovernanceEngine.hashToken('one-time-token-xyz'));
    assert.equal(record.approved, false);
    e.approveProvisioning(record.id, 'sec-lead');
    assert.equal(record.approved, true);
    assert.equal(e.getAsset('SN-002')!.status, 'active', 'approval activates the asset');
    assert.equal(e.stats().provisioningsPending, 0);
  });

  it('validates firmware against expected hashes and measured boot', () => {
    const e = new InfrastructureGovernanceEngine();
    e.registerAsset({
      serial: 'SN-003', model: 'Appliance', role: 'security',
      firmwareVersion: '3.2', firmwareSha256: 'bb'.repeat(32), measuredBoot: 'quote-v1',
    });
    const good = e.validateFirmware('SN-003', 'bb'.repeat(32), 'quote-v1');
    assert.equal(good.status, 'validated');
    const bad = e.validateFirmware('SN-003', 'ff'.repeat(32), 'quote-v1');
    assert.equal(bad.status, 'mismatch');
    assert.equal(e.firmwareStatusReport().mismatch, 1);
    // Missing measured boot when expected → untrusted.
    e.registerAsset({ serial: 'SN-004', model: 'X', role: 'server', firmwareVersion: '1', firmwareSha256: 'cc'.repeat(32), measuredBoot: 'required' });
    const untrusted = e.validateFirmware('SN-004', 'cc'.repeat(32));
    assert.equal(untrusted.status, 'untrusted');
  });

  it('detects golden-config drift with severity and remediates', () => {
    const e = new InfrastructureGovernanceEngine();
    e.registerAsset({ serial: 'SN-005', model: 'FW', role: 'network', firmwareVersion: '1' });
    const drifts = e.detectDrift('SN-005', {
      'firewall.default': 'deny', 'ssh.auth': 'keys-only', 'log.level': 'info',
    }, {
      'firewall.default': 'allow', 'ssh.auth': 'keys-only', 'log.level': 'debug',
    });
    assert.equal(drifts.length, 2);
    const firewall = drifts.find((d) => d.key === 'firewall.default')!;
    assert.equal(firewall.severity, 'high');
    assert.equal(e.driftsList({ open: true }).length, 2);
    assert.equal(e.stats().highSeverityDrifts, 1, 'firewall drift is high severity');
    e.remediateDrift(firewall.id);
    assert.equal(e.driftsList({ open: true }).length, 1);
    assert.equal(e.stats().openDrifts, 1);
    assert.equal(e.stats().highSeverityDrifts, 0, 'only medium drift remains');
  });

  it('runs compliance baselines and reports pass rates', () => {
    const e = new InfrastructureGovernanceEngine();
    const facts: Record<string, boolean> = {
      'os-patches-current': true, 'ssh-keys-only': true, 'root-login-disabled': true,
      'firewall-default-deny': true, 'audit-logging-enabled': true, 'disk-encryption': false,
    };
    e.runComplianceChecks(facts);
    const report = e.complianceReport();
    assert.equal(report.total, HARDENING_BASELINE.length);
    assert.equal(report.failed, 1);
    assert.equal(report.passed, 5);
    assert.equal(e.stats().compliancePassRate, 83);
  });

  it('logs physical access and surfaces denied-access patterns', () => {
    const e = new InfrastructureGovernanceEngine();
    e.logAccess({ facility: 'NBO-DC', zone: 'cage-4', person: 'alice', action: 'entry' });
    e.logAccess({ facility: 'NBO-DC', zone: 'cage-4', person: 'bob', action: 'denied', reason: 'badge expired' });
    e.logAccess({ facility: 'NBO-DC', zone: 'cage-4', person: 'bob', action: 'denied', reason: 'badge expired' });
    assert.equal(e.accessLog({ facility: 'NBO-DC' }).length, 3);
    const patterns = e.deniedAccessPatterns();
    assert.equal(patterns[0]!.person, 'bob');
    assert.equal(patterns[0]!.denials, 2);
    assert.equal(e.stats().accessDenials, 2);
  });
});

describe('InfrastructureGovernanceModule (kernel wiring)', () => {
  let kernel: Kernel;

  before(async () => {
    kernel = createTestKernel();
    kernel.register(new InfrastructureGovernanceModule());
    await kernel.boot();
  });

  after(async () => { await kernel.shutdown(); });

  it('emits integrity events and aggregates stats', async () => {
    const mod = kernel.getModule<InfrastructureGovernanceModule>('infra-governance');
    const events: string[] = [];
    kernel.bus.on(InfraGovernanceEvents.FirmwareMismatch, () => { events.push(InfraGovernanceEvents.FirmwareMismatch); });
    kernel.bus.on(InfraGovernanceEvents.DriftDetected, () => { events.push(InfraGovernanceEvents.DriftDetected); });
    mod.registerAsset({ serial: 'SN-100', model: 'M', role: 'server', firmwareVersion: '1', firmwareSha256: 'dd'.repeat(32) });
    mod.validateFirmware('SN-100', 'ee'.repeat(32));
    mod.detectDrift('SN-100', { 'firewall.default': 'deny' }, { 'firewall.default': 'allow' });
    assert.ok(events.includes(InfraGovernanceEvents.FirmwareMismatch));
    assert.ok(events.includes(InfraGovernanceEvents.DriftDetected));
    assert.equal(mod.stats().assets, 1);
    assert.equal(mod.stats().firmwareMismatch, 1);
  });
});

describe('Hardware root of trust + confidential computing', () => {
  it('attests TPM/Secure-Boot/measured-boot state and reports posture', () => {
    const e = new InfrastructureGovernanceEngine();
    e.registerAsset({ serial: 'SN-200', model: 'Appliance', role: 'server', firmwareVersion: '1', firmwareSha256: 'aa'.repeat(32) });
    const state = e.attestHardware({ serial: 'SN-200', tpmVersion: '2.0', secureBoot: true, measuredBootHash: 'pcrs-1234', hwKeyHandle: 'tpm:0x81000001', attestationQuote: 'quote-abc' });
    assert.equal(state.attested, true);
    assert.equal(state.tpmVersion, '2.0');
    // Missing quote → recorded but not attested.
    e.registerAsset({ serial: 'SN-201', model: 'X', role: 'edge', firmwareVersion: '1' });
    e.attestHardware({ serial: 'SN-201', secureBoot: false });
    const report = e.rootOfTrustReport();
    assert.equal(report.attested, 1);
    assert.equal(report.unAttested, 1);
    assert.equal(report.secureBootEnabled, 1);
    assert.equal(report.tpmPresent, 1);
  });

  it('registers confidential workloads with memory encryption + residency', () => {
    const e = new InfrastructureGovernanceEngine();
    const w = e.registerConfidentialWorkload({
      name: 'payments-enclave', environment: 'enclave', region: 'nbo-1',
      memoryEncryption: true, measurement: 'enclave-hash-1', dataResidency: 'KE',
    });
    assert.equal(w.environment, 'enclave');
    assert.equal(w.dataResidency, 'KE');
    e.registerConfidentialWorkload({ name: 'ml-inference', environment: 'sev-snp', region: 'lon-1', memoryEncryption: true, dataResidency: 'GB' });
    const report = e.confidentialReport();
    assert.equal(report.total, 2);
    assert.equal(report.memoryEncrypted, 2);
    assert.equal(report.byEnvironment.enclave, 1);
    assert.equal(e.confidentialList().length, 2);
  });
});
