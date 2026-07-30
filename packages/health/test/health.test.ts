import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { HealthModule, HEALTH_DISCLAIMER } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

describe('HealthModule', () => {
  let kernel: Kernel;
  let health: HealthModule;

  beforeEach(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new HealthModule());
    await kernel.boot();
    health = kernel.getModule<HealthModule>('health');
  });

  it('creates health records with restricted sensitivity', async () => {
    const rec = await health.createRecord({
      patientId: 'p1', category: 'general', title: 'Annual checkup notes',
      content: 'Patient reports feeling well.', provider: 'Dr. Smith', createdBy: 'admin',
    });
    assert.equal(rec.sensitivity, 'restricted');
    assert.equal(rec.category, 'general');
  });

  it('lists records filtered by patient and category', async () => {
    await health.createRecord({ patientId: 'p1', category: 'general', title: 'A', content: 'x', createdBy: 'a' });
    await health.createRecord({ patientId: 'p1', category: 'clinical', title: 'B', content: 'y', createdBy: 'a' });
    await health.createRecord({ patientId: 'p2', category: 'general', title: 'C', content: 'z', createdBy: 'a' });
    assert.equal((await health.listRecords('p1')).length, 2);
    assert.equal((await health.listRecords('p1', 'clinical')).length, 1);
    assert.equal((await health.listRecords('p2')).length, 1);
  });

  it('records and retrieves vital signs', async () => {
    await health.recordVitals({ patientId: 'p1', type: 'heart_rate', value: 72, unit: 'bpm' });
    await health.recordVitals({ patientId: 'p1', type: 'heart_rate', value: 75, unit: 'bpm' });
    await health.recordVitals({ patientId: 'p1', type: 'weight_kg', value: 70, unit: 'kg' });
    const hr = await health.getVitals('p1', 'heart_rate');
    assert.equal(hr.length, 2);
    assert.ok(hr[0]!.recordedAt >= hr[1]!.recordedAt); // newest first
    const all = await health.getVitals('p1');
    assert.equal(all.length, 3);
  });

  it('creates educational content with disclaimer', async () => {
    const edu = await health.createEducation({
      topic: 'diabetes', title: 'Understanding Blood Sugar',
      content: 'Blood sugar levels...', audience: 'patients', source: 'WHO guidelines',
    });
    assert.ok(edu.disclaimer);
    assert.match(edu.disclaimer!, /not medical advice/);
    assert.equal((await health.listEducation('diabetes')).length, 1);
  });

  it('exposes the NOT-a-diagnostic-tool disclaimer constant', () => {
    assert.match(HEALTH_DISCLAIMER, /NOT.*diagnose/i);
  });

  it('emits record and vital events', async () => {
    let recEvents = 0; let vitalEvents = 0;
    kernel.bus.on('health.record.created', () => { recEvents++; });
    kernel.bus.on('health.vital.recorded', () => { vitalEvents++; });
    await health.createRecord({ patientId: 'p1', category: 'general', title: 'T', content: 'x', createdBy: 'a' });
    await health.recordVitals({ patientId: 'p1', type: 'heart_rate', value: 70, unit: 'bpm' });
    assert.equal(recEvents, 1);
    assert.equal(vitalEvents, 1);
  });
});
