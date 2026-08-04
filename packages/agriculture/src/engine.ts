// AgricultureEngine — KARIS FARM core: farm/field registry, crop cycles with
// growth stages, livestock herds, harvest records, and yield analytics.
// Pure engine.

import { randomUUID } from 'node:crypto';
import type {
  AgricultureStats, CropCycle, CropStage, Farm, Field, FieldStatus,
  HarvestRecord, LivestockHerd, LivestockType,
} from './types.js';

export interface RegisterFarmInput {
  name: string;
  ownerId: string;
  location?: string;
  areaHa?: number;
}

export interface PlantCropInput {
  fieldId: string;
  crop: string;
  variety?: string;
  expectedYieldKg?: number;
}

export interface HarvestInput {
  cropCycleId: string;
  yieldKg: number;
}

export class AgricultureEngine {
  private farms = new Map<string, Farm>();
  private fields = new Map<string, Field>();
  private cycles = new Map<string, CropCycle>();
  private herds = new Map<string, LivestockHerd>();
  private harvests: HarvestRecord[] = [];

  // ---- farms + fields ----------------------------------------------------

  registerFarm(input: RegisterFarmInput): Farm {
    if (!input.name || !input.ownerId) throw new Error('name and ownerId are required');
    const farm: Farm = {
      id: randomUUID(), name: input.name, ownerId: input.ownerId,
      ...(input.location ? { location: input.location } : {}),
      areaHa: input.areaHa ?? 1,
      createdAt: Date.now(),
    };
    this.farms.set(farm.id, farm);
    return farm;
  }

  getFarm(id: string): Farm | undefined { return this.farms.get(id); }
  listFarms(ownerId?: string): Farm[] {
    const all = [...this.farms.values()];
    return ownerId ? all.filter((f) => f.ownerId === ownerId) : all;
  }

  addField(input: { farmId: string; name: string; areaHa?: number; soilType?: string }): Field {
    if (!this.farms.has(input.farmId)) throw new Error(`unknown farm ${input.farmId}`);
    if (!input.name) throw new Error('field name is required');
    const field: Field = {
      id: randomUUID(), farmId: input.farmId, name: input.name,
      areaHa: input.areaHa ?? 0.5, status: 'prepared',
      ...(input.soilType ? { soilType: input.soilType } : {}),
      createdAt: Date.now(),
    };
    this.fields.set(field.id, field);
    return field;
  }

  getField(id: string): Field | undefined { return this.fields.get(id); }
  listFields(farmId?: string, status?: FieldStatus): Field[] {
    return [...this.fields.values()].filter((f) =>
      (!farmId || f.farmId === farmId) && (!status || f.status === status));
  }

  setFieldStatus(id: string, status: FieldStatus): Field | undefined {
    const field = this.fields.get(id);
    if (!field) return undefined;
    field.status = status;
    return field;
  }

  // ---- crop cycles -------------------------------------------------------

  plantCrop(input: PlantCropInput): CropCycle {
    const field = this.fields.get(input.fieldId);
    if (!field) throw new Error(`unknown field ${input.fieldId}`);
    if (!input.crop) throw new Error('crop is required');
    const cycle: CropCycle = {
      id: randomUUID(),
      fieldId: input.fieldId,
      crop: input.crop,
      ...(input.variety ? { variety: input.variety } : {}),
      plantedAt: Date.now(),
      stage: 'planted',
      expectedYieldKg: input.expectedYieldKg ?? 1000,
      createdAt: Date.now(),
    };
    this.cycles.set(cycle.id, cycle);
    field.status = 'active';
    return cycle;
  }

  getCycle(id: string): CropCycle | undefined { return this.cycles.get(id); }
  listCycles(fieldId?: string, stage?: CropStage): CropCycle[] {
    return [...this.cycles.values()].filter((c) =>
      (!fieldId || c.fieldId === fieldId) && (!stage || c.stage === stage));
  }

