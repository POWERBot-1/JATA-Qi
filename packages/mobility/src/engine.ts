// MobilityEngine — MOTO X core: vehicle/fleet/driver registry, dispatch
// (nearest available vehicle), trip lifecycle with fare calculation,
// telemetry ingestion, and geofence checks. Pure engine.

import { randomUUID } from 'node:crypto';
import type {
  Driver, Fleet, GeoPoint, Geofence, MobilityStats, TelemetryPoint, Trip,
  TripStatus, Vehicle, VehicleStatus, VehicleType,
} from './types.js';

export interface RegisterVehicleInput {
  registration: string;
  make: string;
  model: string;
  type?: VehicleType;
  capacity?: number;
  location?: GeoPoint;
  fleetId?: string;
}

export interface RequestTripInput {
  pickup: GeoPoint;
  dropoff: GeoPoint;
  riderId?: string;
  /** Price per km in minor units (default 100 = 1.00/km). */
  pricePerKm?: number;
  /** Base fare in minor units (default 500 = 5.00). */
  baseFare?: number;
}

const EARTH_RADIUS_KM = 6371;
const DEFAULT_PRICE_PER_KM = 100;
const DEFAULT_BASE_FARE = 500;

/** Great-circle distance between two points (km). */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(s));
}

export class MobilityEngine {
  private vehicles = new Map<string, Vehicle>();
  private fleets = new Map<string, Fleet>();
  private drivers = new Map<string, Driver>();
  private trips = new Map<string, Trip>();
  private geofences = new Map<string, Geofence>();
  private telemetry: TelemetryPoint[] = [];
  private readonly MAX_TELEMETRY = 50_000;

  // ---- registry ----------------------------------------------------------

  registerVehicle(input: RegisterVehicleInput): Vehicle {
    if (!input.registration || !input.make || !input.model) {
      throw new Error('registration, make, and model are required');
    }
    const vehicle: Vehicle = {
      id: randomUUID(),
      registration: input.registration,
      make: input.make,
      model: input.model,
      type: input.type ?? 'car',
      status: 'available',
      capacity: input.capacity ?? 4,
      createdAt: Date.now(),
      ...(input.location ? { location: input.location } : {}),
      ...(input.fleetId ? { fleetId: input.fleetId } : {}),
    };
    this.vehicles.set(vehicle.id, vehicle);
    if (input.fleetId) this.addVehicleToFleet(input.fleetId, vehicle.id);
    return vehicle;
  }

  getVehicle(id: string): Vehicle | undefined {
    return this.vehicles.get(id);
  }

  listVehicles(filter?: { status?: VehicleStatus; type?: VehicleType; fleetId?: string }): Vehicle[] {
    return [...this.vehicles.values()].filter((v) =>
      (!filter?.status || v.status === filter.status) &&
      (!filter?.type || v.type === filter.type) &&
      (!filter?.fleetId || v.fleetId === filter.fleetId));
  }

  setVehicleStatus(id: string, status: VehicleStatus): Vehicle | undefined {
    const v = this.vehicles.get(id);
    if (!v) return undefined;
    v.status = status;
    return v;
  }

  createFleet(name: string, ownerId: string): Fleet {
    const fleet: Fleet = { id: randomUUID(), name, ownerId, vehicleIds: [], createdAt: Date.now() };
    this.fleets.set(fleet.id, fleet);
    return fleet;
  }

  getFleet(id: string): Fleet | undefined {
    return this.fleets.get(id);
  }

  listFleets(): Fleet[] {
    return [...this.fleets.values()];
  }

  addVehicleToFleet(fleetId: string, vehicleId: string): Fleet | undefined {
    const fleet = this.fleets.get(fleetId);
    const vehicle = this.vehicles.get(vehicleId);
    if (!fleet || !vehicle) return undefined;
    if (!fleet.vehicleIds.includes(vehicleId)) fleet.vehicleIds.push(vehicleId);
    vehicle.fleetId = fleetId;
    return fleet;
  }

  registerDriver(input: { name: string; license: string; phone?: string }): Driver {
    if (!input.name || !input.license) throw new Error('name and license are required');
    const driver: Driver = {
      id: randomUUID(), name: input.name, license: input.license,
      ...(input.phone ? { phone: input.phone } : {}),
      status: 'available', createdAt: Date.now(),
    };
    this.drivers.set(driver.id, driver);
    return driver;
  }

  getDriver(id: string): Driver | undefined {
    return this.drivers.get(id);
  }

  listDrivers(): Driver[] {
    return [...this.drivers.values()];
  }

  assignDriver(vehicleId: string, driverId: string): { vehicle: Vehicle; driver: Driver } | undefined {
    const vehicle = this.vehicles.get(vehicleId);
    const driver = this.drivers.get(driverId);
    if (!vehicle || !driver) return undefined;
    vehicle.driverId = driverId;
    driver.vehicleId = vehicleId;
    return { vehicle, driver };
  }

  // ---- trips + dispatch --------------------------------------------------

