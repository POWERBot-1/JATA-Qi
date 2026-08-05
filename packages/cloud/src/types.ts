// JATA Qi PRX Part E — Cloud Infrastructure Provider types.
// Covers the accreditation domains: cloud (VMs, storage, networks, GPU,
// autoscaling, multi-region), vps (virtual private servers), hosting
// (shared/dedicated/managed plans, SSL automation, backups).

export interface Region {
  id: string;
  name: string;
  code: string;
  country: string;
  zones: string[];
  /** Total allocatable compute slots. */
  capacitySlots: number;
  usedSlots: number;
  status: 'operational' | 'degraded' | 'maintenance';
  createdAt: number;
}

export type FlavorTier = 'shared' | 'vps' | 'dedicated' | 'gpu';

export interface Flavor {
  id: string;
  name: string;
  tier: FlavorTier;
  vcpu: number;
  ramGb: number;
  diskGb: number;
  gpu?: number;
  /** Price per hour in minor units. */
  pricePerHourMinor: number;
  createdAt: number;
}

export interface Image {
  id: string;
  name: string;
  os: string;
  version: string;
  arch: 'x86_64' | 'arm64';
  createdAt: number;
}

export type InstanceStatus = 'provisioning' | 'running' | 'stopped' | 'terminated' | 'failed';

export interface Instance {
  id: string;
  name: string;
  regionId: string;
  zone: string;
  flavorId: string;
  imageId: string;
  status: InstanceStatus;
  publicIp?: string;
  privateIp?: string;
  vpcId?: string;
  volumeIds: string[];
  /** Hosting plan this instance was provisioned under (when applicable). */
  hostingPlanId?: string;
  autoscalingGroupId?: string;
  createdAt: number;
  updatedAt: number;
}

export type VolumeStatus = 'available' | 'attached' | 'snapshotting';

export interface Volume {
  id: string;
  name: string;
  sizeGb: number;
  regionId: string;
  status: VolumeStatus;
  instanceId?: string;
  createdAt: number;
}

export interface Snapshot {
  id: string;
  volumeId: string;
  sizeGb: number;
  createdAt: number;
}

export interface Vpc {
  id: string;
  name: string;
  regionId: string;
  cidr: string;
  subnetCidrs: string[];
  createdAt: number;
}

export type FirewallAction = 'allow' | 'deny';
export type FirewallDirection = 'ingress' | 'egress';
export type FirewallProtocol = 'tcp' | 'udp' | 'icmp' | 'any';

export interface FirewallRule {
  id: string;
  vpcId: string;
  name: string;
  direction: FirewallDirection;
  protocol: FirewallProtocol;
  portRange?: string;
  sourceCidr?: string;
  action: FirewallAction;
  createdAt: number;
}

export interface LoadBalancer {
  id: string;
  name: string;
  regionId: string;
  protocol: FirewallProtocol;
  port: number;
  targetInstanceIds: string[];
  status: 'active' | 'draining' | 'offline';
  createdAt: number;
}

export type HostingTier = 'shared' | 'vps' | 'dedicated' | 'managed';

export interface HostingPlan {
  id: string;
  name: string;
  tier: HostingTier;
  /** Flavor used for vps/dedicated tiers. */
  flavorId?: string;
  monthlyPriceMinor: number;
  sslAutomation: boolean;
  cdnIncluded: boolean;
  backupIncluded: boolean;
  databasesIncluded: number;
  createdAt: number;
}

export interface AutoscalingGroup {
  id: string;
  name: string;
  regionId: string;
  /** Template instance (flavor/image) cloned for scaling. */
  templateInstanceId: string;
  min: number;
  max: number;
  /** CPU utilization threshold (0..1) that triggers scale-out. */
  cpuHighThreshold: number;
  /** CPU utilization threshold that triggers scale-in. */
  cpuLowThreshold: number;
  currentLoad: number;
  createdAt: number;
}

export interface CloudStats {
  regions: number;
  operationalRegions: number;
  flavors: number;
  images: number;
  instances: number;
  runningInstances: number;
  volumes: number;
  snapshots: number;
  vpcs: number;
  firewallRules: number;
  loadBalancers: number;
  hostingPlans: number;
  autoscalingGroups: number;
  capacityUsedPct: number;
  estimatedMonthlyRevenueMinor: number;
}
