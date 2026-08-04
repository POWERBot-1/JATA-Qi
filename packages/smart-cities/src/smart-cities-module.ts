// SmartCitiesModule — city services, metrics, alerts (#32).
import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';

export type CityDomain = 'transport' | 'energy' | 'water' | 'waste' | 'safety' | 'planning' | string;
export interface CityService {
  id: string; name: string; domain: CityDomain; organizationId?: string;
  status: 'active' | 'inactive'; createdAt: number;
}
export interface CityMetric {
  id: string; serviceId: string; metric: string; value: number; unit: string;
  period: string; timestamp: number;
}
export interface CityAlert {
  id: string; serviceId: string; metric: string; threshold: number; value: number;
  severity: 'info' | 'warning' | 'critical'; message: string; acknowledged: boolean; createdAt: number;
}
export const SmartCityEvents = Object.freeze({ AlertTriggered: 'city.alert.triggered' } as const);

export class SmartCitiesModule implements IModule {
  readonly id = 'smart-cities'; readonly tags = ['intelligence', 'city'] as const; readonly dependsOn = ['storage'] as const;
  private api!: KernelApi; private services!: ICollection<CityService>;
  private metrics!: ICollection<CityMetric>; private alerts!: ICollection<CityAlert>;
  private readonly thresholds = new Map<string, { maxValue?: number; minValue?: number }>();

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as { collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>> };
    this.services = await storage.collection<CityService>('city.services');
    this.metrics = await storage.collection<CityMetric>('city.metrics');
    this.alerts = await storage.collection<CityAlert>('city.alerts');
    kernel.container.registerValue('smart-cities', this);
    kernel.logger.info('smart-cities module initialized');
  }
  async start(_k: KernelApi): Promise<void> {} async stop(_k: KernelApi): Promise<void> {}

  async createService(input: { name: string; domain: CityDomain; organizationId?: string }): Promise<CityService> {
    const s: CityService = { id: randomUUID(), name: input.name, domain: input.domain, status: 'active', createdAt: Date.now(), ...(input.organizationId ? { organizationId: input.organizationId } : {}) };
    await this.services.put(s); return s;
  }
  async listServices(domain?: CityDomain): Promise<CityService[]> {
    const all = await this.services.all(); return domain ? all.filter((s) => s.domain === domain) : all;
  }

  setThreshold(serviceId: string, metric: string, config: { maxValue?: number; minValue?: number }): void {
    this.thresholds.set(`${serviceId}:${metric}`, config);
  }

  async recordMetric(serviceId: string, metric: string, value: number, unit: string, period: string): Promise<{ metric_rec: CityMetric; alert?: CityAlert }> {
    const m: CityMetric = { id: randomUUID(), serviceId, metric, value, unit, period, timestamp: Date.now() };
    await this.metrics.put(m);
    const cfg = this.thresholds.get(`${serviceId}:${metric}`);
    let alert: CityAlert | undefined;
    if (cfg) {
      const exceeded = (cfg.maxValue !== undefined && value > cfg.maxValue) || (cfg.minValue !== undefined && value < cfg.minValue);
      if (exceeded) {
        const severity = cfg.maxValue !== undefined && value > cfg.maxValue * 1.5 ? 'critical' : 'warning';
        alert = { id: randomUUID(), serviceId, metric, threshold: cfg.maxValue ?? cfg.minValue ?? 0, value, severity, message: `${metric}=${value}${unit} exceeds threshold ${cfg.maxValue ?? cfg.minValue}`, acknowledged: false, createdAt: Date.now() };
        await this.alerts.put(alert);
        await this.api.bus.emit(SmartCityEvents.AlertTriggered, { serviceId, metric, severity });
      }
    }
    return { metric_rec: m, ...(alert ? { alert } : {}) };
  }

  async listMetrics(serviceId?: string, metric?: string, limit = 100): Promise<CityMetric[]> {
    let all = await this.metrics.all();
    if (serviceId) all = all.filter((m) => m.serviceId === serviceId);
    if (metric) all = all.filter((m) => m.metric === metric);
    return all.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }
  async listAlerts(acknowledged?: boolean): Promise<CityAlert[]> {
    const all = await this.alerts.all();
    return acknowledged !== undefined ? all.filter((a) => a.acknowledged === acknowledged) : all;
  }
  async acknowledgeAlert(id: string): Promise<CityAlert> {
    const a = await this.alerts.get(id); if (!a) throw new Error(`smart-cities: alert "${id}" not found`);
    const u: CityAlert = { ...a, acknowledged: true }; await this.alerts.put(u); return u;
  }
}
