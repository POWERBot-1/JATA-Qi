// InfrastructureGovernanceModule — kernel module for secure infrastructure
// governance. Wraps the engine, emits bus events on integrity findings.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import { InfrastructureGovernanceEngine, HARDENING_BASELINE } from './engine.js';
import type {
  ComplianceCheck, ConfigDrift, FirmwareStatus, HardwareAsset, HardwareStatus,
  PhysicalAccessRecord, ProvisioningRecord,
} from './types.js';

export const InfraGovernanceEvents = Object.freeze({
  AssetRegistered: 'infra.asset.registered',
  FirmwareMismatch: 'infra.firmware.mismatch',
  DriftDetected: 'infra.config.drift',
  ProvisioningApproved: 'infra.provisioning.approved',
  AccessDenied: 'infra.physical.access.denied',
} as const);

export class InfrastructureGovernanceModule implements IModule {
  readonly id = 'infra-governance';
  readonly tags = ['core', 'security', 'infrastructure'] as const;
  readonly dependsOn = [] as const;

  readonly engine = new InfrastructureGovernanceEngine();
  private api!: KernelApi;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('infra-governance', this);
    kernel.logger.info('infra-governance module initialized (secure infrastructure governance)');
  }
  async start(_kernel: KernelApi): Promise<void> { /* stateless */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  registerAsset(input: Parameters<InfrastructureGovernanceEngine['registerAsset']>[0]): HardwareAsset {
    const asset = this.engine.registerAsset(input);
    void this.api?.bus.emit(InfraGovernanceEvents.AssetRegistered, { serial: asset.serial, role: asset.role });
    return asset;
  }
  getAsset(serial: string) { return this.engine.getAsset(serial); }
  listAssets(filter?: { status?: HardwareStatus; role?: HardwareAsset['role']; eol?: boolean }) { return this.engine.listAssets(filter); }
  setStatus(serial: string, status: HardwareStatus) { return this.engine.setStatus(serial, status); }
  lifecycleAnalytics() { return this.engine.lifecycleAnalytics(); }

  enrollProvisioning(input: { serial: string; token: string; enrolledBy: string; method: ProvisioningRecord['method'] }): ProvisioningRecord {
    return this.engine.enrollProvisioning(input);
  }
  approveProvisioning(id: string, approver: string): ProvisioningRecord | undefined {
    const record = this.engine.approveProvisioning(id, approver);
    if (record) void this.api?.bus.emit(InfraGovernanceEvents.ProvisioningApproved, { id: record.id, serial: record.serial });
    return record;
  }
  provisioningsList() { return this.engine.provisioningsList(); }

  validateFirmware(serial: string, actualSha256: string, measuredBoot?: string): { asset: HardwareAsset; status: FirmwareStatus } {
    const result = this.engine.validateFirmware(serial, actualSha256, measuredBoot);
    if (result.status === 'mismatch') void this.api?.bus.emit(InfraGovernanceEvents.FirmwareMismatch, { serial });
    return result;
  }
  firmwareStatusReport() { return this.engine.firmwareStatusReport(); }

  detectDrift(serial: string, golden: Record<string, string>, live: Record<string, string>): ConfigDrift[] {
    const drifts = this.engine.detectDrift(serial, golden, live);
    for (const d of drifts) void this.api?.bus.emit(InfraGovernanceEvents.DriftDetected, { id: d.id, assetId: d.assetId, key: d.key, severity: d.severity });
    return drifts;
  }
  remediateDrift(id: string) { return this.engine.remediateDrift(id); }
  driftsList(filter?: { severity?: ConfigDrift['severity']; open?: boolean }) { return this.engine.driftsList(filter); }

  runComplianceChecks(assetFacts: Record<string, boolean>): ComplianceCheck[] { return this.engine.runComplianceChecks(assetFacts); }
  complianceReport() { return this.engine.complianceReport(); }

  logAccess(input: { facility: string; zone: string; person: string; action: PhysicalAccessRecord['action']; reason?: string; ts?: number }): PhysicalAccessRecord {
    const record = this.engine.logAccess(input);
    if (record.action === 'denied') void this.api?.bus.emit(InfraGovernanceEvents.AccessDenied, { person: record.person, facility: record.facility });
    return record;
  }
  accessLog(filter?: { facility?: string; action?: PhysicalAccessRecord['action'] }) { return this.engine.accessLog(filter); }
  deniedAccessPatterns() { return this.engine.deniedAccessPatterns(); }

  attestHardware(input: Parameters<InfrastructureGovernanceEngine['attestHardware']>[0]) { return this.engine.attestHardware(input); }
  trustedStates() { return this.engine.trustedStatesList(); }
  trustedState(serial: string) { return this.engine.trustedState(serial); }
  rootOfTrustReport() { return this.engine.rootOfTrustReport(); }

  registerConfidentialWorkload(input: Parameters<InfrastructureGovernanceEngine['registerConfidentialWorkload']>[0]) { return this.engine.registerConfidentialWorkload(input); }
  confidentialWorkloads() { return this.engine.confidentialList(); }
  confidentialReport() { return this.engine.confidentialReport(); }

  stats() { return this.engine.stats(); }
}

export { HARDENING_BASELINE };
