// RoboticsModule — device registry, telemetry, and mission assignment (spec
// Step 32). Devices and missions persist via the storage layer; the module is
// the governed bridge between digital intelligence and physical machines.

import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';
import { RoboticsEvents } from './types.js';
import type { Device, DeviceStatus, Mission, MissionStatus } from './types.js';

const COL_DEVICES = 'robotics.devices';
const COL_MISSIONS = 'robotics.missions';

export interface RegisterDeviceInput {
  name: string;
  kind: Device['kind'];
  capabilities?: string[];
  location?: Device['location'];
  specs?: Record<string, unknown>;
}

export class RoboticsModule implements IModule {
  readonly id = 'robotics';
  readonly tags = ['intelligence', 'robotics'] as const;
  readonly dependsOn = ['storage'] as const;

  private api!: KernelApi;
  private devices!: ICollection<Device>;
  private missions!: ICollection<Mission>;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as {
      collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>>;
    };
    this.devices = await storage.collection<Device>(COL_DEVICES);
    this.missions = await storage.collection<Mission>(COL_MISSIONS);
    kernel.container.registerValue('robotics', this);
    kernel.logger.info('robotics module initialized');
  }

  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  registerDevice(input: RegisterDeviceInput): Device {
    if (!input.name) throw new Error('robotics: device name is required');
    const now = Date.now();
    const device: Device = {
      id: randomUUID(),
      name: input.name,
      kind: input.kind,
      capabilities: input.capabilities ?? [],
      status: 'online',
      telemetry: {},
      twin: {},
      lastSeen: now,
      createdAt: now,
      ...(input.location ? { location: input.location } : {}),
      ...(input.specs ? { twin: { specs: input.specs } } : {}),
    };
    return device;
  }

  async addDevice(input: RegisterDeviceInput): Promise<Device> {
    const device = this.registerDevice(input);
    await this.devices.put(device);
    await this.api.bus.emit(RoboticsEvents.DeviceRegistered, { id: device.id, kind: device.kind });
    return device;
  }

  async getDevice(id: string): Promise<Device | undefined> {
    return this.devices.get(id);
  }

  async listDevices(kind?: string): Promise<Device[]> {
    const all = await this.devices.all();
    return kind ? all.filter((d) => d.kind === kind) : all;
  }

  async setStatus(id: string, status: DeviceStatus): Promise<Device> {
    const d = await this.devices.get(id);
    if (!d) throw new Error(`robotics: device "${id}" not found`);
    const updated: Device = { ...d, status, lastSeen: Date.now() };
    await this.devices.put(updated);
    await this.api.bus.emit(RoboticsEvents.StatusChanged, { id, status });
    return updated;
  }

  async recordTelemetry(id: string, readings: Record<string, number>): Promise<Device> {
    const d = await this.devices.get(id);
    if (!d) throw new Error(`robotics: device "${id}" not found`);
    const updated: Device = { ...d, telemetry: { ...d.telemetry, ...readings }, lastSeen: Date.now() };
    await this.devices.put(updated);
    await this.api.bus.emit(RoboticsEvents.TelemetryRecorded, { id, readings });
    return updated;
  }

  async addMaintenance(id: string, note: string): Promise<Device> {
    const d = await this.devices.get(id);
    if (!d) throw new Error(`robotics: device "${id}" not found`);
    const record = { at: Date.now(), note };
    const maintenance = [...(d.twin.maintenance ?? []), record];
    const updated: Device = { ...d, twin: { ...d.twin, maintenance } };
    await this.devices.put(updated);
    return updated;
  }

  async assignMission(deviceId: string, objective: string): Promise<Mission> {
    const d = await this.devices.get(deviceId);
    if (!d) throw new Error(`robotics: device "${deviceId}" not found`);
    const now = Date.now();
    const mission: Mission = {
      id: randomUUID(),
      deviceId,
      objective,
      status: 'active',
      createdAt: now,
      assignedAt: now,
    };
    await this.missions.put(mission);
    await this.setStatus(deviceId, 'busy');
    await this.api.bus.emit(RoboticsEvents.MissionAssigned, { id: mission.id, deviceId });
    return mission;
  }

  async completeMission(missionId: string, status: 'completed' | 'failed', result?: string): Promise<Mission> {
    const m = await this.missions.get(missionId);
    if (!m) throw new Error(`robotics: mission "${missionId}" not found`);
    const now = Date.now();
    const updated: Mission = { ...m, status, completedAt: now, ...(result !== undefined ? { result } : {}) };
    await this.missions.put(updated);
    await this.setStatus(m.deviceId, 'online');
    await this.api.bus.emit(RoboticsEvents.MissionCompleted, { id: missionId, status });
    return updated;
  }

  async listMissions(deviceId?: string, status?: MissionStatus): Promise<Mission[]> {
    let all = await this.missions.all();
    if (deviceId) all = all.filter((m) => m.deviceId === deviceId);
    if (status) all = all.filter((m) => m.status === status);
    return all.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }

  async stats(): Promise<{ devices: number; missions: number; byStatus: Record<string, number> }> {
    const devices = await this.devices.all();
    const byStatus: Record<string, number> = {};
    for (const d of devices) byStatus[d.status] = (byStatus[d.status] ?? 0) + 1;
    return { devices: devices.length, missions: await this.missions.count(), byStatus };
  }
}