  /** Dispatch: find the nearest available vehicle to the pickup point. */
  requestTrip(input: RequestTripInput): Trip {
    if (!isValidPoint(input.pickup) || !isValidPoint(input.dropoff)) {
      throw new Error('valid pickup and dropoff coordinates are required');
    }
    const candidates = this.listVehicles({ status: 'available' });
    if (candidates.length === 0) throw new Error('no available vehicles');
    let nearest = candidates[0]!;
    let bestDist = haversineKm(input.pickup, nearest.location ?? input.pickup);
    for (const v of candidates.slice(1)) {
      const d = haversineKm(input.pickup, v.location ?? input.pickup);
      if (d < bestDist) { bestDist = d; nearest = v; }
    }
    const distanceKm = haversineKm(input.pickup, input.dropoff);
    const pricePerKm = input.pricePerKm ?? DEFAULT_PRICE_PER_KM;
    const baseFare = input.baseFare ?? DEFAULT_BASE_FARE;
    const fare = BigInt(Math.round(distanceKm * pricePerKm)) + BigInt(baseFare);
    const trip: Trip = {
      id: randomUUID(),
      ...(input.riderId ? { riderId: input.riderId } : {}),
      vehicleId: nearest.id,
      driverId: nearest.driverId,
      status: 'requested',
      pickup: input.pickup,
      dropoff: input.dropoff,
      fare: fare.toString(),
      distanceKm,
      createdAt: Date.now(),
    };
    this.trips.set(trip.id, trip);
    nearest.status = 'on_trip';
    if (nearest.driverId) {
      const driver = this.drivers.get(nearest.driverId);
      if (driver) driver.status = 'on_trip';
    }
    return trip;
  }

  getTrip(id: string): Trip | undefined {
    return this.trips.get(id);
  }

  listTrips(filter?: { status?: TripStatus; riderId?: string; vehicleId?: string }): Trip[] {
    return [...this.trips.values()].filter((t) =>
      (!filter?.status || t.status === filter.status) &&
      (!filter?.riderId || t.riderId === filter.riderId) &&
      (!filter?.vehicleId || t.vehicleId === filter.vehicleId));
  }

  updateTripStatus(id: string, status: TripStatus): Trip | undefined {
    const trip = this.trips.get(id);
    if (!trip) return undefined;
    const now = Date.now();
    trip.status = status;
    if (status === 'in_progress' && trip.startedAt === undefined) trip.startedAt = now;
    if (status === 'completed') {
      trip.completedAt = now;
      const vehicle = trip.vehicleId ? this.vehicles.get(trip.vehicleId) : undefined;
      if (vehicle) {
        vehicle.status = 'available';
        vehicle.location = trip.dropoff;
        if (vehicle.driverId) {
          const driver = this.drivers.get(vehicle.driverId);
          if (driver) driver.status = 'available';
        }
      }
    }
    if (status === 'cancelled') {
      const vehicle = trip.vehicleId ? this.vehicles.get(trip.vehicleId) : undefined;
      if (vehicle) vehicle.status = 'available';
    }
    return trip;
  }

  // ---- telemetry ---------------------------------------------------------

  recordTelemetry(point: Omit<TelemetryPoint, 'ts'> & { ts?: number }): TelemetryPoint {
    const vehicle = this.vehicles.get(point.vehicleId);
    if (!vehicle) throw new Error(`unknown vehicle ${point.vehicleId}`);
    const full: TelemetryPoint = { ...point, ts: point.ts ?? Date.now() };
    vehicle.location = { lat: point.lat, lng: point.lng };
    this.telemetry.push(full);
    if (this.telemetry.length > this.MAX_TELEMETRY) {
      this.telemetry.splice(0, this.telemetry.length - this.MAX_TELEMETRY);
    }
    return full;
  }

  telemetryFor(vehicleId: string, limit = 100): TelemetryPoint[] {
    return this.telemetry.filter((t) => t.vehicleId === vehicleId).slice(-limit);
  }

  // ---- geofences ---------------------------------------------------------

  createGeofence(name: string, center: GeoPoint, radiusM: number): Geofence {
    if (!isValidPoint(center) || radiusM <= 0) throw new Error('valid center and radius are required');
    const fence: Geofence = { id: randomUUID(), name, center, radiusM, createdAt: Date.now() };
    this.geofences.set(fence.id, fence);
    return fence;
  }

  listGeofences(): Geofence[] {
    return [...this.geofences.values()];
  }

  /** True when the point is inside the geofence. */
  pointInGeofence(fenceId: string, point: GeoPoint): boolean {
    const fence = this.geofences.get(fenceId);
    if (!fence) throw new Error(`unknown geofence ${fenceId}`);
    return haversineKm(fence.center, point) * 1000 <= fence.radiusM;
  }

  /** Vehicles currently inside a geofence. */
  vehiclesInGeofence(fenceId: string): Vehicle[] {
    return this.listVehicles().filter((v) => v.location && this.pointInGeofence(fenceId, v.location));
  }

  // ---- stats -------------------------------------------------------------

  stats(): MobilityStats {
    const all = [...this.vehicles.values()];
    const trips = [...this.trips.values()];
    return {
      vehicles: all.length,
      fleets: this.fleets.size,
      drivers: this.drivers.size,
      trips: trips.length,
      completedTrips: trips.filter((t) => t.status === 'completed').length,
      cancelledTrips: trips.filter((t) => t.status === 'cancelled').length,
      geofences: this.geofences.size,
      telemetryPoints: this.telemetry.length,
      vehiclesInService: all.filter((v) => v.status === 'available' || v.status === 'on_trip').length,
    };
  }
}

function isValidPoint(p: GeoPoint): boolean {
  return Number.isFinite(p.lat) && Number.isFinite(p.lng) &&
    p.lat >= -90 && p.lat <= 90 && p.lng >= -180 && p.lng <= 180;
}
