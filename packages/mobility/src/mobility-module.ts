// MobilityModule — MOTO X kernel module. Wraps the engine, emits bus events,
// and records trips into the Digital Memory Engine (governed).

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { DigitalMemoryModule } from '@jataqi/memory';
import { MobilityEngine, type RegisterVehicleInput, type RequestTripInput } from './engine.js';
import type {
  Driver, Fleet, GeoPoint, Geofence, MobilityStats, TelemetryPoint, Trip,
  TripStatus, Vehicle, VehicleStatus, VehicleType,
} from './types.js';

export const MobilityEvents = Object.freeze({
  VehicleRegistered: 'mobility.vehicle.registered',
  TripRequested: 'mobility.trip.requested',
  TripUpdated: 'mobility.trip.updated',
  TripCompleted: 'mobility.trip.completed',
  TelemetryRecorded: 'mobility.telemetry.recorded',
  GeofenceCreated: 'mobility.geofence.created',
} as const);

export class MobilityModule implements IModule {
  readonly id = 'mobility';
  readonly tags = ['core', 'mobility', 'intelligence'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private memory?: DigitalMemoryModule;
  readonly engine = new MobilityEngine();

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('mobility', this);
    this.memory = this.tryModule<DigitalMemoryModule>('memory');
    kernel.logger.info('mobility module initialized (MOTO X)');
  }
  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  // ---- registry ----------------------------------------------------------

  registerVehicle(input: RegisterVehicleInput): Vehicle {
    const vehicle = this.engine.registerVehicle(input);
    void this.api.bus.emit(MobilityEvents.VehicleRegistered, { id: vehicle.id, registration: vehicle.registration });
    return vehicle;
  }

  getVehicle(id: string): Vehicle | undefined { return this.engine.getVehicle(id); }
  listVehicles(filter?: { status?: VehicleStatus; type?: VehicleType; fleetId?: string }): Vehicle[] {
    return this.engine.listVehicles(filter);
  }
  setVehicleStatus(id: string, status: VehicleStatus): Vehicle | undefined {
    return this.engine.setVehicleStatus(id, status);
  }
  createFleet(name: string, ownerId: string): Fleet { return this.engine.createFleet(name, ownerId); }
  getFleet(id: string): Fleet | undefined { return this.engine.getFleet(id); }
  listFleets(): Fleet[] { return this.engine.listFleets(); }
  addVehicleToFleet(fleetId: string, vehicleId: string): Fleet | undefined {
    return this.engine.addVehicleToFleet(fleetId, vehicleId);
  }
  registerDriver(input: { name: string; license: string; phone?: string }): Driver {
    return this.engine.registerDriver(input);
  }
  listDrivers(): Driver[] { return this.engine.listDrivers(); }
  assignDriver(vehicleId: string, driverId: string): { vehicle: Vehicle; driver: Driver } | undefined {
    return this.engine.assignDriver(vehicleId, driverId);
  }

  // ---- trips + dispatch --------------------------------------------------

  requestTrip(input: RequestTripInput): Trip {
    const trip = this.engine.requestTrip(input);
    void this.api.bus.emit(MobilityEvents.TripRequested, { id: trip.id, vehicleId: trip.vehicleId, fare: trip.fare });
    void this.recordMemory('mobility_trip', `trip requested: ${trip.distanceKm.toFixed(1)}km fare=${trip.fare}`, {
      tripId: trip.id, vehicleId: trip.vehicleId ?? null, distanceKm: trip.distanceKm, fare: trip.fare,
    });
    return trip;
  }

  getTrip(id: string): Trip | undefined { return this.engine.getTrip(id); }
  listTrips(filter?: { status?: TripStatus; riderId?: string; vehicleId?: string }): Trip[] {
    return this.engine.listTrips(filter);
  }

  async updateTripStatus(id: string, status: TripStatus): Promise<Trip | undefined> {
    const trip = this.engine.updateTripStatus(id, status);
    if (trip) {
      void this.api.bus.emit(MobilityEvents.TripUpdated, { id: trip.id, status: trip.status });
      if (status === 'completed') {
        void this.api.bus.emit(MobilityEvents.TripCompleted, { id: trip.id, fare: trip.fare });
        await this.recordMemory('mobility_trip', `trip completed: ${trip.distanceKm.toFixed(1)}km fare=${trip.fare}`, {
          tripId: trip.id, vehicleId: trip.vehicleId ?? null, fare: trip.fare,
        });
      }
    }
    return trip;
  }

  // ---- telemetry + geofences ---------------------------------------------

  recordTelemetry(point: Omit<TelemetryPoint, 'ts'> & { ts?: number }): TelemetryPoint {
    const full = this.engine.recordTelemetry(point);
    void this.api.bus.emit(MobilityEvents.TelemetryRecorded, { vehicleId: point.vehicleId, lat: point.lat, lng: point.lng });
    return full;
  }

  telemetryFor(vehicleId: string, limit = 100): TelemetryPoint[] {
    return this.engine.telemetryFor(vehicleId, limit);
  }

  createGeofence(name: string, center: GeoPoint, radiusM: number): Geofence {
    const fence = this.engine.createGeofence(name, center, radiusM);
    void this.api.bus.emit(MobilityEvents.GeofenceCreated, { id: fence.id, name: fence.name });
    return fence;
  }

  listGeofences(): Geofence[] { return this.engine.listGeofences(); }
  pointInGeofence(fenceId: string, point: GeoPoint): boolean { return this.engine.pointInGeofence(fenceId, point); }
  vehiclesInGeofence(fenceId: string): Vehicle[] { return this.engine.vehiclesInGeofence(fenceId); }

  stats(): MobilityStats { return this.engine.stats(); }

  // ---- internals ---------------------------------------------------------

  private async recordMemory(category: string, summary: string, data: Record<string, unknown>): Promise<void> {
    if (!this.memory) return;
    try {
      await this.memory.record({ category, summary, data, tags: ['mobility', category] });
    } catch { /* non-fatal */ }
  }

  private tryModule<T extends IModule>(id: string): T | undefined {
    try { return this.api.getModule<T>(id); } catch { return undefined; }
  }
}
