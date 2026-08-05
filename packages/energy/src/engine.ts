// EnergyEngine — KARIS ENERGY core: generation assets, meters with cumulative
// readings, consumption analytics (period usage, billing), tariffs. Pure engine.

import { randomUUID } from 'node:crypto';
import type { AssetStatus, EnergyAsset, EnergySource, EnergyStats, Meter, MeterReading, Tariff } from './types.js';

export interface RegisterAssetInput {
  name: string;
  source: EnergySource;
  capacityKw: number;
  location?: string;
}

export interface RecordReadingInput {
  meterId: string;
  kwh: number;
  voltageV?: number;
  ts?: number;
}

export interface BillInput {
  meterId: string;
  tariffId: string;
  /** Bill from this reading (or from the meter's first reading). */
  fromReadingId?: string;
  /** Bill up to this reading (default: the latest). */
  toReadingId?: string;
}

export interface BillResult {
  id: string;
  meterId: string;
  tariffId: string;
  /** kWh consumed in the period. */
  kwhUsed: number;
  /** Consumption charge in minor units. */
  consumptionCharge: number;
  /** Fixed charge in minor units. */
  fixedCharge: number;
  /** Total in minor units. */
  total: number;
  fromReadingId?: string;
  toReadingId?: string;
}

export class EnergyEngine {
  private assets = new Map<string, EnergyAsset>();
  private meters = new Map<string, Meter>();
  private readings = new Map<string, MeterReading>();
  private tariffs = new Map<string, Tariff>();
  private bills: BillResult[] = [];
  private readonly MAX_READINGS_PER_METER = 50_000;

  // ---- assets ------------------------------------------------------------

  registerAsset(input: RegisterAssetInput): EnergyAsset {
    if (!input.name) throw new Error('asset name is required');
    if (input.capacityKw <= 0) throw new Error('capacityKw must be positive');
    const asset: EnergyAsset = {
      id: randomUUID(), name: input.name, source: input.source,
      capacityKw: input.capacityKw, status: 'online',
      ...(input.location ? { location: input.location } : {}),
      createdAt: Date.now(),
    };
    this.assets.set(asset.id, asset);
    return asset;
  }

  getAsset(id: string): EnergyAsset | undefined { return this.assets.get(id); }
  listAssets(source?: EnergySource, status?: AssetStatus): EnergyAsset[] {
    return [...this.assets.values()].filter((a) =>
      (!source || a.source === source) && (!status || a.status === status));
  }

  setAssetStatus(id: string, status: AssetStatus): EnergyAsset | undefined {
    const asset = this.assets.get(id);
    if (!asset) return undefined;
    asset.status = status;
    return asset;
  }

  // ---- meters + readings -------------------------------------------------

  registerMeter(input: { name: string; customerId?: string; location?: string }): Meter {
    if (!input.name) throw new Error('meter name is required');
    const meter: Meter = {
      id: randomUUID(), name: input.name,
      ...(input.customerId ? { customerId: input.customerId } : {}),
      ...(input.location ? { location: input.location } : {}),
      createdAt: Date.now(),
    };
    this.meters.set(meter.id, meter);
    return meter;
  }

  getMeter(id: string): Meter | undefined { return this.meters.get(id); }
  listMeters(customerId?: string): Meter[] {
    const all = [...this.meters.values()];
    return customerId ? all.filter((m) => m.customerId === customerId) : all;
  }

  recordReading(input: RecordReadingInput): MeterReading {
    const meter = this.meters.get(input.meterId);
    if (!meter) throw new Error(`unknown meter ${input.meterId}`);
    if (input.kwh < 0) throw new Error('kwh must be non-negative');
    const reading: MeterReading = {
      id: randomUUID(), meterId: input.meterId, kwh: input.kwh,
      ...(input.voltageV !== undefined ? { voltageV: input.voltageV } : {}),
      ts: input.ts ?? Date.now(),
    };
    // Keep readings monotonically increasing per meter (drop stale/rewound).
    const existing = this.readingsFor(input.meterId);
    const last = existing[existing.length - 1];
    if (last && reading.kwh < last.kwh) throw new Error('reading rewound — kwh must not decrease for a meter');
    this.readings.set(reading.id, reading);
    return reading;
  }

