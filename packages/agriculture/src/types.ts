// KARIS FARM — Agricultural Intelligence (Phase 7) types.

export interface Farm {
  id: string;
  name: string;
  ownerId: string;
  location?: string;
  /** Total area in hectares. */
  areaHa: number;
  createdAt: number;
}

export type FieldStatus = 'active' | 'fallow' | 'prepared';

export interface Field {
  id: string;
  farmId: string;
  name: string;
  areaHa: number;
  status: FieldStatus;
  soilType?: string;
  createdAt: number;
}

export type CropStage = 'planted' | 'growing' | 'flowering' | 'harvesting' | 'harvested';

export interface CropCycle {
  id: string;
  fieldId: string;
  crop: string;
  variety?: string;
  plantedAt: number;
  stage: CropStage;
  /** Expected yield in kg (estimate). */
  expectedYieldKg: number;
  harvestedAt?: number;
  harvestedYieldKg?: number;
  createdAt: number;
}

export type LivestockType = 'cattle' | 'goat' | 'sheep' | 'poultry' | 'pig';

export interface LivestockHerd {
  id: string;
  farmId: string;
  type: LivestockType;
  headCount: number;
  healthStatus: 'healthy' | 'attention' | 'sick';
  createdAt: number;
}

export interface HarvestRecord {
  id: string;
  cropCycleId: string;
  fieldId: string;
  crop: string;
  yieldKg: number;
  harvestedAt: number;
}

export interface AgricultureStats {
  farms: number;
  fields: number;
  activeFields: number;
  cropCycles: number;
  activeCycles: number;
  harvestedCycles: number;
  herds: number;
  livestockHead: number;
  harvestRecords: number;
  totalHarvestedKg: number;
  avgYieldKgPerHa?: number;
}