  updateCycleStage(id: string, stage: CropStage): CropCycle | undefined {
    const cycle = this.cycles.get(id);
    if (!cycle) return undefined;
    cycle.stage = stage;
    if (stage === 'harvested' && cycle.harvestedAt === undefined) cycle.harvestedAt = Date.now();
    return cycle;
  }

  // ---- harvests ----------------------------------------------------------

  recordHarvest(input: HarvestInput): { harvest: HarvestRecord; cycle: CropCycle } {
    const cycle = this.cycles.get(input.cropCycleId);
    if (!cycle) throw new Error(`unknown crop cycle ${input.cropCycleId}`);
    if (input.yieldKg < 0) throw new Error('yield must be non-negative');
    const harvest: HarvestRecord = {
      id: randomUUID(),
      cropCycleId: cycle.id,
      fieldId: cycle.fieldId,
      crop: cycle.crop,
      yieldKg: input.yieldKg,
      harvestedAt: Date.now(),
    };
    this.harvests.push(harvest);
    cycle.stage = 'harvested';
    cycle.harvestedAt = harvest.harvestedAt;
    cycle.harvestedYieldKg = input.yieldKg;
    return { harvest, cycle };
  }

  harvestsList(farmId?: string): HarvestRecord[] {
    if (!farmId) return [...this.harvests];
    const fieldIds = new Set(this.listFields(farmId).map((f) => f.id));
    return this.harvests.filter((h) => fieldIds.has(h.fieldId));
  }

  // ---- livestock ---------------------------------------------------------

  registerHerd(input: { farmId: string; type: LivestockType; headCount: number }): LivestockHerd {
    if (!this.farms.has(input.farmId)) throw new Error(`unknown farm ${input.farmId}`);
    if (input.headCount < 0) throw new Error('headCount must be non-negative');
    const herd: LivestockHerd = {
      id: randomUUID(), farmId: input.farmId, type: input.type,
      headCount: input.headCount, healthStatus: 'healthy',
      createdAt: Date.now(),
    };
    this.herds.set(herd.id, herd);
    return herd;
  }

  listHerds(farmId?: string): LivestockHerd[] {
    const all = [...this.herds.values()];
    return farmId ? all.filter((h) => h.farmId === farmId) : all;
  }

  updateHerdHealth(id: string, healthStatus: LivestockHerd['healthStatus']): LivestockHerd | undefined {
    const herd = this.herds.get(id);
    if (!herd) return undefined;
    herd.healthStatus = healthStatus;
    return herd;
  }

  // ---- analytics ---------------------------------------------------------

  stats(farmId?: string): AgricultureStats {
    const farms = farmId ? this.listFarms().filter((f) => f.id === farmId) : this.listFarms();
    const farmIds = new Set(farms.map((f) => f.id));
    const fields = this.listFields().filter((f) => !farmId || farmIds.has(f.farmId));
    const fieldIds = new Set(fields.map((f) => f.id));
    const cycles = [...this.cycles.values()].filter((c) => !farmId || fieldIds.has(c.fieldId));
    const herds = this.listHerds().filter((h) => !farmId || farmIds.has(h.farmId));
    const harvests = this.harvestsList().filter((h) => !farmId || fieldIds.has(h.fieldId));
    const harvestedCycles = cycles.filter((c) => c.stage === 'harvested');
    const totalHarvestedKg = harvests.reduce((s, h) => s + h.yieldKg, 0);
    const harvestedArea = harvestedCycles.reduce((s, c) => {
      const field = this.fields.get(c.fieldId);
      return s + (field?.areaHa ?? 0);
    }, 0);
    return {
      farms: farms.length,
      fields: fields.length,
      activeFields: fields.filter((f) => f.status === 'active').length,
      cropCycles: cycles.length,
      activeCycles: cycles.filter((c) => c.stage !== 'harvested').length,
      harvestedCycles: harvestedCycles.length,
      herds: herds.length,
      livestockHead: herds.reduce((s, h) => s + h.headCount, 0),
      harvestRecords: harvests.length,
      totalHarvestedKg,
      ...(harvestedArea > 0 ? { avgYieldKgPerHa: totalHarvestedKg / harvestedArea } : {}),
    };
  }
}
