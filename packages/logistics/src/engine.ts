// LogisticsEngine — PORTLINK core: ports, vessels, containers, shipments
// with tracking timelines, warehouses, and freight analytics. Pure engine.

import { randomUUID } from 'node:crypto';
import type {
  Container, ContainerStatus, ContainerType, LogisticsStats, Port, Shipment,
  ShipmentMode, ShipmentStatus, TrackingCode, TrackingEvent, Vessel,
  VesselStatus, Warehouse,
} from './types.js';

export interface RegisterPortInput {
  name: string;
  code: string;
  country: string;
  city?: string;
  capacityTeu?: number;
  berths?: number;
}

export interface CreateShipmentInput {
  mode: ShipmentMode;
  origin: string;
  destination: string;
  shipper: string;
  consignee: string;
  weightKg?: number;
  volumeCbm?: number;
}

const STATUS_FOR_CODE: Record<TrackingCode, ShipmentStatus> = {
  departed: 'in_transit',
  arrived: 'arrived',
  cleared: 'customs',
  delivered: 'delivered',
  exception: 'exception',
};

export class LogisticsEngine {
  private ports = new Map<string, Port>();
  private vessels = new Map<string, Vessel>();
  private containers = new Map<string, Container>();
  private shipments = new Map<string, Shipment>();
  private warehouses = new Map<string, Warehouse>();
  private events: TrackingEvent[] = [];
  private readonly MAX_EVENTS = 50_000;

  // ---- ports + vessels ---------------------------------------------------

  registerPort(input: RegisterPortInput): Port {
    if (!input.name || !input.code || !input.country) throw new Error('name, code, and country are required');
    const port: Port = {
      id: randomUUID(), name: input.name, code: input.code.toUpperCase(), country: input.country,
      ...(input.city ? { city: input.city } : {}),
      capacityTeu: input.capacityTeu ?? 100_000,
      berths: input.berths ?? 4,
      createdAt: Date.now(),
    };
    this.ports.set(port.id, port);
    return port;
  }

  getPort(id: string): Port | undefined { return this.ports.get(id); }
  listPorts(): Port[] { return [...this.ports.values()]; }

  registerVessel(input: { name: string; imo: string; portId?: string; eta?: number; etd?: number }): Vessel {
    if (!input.name || !input.imo) throw new Error('name and imo are required');
    const vessel: Vessel = {
      id: randomUUID(), name: input.name, imo: input.imo, status: 'inbound',
      ...(input.portId ? { portId: input.portId } : {}),
      ...(input.eta ? { eta: input.eta } : {}),
      ...(input.etd ? { etd: input.etd } : {}),
      createdAt: Date.now(),
    };
    this.vessels.set(vessel.id, vessel);
    return vessel;
  }

  getVessel(id: string): Vessel | undefined { return this.vessels.get(id); }
  listVessels(status?: VesselStatus): Vessel[] {
    const all = [...this.vessels.values()];
    return status ? all.filter((v) => v.status === status) : all;
  }

  updateVesselStatus(id: string, status: VesselStatus, portId?: string): Vessel | undefined {
    const vessel = this.vessels.get(id);
    if (!vessel) return undefined;
    vessel.status = status;
    if (portId) vessel.portId = portId;
    return vessel;
  }

  // ---- containers --------------------------------------------------------

  registerContainer(input: { number: string; type?: ContainerType; portId?: string }): Container {
    if (!input.number) throw new Error('container number is required');
    const container: Container = {
      id: randomUUID(), number: input.number, type: input.type ?? '20',
      status: 'empty', ...(input.portId ? { portId: input.portId } : {}),
      createdAt: Date.now(),
    };
    this.containers.set(container.id, container);
    return container;
  }

  getContainer(id: string): Container | undefined { return this.containers.get(id); }
  listContainers(filter?: { status?: ContainerStatus; shipmentId?: string }): Container[] {
    return [...this.containers.values()].filter((c) =>
      (!filter?.status || c.status === filter.status) &&
      (!filter?.shipmentId || c.shipmentId === filter.shipmentId));
  }

  updateContainerStatus(id: string, status: ContainerStatus, portId?: string): Container | undefined {
    const container = this.containers.get(id);
    if (!container) return undefined;
    container.status = status;
    if (portId) container.portId = portId;
    return container;
  }

  // ---- shipments + tracking ----------------------------------------------

  createShipment(input: CreateShipmentInput): Shipment {
    if (!input.origin || !input.destination || !input.shipper || !input.consignee) {
      throw new Error('origin, destination, shipper, and consignee are required');
    }
    const now = Date.now();
    const shipment: Shipment = {
      id: randomUUID(),
      trackingRef: generateTrackingRef(),
      mode: input.mode,
      status: 'booked',
      origin: input.origin,
      destination: input.destination,
      shipper: input.shipper,
      consignee: input.consignee,
      containerIds: [],
      weightKg: input.weightKg ?? 0,
      volumeCbm: input.volumeCbm ?? 0,
      createdAt: now,
      updatedAt: now,
    };
    this.shipments.set(shipment.id, shipment);
    return shipment;
  }

