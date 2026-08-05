// KARIS ENERGY — Energy Intelligence (Phase 7) types.

export type EnergySource = 'solar' | 'wind' | 'hydro' | 'grid' | 'diesel' | 'battery';

export type AssetStatus = 'online' | 'offline' | 'maintenance';

export interface EnergyAsset {
  id: string;
  name: string;
  source: EnergySource;
  /** Rated capacity in kW. */
  capacityKw: number;
  status: AssetStatus;
  location?: string;
  createdAt: number;
}

export interface Meter {
  id: string;
  name: string;
  /** Customer / site the meter belongs to. */
  customerId?: string;
  location?: string;
  createdAt: number;
}

export interface MeterReading {
  id: string;
  meterId: string;
  /** Cumulative consumption in kWh. */
  kwh: number;
  /** Voltage (V) when reported. */
  voltageV?: number;
  ts: number;
}

export interface Tariff {
  id: string;
  name: string;
  /** Price per kWh in minor units. */
  pricePerKwh: number;
  /** Fixed monthly charge in minor units. */
  fixedCharge: number;
  createdAt: number;
}

export interface EnergyStats {
  assets: number;
  assetsOnline: number;
  totalCapacityKw: number;
  meters: number;
  readings: number;
  tariffs: number;
  totalConsumptionKwh: number;
  latestReading?: { meterId: string; kwh: number; ts: number };
}
