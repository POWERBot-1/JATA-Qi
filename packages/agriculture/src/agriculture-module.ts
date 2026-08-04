// AgricultureModule — KARIS FARM kernel module. Wraps the engine, emits bus
// events, and records planting/harvest milestones into the Digital Memory
// Engine.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { DigitalMemoryModule } from '@jataqi/memory';
import { AgricultureEngine, type HarvestInput, type PlantCropInput, type RegisterFarmInput } from './engine.js';
import type {
  AgricultureStats, CropCycle, CropStage, Farm, Field, FieldStatus,
  HarvestRecord, LivestockHerd, LivestockType,
} from './types.js';

export const AgricultureEvents = Object.freeze({
  FarmRegistered: 'agriculture.farm.registered',
  FieldAdded: 'agriculture.field.added',
  CropPlanted: 'agriculture.crop.planted',
  CropHarvested: 'agriculture.crop.harvested',
  HerdRegistered: 'agriculture.herd.registered',
} as const);

export class AgricultureModule implements IModule {
  readonly id = 'agriculture';
  readonly tags = ['core', 'agriculture', 'intelligence'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private memory?: DigitalMemoryModule;
  readonly engine = new AgricultureEngine();

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('agriculture', this);
    this.memory = this.tryModule<DigitalMemoryModule>('memory');
    kernel.logger.info('agriculture module initialized (KARIS FARM)');
  }
  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  registerFarm(input: RegisterFarmInput): Farm {
    const farm = this.engine.registerFarm(input);
    void this.api.bus.emit(AgricultureEvents.FarmRegistered, { id: farm.id, name: farm.name });
    return farm;
  }
  getFarm(id: string): Farm | undefined { return this.engine.getFarm(id); }
  listFarms(ownerId?: string): Farm[] { return this.engine.listFarms(ownerId); }

  addField(input: { farmId: string; name: string; areaHa?: number; soilType?: string }): Field {
    const field = this.engine.addField(input);
    void this.api.bus.emit(AgricultureEvents.FieldAdded, { id: field.id, farmId: field.farmId });
    return field;
  }
  listFields(farmId?: string, status?: FieldStatus): Field[] { return this.engine.listFields(farmId, status); }
  setFieldStatus(id: string, status: FieldStatus): Field | undefined { return this.engine.setFieldStatus(id, status); }

  plantCrop(input: PlantCropInput): CropCycle {
    const cycle = this.engine.plantCrop(input);
    void this.api.bus.emit(AgricultureEvents.CropPlanted, { id: cycle.id, crop: cycle.crop, fieldId: cycle.fieldId });
    void this.recordMemory('agriculture_crop', `planted ${cycle.crop} on field ${cycle.fieldId}`, {
      cycleId: cycle.id, crop: cycle.crop, fieldId: cycle.fieldId,
    });
    return cycle;
  }
  getCycle(id: string): CropCycle | undefined { return this.engine.getCycle(id); }
  listCycles(fieldId?: string, stage?: CropStage): CropCycle[] { return this.engine.listCycles(fieldId, stage); }
  updateCycleStage(id: string, stage: CropStage): CropCycle | undefined { return this.engine.updateCycleStage(id, stage); }

  async recordHarvest(input: HarvestInput): Promise<{ harvest: HarvestRecord; cycle: CropCycle }> {
    const result = this.engine.recordHarvest(input);
    void this.api.bus.emit(AgricultureEvents.CropHarvested, {
      id: result.cycle.id, crop: result.cycle.crop, yieldKg: input.yieldKg,
    });
    await this.recordMemory('agriculture_crop', `harvested ${result.cycle.crop}: ${input.yieldKg}kg`, {
      cycleId: result.cycle.id, crop: result.cycle.crop, yieldKg: input.yieldKg,
    });
    return result;
  }
  harvestsList(farmId?: string): HarvestRecord[] { return this.engine.harvestsList(farmId); }

  registerHerd(input: { farmId: string; type: LivestockType; headCount: number }): LivestockHerd {
    const herd = this.engine.registerHerd(input);
    void this.api.bus.emit(AgricultureEvents.HerdRegistered, { id: herd.id, type: herd.type, headCount: herd.headCount });
    return herd;
  }
  listHerds(farmId?: string): LivestockHerd[] { return this.engine.listHerds(farmId); }
  updateHerdHealth(id: string, healthStatus: LivestockHerd['healthStatus']): LivestockHerd | undefined {
    return this.engine.updateHerdHealth(id, healthStatus);
  }

  stats(farmId?: string): AgricultureStats { return this.engine.stats(farmId); }

  // ---- internals ---------------------------------------------------------

  private async recordMemory(category: string, summary: string, data: Record<string, unknown>): Promise<void> {
    if (!this.memory) return;
    try {
      await this.memory.record({ category, summary, data, tags: ['agriculture', category] });
    } catch { /* non-fatal */ }
  }

  private tryModule<T extends IModule>(id: string): T | undefined {
    try { return this.api.getModule<T>(id); } catch { return undefined; }
  }
}
