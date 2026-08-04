// EnvironmentModule — monitoring stations, readings, threshold alerts, sustainability (#31).
import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';
import { EnvironmentEvents } from './types.js';
import type { EnvironmentalAlert, EnvironmentalReading, MonitoringStation, SustainabilityMetric } from './types.js';

const COL = { STA: 'env.stations', READ: 'env.readings', ALERT: 'env.alerts', SUST: 'env.sustainability' };

export interface ThresholdConfig { parameter: string; maxValue?: number; minValue?: number; }

export class EnvironmentModule implements IModule {
  readonly id = 'environment'; readonly tags = ['intelligence', 'environment'] as const; readonly dependsOn = ['storage'] as const;
  private api!: KernelApi; private stations!: ICollection<MonitoringStation>; private readings!: ICollection<EnvironmentalReading>;
  private alerts!: ICollection<EnvironmentalAlert>; private sustainability!: ICollection<SustainabilityMetric>;
  private readonly thresholds = new Map<string, ThresholdConfig>();

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as { collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>> };
    const C = <T extends { id: string }>(n: string) => storage.collection<T>(n);
    this.stations = await C<MonitoringStation>(COL.STA); this.readings = await C<EnvironmentalReading>(COL.READ);
    this.alerts = await C<EnvironmentalAlert>(COL.ALERT); this.sustainability = await C<SustainabilityMetric>(COL.SUST);
    kernel.container.registerValue('environment', this);
    kernel.logger.info('environment module initialized');
  }
  async start(_k: KernelApi): Promise<void> {} async stop(_k: KernelApi): Promise<void> {}

  setThreshold(stationId: string, config: ThresholdConfig): void { this.thresholds.set(`${stationId}:${config.parameter}`, config); }

  async createStation(input: { name: string; type: MonitoringStation['type']; location?: string; organizationId?: string }): Promise<MonitoringStation> {
    const s: MonitoringStation = { id: randomUUID(), name: input.name, type: input.type, status: 'active', createdAt: Date.now(), ...(input.location ? { location: input.location } : {}), ...(input.organizationId ? { organizationId: input.organizationId } : {}) };
    await this.stations.put(s); return s;
  }
  async listStations(type?: string): Promise<MonitoringStation[]> {
    const all = await this.stations.all(); return type ? all.filter((s) => s.type === type) : all;
  }

  async recordReading(stationId: string, parameter: string, value: number, unit: string): Promise<{ reading: EnvironmentalReading; alert?: EnvironmentalAlert }> {
    const reading: EnvironmentalReading = { id: randomUUID(), stationId, parameter, value, unit, timestamp: Date.now() };
    await this.readings.put(reading);
    await this.api.bus.emit(EnvironmentEvents.ReadingRecorded, { stationId, parameter });
    // Check thresholds.
    const cfg = this.thresholds.get(`${stationId}:${parameter}`);
    let alert: EnvironmentalAlert | undefined;
    if (cfg) {
      const exceeded = (cfg.maxValue !== undefined && value > cfg.maxValue) || (cfg.minValue !== undefined && value < cfg.minValue);
      if (exceeded) {
        const severity = cfg.maxValue !== undefined && value > (cfg.maxValue * 1.5) ? 'critical' : 'warning';
        alert = { id: randomUUID(), stationId, parameter, threshold: cfg.maxValue ?? cfg.minValue ?? 0, value, severity, message: `${parameter} = ${value} ${unit} (threshold ${cfg.maxValue ?? cfg.minValue})`, acknowledged: false, createdAt: Date.now() };
        await this.alerts.put(alert);
        await this.api.bus.emit(EnvironmentEvents.AlertTriggered, { alertId: alert.id, stationId, parameter, severity });
        await this.notify(stationId, 'environment', `Environmental alert: ${parameter}`, alert.message);
      }
    }
    await this.audit(stationId, 'reading_recorded', { parameter, value });
    return { reading, ...(alert ? { alert } : {}) };
  }

  async listReadings(stationId?: string, parameter?: string, limit = 100): Promise<EnvironmentalReading[]> {
    let all = await this.readings.all();
    if (stationId) all = all.filter((r) => r.stationId === stationId);
    if (parameter) all = all.filter((r) => r.parameter === parameter);
    return all.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }
  async listAlerts(acknowledged?: boolean): Promise<EnvironmentalAlert[]> {
    const all = await this.alerts.all();
    return acknowledged !== undefined ? all.filter((a) => a.acknowledged === acknowledged) : all;
  }
  async acknowledgeAlert(id: string): Promise<EnvironmentalAlert> {
    const a = await this.alerts.get(id); if (!a) throw new Error(`environment: alert "${id}" not found`);
    const u: EnvironmentalAlert = { ...a, acknowledged: true }; await this.alerts.put(u); return u;
  }

  async recordSustainability(input: { organizationId?: string; metric: string; value: number; unit: string; period: string }): Promise<SustainabilityMetric> {
    const m: SustainabilityMetric = { id: randomUUID(), ...input, createdAt: Date.now() };
    await this.sustainability.put(m); return m;
  }
  async listSustainability(metric?: string): Promise<SustainabilityMetric[]> {
    const all = await this.sustainability.all(); return metric ? all.filter((m) => m.metric === metric) : all;
  }

  private async audit(actor: string, action: string, detail: Record<string, unknown>): Promise<void> {
    try { const s = this.api.getModule('security') as unknown as { audit: (r: Record<string, unknown>) => Promise<unknown> } | undefined; if (s?.audit) await s.audit({ actor, action: `env.${action}`, result: 'success', detail }); } catch {}
  }
  private async notify(r: string, t: string, title: string, body: string): Promise<void> {
    try { const n = this.api.getModule('notifications') as unknown as { notify: (r: string, p: { type: string; title: string; body?: string }) => Promise<unknown> } | undefined; if (n?.notify) await n.notify(r, { type: t, title, body }); } catch {}
  }
}
