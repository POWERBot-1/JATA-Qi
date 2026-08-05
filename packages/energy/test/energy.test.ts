// KARIS ENERGY (Phase 7) tests: generation assets, meters + readings
// (monotonicity), consumption + billing, tariff registry, and memory
// integration.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EnergyEngine } from '../src/index.js';
import { EnergyModule } from '../src/index.js';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { DigitalMemoryModule } from '@jataqi/memory';

describe('EnergyEngine', () => {
  it('registers assets and toggles status', () => {
    const e = new EnergyEngine();
    const solar = e.registerAsset({ name: 'Roof Array', source: 'solar', capacityKw: 12.5, location: 'Nairobi' });
    e.registerAsset({ name: 'Backup Gen', source: 'diesel', capacityKw: 50 });
    assert.equal(e.listAssets().length, 2);
    assert.equal(e.listAssets('solar').length, 1);
    e.setAssetStatus(solar.id, 'maintenance');
    assert.equal(e.getAsset(solar.id)!.status, 'maintenance');
    assert.equal(e.listAssets(undefined, 'maintenance').length, 1);
    assert.throws(() => e.registerAsset({ name: 'X', source: 'grid', capacityKw: 0 }), /positive/);
    assert.throws(() => e.registerAsset({ name: '', source: 'grid', capacityKw: 1 }), /required/);
  });

  it('records meters and monotonic cumulative readings', () => {
    const e = new EnergyEngine();
    const meter = e.registerMeter({ name: 'Shop Meter', customerId: 'c1' });
    assert.equal(e.listMeters('c1').length, 1);
    e.recordReading({ meterId: meter.id, kwh: 100, ts: 1000 });
    e.recordReading({ meterId: meter.id, kwh: 150, voltageV: 240, ts: 2000 });
    e.recordReading({ meterId: meter.id, kwh: 230, ts: 3000 });
    assert.equal(e.readingsFor(meter.id).length, 3);
    // Monotonicity enforced.
    assert.throws(() => e.recordReading({ meterId: meter.id, kwh: 200, ts: 4000 }), /rewound/);
    assert.throws(() => e.recordReading({ meterId: 'nope', kwh: 1 }), /unknown meter/);
    // Windowed queries.
    assert.equal(e.readingsFor(meter.id, { fromTs: 1500 }).length, 2);
    assert.equal(e.readingsFor(meter.id, { limit: 1 })[0]!.kwh, 230);
  });

  it('computes consumption and bills against tariffs', () => {
    const e = new EnergyEngine();
    const meter = e.registerMeter({ name: 'Home' });
    const r1 = e.recordReading({ meterId: meter.id, kwh: 500, ts: 1000 });
    e.recordReading({ meterId: meter.id, kwh: 800, ts: 2000 });
    const tariff = e.registerTariff({ name: 'Residential', pricePerKwh: 20, fixedCharge: 1500 });

    const bill = e.bill({ meterId: meter.id, tariffId: tariff.id, fromReadingId: r1.id });
    assert.equal(bill.kwhUsed, 300);
    assert.equal(bill.consumptionCharge, 6000); // 300 × 20
    assert.equal(bill.fixedCharge, 1500);
    assert.equal(bill.total, 7500);
    assert.equal(bill.fromReadingId, r1.id);

    // Period billing between explicit readings.
    const r3 = e.recordReading({ meterId: meter.id, kwh: 900, ts: 3000 });
    const partial = e.bill({ meterId: meter.id, tariffId: tariff.id, fromReadingId: r1.id, toReadingId: r3.id });
    assert.equal(partial.kwhUsed, 400);
    assert.equal(e.billsList(meter.id).length, 2);
    assert.throws(() => e.bill({ meterId: meter.id, tariffId: 'nope' }), /unknown tariff/);
  });

  it('reports aggregate stats', () => {
    const e = new EnergyEngine();
    e.registerAsset({ name: 'A', source: 'wind', capacityKw: 10 });
    e.registerAsset({ name: 'B', source: 'solar', capacityKw: 5 });
    const meter = e.registerMeter({ name: 'M' });
    e.recordReading({ meterId: meter.id, kwh: 120 });
    e.registerTariff({ name: 'T', pricePerKwh: 1 });
    const stats = e.stats();
    assert.equal(stats.assets, 2);
    assert.equal(stats.assetsOnline, 2);
    assert.equal(stats.totalCapacityKw, 15);
    assert.equal(stats.totalConsumptionKwh, 120);
    assert.equal(stats.latestReading!.kwh, 120);
  });
});

describe('EnergyModule', () => {
  it('integrates with memory and emits bill events', async () => {
    const kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new DigitalMemoryModule());
    kernel.register(new EnergyModule());
    await kernel.boot();
    try {
      const mod = kernel.getModule<EnergyModule>('energy');
      const billed: string[] = [];
      kernel.bus.on('energy.bill.issued', (p: { id: string }) => { billed.push(p.id); });

      const meter = mod.registerMeter({ name: 'Office' });
      await mod.recordReading({ meterId: meter.id, kwh: 100 });
      await mod.recordReading({ meterId: meter.id, kwh: 250 });
      const tariff = mod.registerTariff({ name: 'Commercial', pricePerKwh: 15, fixedCharge: 2000 });
      const firstReading = mod.engine.readingsFor(meter.id)[0]!;
      const bill = await mod.bill({ meterId: meter.id, tariffId: tariff.id, fromReadingId: firstReading.id });
      assert.equal(billed.length, 1);
      assert.equal(billed[0], bill.id);
      assert.equal(bill.total, 4250); // 150 × 15 + 2000

      // Reading + bill recorded into the DME (order-independent: readings
      // can share a millisecond under load, so match on content not index).
      const memory = kernel.getModule<DigitalMemoryModule>('memory');
      const readings = memory.query({ category: 'energy_reading' });
      assert.equal(readings.length, 2);
      assert.ok(readings.some((r) => /at 250 kWh/.test(r.summary)));
      assert.ok(readings.some((r) => /at 100 kWh/.test(r.summary)));
      const bills = memory.query({ category: 'energy_bill' });
      assert.equal(bills.length, 1);
      assert.match(bills[0]!.summary, /bill 4250 minor units/);

      assert.equal(mod.stats().meters, 1);
    } finally {
      await kernel.shutdown();
    }
  });
});