  getShipment(id: string): Shipment | undefined { return this.shipments.get(id); }

  getShipmentByTrackingRef(ref: string): Shipment | undefined {
    return [...this.shipments.values()].find((s) => s.trackingRef === ref);
  }

  listShipments(filter?: { status?: ShipmentStatus; mode?: ShipmentMode; consignee?: string }): Shipment[] {
    return [...this.shipments.values()].filter((s) =>
      (!filter?.status || s.status === filter.status) &&
      (!filter?.mode || s.mode === filter.mode) &&
      (!filter?.consignee || s.consignee === filter.consignee));
  }

  /** Attach a container to a shipment (marks it loaded). */
  assignContainer(shipmentId: string, containerId: string): { shipment: Shipment; container: Container } | undefined {
    const shipment = this.shipments.get(shipmentId);
    const container = this.containers.get(containerId);
    if (!shipment || !container) return undefined;
    if (!shipment.containerIds.includes(containerId)) shipment.containerIds.push(containerId);
    container.shipmentId = shipmentId;
    container.status = 'loaded';
    shipment.updatedAt = Date.now();
    return { shipment, container };
  }

  /** Record a tracking event; the shipment status follows the event code. */
  addTrackingEvent(input: { shipmentId: string; code: TrackingCode; location: string; note?: string; ts?: number }): TrackingEvent {
    const shipment = this.shipments.get(input.shipmentId);
    if (!shipment) throw new Error(`unknown shipment ${input.shipmentId}`);
    const event: TrackingEvent = {
      id: randomUUID(),
      shipmentId: input.shipmentId,
      code: input.code,
      location: input.location,
      ts: input.ts ?? Date.now(),
      ...(input.note ? { note: input.note } : {}),
    };
    this.events.push(event);
    if (this.events.length > this.MAX_EVENTS) this.events.splice(0, this.events.length - this.MAX_EVENTS);
    shipment.status = STATUS_FOR_CODE[input.code];
    shipment.updatedAt = event.ts;
    // Delivered containers follow the shipment.
    if (input.code === 'delivered') {
      for (const cid of shipment.containerIds) {
        const container = this.containers.get(cid);
        if (container) container.status = 'delivered';
      }
    }
    return event;
  }

  shipmentTimeline(shipmentId: string): TrackingEvent[] {
    return this.events.filter((e) => e.shipmentId === shipmentId);
  }

  // ---- warehouses --------------------------------------------------------

  registerWarehouse(input: { name: string; location: string; capacitySlots?: number }): Warehouse {
    if (!input.name || !input.location) throw new Error('name and location are required');
    const warehouse: Warehouse = {
      id: randomUUID(), name: input.name, location: input.location,
      capacitySlots: input.capacitySlots ?? 1000, usedSlots: 0,
      createdAt: Date.now(),
    };
    this.warehouses.set(warehouse.id, warehouse);
    return warehouse;
  }

  listWarehouses(): Warehouse[] { return [...this.warehouses.values()]; }

  /** Occupy or free warehouse slots. */
  adjustWarehouseSlots(id: string, delta: number): Warehouse | undefined {
    const warehouse = this.warehouses.get(id);
    if (!warehouse) return undefined;
    const next = warehouse.usedSlots + delta;
    if (next < 0 || next > warehouse.capacitySlots) throw new Error('slot adjustment exceeds capacity');
    warehouse.usedSlots = next;
    return warehouse;
  }

  // ---- analytics ---------------------------------------------------------

  stats(): LogisticsStats {
    const shipments = [...this.shipments.values()];
    const containers = [...this.containers.values()];
    const byStatus: Record<ShipmentStatus, number> = { booked: 0, in_transit: 0, arrived: 0, customs: 0, delivered: 0, exception: 0 };
    for (const s of shipments) byStatus[s.status] += 1;
    const byContainer: Record<ContainerStatus, number> = { empty: 0, loaded: 0, in_transit: 0, at_port: 0, delivered: 0 };
    for (const c of containers) byContainer[c.status] += 1;
    const delivered = shipments.filter((s) => s.status === 'delivered');
    // Clamp negative legs (backdated tracking events) to 0.
    const avgTransitMs = delivered.length > 0
      ? delivered.reduce((sum, s) => sum + Math.max(0, s.updatedAt - s.createdAt), 0) / delivered.length
      : undefined;
    return {
      ports: this.ports.size,
      vessels: this.vessels.size,
      containers: containers.length,
      shipments: shipments.length,
      warehouses: this.warehouses.size,
      shipmentsByStatus: byStatus,
      containersByStatus: byContainer,
      ...(avgTransitMs !== undefined ? { avgTransitMs } : {}),
    };
  }
}

/** Human-friendly tracking reference, e.g. JQ-8F3K2M. */
function generateTrackingRef(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = 'JQ-';
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}
