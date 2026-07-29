import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { RoboticsModule } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

describe('RoboticsModule (kernel integration)', () => {
  let kernel: Kernel;
  let rob: RoboticsModule;

  beforeEach(async () => {
    kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new RoboticsModule());
    await kernel.boot();
    rob = kernel.getModule<RoboticsModule>('robotics');
  });

  it('registers, lists, and filters devices', async () => {
    await rob.addDevice({ name: 'Spot', kind: 'explorer', capabilities: ['locomotion', 'scan'] });
    await rob.addDevice({ name: 'AgriBot', kind: 'agricultural' });
    assert.equal((await rob.listDevices()).length, 2);
    assert.equal((await rob.listDevices('agricultural')).length, 1);
  });

  it('updates status and records telemetry', async () => {
    const d = await rob.addDevice({ name: 'Drone1', kind: 'drone' });
    await rob.setStatus(d.id, 'busy');
    const updated = await rob.recordTelemetry(d.id, { battery: 87, altitude: 120 });
    assert.equal(updated.status, 'busy');
    assert.equal(updated.telemetry.battery, 87);
    assert.equal(updated.telemetry.altitude, 120);
  });

  it('assigns and completes missions, toggling device status', async () => {
    let statuses: string[] = [];
    kernel.bus.on('robotics.device.status_changed', (p: { status: string }) => { statuses.push(p.status); });
    const d = await rob.addDevice({ name: 'Arm1', kind: 'industrial' });
    const m = await rob.assignMission(d.id, 'weld joint A');
    assert.equal(m.status, 'active');
    assert.equal((await rob.getDevice(d.id))?.status, 'busy');
    const done = await rob.completeMission(m.id, 'completed', 'joint welded');
    assert.equal(done.status, 'completed');
    assert.equal(done.result, 'joint welded');
    assert.equal((await rob.getDevice(d.id))?.status, 'online');
    assert.deepEqual(statuses, ['busy', 'online']);
  });

  it('records maintenance history in the digital twin', async () => {
    const d = await rob.addDevice({ name: 'Rover', kind: 'explorer', specs: { mass: 900 } });
    await rob.addMaintenance(d.id, 'replaced wheel');
    const after = await rob.getDevice(d.id);
    assert.equal(after!.twin.maintenance!.length, 1);
    assert.equal(after!.twin.specs!.mass, 900);
  });

  it('rejects operations on unknown devices', async () => {
    await assert.rejects(() => rob.setStatus('nope', 'offline'), /not found/);
    await assert.rejects(() => rob.assignMission('nope', 'x'), /not found/);
  });

  it('reports aggregate stats', async () => {
    await rob.addDevice({ name: 'A', kind: 'drone' });
    await rob.addDevice({ name: 'B', kind: 'drone' });
    const s = await rob.stats();
    assert.equal(s.devices, 2);
    assert.equal(s.byStatus.online, 2);
  });
});
