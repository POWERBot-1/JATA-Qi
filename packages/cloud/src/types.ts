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
  // ---- deep-dive (all optional → backward compatible) ---------------------
  /** Min seconds between scale actions (anti-flapping). */
  cooldownMs?: number;
  /** Memory utilization thresholds (0..1). */
  memoryHighThreshold?: number;
  memoryLowThreshold?: number;
  /** Requests-per-minute thresholds. */
  requestsHigh?: number;
  requestsLow?: number;
  /** Time-of-day capacity override windows (local hours). */
  schedule?: AutoscaleScheduleWindow[];
  /** When the last scale action happened (cooldown bookkeeping). */
  lastDecisionAt?: number;
  /** Rollup of recent evaluation decisions. */
  decisions?: AutoscaleDecision[];
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

// ---- Autoscaling deep-dive: multi-signal thresholds, cooldowns, schedules,

export interface AutoscaleScheduleWindow {
  /** Local hour (0-23) when the window starts. */
  startHour: number;
  /** Local hour (0-23, exclusive) when the window ends. */
  endHour: number;
  /** Override min capacity during the window. */
  min?: number;
  /** Override max capacity during the window. */
  max?: number;
}

export interface AutoscaleSignals {
  /** CPU utilization 0..1. */
  cpu?: number;
  /** Memory utilization 0..1. */
  memory?: number;
  /** Requests per minute. */
  requestsPerMinute?: number;
}

export interface AutoscaleDecision {
  ts: number;
  signals: AutoscaleSignals;
  action: 'scale_out' | 'scale_in' | 'none';
  count: number;
  reason: string;
}

export interface AutoscalingHistoryEntry extends AutoscaleDecision {
  groupId: string;
}
