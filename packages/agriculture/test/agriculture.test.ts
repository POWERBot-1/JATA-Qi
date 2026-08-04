// KARIS FARM (Phase 7) tests: farm/field registry, crop cycles with growth
// stages, harvest records + yield analytics, livestock herds, and memory
// integration.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AgricultureEngine } from '../src/index.js';
import { AgricultureModule } from '../src/index.js';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { DigitalMemoryModule } from '@jataqi/memory';

describe('AgricultureEngine', () => {
  it('registers farms and fields', () => {
    const a = new AgricultureEngine();
    const farm = a.registerFarm({ name: 'Green Acres', ownerId: 'u1', location: 'Nakuru', areaHa: 25 });
    assert.equal(a.getFarm(farm.id)!.areaHa, 25);
    assert.equal(a.listFarms('u1').length, 1);
    assert.throws(() => a.registerFarm({ name: '', ownerId: 'u1' }), /required/);

    const field = a.addField({ farmId: farm.id, name: 'North Plot', areaHa: 8, soilType: 'loam' });
    assert.equal(field.status, 'prepared');
    assert.equal(a.listFields(farm.id).length, 1);
    a.setFieldStatus(field.id, 'active');
    assert.equal(a.getField(field.id)!.status, 'active');
    assert.throws(() => a.addField({ farmId: 'nope', name: 'X' }), /unknown farm/);
  });

  it('plants crops, walks growth stages, and records harvests', () => {
    const a = new AgricultureEngine();
    const farm = a.registerFarm({ name: 'Farm', ownerId: 'u1', areaHa: 10 });
    const field = a.addField({ farmId: farm.id, name: 'Plot A', areaHa: 2 });
    const cycle = a.plantCrop({ fieldId: field.id, crop: 'maize', variety: 'H513', expectedYieldKg: 3000 });
    assert.equal(cycle.stage, 'planted');
    assert.equal(a.getField(field.id)!.status, 'active');

    a.updateCycleStage(cycle.id, 'growing');
    a.updateCycleStage(cycle.id, 'flowering');
    a.updateCycleStage(cycle.id, 'harvesting');
    assert.equal(a.getCycle(cycle.id)!.stage, 'harvesting');

    const { harvest, cycle: done } = a.recordHarvest({ cropCycleId: cycle.id, yieldKg: 3400 });
    assert.equal(harvest.crop, 'maize');
    assert.equal(done.stage, 'harvested');
    assert.equal(done.harvestedYieldKg, 3400);
    assert.equal(a.harvestsList().length, 1);
    assert.equal(a.harvestsList(farm.id).length, 1);
    assert.throws(() => a.recordHarvest({ cropCycleId: 'nope', yieldKg: 10 }), /unknown crop cycle/);
  });

  it('tracks livestock herds and health', () => {
    const a = new AgricultureEngine();
    const farm = a.registerFarm({ name: 'Ranch', ownerId: 'u1' });
    const herd = a.registerHerd({ farmId: farm.id, type: 'cattle', headCount: 42 });
    a.registerHerd({ farmId: farm.id, type: 'poultry', headCount: 500 });
    assert.equal(a.listHerds(farm.id).length, 2);
    a.updateHerdHealth(herd.id, 'attention');
    assert.equal(a.listHerds()[0]!.healthStatus, 'attention');
    assert.throws(() => a.registerHerd({ farmId: 'nope', type: 'goat', headCount: 3 }), /unknown farm/);
  });

  it('computes yield analytics per farm', () => {
    const a = new AgricultureEngine();
    const farm = a.registerFarm({ name: 'Farm', ownerId: 'u1', areaHa: 10 });
    const f1 = a.addField({ farmId: farm.id, name: 'P1', areaHa: 2 });
    const f2 = a.addField({ farmId: farm.id, name: 'P2', areaHa: 3 });
    const c1 = a.plantCrop({ fieldId: f1.id, crop: 'wheat', expectedYieldKg: 2000 });
    a.plantCrop({ fieldId: f2.id, crop: 'wheat', expectedYieldKg: 3000 });
    a.recordHarvest({ cropCycleId: c1.id, yieldKg: 2400 });

    const stats = a.stats(farm.id);
    assert.equal(stats.fields, 2);
    assert.equal(stats.cropCycles, 2);
    assert.equal(stats.harvestedCycles, 1);
    assert.equal(stats.totalHarvestedKg, 2400);
    // 2400 kg / 2 ha planted-and-harvested field = 1200 kg/ha.
    assert.equal(stats.avgYieldKgPerHa, 1200);
    assert.equal(stats.livestockHead, 0);
  });
});

describe('AgricultureModule', () => {
  it('integrates with memory and emits harvest events', async () => {
    const kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new DigitalMemoryModule());
    kernel.register(new AgricultureModule());
    await kernel.boot();
    try {
      const mod = kernel.getModule<AgricultureModule>('agriculture');
      const harvested: string[] = [];
      kernel.bus.on('agriculture.crop.harvested', (p: { id: string }) => { harvested.push(p.id); });

      const farm = mod.registerFarm({ name: 'Demo Farm', ownerId: 'u1' });
      const field = mod.addField({ farmId: farm.id, name: 'Demo Plot', areaHa: 1 });
      const cycle = mod.plantCrop({ fieldId: field.id, crop: 'tomatoes', expectedYieldKg: 800 });
      await mod.recordHarvest({ cropCycleId: cycle.id, yieldKg: 900 });
      assert.equal(harvested.length, 1);
      assert.equal(harvested[0], cycle.id);

      // Planting + harvest recorded in the DME (newest first).
      const memory = kernel.getModule<DigitalMemoryModule>('memory');
      const recs = memory.query({ category: 'agriculture_crop' });
      assert.equal(recs.length, 2);
      assert.match(recs[0]!.summary, /harvested tomatoes: 900kg/);
      assert.match(recs[1]!.summary, /planted tomatoes/);

      assert.equal(mod.stats(farm.id)!.totalHarvestedKg, 900);
    } finally {
      await kernel.shutdown();
    }
  });
});
