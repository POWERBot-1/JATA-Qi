// MOTO X — Mobility Intelligence (Phase 7) types.

export interface GeoPoint {
  lat: number;
  lng: number;
}

export type VehicleStatus = 'available' | 'on_trip' | 'maintenance' | 'offline';
export type VehicleType = 'car' | 'bike' | 'van' | 'truck' | 'bus' | 'ev';

export interface Vehicle {
  id: string;
  registration: string;
  make: string;
  model: string;
  type: VehicleType;
  status: VehicleStatus;
  fleetId?: string;
  driverId?: string;
  location?: GeoPoint;
  capacity: number;
  createdAt: number;
}

export interface Fleet {
  id: string;
  name: string;
  ownerId: string;
  vehicleIds: string[];
  createdAt: number;
}

export interface Driver {
  id: string;
  name: string;
  license: string;
  phone?: string;
  status: 'available' | 'on_trip' | 'offline';
  vehicleId?: string;
  createdAt: number;
}

export type TripStatus = 'requested' | 'accepted' | 'picked_up' | 'in_progress' | 'completed' | 'cancelled';

export interface Trip {
  id: string;
  riderId?: string;
  vehicleId?: string;
  driverId?: string;
  status: TripStatus;
  pickup: GeoPoint;
  dropoff: GeoPoint;
  /** Fare in minor units (bigint-safe string). */
  fare: string;
  distanceKm: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface TelemetryPoint {
  vehicleId: string;
  ts: number;
  lat: number;
  lng: number;
  speedKmh?: number;
  headingDeg?: number;
  batteryPct?: number;
  odometerKm?: number;
}

export interface Geofence {
  id: string;
  name: string;
  center: GeoPoint;
  radiusM: number;
  createdAt: number;
}

export interface MobilityStats {
  vehicles: number;
  fleets: number;
  drivers: number;
  trips: number;
  completedTrips: number;
  cancelledTrips: number;
  geofences: number;
  telemetryPoints: number;
  vehiclesInService: number;
}
