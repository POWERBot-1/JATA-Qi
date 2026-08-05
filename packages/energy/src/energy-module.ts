// EnergyModule — KARIS ENERGY kernel module. Wraps the engine, emits bus
// events, and records readings/bills into the Digital Memory Engine.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { DigitalMemoryModule } from '@jataqi/memory';
import { EnergyEngine, type BillInput, type RecordReadingInput, type RegisterAssetInput } from './engine.js';
import type { AssetStatus, EnergyAsset, EnergySource, EnergyStats, Meter, MeterReading, Tariff } from './types.js';

export const EnergyEvents = Object.freeze({
  AssetRegistered: 'energy.asset.registered',
  AssetStatusChanged: 'energy.asset.status_changed',
  ReadingRecorded: 'energy.reading.recorded',
  BillIssued: 'energy.bill.issued',
} as const);

export class EnergyModule implements IModule {
  readonly id = 'energy';
  readonly tags = ['core', 'energy', 'intelligence'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private memory?: DigitalMemoryModule;
  readonly engine = new EnergyEngine();

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('energy', this);
    this.memory = this.tryModule<DigitalMemoryModule>('memory');
    kernel.logger.info('energy module initialized (KARIS ENERGY)');
  }
  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  registerAsset(input: RegisterAssetInput): EnergyAsset {
    const asset = this.engine.registerAsset(input);
    void this.api.bus.emit(EnergyEvents.AssetRegistered, { id: asset.id, source: asset.source, capacityKw: asset.capacityKw });
    return asset;
  }
  getAsset(id: string): EnergyAsset | undefined { return this.engine.getAsset(id); }
  listAssets(source?: EnergySource, status?: AssetStatus): EnergyAsset[] { return this.engine.listAssets(source, status); }
  setAssetStatus(id: string, status: AssetStatus): EnergyAsset | undefined {
    const asset = this.engine.setAssetStatus(id, status);
    if (asset) void this.api.bus.emit(EnergyEvents.AssetStatusChanged, { id: asset.id, status: asset.status });
    return asset;
  }

  registerMeter(input: { name: string; customerId?: string; location?: string }): Meter {
    return this.engine.registerMeter(input);
  }
  listMeters(customerId?: string): Meter[] { return this.engine.listMeters(customerId); }
  readingsFor(meterId: string, opts?: { fromTs?: number; toTs?: number; limit?: number }): MeterReading[] {
    return this.engine.readingsFor(meterId, opts);
  }

  async recordReading(input: RecordReadingInput): Promise<MeterReading> {
    const reading = this.engine.recordReading(input);
    void this.api.bus.emit(EnergyEvents.ReadingRecorded, { id: reading.id, meterId: reading.meterId, kwh: reading.kwh });
    await this.recordMemory('energy_reading', `meter ${reading.meterId} at ${reading.kwh} kWh`, {
      readingId: reading.id, meterId: reading.meterId, kwh: reading.kwh,
    });
    return reading;
  }

  registerTariff(input: { name: string; pricePerKwh: number; fixedCharge?: number }): Tariff {
    return this.engine.registerTariff(input);
  }
  listTariffs(): Tariff[] { return this.engine.listTariffs(); }

  async bill(input: BillInput): Promise<import('./engine.js').BillResult> {
    const result = this.engine.bill(input);
    void this.api.bus.emit(EnergyEvents.BillIssued, { id: result.id, meterId: result.meterId, total: result.total });
    await this.recordMemory('energy_bill', `bill ${result.total} minor units for meter ${result.meterId}`, {
      billId: result.id, meterId: result.meterId, kwhUsed: result.kwhUsed, total: result.total,
    });
    return result;
  }
  billsList(meterId?: string): import('./engine.js').BillResult[] { return this.engine.billsList(meterId); }

  stats(): EnergyStats { return this.engine.stats(); }

  // ---- internals ---------------------------------------------------------

  private async recordMemory(category: string, summary: string, data: Record<string, unknown>): Promise<void> {
    if (!this.memory) return;
    try {
      await this.memory.record({ category, summary, data, tags: ['energy', category] });
    } catch { /* non-fatal */ }
  }

  private tryModule<T extends IModule>(id: string): T | undefined {
    try { return this.api.getModule<T>(id); } catch { return undefined; }
  }
}
