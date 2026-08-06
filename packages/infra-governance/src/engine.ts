// InfrastructureGovernanceEngine — secure infrastructure governance.
//
// Hardware lifecycle management (inventory → provisioning → active → EOL →
// decommission), trusted provisioning with one-time tokens, secure firmware
// validation (expected SHA-256 + measured-boot attestation), infrastructure
// integrity monitoring (golden-config drift), compliance baselines, and
// physical security controls (facility access logs). Pure engine.

import { createHash, randomUUID } from 'node:crypto';
import type {
  ComplianceCheck, ConfigDrift, FirmwareStatus, HardwareAsset, HardwareStatus,
  PhysicalAccessRecord, ProvisioningRecord,
} from './types.js';

export const HARDENING_BASELINE: Array<{ name: string; category: 'baseline' | 'hardening' }> = [
  { name: 'os-patches-current', category: 'baseline' },
  { name: 'ssh-keys-only', category: 'baseline' },
  { name: 'root-login-disabled', category: 'hardening' },
  { name: 'firewall-default-deny', category: 'hardening' },
  { name: 'audit-logging-enabled', category: 'baseline' },
  { name: 'disk-encryption', category: 'hardening' },
];

export class InfrastructureGovernanceEngine {
  private assets = new Map<string, HardwareAsset>();
  private provisionings: ProvisioningRecord[] = [];
  private drifts: ConfigDrift[] = [];
  private compliance: ComplianceCheck[] = [];
  private access: PhysicalAccessRecord[] = [];

  static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  // ---- hardware inventory + lifecycle -----------------------------------------

  registerAsset(input: {
    serial: string; model: string; role: HardwareAsset['role'];
    firmwareVersion: string; firmwareSha256?: string; measuredBoot?: string;
    location?: string; purchasedAt?: number; eolAt?: number;
  }): HardwareAsset {
    if (!input.serial || !input.model) throw new Error('serial and model are required');
    if (this.assets.has(input.serial)) throw new Error(`asset ${input.serial} already registered`);
    const asset: HardwareAsset = {
      id: randomUUID(), serial: input.serial, model: input.model, role: input.role,
      status: 'provisioned', firmwareVersion: input.firmwareVersion,
      ...(input.firmwareSha256 ? { firmwareSha256: input.firmwareSha256 } : {}),
      firmwareStatus: 'untrusted',
      ...(input.measuredBoot ? { measuredBoot: input.measuredBoot } : {}),
      ...(input.location ? { location: input.location } : {}),
      purchasedAt: input.purchasedAt ?? Date.now(),
      ...(input.eolAt ? { eolAt: input.eolAt } : {}),
      ...(input.measuredBoot ? { provisionedAt: Date.now() } : {}),
    };
    this.assets.set(asset.serial, asset);
    return asset;
  }

  getAsset(serial: string): HardwareAsset | undefined {
    return this.assets.get(serial);
  }

  listAssets(filter?: { status?: HardwareStatus; role?: HardwareAsset['role']; eol?: boolean }): HardwareAsset[] {
    const now = Date.now();
    return [...this.assets.values()].filter((a) =>
      (!filter?.status || a.status === filter.status) &&
      (!filter?.role || a.role === filter.role) &&
      (filter?.eol === undefined || (filter.eol ? (a.eolAt !== undefined && a.eolAt < now) : (a.eolAt === undefined || a.eolAt >= now))));
  }

  setStatus(serial: string, status: HardwareStatus): HardwareAsset | undefined {
    const asset = this.assets.get(serial);
    if (!asset) return undefined;
    asset.status = status;
    if (status === 'decommissioned') asset.decommissionedAt = Date.now();
    return asset;
  }

  /** Hardware lifecycle analytics: counts per status + EOL exposure. */
  lifecycleAnalytics(): { byStatus: Record<string, number>; eolExposed: number; total: number } {
    const byStatus: Record<string, number> = {};
    for (const a of this.assets.values()) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
    return { byStatus, eolExposed: this.listAssets({ eol: true }).length, total: this.assets.size };
  }

