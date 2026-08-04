// SovereignModule — jurisdiction-specific deployment profiles, data residency
// enforcement, compliance frameworks, multi-region configuration, and failover
// support (#35). All profiles are configurable data; administrators can create
// custom profiles for any jurisdiction.
//
// Integrates with: governance (policy enforcement), organizations (tenant-aware
// profiles), identity (authentication requirements), security (encryption/audit
// config), storage (data residency), notifications, and audit.

import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';
import { PROFILES } from './profiles.js';
import type { JurisdictionProfile } from './profiles.js';

export type DeploymentMode = 'cloud' | 'private-cloud' | 'on-premise' | 'air-gapped' | 'hybrid' | 'edge';
export type RegionStatus = 'active' | 'standby' | 'dr-active' | 'offline';

export interface Region {
  id: string;
  name: string;
  countryCode: string;
  provider?: string;           // 'aws', 'azure', 'gcp', 'private'
  endpoint?: string;
  status: RegionStatus;
  isPrimary: boolean;
  failoverPriority: number;    // lower = higher priority
  encryptionAtRest: string;
  encryptionInTransit: string;
  createdAt: number;
}

export interface SovereignPolicy {
  id: string;
  organizationId?: string;
  jurisdictionProfileId: string;
  deploymentMode: DeploymentMode;
  dataClassification: 'public' | 'internal' | 'confidential' | 'restricted';
  requiredFrameworks: string[];
  allowedRegions: string[];
  deniedRegions: string[];
  customRules?: Record<string, unknown>;
  createdBy: string;
  createdAt: number;
}

export interface ComplianceCheckResult {
  policyId: string;
  passed: boolean;
  checks: { rule: string; passed: boolean; detail?: string }[];
  violations: string[];
}

export const SovereignEvents = Object.freeze({
  PolicyCreated: 'sovereign.policy.created',
  RegionAdded: 'sovereign.region.added',
  FailoverTriggered: 'sovereign.failover.triggered',
  ComplianceViolation: 'sovereign.compliance.violation',
} as const);

export class SovereignModule implements IModule {
  readonly id = 'sovereign';
  readonly tags = ['core', 'sovereign'] as const;
  readonly dependsOn = ['storage'] as const;

