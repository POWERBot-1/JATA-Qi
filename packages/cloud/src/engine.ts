// CloudEngine — PRX Part E core: regions with capacity, compute instances
// with full lifecycle, volumes + snapshots, VPCs + firewall rules, load
// balancers, hosting plans, and autoscaling groups. Pure engine — the module
// wires kernel events + memory.

import { randomUUID } from 'node:crypto';
import type {
  AutoscalingGroup, CloudStats, FirewallAction, FirewallDirection,
  FirewallProtocol, FirewallRule, Flavor, FlavorTier, HostingPlan, HostingTier,
  Image, Instance, InstanceStatus, LoadBalancer, Region, Snapshot, Volume, Vpc,
} from './types.js';

export interface RegisterRegionInput {
  name: string;
  code: string;
  country: string;
  zones: string[];
  capacitySlots?: number;
}

export interface RegisterFlavorInput {
  name: string;
  tier: FlavorTier;
  vcpu: number;
  ramGb: number;
  diskGb: number;
  gpu?: number;
  pricePerHourMinor: number;
}

export interface ProvisionInstanceInput {
  name: string;
  regionId: string;
  zone?: string;
  flavorId: string;
  imageId: string;
  vpcId?: string;
  hostingPlanId?: string;
  autoscalingGroupId?: string;
}

export class CloudEngine {
  private regions = new Map<string, Region>();
  private flavors = new Map<string, Flavor>();
  private images = new Map<string, Image>();
  private instances = new Map<string, Instance>();
  private volumes = new Map<string, Volume>();
  private snapshots = new Map<string, Snapshot>();
  private vpcs = new Map<string, Vpc>();
  private firewallRules = new Map<string, FirewallRule>();
  private loadBalancers = new Map<string, LoadBalancer>();
  private hostingPlans = new Map<string, HostingPlan>();
  private autoscalingGroups = new Map<string, AutoscalingGroup>();

  // ---- catalog -----------------------------------------------------------

  registerRegion(input: RegisterRegionInput): Region {
    if (!input.name || !input.code || !input.country || input.zones.length === 0) {
      throw new Error('name, code, country, and at least one zone are required');
    }
    const region: Region = {
      id: randomUUID(), name: input.name, code: input.code.toUpperCase(),
      country: input.country, zones: [...input.zones],
      capacitySlots: input.capacitySlots ?? 1000, usedSlots: 0,
      status: 'operational', createdAt: Date.now(),
    };
    this.regions.set(region.id, region);
    return region;
  }

  getRegion(id: string): Region | undefined { return this.regions.get(id); }
  listRegions(status?: Region['status']): Region[] {
    const all = [...this.regions.values()];
    return status ? all.filter((r) => r.status === status) : all;
  }

  setRegionStatus(id: string, status: Region['status']): Region | undefined {
    const region = this.regions.get(id);
    if (!region) return undefined;
    region.status = status;
    return region;
  }

  registerFlavor(input: RegisterFlavorInput): Flavor {
    if (!input.name || input.vcpu <= 0 || input.ramGb <= 0) throw new Error('valid name, vcpu, and ramGb are required');
    const flavor: Flavor = {
      id: randomUUID(), name: input.name, tier: input.tier,
      vcpu: input.vcpu, ramGb: input.ramGb, diskGb: input.diskGb,
      ...(input.gpu !== undefined ? { gpu: input.gpu } : {}),
      pricePerHourMinor: input.pricePerHourMinor, createdAt: Date.now(),
    };
    this.flavors.set(flavor.id, flavor);
    return flavor;
  }

  getFlavor(id: string): Flavor | undefined { return this.flavors.get(id); }
  listFlavors(tier?: FlavorTier): Flavor[] {
    const all = [...this.flavors.values()];
    return tier ? all.filter((f) => f.tier === tier) : all;
  }