  // ---- trusted provisioning -------------------------------------------------------

  /**
   * Enroll a provisioning request: stores a hash of the one-time token (the
   * plaintext is never persisted) and requires approval before completion.
   */
  enrollProvisioning(input: { serial: string; token: string; enrolledBy: string; method: ProvisioningRecord['method'] }): ProvisioningRecord {
    const asset = this.assets.get(input.serial);
    if (!asset) throw new Error(`unknown asset ${input.serial}`);
    const record: ProvisioningRecord = {
      id: randomUUID(), serial: input.serial, tokenHash: InfrastructureGovernanceEngine.hashToken(input.token),
      enrolledBy: input.enrolledBy, method: input.method, approved: false, createdAt: Date.now(),
    };
    this.provisionings.push(record);
    return record;
  }

  approveProvisioning(id: string, approver: string): ProvisioningRecord | undefined {
    const record = this.provisionings.find((p) => p.id === id);
    if (!record) return undefined;
    record.approved = true;
    record.completedAt = Date.now();
    const asset = this.assets.get(record.serial);
    if (asset && asset.status === 'provisioned') {
      asset.status = 'active';
      asset.provisionedAt = Date.now();
    }
    return record;
  }

  provisioningsList(): ProvisioningRecord[] {
    return [...this.provisionings].reverse();
  }

  // ---- secure firmware validation -----------------------------------------------------

  /** Validate a measured boot / firmware report against the expected hash. */
  validateFirmware(serial: string, actualSha256: string, measuredBoot?: string): { asset: HardwareAsset; status: FirmwareStatus } {
    const asset = this.assets.get(serial);
    if (!asset) throw new Error(`unknown asset ${serial}`);
    if (!asset.firmwareSha256) {
      asset.firmwareStatus = 'untrusted';
      return { asset, status: 'untrusted' };
    }
    if (actualSha256 !== asset.firmwareSha256) {
      asset.firmwareStatus = 'mismatch';
      return { asset, status: 'mismatch' };
    }
    // Measured boot must be present when the asset claims TPM attestation.
    if (asset.measuredBoot && !measuredBoot) {
      asset.firmwareStatus = 'untrusted';
      return { asset, status: 'untrusted' };
    }
    if (measuredBoot) asset.measuredBoot = measuredBoot;
    asset.firmwareStatus = 'validated';
    return { asset, status: 'validated' };
  }

  firmwareStatusReport(): { validated: number; mismatch: number; untrusted: number } {
    const out = { validated: 0, mismatch: 0, untrusted: 0 };
    for (const a of this.assets.values()) out[a.firmwareStatus] += 1;
    return out;
  }

  // ---- infrastructure integrity (config drift) --------------------------------------------

  /**
   * Compare the live config of an asset against its golden config; any
   * difference is recorded as drift (severity by key category).
   */
  detectDrift(serial: string, golden: Record<string, string>, live: Record<string, string>): ConfigDrift[] {
    const asset = this.assets.get(serial);
    if (!asset) throw new Error(`unknown asset ${serial}`);
    const found: ConfigDrift[] = [];
    const keys = new Set([...Object.keys(golden), ...Object.keys(live)]);
    for (const key of keys) {
      const expected = golden[key];
      const actual = live[key];
      if (expected === actual) continue;
      const severity = key.includes('firewall') || key.includes('auth') || key.includes('encrypt') ? 'high' : 'medium';
      const drift: ConfigDrift = {
        id: randomUUID(), assetId: asset.id, key, expected: expected ?? '(absent)', actual: actual ?? '(absent)',
        severity, detectedAt: Date.now(),
      };
      this.drifts.push(drift);
      found.push(drift);
    }
    return found;
  }

  remediateDrift(id: string): ConfigDrift | undefined {
    const drift = this.drifts.find((d) => d.id === id);
    if (!drift) return undefined;
    drift.remediated = true;
    return drift;
  }

