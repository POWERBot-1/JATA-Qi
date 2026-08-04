// PORTLINK — Logistics & Port Intelligence (Phase 7) types.

export interface Port {
  id: string;
  name: string;
  code: string;
  country: string;
  city?: string;
  capacityTeu: number;
  berths: number;
  createdAt: number;
}

export type VesselStatus = 'inbound' | 'berthed' | 'outbound' | 'sailed';

export interface Vessel {
  id: string;
  name: string;
  imo: string;
  status: VesselStatus;
  portId?: string;
  eta?: number;
  etd?: number;
  createdAt: number;
}

export type ContainerType = '20' | '40' | '40hc' | 'reefer';
export type ContainerStatus = 'empty' | 'loaded' | 'in_transit' | 'at_port' | 'delivered';

export interface Container {
  id: string;
  number: string;
  type: ContainerType;
  status: ContainerStatus;
  shipmentId?: string;
  portId?: string;
  createdAt: number;
}

export type ShipmentMode = 'sea' | 'air' | 'road' | 'rail';
export type ShipmentStatus = 'booked' | 'in_transit' | 'arrived' | 'customs' | 'delivered' | 'exception';

export interface Shipment {
  id: string;
  trackingRef: string;
  mode: ShipmentMode;
  status: ShipmentStatus;
  origin: string;
  destination: string;
  shipper: string;
  consignee: string;
  containerIds: string[];
  weightKg: number;
  volumeCbm: number;
  createdAt: number;
  updatedAt: number;
}

export type TrackingCode = 'departed' | 'arrived' | 'cleared' | 'delivered' | 'exception';

export interface TrackingEvent {
  id: string;
  shipmentId: string;
  code: TrackingCode;
  location: string;
  ts: number;
  note?: string;
}

export interface Warehouse {
  id: string;
  name: string;
  location: string;
  capacitySlots: number;
  usedSlots: number;
  createdAt: number;
}

export interface LogisticsStats {
  ports: number;
  vessels: number;
  containers: number;
  shipments: number;
  warehouses: number;
  shipmentsByStatus: Record<ShipmentStatus, number>;
  containersByStatus: Record<ContainerStatus, number>;
  avgTransitMs?: number;
}
