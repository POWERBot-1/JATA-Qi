// CloudModule — PRX Part E kernel module. Wraps the CloudEngine, emits bus
// events, and records instance/volume milestones into the Digital Memory
// Engine.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { DigitalMemoryModule } from '@jataqi/memory';
import { CloudEngine, type ProvisionInstanceInput, type RegisterFlavorInput, type RegisterRegionInput } from './engine.js';
import type {
  AutoscalingGroup, CloudStats, FirewallAction, FirewallDirection,
  FirewallProtocol, FirewallRule, Flavor, FlavorTier, HostingPlan, HostingTier,
  Image, Instance, InstanceStatus, LoadBalancer, Region, Snapshot, Volume, Vpc,
} from './types.js';

export const CloudEvents = Object.freeze({
  RegionRegistered: 'cloud.region.registered',
  InstanceProvisioned: 'cloud.instance.provisioned',
  InstanceStatusChanged: 'cloud.instance.status_changed',
  InstanceTerminated: 'cloud.instance.terminated',
  VolumeCreated: 'cloud.volume.created',
  HostingProvisioned: 'cloud.hosting.provisioned',
  AutoscalingEvaluated: 'cloud.autoscaling.evaluated',
} as const);

export class CloudModule implements IModule {
  readonly id = 'cloud';
  readonly tags = ['core', 'cloud', 'infrastructure'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private memory?: DigitalMemoryModule;
  readonly engine = new CloudEngine();

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('cloud', this);
    this.memory = this.tryModule<DigitalMemoryModule>('memory');
    kernel.logger.info('cloud module initialized (PRX Part E — Cloud Infrastructure Provider)');
  }
  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  // ---- catalog -----------------------------------------------------------

  registerRegion(input: RegisterRegionInput): Region {
    const region = this.engine.registerRegion(input);
    void this.api.bus.emit(CloudEvents.RegionRegistered, { id: region.id, code: region.code });
    return region;
  }
  getRegion(id: string): Region | undefined { return this.engine.getRegion(id); }
  listRegions(status?: Region['status']): Region[] { return this.engine.listRegions(status); }
  setRegionStatus(id: string, status: Region['status']): Region | undefined {
    return this.engine.setRegionStatus(id, status);
  }

  registerFlavor(input: RegisterFlavorInput): Flavor { return this.engine.registerFlavor(input); }
  getFlavor(id: string): Flavor | undefined { return this.engine.getFlavor(id); }
  listFlavors(tier?: FlavorTier): Flavor[] { return this.engine.listFlavors(tier); }

  registerImage(input: { name: string; os: string; version: string; arch?: 'x86_64' | 'arm64' }): Image {
    return this.engine.registerImage(input);
  }
  getImage(id: string): Image | undefined { return this.engine.getImage(id); }
  listImages(): Image[] { return this.engine.listImages(); }

  // ---- instances ---------------------------------------------------------

  async provisionInstance(input: ProvisionInstanceInput): Promise<Instance> {
    const instance = this.engine.provisionInstance(input);
    void this.api.bus.emit(CloudEvents.InstanceProvisioned, { id: instance.id, regionId: instance.regionId, flavorId: instance.flavorId });
    await this.recordMemory('cloud_instance', `provisioned ${instance.name} (${instance.id}) in ${instance.regionId}`, {
      instanceId: instance.id, regionId: instance.regionId, flavorId: instance.flavorId,
    });
    return instance;
  }
  getInstance(id: string): Instance | undefined { return this.engine.getInstance(id); }
  listInstances(filter?: { regionId?: string; status?: InstanceStatus; hostingPlanId?: string }): Instance[] {
    return this.engine.listInstances(filter);
  }

  async setInstanceStatus(id: string, status: InstanceStatus): Promise<Instance | undefined> {
    const instance = this.engine.setInstanceStatus(id, status);
    if (instance) {
      void this.api.bus.emit(CloudEvents.InstanceStatusChanged, { id: instance.id, status: instance.status });
      if (status === 'terminated') void this.api.bus.emit(CloudEvents.InstanceTerminated, { id: instance.id });
      await this.recordMemory('cloud_instance', `instance ${instance.name} → ${instance.status}`, {
        instanceId: instance.id, status: instance.status,
      });
    }
    return instance;
  }
  rebootInstance(id: string): Instance | undefined { return this.engine.rebootInstance(id); }
  async terminateInstance(id: string): Promise<Instance | undefined> {
    const instance = this.engine.terminateInstance(id);
    if (instance) {
      void this.api.bus.emit(CloudEvents.InstanceTerminated, { id: instance.id });
      await this.recordMemory('cloud_instance', `terminated ${instance.name}`, { instanceId: instance.id });
    }
    return instance;
  }