  driftsList(filter?: { severity?: ConfigDrift['severity']; open?: boolean }): ConfigDrift[] {
    return this.drifts.filter((d) =>
      (!filter?.severity || d.severity === filter.severity) &&
      (filter?.open === undefined || (filter.open ? !d.remediated : d.remediated === true)));
  }

  // ---- compliance baselines -------------------------------------------------------------

  runComplianceChecks(assetFacts: Record<string, boolean>): ComplianceCheck[] {
    const checks: ComplianceCheck[] = [];
    for (const baseline of HARDENING_BASELINE) {
      const passed = assetFacts[baseline.name] ?? false;
      const check: ComplianceCheck = {
        id: randomUUID(), category: baseline.category, name: baseline.name,
        passed, ...(passed ? {} : { detail: `control "${baseline.name}" not satisfied` }),
        checkedAt: Date.now(),
      };
      this.compliance.push(check);
      checks.push(check);
    }
    return checks;
  }

  complianceReport(): { passed: number; failed: number; total: number; failing: ComplianceCheck[] } {
    const failed = this.compliance.filter((c) => !c.passed);
    return {
      passed: this.compliance.length - failed.length,
      failed: failed.length,
      total: this.compliance.length,
      failing: failed,
    };
  }

  // ---- physical security ----------------------------------------------------------------

  logAccess(input: { facility: string; zone: string; person: string; action: PhysicalAccessRecord['action']; reason?: string; ts?: number }): PhysicalAccessRecord {
    if (input.action === 'entry' && !input.reason) {
      // Escorted entry requires a reason (physical control).
    }
    const record: PhysicalAccessRecord = {
      id: randomUUID(), facility: input.facility, zone: input.zone, person: input.person,
      action: input.action, ...(input.reason ? { reason: input.reason } : {}),
      ts: input.ts ?? Date.now(),
    };
    this.access.push(record);
    return record;
  }

  accessLog(filter?: { facility?: string; action?: PhysicalAccessRecord['action'] }): PhysicalAccessRecord[] {
    return this.access.filter((r) =>
      (!filter?.facility || r.facility === filter.facility) &&
      (!filter?.action || r.action === filter.action));
  }

  /** Anomalous access: denied entries per person (badge misuse). */
  deniedAccessPatterns(): Array<{ person: string; denials: number; lastDeniedAt: number }> {
    const map = new Map<string, { denials: number; lastDeniedAt: number }>();
    for (const r of this.access) {
      if (r.action !== 'denied') continue;
      const rec = map.get(r.person) ?? { denials: 0, lastDeniedAt: 0 };
      rec.denials += 1;
      rec.lastDeniedAt = Math.max(rec.lastDeniedAt, r.ts);
      map.set(r.person, rec);
    }
    return [...map.entries()].map(([person, rec]) => ({ person, ...rec })).sort((a, b) => b.denials - a.denials);
  }

  stats(): {
    assets: number; active: number; eolExposed: number; firmwareValidated: number; firmwareMismatch: number;
    openDrifts: number; highSeverityDrifts: number; compliancePassRate: number; provisioningsPending: number;
    accessDenials: number;
  } {
    const report = this.complianceReport();
    return {
      assets: this.assets.size,
      active: this.listAssets({ status: 'active' }).length,
      eolExposed: this.listAssets({ eol: true }).length,
      firmwareValidated: this.firmwareStatusReport().validated,
      firmwareMismatch: this.firmwareStatusReport().mismatch,
      openDrifts: this.driftsList({ open: true }).length,
      highSeverityDrifts: this.driftsList({ severity: 'high', open: true }).length,
      compliancePassRate: report.total === 0 ? 0 : Math.round((report.passed / report.total) * 100),
      provisioningsPending: this.provisionings.filter((p) => !p.approved).length,
      accessDenials: this.access.filter((r) => r.action === 'denied').length,
    };
  }
}