  registerImage(input: { name: string; os: string; version: string; arch?: 'x86_64' | 'arm64' }): Image {
    if (!input.name || !input.os) throw new Error('name and os are required');
    const image: Image = {
      id: randomUUID(), name: input.name, os: input.os, version: input.version,
      arch: input.arch ?? 'x86_64', createdAt: Date.now(),
    };
    this.images.set(image.id, image);
    return image;
  }

  getImage(id: string): Image | undefined { return this.images.get(id); }
  listImages(): Image[] { return [...this.images.values()]; }

  // ---- instances ---------------------------------------------------------

  provisionInstance(input: ProvisionInstanceInput): Instance {
    const region = this.regions.get(input.regionId);
    if (!region) throw new Error(`unknown region ${input.regionId}`);
    if (region.status === 'maintenance') throw new Error(`region ${region.name} is in maintenance`);
    const flavor = this.flavors.get(input.flavorId);
    if (!flavor) throw new Error(`unknown flavor ${input.flavorId}`);
    const image = this.images.get(input.imageId);
    if (!image) throw new Error(`unknown image ${input.imageId}`);
    if (region.usedSlots >= region.capacitySlots) throw new Error(`region ${region.name} is at capacity`);

    const now = Date.now();
    const instance: Instance = {
      id: randomUUID(), name: input.name, regionId: region.id,
      zone: input.zone ?? region.zones[0]!,
      flavorId: flavor.id, imageId: image.id,
      status: 'provisioning', volumeIds: [],
      ...(input.vpcId ? { vpcId: input.vpcId } : {}),
      ...(input.hostingPlanId ? { hostingPlanId: input.hostingPlanId } : {}),
      ...(input.autoscalingGroupId ? { autoscalingGroupId: input.autoscalingGroupId } : {}),
      createdAt: now, updatedAt: now,
    };
    region.usedSlots += 1;
    this.instances.set(instance.id, instance);
    return instance;
  }

  getInstance(id: string): Instance | undefined { return this.instances.get(id); }

  listInstances(filter?: { regionId?: string; status?: InstanceStatus; hostingPlanId?: string }): Instance[] {
    return [...this.instances.values()].filter((i) =>
      (!filter?.regionId || i.regionId === filter.regionId) &&
      (!filter?.status || i.status === filter.status) &&
      (!filter?.hostingPlanId || i.hostingPlanId === filter.hostingPlanId));
  }

  /** Move an instance through its lifecycle; 'running' assigns IPs. */
  setInstanceStatus(id: string, status: InstanceStatus): Instance | undefined {
    const instance = this.instances.get(id);
    if (!instance) return undefined;
    if (instance.status === 'terminated') throw new Error(`instance ${id} is terminated`);
    instance.status = status;
    if (status === 'running') {
      instance.publicIp ??= ipv4(instance.id);
      instance.privateIp ??= `10.0.${(instance.regionId.length % 250) + 1}.${(instance.id.length % 250) + 1}`;
    }
    instance.updatedAt = Date.now();
    return instance;
  }

  /** Reboot: stop → start. */
  rebootInstance(id: string): Instance | undefined {
    const instance = this.instances.get(id);
    if (!instance) return undefined;
    if (instance.status !== 'running') throw new Error(`instance ${id} is not running`);
    instance.status = 'stopped';
    instance.updatedAt = Date.now();
    return instance;
  }

  /** Terminate an instance and free its region capacity. */
  terminateInstance(id: string): Instance | undefined {
    const instance = this.instances.get(id);
    if (!instance) return undefined;
    if (instance.status === 'terminated') throw new Error(`instance ${id} is already terminated`);
    const region = this.regions.get(instance.regionId);
    if (region) region.usedSlots = Math.max(0, region.usedSlots - 1);
    // Detach any attached volumes.
    for (const volumeId of instance.volumeIds) {
      const volume = this.volumes.get(volumeId);
      if (volume) { volume.status = 'available'; volume.instanceId = undefined; }
    }
    instance.status = 'terminated';
    instance.updatedAt = Date.now();
    return instance;
  }

  // ---- volumes + snapshots -----------------------------------------------