  // ---- volumes + snapshots -----------------------------------------------

  createVolume(input: { name: string; sizeGb: number; regionId: string }): Volume {
    const volume = this.engine.createVolume(input);
    void this.api.bus.emit(CloudEvents.VolumeCreated, { id: volume.id, sizeGb: volume.sizeGb });
    return volume;
  }
  getVolume(id: string): Volume | undefined { return this.engine.getVolume(id); }
  listVolumes(regionId?: string): Volume[] { return this.engine.listVolumes(regionId); }
  attachVolume(volumeId: string, instanceId: string): Volume | undefined {
    return this.engine.attachVolume(volumeId, instanceId);
  }
  detachVolume(volumeId: string): Volume | undefined { return this.engine.detachVolume(volumeId); }
  createSnapshot(volumeId: string): Snapshot { return this.engine.createSnapshot(volumeId); }
  listSnapshots(volumeId?: string): Snapshot[] { return this.engine.listSnapshots(volumeId); }

  // ---- networking --------------------------------------------------------

  createVpc(input: { name: string; regionId: string; cidr: string; subnetCidrs: string[] }): Vpc {
    return this.engine.createVpc(input);
  }
  getVpc(id: string): Vpc | undefined { return this.engine.getVpc(id); }
  listVpcs(regionId?: string): Vpc[] { return this.engine.listVpcs(regionId); }
  addFirewallRule(input: {
    vpcId: string; name: string; direction: FirewallDirection;
    protocol: FirewallProtocol; portRange?: string; sourceCidr?: string; action: FirewallAction;
  }): FirewallRule {
    return this.engine.addFirewallRule(input);
  }
  listFirewallRules(vpcId: string): FirewallRule[] { return this.engine.listFirewallRules(vpcId); }
  createLoadBalancer(input: { name: string; regionId: string; protocol: FirewallProtocol; port: number }): LoadBalancer {
    return this.engine.createLoadBalancer(input);
  }
  listLoadBalancers(regionId?: string): LoadBalancer[] { return this.engine.listLoadBalancers(regionId); }
  addLoadBalancerTarget(lbId: string, instanceId: string): LoadBalancer | undefined {
    return this.engine.addLoadBalancerTarget(lbId, instanceId);
  }

  // ---- hosting + autoscaling ---------------------------------------------

  createHostingPlan(input: {
    name: string; tier: HostingTier; monthlyPriceMinor: number;
    flavorId?: string; sslAutomation?: boolean; cdnIncluded?: boolean;
    backupIncluded?: boolean; databasesIncluded?: number;
  }): HostingPlan {
    return this.engine.createHostingPlan(input);
  }
  getHostingPlan(id: string): HostingPlan | undefined { return this.engine.getHostingPlan(id); }
  listHostingPlans(tier?: HostingTier): HostingPlan[] { return this.engine.listHostingPlans(tier); }

  async provisionHosting(input: { planId: string; regionId: string; siteName: string; imageId: string }): Promise<Instance> {
    const instance = this.engine.provisionHosting(input);
    void this.api.bus.emit(CloudEvents.HostingProvisioned, { id: instance.id, planId: input.planId, siteName: input.siteName });
    await this.recordMemory('cloud_hosting', `provisioned hosting "${input.siteName}" (${instance.id})`, {
      instanceId: instance.id, planId: input.planId, siteName: input.siteName,
    });
    return instance;
  }

  createAutoscalingGroup(input: {
    name: string; regionId: string; templateInstanceId: string;
    min: number; max: number; cpuHighThreshold?: number; cpuLowThreshold?: number;
  }): AutoscalingGroup {
    return this.engine.createAutoscalingGroup(input);
  }
  listAutoscalingGroups(): AutoscalingGroup[] { return this.engine.listAutoscalingGroups(); }

  evaluateAutoscaling(groupId: string, load: number): { action: 'scale_out' | 'scale_in' | 'none'; count: number } {
    const result = this.engine.evaluateAutoscaling(groupId, load);
    void this.api.bus.emit(CloudEvents.AutoscalingEvaluated, { groupId, action: result.action, count: result.count, load });
    return result;
  }

  stats(): CloudStats { return this.engine.stats(); }

  // ---- internals ---------------------------------------------------------

  private async recordMemory(category: string, summary: string, data: Record<string, unknown>): Promise<void> {
    if (!this.memory) return;
    try {
      await this.memory.record({ category, summary, data, tags: ['cloud', category] });
    } catch { /* non-fatal */ }
  }

  private tryModule<T extends IModule>(id: string): T | undefined {
    try { return this.api.getModule<T>(id); } catch { return undefined; }
  }
}