  readingsFor(meterId: string, opts: { fromTs?: number; toTs?: number; limit?: number } = {}): MeterReading[] {
    const all = [...this.readings.values()]
      .filter((r) => r.meterId === meterId)
      .filter((r) => (opts.fromTs === undefined || r.ts >= opts.fromTs) && (opts.toTs === undefined || r.ts <= opts.toTs))
      .sort((a, b) => a.ts - b.ts);
    const limit = opts.limit ?? all.length;
    return limit >= all.length ? all : all.slice(-limit);
  }

  /** kWh consumed between two readings (or from zero). */
  consumption(meterId: string, fromReadingId?: string, toReadingId?: string): { kwh: number; from?: MeterReading; to?: MeterReading } {
    const all = this.readingsFor(meterId);
    if (all.length === 0) return { kwh: 0 };
    const to = toReadingId ? all.find((r) => r.id === toReadingId) : all[all.length - 1]!;
    if (!to) throw new Error(`reading ${toReadingId} not found`);
    const from = fromReadingId ? all.find((r) => r.id === fromReadingId) : undefined;
    const kwh = Math.max(0, to.kwh - (from?.kwh ?? 0));
    return { kwh, from, to };
  }

  // ---- tariffs + billing -------------------------------------------------

  registerTariff(input: { name: string; pricePerKwh: number; fixedCharge?: number }): Tariff {
    if (!input.name || input.pricePerKwh < 0) throw new Error('valid name and pricePerKwh are required');
    const tariff: Tariff = {
      id: randomUUID(), name: input.name, pricePerKwh: input.pricePerKwh,
      fixedCharge: input.fixedCharge ?? 0, createdAt: Date.now(),
    };
    this.tariffs.set(tariff.id, tariff);
    return tariff;
  }

  listTariffs(): Tariff[] { return [...this.tariffs.values()]; }

  bill(input: BillInput): BillResult {
    const tariff = this.tariffs.get(input.tariffId);
    if (!tariff) throw new Error(`unknown tariff ${input.tariffId}`);
    const { kwh, from, to } = this.consumption(input.meterId, input.fromReadingId, input.toReadingId);
    const consumptionCharge = Math.round(kwh * tariff.pricePerKwh);
    const bill: BillResult = {
      id: randomUUID(), meterId: input.meterId, tariffId: input.tariffId,
      kwhUsed: kwh, consumptionCharge, fixedCharge: tariff.fixedCharge,
      total: consumptionCharge + tariff.fixedCharge,
      ...(from ? { fromReadingId: from.id } : {}),
      ...(to ? { toReadingId: to.id } : {}),
    };
    this.bills.push(bill);
    return bill;
  }

  billsList(meterId?: string): BillResult[] {
    return meterId ? this.bills.filter((b) => b.meterId === meterId) : [...this.bills];
  }

  // ---- analytics ---------------------------------------------------------

  stats(): EnergyStats {
    const allAssets = [...this.assets.values()];
    const allMeters = [...this.meters.values()];
    const allReadings = [...this.readings.values()];
    const latestByMeter = new Map<string, MeterReading>();
    for (const r of allReadings) {
      const cur = latestByMeter.get(r.meterId);
      if (!cur || r.ts > cur.ts) latestByMeter.set(r.meterId, r);
    }
    const latest = [...latestByMeter.values()].sort((a, b) => b.ts - a.ts)[0];
    return {
      assets: allAssets.length,
      assetsOnline: allAssets.filter((a) => a.status === 'online').length,
      totalCapacityKw: allAssets.reduce((s, a) => s + a.capacityKw, 0),
      meters: allMeters.length,
      readings: allReadings.length,
      tariffs: this.tariffs.size,
      totalConsumptionKwh: [...latestByMeter.values()].reduce((s, r) => s + r.kwh, 0),
      ...(latest ? { latestReading: { meterId: latest.meterId, kwh: latest.kwh, ts: latest.ts } } : {}),
    };
  }
}