  createVolume(input: { name: string; sizeGb: number; regionId: string }): Volume {
    if (!input.name || input.sizeGb <= 0) throw new Error('valid name and sizeGb are required');
    const region = this.regions.get(input.regionId);
    if (!region) throw new Error(`unknown region ${input.regionId}`);
    const volume: Volume = {
      id: randomUUID(), name: input.name, sizeGb: input.sizeGb,
      regionId: region.id, status: 'available', createdAt: Date.now(),
    };
    this.volumes.set(volume.id, volume);
    return volume;
  }

  getVolume(id: string): Volume | undefined { return this.volumes.get(id); }
  listVolumes(regionId?: string): Volume[] {
    const all = [...this.volumes.values()];
    return regionId ? all.filter((v) => v.regionId === regionId) : all;
  }

  attachVolume(volumeId: string, instanceId: string): Volume | undefined {
    const volume = this.volumes.get(volumeId);
    const instance = this.instances.get(instanceId);
    if (!volume || !instance) return undefined;
    if (volume.status === 'attached') throw new Error(`volume ${volumeId} is already attached`);
    volume.status = 'attached';
    volume.instanceId = instanceId;
    if (!instance.volumeIds.includes(volumeId)) instance.volumeIds.push(volumeId);
    instance.updatedAt = Date.now();
    return volume;
  }

  detachVolume(volumeId: string): Volume | undefined {
    const volume = this.volumes.get(volumeId);
    if (!volume) return undefined;
    const instance = volume.instanceId ? this.instances.get(volume.instanceId) : undefined;
    volume.status = 'available';
    volume.instanceId = undefined;
    if (instance) {
      instance.volumeIds = instance.volumeIds.filter((v) => v !== volumeId);
      instance.updatedAt = Date.now();
    }
    return volume;
  }

  createSnapshot(volumeId: string): Snapshot {
    const volume = this.volumes.get(volumeId);
    if (!volume) throw new Error(`unknown volume ${volumeId}`);
    const snapshot: Snapshot = { id: randomUUID(), volumeId, sizeGb: volume.sizeGb, createdAt: Date.now() };
    this.snapshots.set(snapshot.id, snapshot);
    return snapshot;
  }

  listSnapshots(volumeId?: string): Snapshot[] {
    const all = [...this.snapshots.values()];
    return volumeId ? all.filter((s) => s.volumeId === volumeId) : all;
  }

  // ---- networking --------------------------------------------------------

  createVpc(input: { name: string; regionId: string; cidr: string; subnetCidrs: string[] }): Vpc {
    if (!input.name || !input.cidr) throw new Error('name and cidr are required');
    const region = this.regions.get(input.regionId);
    if (!region) throw new Error(`unknown region ${input.regionId}`);
    const vpc: Vpc = {
      id: randomUUID(), name: input.name, regionId: region.id,
      cidr: input.cidr, subnetCidrs: [...input.subnetCidrs], createdAt: Date.now(),
    };
    this.vpcs.set(vpc.id, vpc);
    return vpc;
  }

  getVpc(id: string): Vpc | undefined { return this.vpcs.get(id); }
  listVpcs(regionId?: string): Vpc[] {
    const all = [...this.vpcs.values()];
    return regionId ? all.filter((v) => v.regionId === regionId) : all;
  }

  addFirewallRule(input: {
    vpcId: string; name: string; direction: FirewallDirection;
    protocol: FirewallProtocol; portRange?: string; sourceCidr?: string; action: FirewallAction;
  }): FirewallRule {
    const vpc = this.vpcs.get(input.vpcId);
    if (!vpc) throw new Error(`unknown vpc ${input.vpcId}`);
    const rule: FirewallRule = {
      id: randomUUID(), vpcId: vpc.id, name: input.name, direction: input.direction,
      protocol: input.protocol,
      ...(input.portRange ? { portRange: input.portRange } : {}),
      ...(input.sourceCidr ? { sourceCidr: input.sourceCidr } : {}),
      action: input.action, createdAt: Date.now(),
    };
    this.firewallRules.set(rule.id, rule);
    return rule;
  }

