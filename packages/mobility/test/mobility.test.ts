// MOTO X (Phase 7) tests: registry, dispatch (nearest vehicle), trip
// lifecycle + fares, telemetry, geofences, and memory integration.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MobilityEngine, haversineKm } from '../src/index.js';
import { MobilityModule } from '../src/index.js';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { DigitalMemoryModule } from '@jataqi/memory';

const NBO = { lat: -1.2921, lng: 36.8219 }; // Nairobi
const MSA = { lat: -4.0435, lng: 39.6682 }; // Mombasa
const TOWN = { lat: -1.2864, lng: 36.8172 }; // Nairobi CBD

describe('haversineKm', () => {
  it('computes great-circle distances', () => {
    const d = haversineKm(NBO, MSA);
    assert.ok(d > 400 && d < 500, `Nairobi→Mombasa ~480km, got ${d}`);
    assert.equal(haversineKm(NBO, NBO), 0);
  });
});

describe('MobilityEngine', () => {
  it('registers vehicles, fleets, and drivers', () => {
    const m = new MobilityEngine();
    const fleet = m.createFleet('City Taxis', 'owner-1');
    const v = m.registerVehicle({ registration: 'KDD 123A', make: 'Toyota', model: 'Corolla', type: 'car', capacity: 4, fleetId: fleet.id, location: NBO });
    assert.equal(v.status, 'available');
    assert.equal(m.getFleet(fleet.id)!.vehicleIds.length, 1);
    assert.equal(m.getVehicle(v.id)!.fleetId, fleet.id);
    const d = m.registerDriver({ name: 'Ada', license: 'DL-001' });
    m.assignDriver(v.id, d.id);
    assert.equal(m.getVehicle(v.id)!.driverId, d.id);
    assert.equal(m.getDriver(d.id)!.vehicleId, v.id);
    assert.equal(m.listVehicles({ status: 'available' }).length, 1);
    assert.equal(m.listVehicles({ type: 'truck' }).length, 0);
    assert.throws(() => m.registerVehicle({ registration: '', make: 'X', model: 'Y' }), /required/);
  });

  it('dispatches the nearest available vehicle and computes fares', () => {
    const m = new MobilityEngine();
    m.registerVehicle({ registration: 'KDA 100A', make: 'Nissan', model: 'Note', location: { lat: -1.3, lng: 36.8 } });
    m.registerVehicle({ registration: 'KDK 900Z', make: 'Honda', model: 'Fit', location: MSA }); // far away
    const trip = m.requestTrip({ pickup: NBO, dropoff: TOWN, riderId: 'r-1', pricePerKm: 100, baseFare: 500 });
    assert.equal(trip.status, 'requested');
    assert.equal(trip.vehicleId, m.listVehicles()[0]!.id); // nearest (Nairobi) chosen
    assert.equal(m.getVehicle(trip.vehicleId!)!.status, 'on_trip');
    assert.ok(trip.distanceKm > 0 && trip.distanceKm < 10);
    // fare = distance*100 + 500
    const expected = BigInt(Math.round(trip.distanceKm * 100)) + 500n;
    assert.equal(BigInt(trip.fare), expected);
  });

  it('rejects dispatch when no vehicle is available', () => {
    const m = new MobilityEngine();
    m.registerVehicle({ registration: 'KDL 1A', make: 'Toyota', model: 'Avanza', location: NBO });
    m.setVehicleStatus(m.listVehicles()[0]!.id, 'maintenance');
    assert.throws(() => m.requestTrip({ pickup: NBO, dropoff: TOWN }), /no available vehicles/);
  });

  it('walks the trip lifecycle and frees the vehicle', () => {
    const m = new MobilityEngine();
    const v = m.registerVehicle({ registration: 'KDN 2B', make: 'Toyota', model: 'Prius', location: NBO });
    const trip = m.requestTrip({ pickup: NBO, dropoff: TOWN });
    m.updateTripStatus(trip.id, 'accepted');
    m.updateTripStatus(trip.id, 'in_progress');
    assert.ok(m.getTrip(trip.id)!.startedAt);
    m.updateTripStatus(trip.id, 'completed');
    const done = m.getTrip(trip.id)!;
    assert.equal(done.status, 'completed');
    assert.ok(done.completedAt);
    assert.equal(m.getVehicle(v.id)!.status, 'available');
    assert.equal(m.getVehicle(v.id)!.location!.lat, TOWN.lat); // vehicle now at dropoff
    assert.equal(m.stats().completedTrips, 1);
  });

  it('records telemetry and checks geofences', () => {
    const m = new MobilityEngine();
    const v = m.registerVehicle({ registration: 'KDP 3C', make: 'BYD', model: 'e6', type: 'ev', location: NBO });
    m.recordTelemetry({ vehicleId: v.id, lat: NBO.lat, lng: NBO.lng, speedKmh: 40, batteryPct: 88 });
    m.recordTelemetry({ vehicleId: v.id, lat: NBO.lat + 0.001, lng: NBO.lng, speedKmh: 55 });
    assert.equal(m.telemetryFor(v.id).length, 2);
    assert.equal(m.getVehicle(v.id)!.location!.lat, NBO.lat + 0.001);

    const fence = m.createGeofence('CBD', NBO, 500);
    const close = { lat: NBO.lat + 0.0005, lng: NBO.lng }; // ~55m away
    assert.equal(m.pointInGeofence(fence.id, close), true);
    assert.equal(m.pointInGeofence(fence.id, TOWN), false); // ~600m away
    assert.equal(m.pointInGeofence(fence.id, MSA), false);
    assert.ok(m.vehiclesInGeofence(fence.id).some((x) => x.id === v.id));
    assert.throws(() => m.pointInGeofence('nope', NBO), /unknown geofence/);
  });
});

describe('MobilityModule', () => {
  it('integrates with memory and emits events', async () => {
    const kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new DigitalMemoryModule());
    kernel.register(new MobilityModule());
    await kernel.boot();
    try {
      const mod = kernel.getModule<MobilityModule>('mobility');
      const events: string[] = [];
      kernel.bus.on("mobility.trip.completed", (p: { id: string }) => { events.push(p.id); });

      mod.registerVehicle({ registration: 'KDR 4D', make: 'Toyota', model: 'Land Cruiser', location: NBO });
      const trip = mod.requestTrip({ pickup: NBO, dropoff: TOWN, riderId: 'u1' });
      mod.updateTripStatus(trip.id, 'completed');
      assert.equal(events.length, 1);
      assert.equal(events[0], trip.id);

      // Trip recorded into the DME (newest first).
      const memory = kernel.getModule<DigitalMemoryModule>('memory');
      const recs = memory.query({ category: 'mobility_trip' });
      assert.equal(recs.length, 2); // requested + completed
      assert.match(recs[0]!.summary, /trip completed/);
      assert.match(recs[1]!.summary, /trip requested/);

      assert.ok(mod.stats().trips >= 1);
    } finally {
      await kernel.shutdown();
    }
  });
});
