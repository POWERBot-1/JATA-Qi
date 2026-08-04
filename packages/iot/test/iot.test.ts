import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { IoTModule } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

describe('IoTModule', () => {
  let kernel: Kernel; let iot: IoTModule;
  beforeEach(async () => { kernel = createTestKernel(); kernel.register(new StorageModule()); kernel.register(new IoTModule()); await kernel.boot(); iot = kernel.getModule<IoTModule>('iot'); });

  it('registers devices and updates status', async () => {
    const d = await iot.registerDevice({ name: 'Temp Sensor 1', type: 'sensor', protocol: 'MQTT', location: 'Building A' });
    assert.equal(d.status, 'online');
    const off = await iot.updateDeviceStatus(d.id, 'offline');
    assert.equal(off.status, 'offline');
    assert.ok(off.lastSeen);
  });

  it('records telemetry and tracks per-device readings', async () => {
    const d = await iot.registerDevice({ name: 'Humidity', type: 'sensor', protocol: 'LoRaWAN' });
    await iot.recordTelemetry(d.id, 'humidity', 65, '%');
    await iot.recordTelemetry(d.id, 'temperature', 24, '°C');
    await iot.recordTelemetry(d.id, 'humidity', 68, '%');
    assert.equal((await iot.listTelemetry(d.id)).length, 3);
    assert.equal((await iot.listTelemetry(d.id, 'humidity')).length, 2);
  });

  it('sends commands and acknowledges them', async () => {
    const d = await iot.registerDevice({ name: 'Valve', type: 'actuator', protocol: 'Zigbee' });
    const cmd = await iot.sendCommand(d.id, 'open', { duration: 30 });
    assert.equal(cmd.status, 'sent');
    const ack = await iot.acknowledgeCommand(cmd.id);
    assert.equal(ack.status, 'acknowledged');
  });

  it('rejects commands to offline devices', async () => {
    const d = await iot.registerDevice({ name: 'X', type: 'sensor', protocol: 'WiFi' });
    await iot.updateDeviceStatus(d.id, 'offline');
    await assert.rejects(() => iot.sendCommand(d.id, 'read'), /offline/);
  });

  it('emits telemetry and device events', async () => {
    let telemetry = 0; let offline = 0;
    kernel.bus.on('iot.telemetry.recorded', () => { telemetry++; });
    kernel.bus.on('iot.device.offline', () => { offline++; });
    const d = await iot.registerDevice({ name: 'S', type: 'sensor', protocol: 'BLE' });
    await iot.recordTelemetry(d.id, 'temp', 20, '°C');
    await iot.updateDeviceStatus(d.id, 'offline');
    assert.equal(telemetry, 1);
    assert.equal(offline, 1);
  });
});