  listFirewallRules(vpcId: string): FirewallRule[] {
    return [...this.firewallRules.values()].filter((r) => r.vpcId === vpcId);
  }

  createLoadBalancer(input: {
    name: string; regionId: string; protocol: FirewallProtocol; port: number;
  }): LoadBalancer {
    const region = this.regions.get(input.regionId);
    if (!region) throw new Error(`unknown region ${input.regionId}`);
    const lb: LoadBalancer = {
      id: randomUUID(), name: input.name, regionId: region.id,
      protocol: input.protocol, port: input.port, targetInstanceIds: [],
      status: 'active', createdAt: Date.now(),
    };
    this.loadBalancers.set(lb.id, lb);
    return lb;
  }

  listLoadBalancers(regionId?: string): LoadBalancer[] {
    const all = [...this.loadBalancers.values()];
    return regionId ? all.filter((lb) => lb.regionId === regionId) : all;
  }

  addLoadBalancerTarget(lbId: string, instanceId: string): LoadBalancer | undefined {
    const lb = this.loadBalancers.get(lbId);
    const instance = this.instances.get(instanceId);
    if (!lb || !instance) return undefined;
    if (!lb.targetInstanceIds.includes(instanceId)) lb.targetInstanceIds.push(instanceId);
    return lb;
  }

  // ---- hosting plans -----------------------------------------------------

  createHostingPlan(input: {
    name: string; tier: HostingTier; monthlyPriceMinor: number;
    flavorId?: string; sslAutomation?: boolean; cdnIncluded?: boolean;
    backupIncluded?: boolean; databasesIncluded?: number;
  }): HostingPlan {
    if (!input.name || input.monthlyPriceMinor < 0) throw new Error('valid name and monthlyPriceMinor are required');
    const plan: HostingPlan = {
      id: randomUUID(), name: input.name, tier: input.tier,
      monthlyPriceMinor: input.monthlyPriceMinor,
      ...(input.flavorId ? { flavorId: input.flavorId } : {}),
      sslAutomation: input.sslAutomation ?? true,
      cdnIncluded: input.cdnIncluded ?? false,
      backupIncluded: input.backupIncluded ?? true,
      databasesIncluded: input.databasesIncluded ?? 0,
      createdAt: Date.now(),
    };
    this.hostingPlans.set(plan.id, plan);
    return plan;
  }

  getHostingPlan(id: string): HostingPlan | undefined { return this.hostingPlans.get(id); }
  listHostingPlans(tier?: HostingTier): HostingPlan[] {
    const all = [...this.hostingPlans.values()];
    return tier ? all.filter((p) => p.tier === tier) : all;
  }

  /** Provision a hosting site: instance from the plan's flavor + image. */
  provisionHosting(input: {
    planId: string; regionId: string; siteName: string; imageId: string;
  }): Instance {
    const plan = this.hostingPlans.get(input.planId);
    if (!plan) throw new Error(`unknown hosting plan ${input.planId}`);
    if (!plan.flavorId && plan.tier !== 'shared') throw new Error(`plan ${plan.name} has no flavor`);
    const instance = this.provisionInstance({
      name: `${input.siteName}-host`,
      regionId: input.regionId,
      flavorId: plan.flavorId ?? this.listFlavors('shared')[0]!.id,
      imageId: input.imageId,
      hostingPlanId: plan.id,
    });
    // Managed tier: auto-provision storage + SSL automation is a plan feature.
    return instance;
  }

  // ---- autoscaling -------------------------------------------------------

