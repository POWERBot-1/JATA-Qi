import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { EnvironmentModule } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

describe('EnvironmentModule', () => {
  let kernel: Kernel; let env: EnvironmentModule;
  beforeEach(async () => { kernel = createTestKernel(); kernel.register(new StorageModule()); kernel.register(new EnvironmentModule()); await kernel.boot(); env = kernel.getModule<EnvironmentModule>('environment'); });

  it('creates monitoring stations', async () => {
    const s = await env.createStation({ name: 'Nairobi Air Monitor', type: 'air', location: '-1.2864,36.8172' });
    assert.equal(s.type, 'air'); assert.equal(s.status, 'active');
  });

  it('records readings and triggers threshold alerts', async () => {
    let alerts = 0; kernel.bus.on('env.alert.triggered', () => { alerts++; });
    const s = await env.createStation({ name: 'AQ Station', type: 'air' });
    env.setThreshold(s.id, { parameter: 'pm25', maxValue: 35 });
    // Normal reading → no alert.
    await env.recordReading(s.id, 'pm25', 20, 'µg/m³');
    assert.equal(alerts, 0);
    // Exceedance → alert.
    const { alert } = await env.recordReading(s.id, 'pm25', 60, 'µg/m³');
    assert.ok(alert);
    assert.equal(alert!.severity, 'critical'); // 60 > 35*1.5=52.5
    assert.equal(alerts, 1);
    // Acknowledge.
    const ack = await env.acknowledgeAlert(alert!.id);
    assert.equal(ack.acknowledged, true);
  });

  it('lists readings filtered by station and parameter', async () => {
    const s = await env.createStation({ name: 'S1', type: 'water' });
    await env.recordReading(s.id, 'ph', 7.0, '');
    await env.recordReading(s.id, 'ph', 7.2, '');
    await env.recordReading(s.id, 'temperature', 22, '°C');
    assert.equal((await env.listReadings(s.id, 'ph')).length, 2);
    assert.equal((await env.listReadings(s.id)).length, 3);
  });

  it('tracks sustainability metrics', async () => {
    await env.recordSustainability({ metric: 'carbon', value: 42.5, unit: 'tCO2e', period: '2026-Q3' });
    await env.recordSustainability({ metric: 'energy', value: 1500, unit: 'kWh', period: '2026-Q3' });
    assert.equal((await env.listSustainability()).length, 2);
    assert.equal((await env.listSustainability('carbon')).length, 1);
  });
});
