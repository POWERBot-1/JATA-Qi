import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { SmartCitiesModule } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

describe('SmartCitiesModule', () => {
  let kernel: Kernel; let city: SmartCitiesModule;
  beforeEach(async () => { kernel = createTestKernel(); kernel.register(new StorageModule()); kernel.register(new SmartCitiesModule()); await kernel.boot(); city = kernel.getModule<SmartCitiesModule>('smart-cities'); });

  it('creates city services by domain', async () => {
    await city.createService({ name: 'Nairobi Transport', domain: 'transport' });
    await city.createService({ name: 'Water Supply', domain: 'water' });
    assert.equal((await city.listServices()).length, 2);
    assert.equal((await city.listServices('transport')).length, 1);
  });

  it('records metrics and triggers threshold alerts', async () => {
    let alerts = 0; kernel.bus.on('city.alert.triggered', () => { alerts++; });
    const s = await city.createService({ name: 'Energy Grid', domain: 'energy' });
    city.setThreshold(s.id, 'load_mw', { maxValue: 500 });
    await city.recordMetric(s.id, 'load_mw', 400, 'MW', '2026-07');
    assert.equal(alerts, 0);
    const { alert } = await city.recordMetric(s.id, 'load_mw', 800, 'MW', '2026-07');
    assert.ok(alert);
    assert.equal(alert!.severity, 'critical');
    assert.equal(alerts, 1);
    await city.acknowledgeAlert(alert!.id);
    assert.equal((await city.listAlerts(false)).length, 0);
  });

  it('lists metrics by service and metric name', async () => {
    const s = await city.createService({ name: 'Waste Mgmt', domain: 'waste' });
    await city.recordMetric(s.id, 'collection_rate', 85, '%', '2026-W30');
    await city.recordMetric(s.id, 'collection_rate', 90, '%', '2026-W31');
    await city.recordMetric(s.id, 'bins_active', 1200, '', '2026-W30');
    assert.equal((await city.listMetrics(s.id, 'collection_rate')).length, 2);
    assert.equal((await city.listMetrics(s.id)).length, 3);
  });
});