  createAutoscalingGroup(input: {
    name: string; regionId: string; templateInstanceId: string;
    min: number; max: number; cpuHighThreshold?: number; cpuLowThreshold?: number;
  }): AutoscalingGroup {
    const template = this.instances.get(input.templateInstanceId);
    if (!template) throw new Error(`unknown template instance ${input.templateInstanceId}`);
    if (input.min < 0 || input.max < input.min) throw new Error('valid min/max required');
    const group: AutoscalingGroup = {
      id: randomUUID(), name: input.name, regionId: input.regionId,
      templateInstanceId: input.templateInstanceId,
      min: input.min, max: input.max,
      cpuHighThreshold: input.cpuHighThreshold ?? 0.75,
      cpuLowThreshold: input.cpuLowThreshold ?? 0.25,
      currentLoad: 0, createdAt: Date.now(),
    };
    this.autoscalingGroups.set(group.id, group);
    return group;
  }

  getAutoscalingGroup(id: string): AutoscalingGroup | undefined { return this.autoscalingGroups.get(id); }
  listAutoscalingGroups(): AutoscalingGroup[] { return [...this.autoscalingGroups.values()]; }

  /**
   * Evaluate an autoscaling group against the current load (0..1). Scales out
   * when load > cpuHighThreshold and count < max; scales in when load <
   * cpuLowThreshold and count > min (terminating the newest scaled instance).
   */
  evaluateAutoscaling(groupId: string, load: number): { action: 'scale_out' | 'scale_in' | 'none'; count: number } {
    const group = this.autoscalingGroups.get(groupId);
    if (!group) throw new Error(`unknown autoscaling group ${groupId}`);
    group.currentLoad = load;
    const members = this.listInstances({ autoscalingGroupId: groupId } as never)
      .filter((i) => i.autoscalingGroupId === groupId && i.status !== 'terminated');
    const template = this.getInstance(group.templateInstanceId)!;

    if (load > group.cpuHighThreshold && members.length < group.max) {
      this.provisionInstance({
        name: `${template.name}-scale`,
        regionId: group.regionId,
        flavorId: template.flavorId,
        imageId: template.imageId,
        autoscalingGroupId: groupId,
      });
      return { action: 'scale_out', count: members.length + 1 };
    }
    if (load < group.cpuLowThreshold && members.length > group.min) {
      // Terminate the newest member (oldest template stays).
      const newest = [...members].sort((a, b) => b.createdAt - a.createdAt)[0];
      if (newest) this.terminateInstance(newest.id);
      return { action: 'scale_in', count: members.length - 1 };
    }
    return { action: 'none', count: members.length };
  }

  // ---- analytics ---------------------------------------------------------

  stats(): CloudStats {
    const allInstances = [...this.instances.values()];
    const regions = [...this.regions.values()];
    const totalCapacity = regions.reduce((s, r) => s + r.capacitySlots, 0);
    const usedCapacity = regions.reduce((s, r) => s + r.usedSlots, 0);
    // Monthly revenue estimate: running instance hours × flavor price × 730.
    const monthlyRevenue = allInstances
      .filter((i) => i.status === 'running')
      .reduce((s, i) => s + (this.flavors.get(i.flavorId)?.pricePerHourMinor ?? 0) * 730, 0);
    return {
      regions: regions.length,
      operationalRegions: this.listRegions('operational').length,
      flavors: this.flavors.size,
      images: this.images.size,
      instances: allInstances.length,
      runningInstances: allInstances.filter((i) => i.status === 'running').length,
      volumes: this.volumes.size,
      snapshots: this.snapshots.size,
      vpcs: this.vpcs.size,
      firewallRules: this.firewallRules.size,
      loadBalancers: this.loadBalancers.size,
      hostingPlans: this.hostingPlans.size,
      autoscalingGroups: this.autoscalingGroups.size,
      capacityUsedPct: totalCapacity > 0 ? Math.round((usedCapacity / totalCapacity) * 1000) / 10 : 0,
      estimatedMonthlyRevenueMinor: monthlyRevenue,
    };
  }
}

/** Deterministic pseudo-IP from a string seed. */
function ipv4(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return `${(h % 223) + 1}.${(h >> 8) % 255}.${(h >> 16) % 255}.${(h >> 24) % 254 + 1}`;
}