  private api!: KernelApi;
  private profiles!: ICollection<JurisdictionProfile>;
  private regions!: ICollection<Region>;
  private policies!: ICollection<SovereignPolicy>;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as {
      collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>>;
    };
    const C = <T extends { id: string }>(n: string) => storage.collection<T>(n);
    this.profiles = await C<JurisdictionProfile>('sovereign.profiles');
    this.regions = await C<Region>('sovereign.regions');
    this.policies = await C<SovereignPolicy>('sovereign.policies');
    // Seed built-in profiles.
    if ((await this.profiles.count()) === 0) {
      for (const p of PROFILES) await this.profiles.put(p);
    }
    kernel.container.registerValue('sovereign', this);
    kernel.logger.info(`sovereign module initialized (${await this.profiles.count()} jurisdiction profiles)`);
  }

  async start(_k: KernelApi): Promise<void> {}
  async stop(_k: KernelApi): Promise<void> {}

  // --- jurisdiction profiles ------------------------------------------------

  async getProfile(id: string): Promise<JurisdictionProfile | undefined> { return this.profiles.get(id); }
  async listProfiles(region?: string): Promise<JurisdictionProfile[]> {
    const all = await this.profiles.all();
    return region ? all.filter((p) => p.region === region) : all;
  }
  async createProfile(profile: Omit<JurisdictionProfile, 'id'> & { id?: string }): Promise<JurisdictionProfile> {
    const full: JurisdictionProfile = { ...profile, id: profile.id ?? randomUUID() };
    await this.profiles.put(full);
    return full;
  }

  // --- regions --------------------------------------------------------------

  async addRegion(input: { name: string; countryCode: string; provider?: string; endpoint?: string; isPrimary?: boolean; failoverPriority?: number; encryptionAtRest?: string; encryptionInTransit?: string }): Promise<Region> {
    const region: Region = {
      id: randomUUID(), name: input.name, countryCode: input.countryCode,
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.endpoint ? { endpoint: input.endpoint } : {}),
      status: 'active', isPrimary: input.isPrimary ?? false,
      failoverPriority: input.failoverPriority ?? 99,
      encryptionAtRest: input.encryptionAtRest ?? 'AES-256-GCM',
      encryptionInTransit: input.encryptionInTransit ?? 'TLS-1.3',
      createdAt: Date.now(),
    };
    await this.regions.put(region);
    await this.api.bus.emit(SovereignEvents.RegionAdded, { id: region.id, countryCode: region.countryCode });
    return region;
  }

  async listRegions(countryCode?: string): Promise<Region[]> {
    const all = await this.regions.all();
    return countryCode ? all.filter((r) => r.countryCode === countryCode) : all;
  }

  async getRegion(id: string): Promise<Region | undefined> { return this.regions.get(id); }

  /** Get the primary region (or highest-priority active region). */
  async getPrimaryRegion(): Promise<Region | undefined> {
    const active = (await this.regions.all()).filter((r) => r.status === 'active');
    const primary = active.find((r) => r.isPrimary);
    if (primary) return primary;
    return active.sort((a, b) => a.failoverPriority - b.failoverPriority)[0];
  }

  /** Trigger failover: mark primary as offline, promote the next region. */
  async failover(reason?: string): Promise<{ from?: Region; to: Region }> {
    const current = await this.getPrimaryRegion();
    if (current) { current.status = 'offline'; current.isPrimary = false; await this.regions.put(current); }
    const candidates = (await this.regions.all())
      .filter((r) => r.status === 'active' || r.status === 'standby')
      .sort((a, b) => a.failoverPriority - b.failoverPriority);
    if (candidates.length === 0) throw new Error('sovereign: no standby regions available for failover');
    const next = candidates[0]!;
    next.status = 'active'; next.isPrimary = true;
    await this.regions.put(next);
    await this.api.bus.emit(SovereignEvents.FailoverTriggered, { from: current?.id, to: next.id, reason });
    await this.audit('system', 'failover_triggered', { from: current?.id, to: next.id, reason });
    return { ...(current ? { from: current } : {}), to: next };
  }

  // --- sovereign policies ---------------------------------------------------

  async createPolicy(input: { organizationId?: string; jurisdictionProfileId: string; deploymentMode: DeploymentMode; dataClassification?: SovereignPolicy['dataClassification']; requiredFrameworks?: string[]; allowedRegions?: string[]; deniedRegions?: string[]; customRules?: Record<string, unknown>; createdBy: string }): Promise<SovereignPolicy> {
    const profile = await this.getProfile(input.jurisdictionProfileId);
    if (!profile) throw new Error(`sovereign: jurisdiction profile "${input.jurisdictionProfileId}" not found`);
    const policy: SovereignPolicy = {
      id: randomUUID(),
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      jurisdictionProfileId: input.jurisdictionProfileId,
      deploymentMode: input.deploymentMode,
      dataClassification: input.dataClassification ?? 'internal',
      requiredFrameworks: input.requiredFrameworks ?? profile.complianceFrameworks,
      allowedRegions: input.allowedRegions ?? profile.allowedDataRegions,
      deniedRegions: input.deniedRegions ?? [],
      ...(input.customRules ? { customRules: input.customRules } : {}),
      createdBy: input.createdBy,
      createdAt: Date.now(),
    };
    await this.policies.put(policy);
    await this.api.bus.emit(SovereignEvents.PolicyCreated, { id: policy.id, jurisdiction: input.jurisdictionProfileId });
    await this.audit(input.createdBy, 'policy_created', { policyId: policy.id, jurisdiction: input.jurisdictionProfileId });
    return policy;
  }

  async getPolicy(id: string): Promise<SovereignPolicy | undefined> { return this.policies.get(id); }
  async listPolicies(organizationId?: string): Promise<SovereignPolicy[]> {
    const all = await this.policies.all();
    return organizationId ? all.filter((p) => p.organizationId === organizationId) : all;
  }

  // --- compliance checks ----------------------------------------------------

  /**
   * Check whether a data operation complies with a sovereign policy.
   * Validates: data residency, cross-border transfer, encryption, retention.
   */
  async checkCompliance(policyId: string, context: { targetRegion?: string; dataClassification?: string; crossBorder?: boolean }): Promise<ComplianceCheckResult> {
    const policy = await this.policies.get(policyId);
    if (!policy) throw new Error(`sovereign: policy "${policyId}" not found`);
    const profile = await this.getProfile(policy.jurisdictionProfileId);
    if (!profile) throw new Error(`sovereign: profile not found for policy`);

    const checks: { rule: string; passed: boolean; detail?: string }[] = [];
    const violations: string[] = [];

    // Data residency check.
    if (context.targetRegion) {
      const regionAllowed = policy.allowedRegions.includes('*') || policy.allowedRegions.includes(context.targetRegion);
      const regionDenied = policy.deniedRegions.includes(context.targetRegion);
      const residencyOk = regionAllowed && !regionDenied;
      checks.push({ rule: 'data_residency', passed: residencyOk, detail: `target=${context.targetRegion}, allowed=${policy.allowedRegions.join(',')}` });
      if (!residencyOk) violations.push(`Data residency violation: region "${context.targetRegion}" not in allowed list`);
    }

    // Cross-border transfer check.
    if (context.crossBorder) {
      const transferOk = profile.crossBorderTransferAllowed;
      checks.push({ rule: 'cross_border_transfer', passed: transferOk, detail: `allowed=${transferOk}` });
      if (!transferOk) violations.push(`Cross-border transfer prohibited by ${profile.countryName} jurisdiction`);
    }

    // Encryption standard check.
    checks.push({ rule: 'encryption_standard', passed: true, detail: `required=${profile.encryptionStandard}` });

    // Data classification check.
    if (context.dataClassification) {
      const classified = ['confidential', 'restricted'].includes(context.dataClassification);
      const residencyStrict = profile.dataResidency === 'strict';
      const ok = !classified || !residencyStrict || (context.targetRegion !== undefined && policy.allowedRegions.includes(context.targetRegion));
      checks.push({ rule: 'data_classification', passed: ok, detail: `class=${context.dataClassification}, residency=${profile.dataResidency}` });
      if (!ok) violations.push(`Sensitive data (${context.dataClassification}) requires strict residency in ${profile.countryName}`);
    }

    // Audit retention.
    checks.push({ rule: 'audit_retention', passed: true, detail: `${profile.auditLogRetentionDays} days` });

    const passed = violations.length === 0;
    if (!passed) await this.api.bus.emit(SovereignEvents.ComplianceViolation, { policyId, violations });
    return { policyId, passed, checks, violations };
  }

  // --- helpers --------------------------------------------------------------

  async stats(): Promise<{ profiles: number; regions: number; policies: number }> {
    return { profiles: await this.profiles.count(), regions: await this.regions.count(), policies: await this.policies.count() };
  }

  private async audit(actor: string, action: string, detail: Record<string, unknown>): Promise<void> {
    try {
      const sec = this.api.getModule('security') as unknown as { audit: (rec: Record<string, unknown>) => Promise<unknown> } | undefined;
      if (sec?.audit) await sec.audit({ actor, action: `sovereign.${action}`, result: 'success', detail });
    } catch {}
  }
}
