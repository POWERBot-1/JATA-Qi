// PORTLINK (Phase 7) tests: ports/vessels/containers registry, shipment
// lifecycle with tracking-event timelines, status transitions, warehouse
// slots, analytics, and memory integration.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LogisticsEngine } from '../src/index.js';
import { LogisticsModule } from '../src/index.js';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { DigitalMemoryModule } from '@jataqi/memory';

describe('LogisticsEngine', () => {
  it('registers ports, vessels, and warehouses', () => {
    const l = new LogisticsEngine();
    const momba = l.registerPort({ name: 'Mombasa', code: 'MBA', country: 'KE', city: 'Mombasa', capacityTeu: 1_500_000, berths: 12 });
    l.registerPort({ name: 'Dar es Salaam', code: 'DAR', country: 'TZ' });
    assert.equal(l.listPorts().length, 2);
    assert.equal(momba.code, 'MBA');
    assert.throws(() => l.registerPort({ name: 'X', code: '', country: 'KE' }), /required/);

    const vessel = l.registerVessel({ name: 'MV Jambo', imo: 'IMO1234567', portId: momba.id, eta: Date.now() + 86_400_000 });
    assert.equal(vessel.status, 'inbound');
    l.updateVesselStatus(vessel.id, 'berthed', momba.id);
    assert.equal(l.getVessel(vessel.id)!.status, 'berthed');
    assert.equal(l.listVessels('berthed').length, 1);

    const wh = l.registerWarehouse({ name: 'ICD Embakasi', location: 'Nairobi', capacitySlots: 500 });
    l.adjustWarehouseSlots(wh.id, 120);
    assert.equal(l.listWarehouses()[0]!.usedSlots, 120);
  });

  it('creates shipments with tracking refs and walks the lifecycle', () => {
    const l = new LogisticsEngine();
    const s = l.createShipment({
      mode: 'sea', origin: 'Shanghai', destination: 'Mombasa',
      shipper: 'Exporter Ltd', consignee: 'Importer Co', weightKg: 18_000, volumeCbm: 30,
    });
    assert.equal(s.status, 'booked');
    assert.match(s.trackingRef, /^JQ-[A-Z2-9]{6}$/);
    assert.equal(l.getShipmentByTrackingRef(s.trackingRef)!.id, s.id);

    l.addTrackingEvent({ shipmentId: s.id, code: 'departed', location: 'Shanghai Port' });
    assert.equal(l.getShipment(s.id)!.status, 'in_transit');
    l.addTrackingEvent({ shipmentId: s.id, code: 'arrived', location: 'Mombasa Port' });
    assert.equal(l.getShipment(s.id)!.status, 'arrived');
    l.addTrackingEvent({ shipmentId: s.id, code: 'cleared', location: 'KPA Customs' });
    assert.equal(l.getShipment(s.id)!.status, 'customs');
    l.addTrackingEvent({ shipmentId: s.id, code: 'delivered', location: 'ICD Embakasi' });
    assert.equal(l.getShipment(s.id)!.status, 'delivered');

    const timeline = l.shipmentTimeline(s.id);
    assert.equal(timeline.length, 4);
    assert.deepEqual(timeline.map((e) => e.code), ['departed', 'arrived', 'cleared', 'delivered']);
    assert.equal(l.listShipments({ status: 'delivered' }).length, 1);
    assert.equal(l.listShipments({ mode: 'sea' }).length, 1);
    assert.throws(() => l.addTrackingEvent({ shipmentId: 'nope', code: 'arrived', location: 'X' }), /unknown shipment/);
  });

  it('assigns containers and updates their status with the shipment', () => {
    const l = new LogisticsEngine();
    const s = l.createShipment({
      mode: 'rail', origin: 'Mombasa', destination: 'Nairobi',
      shipper: 'A', consignee: 'B',
    });
    const c1 = l.registerContainer({ number: 'MSCU1234567', type: '40' });
    const c2 = l.registerContainer({ number: 'MAEU7654321', type: 'reefer', portId: l.listPorts()[0]?.id });
    const assigned = l.assignContainer(s.id, c1.id)!;
    assert.equal(assigned.container.status, 'loaded');
    assert.equal(assigned.shipment.containerIds.length, 1);
    assert.equal(l.getContainer(c1.id)!.shipmentId, s.id);
    l.addTrackingEvent({ shipmentId: s.id, code: 'delivered', location: 'Nairobi ICD' });
    assert.equal(l.getContainer(c1.id)!.status, 'delivered');
    assert.equal(l.getContainer(c2.id)!.status, 'empty');
    assert.equal(l.listContainers({ status: 'delivered' }).length, 1);
    assert.throws(() => l.registerContainer({ number: '' }), /required/);
  });

  it('reports analytics with status breakdowns and transit times', () => {
    const l = new LogisticsEngine();
    const now = Date.now();
    for (let i = 0; i < 2; i++) {
      const s = l.createShipment({ mode: 'road', origin: 'Nairobi', destination: 'Kampala', shipper: 'S', consignee: 'C' });
      l.addTrackingEvent({ shipmentId: s.id, code: 'departed', location: 'Nairobi', ts: now });
      l.addTrackingEvent({ shipmentId: s.id, code: 'delivered', location: 'Kampala', ts: now + 2 * 86_400_000 });
    }
    const open = l.createShipment({ mode: 'air', origin: 'NBO', destination: 'AMS', shipper: 'S', consignee: 'C' });
    l.addTrackingEvent({ shipmentId: open.id, code: 'departed', location: 'JKIA', ts: now });

    const stats = l.stats();
    assert.equal(stats.shipments, 3);
    assert.equal(stats.shipmentsByStatus.delivered, 2);
    assert.equal(stats.shipmentsByStatus.in_transit, 1);
    assert.ok(stats.avgTransitMs !== undefined && stats.avgTransitMs > 0);
    assert.ok(Math.abs(stats.avgTransitMs - 2 * 86_400_000) < 10_000);
  });
});

describe('LogisticsModule', () => {
  it('integrates with memory and emits tracking events', async () => {
    const kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new DigitalMemoryModule());
    kernel.register(new LogisticsModule());
    await kernel.boot();
    try {
      const mod = kernel.getModule<LogisticsModule>('logistics');
      const delivered: string[] = [];
      kernel.bus.on('logistics.shipment.delivered', (p: { shipmentId: string }) => { delivered.push(p.shipmentId); });

      mod.registerPort({ name: 'Mombasa', code: 'MBA', country: 'KE' });
      const s = mod.createShipment({ mode: 'sea', origin: 'Shanghai', destination: 'Mombasa', shipper: 'S', consignee: 'C' });
      await mod.trackShipment({ shipmentId: s.id, code: 'delivered', location: 'Mombasa Port' });
      assert.equal(delivered.length, 1);
      assert.equal(delivered[0], s.id);

      // Milestone recorded in the DME.
      const memory = kernel.getModule<DigitalMemoryModule>('memory');
      const recs = memory.query({ category: 'logistics_shipment' });
      assert.equal(recs.length, 2); // booked + delivered (order-independent:
      // events can share a millisecond under load, so match on content)
      assert.ok(recs.some((r) => /delivered at/.test(r.summary)));
      assert.ok(recs.some((r) => /booked:/.test(r.summary)));

      assert.equal(mod.stats().shipments, 1);
    } finally {
      await kernel.shutdown();
    }
  });
});
