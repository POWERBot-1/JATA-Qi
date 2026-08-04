// IoTModule — device registry, telemetry, commands (#50).
import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';

export type DeviceType = 'sensor' | 'actuator' | 'gateway' | 'camera' | 'robot';
export type DeviceStatus = 'online' | 'offline' | 'error' | 'maintenance';

export interface IoTDevice {
  id: string; name: string; type: DeviceType; protocol: string;
  location?: string; organizationId?: string; status: DeviceStatus;
  lastSeen?: number; metadata?: Record<string, unknown>; createdAt: number;
}
export interface TelemetryReading {
  id: string; deviceId: string; metric: string; value: number; unit: string; timestamp: number;
}
export interface DeviceCommand {
  id: string; deviceId: string; command: string; params?: Record<string, unknown>;
  status: 'queued' | 'sent' | 'acknowledged' | 'failed'; sentAt?: number; createdAt: number;
}
export const IoTEvents = Object.freeze({
  TelemetryRecorded: 'iot.telemetry.recorded', DeviceOffline: 'iot.device.offline', CommandSent: 'iot.command.sent',
} as const);

export class IoTModule implements IModule {
  readonly id = 'iot'; readonly tags = ['intelligence', 'iot'] as const; readonly dependsOn = ['storage'] as const;
  private api!: KernelApi; private devices!: ICollection<IoTDevice>;
  private telemetry!: ICollection<TelemetryReading>; private commands!: ICollection<DeviceCommand>;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as { collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>> };
    this.devices = await storage.collection<IoTDevice>('iot.devices');
    this.telemetry = await storage.collection<TelemetryReading>('iot.telemetry');
    this.commands = await storage.collection<DeviceCommand>('iot.commands');
    kernel.container.registerValue('iot', this);
    kernel.logger.info('iot module initialized');
  }
  async start(_k: KernelApi): Promise<void> {} async stop(_k: KernelApi): Promise<void> {}

  async registerDevice(input: { name: string; type: DeviceType; protocol: string; location?: string; organizationId?: string }): Promise<IoTDevice> {
    const d: IoTDevice = { id: randomUUID(), name: input.name, type: input.type, protocol: input.protocol, status: 'online', createdAt: Date.now(), ...(input.location ? { location: input.location } : {}), ...(input.organizationId ? { organizationId: input.organizationId } : {}) };
    await this.devices.put(d); return d;
  }
  async listDevices(type?: DeviceType, organizationId?: string): Promise<IoTDevice[]> {
    let all = await this.devices.all();
    if (type) all = all.filter((d) => d.type === type);
    if (organizationId) all = all.filter((d) => d.organizationId === organizationId);
    return all;
  }
  async updateDeviceStatus(id: string, status: DeviceStatus): Promise<IoTDevice> {
    const d = await this.devices.get(id); if (!d) throw new Error(`iot: device "${id}" not found`);
    const u: IoTDevice = { ...d, status, lastSeen: Date.now() }; await this.devices.put(u);
    if (status === 'offline') await this.api.bus.emit(IoTEvents.DeviceOffline, { deviceId: id });
    return u;
  }
  async recordTelemetry(deviceId: string, metric: string, value: number, unit: string): Promise<TelemetryReading> {
    const r: TelemetryReading = { id: randomUUID(), deviceId, metric, value, unit, timestamp: Date.now() };
    await this.telemetry.put(r);
    await this.api.bus.emit(IoTEvents.TelemetryRecorded, { deviceId, metric });
    // Update lastSeen.
    const d = await this.devices.get(deviceId);
    if (d) { d.lastSeen = Date.now(); await this.devices.put(d); }
    return r;
  }
  async listTelemetry(deviceId?: string, metric?: string, limit = 100): Promise<TelemetryReading[]> {
    let all = await this.telemetry.all();
    if (deviceId) all = all.filter((r) => r.deviceId === deviceId);
    if (metric) all = all.filter((r) => r.metric === metric);
    return all.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }
  async sendCommand(deviceId: string, command: string, params?: Record<string, unknown>): Promise<DeviceCommand> {
    const d = await this.devices.get(deviceId);
    if (!d) throw new Error(`iot: device "${deviceId}" not found`);
    if (d.status === 'offline') throw new Error(`iot: device "${deviceId}" is offline`);
    const cmd: DeviceCommand = { id: randomUUID(), deviceId, command, ...(params ? { params } : {}), status: 'sent', sentAt: Date.now(), createdAt: Date.now() };
    await this.commands.put(cmd);
    await this.api.bus.emit(IoTEvents.CommandSent, { deviceId, command });
    await this.audit(deviceId, 'command_sent', { command });
    return cmd;
  }
  async acknowledgeCommand(id: string): Promise<DeviceCommand> {
    const c = await this.commands.get(id); if (!c) throw new Error(`iot: command "${id}" not found`);
    const u: DeviceCommand = { ...c, status: 'acknowledged' }; await this.commands.put(u); return u;
  }
  async listCommands(deviceId?: string): Promise<DeviceCommand[]> {
    const all = await this.commands.all();
    return deviceId ? all.filter((c) => c.deviceId === deviceId) : all;
  }
  private async audit(actor: string, action: string, detail: Record<string, unknown>): Promise<void> {
    try { const s = this.api.getModule('security') as unknown as { audit: (r: Record<string, unknown>) => Promise<unknown> } | undefined; if (s?.audit) await s.audit({ actor, action: `iot.${action}`, result: 'success', detail }); } catch {}
  }
}
