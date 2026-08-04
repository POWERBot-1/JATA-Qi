// LogisticsModule — PORTLINK kernel module. Wraps the engine, emits bus
// events, and records shipment milestones into the Digital Memory Engine.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { DigitalMemoryModule } from '@jataqi/memory';
import { LogisticsEngine, type CreateShipmentInput, type RegisterPortInput } from './engine.js';
import type {
  Container, ContainerStatus, ContainerType, LogisticsStats, Port, Shipment,
  ShipmentMode, ShipmentStatus, TrackingCode, TrackingEvent, Vessel,
  VesselStatus, Warehouse,
} from './types.js';

export const LogisticsEvents = Object.freeze({
  PortRegistered: 'logistics.port.registered',
  VesselUpdated: 'logistics.vessel.updated',
  ShipmentCreated: 'logistics.shipment.created',
  ShipmentTracked: 'logistics.shipment.tracked',
  ShipmentDelivered: 'logistics.shipment.delivered',
  ContainerRegistered: 'logistics.container.registered',
} as const);

export class LogisticsModule implements IModule {
  readonly id = 'logistics';
  readonly tags = ['core', 'logistics', 'intelligence'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private memory?: DigitalMemoryModule;
  readonly engine = new LogisticsEngine();

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('logistics', this);
    this.memory = this.tryModule<DigitalMemoryModule>('memory');
    kernel.logger.info('logistics module initialized (PORTLINK)');
  }
  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  // ---- ports + vessels ---------------------------------------------------

  registerPort(input: RegisterPortInput): Port {
    const port = this.engine.registerPort(input);
    void this.api.bus.emit(LogisticsEvents.PortRegistered, { id: port.id, code: port.code });
    return port;
  }
  getPort(id: string): Port | undefined { return this.engine.getPort(id); }
  listPorts(): Port[] { return this.engine.listPorts(); }

  registerVessel(input: { name: string; imo: string; portId?: string; eta?: number; etd?: number }): Vessel {
    return this.engine.registerVessel(input);
  }
  listVessels(status?: VesselStatus): Vessel[] { return this.engine.listVessels(status); }
  updateVesselStatus(id: string, status: VesselStatus, portId?: string): Vessel | undefined {
    const vessel = this.engine.updateVesselStatus(id, status, portId);
    if (vessel) void this.api.bus.emit(LogisticsEvents.VesselUpdated, { id: vessel.id, status: vessel.status });
    return vessel;
  }

  // ---- containers --------------------------------------------------------

  registerContainer(input: { number: string; type?: ContainerType; portId?: string }): Container {
    const container = this.engine.registerContainer(input);
    void this.api.bus.emit(LogisticsEvents.ContainerRegistered, { id: container.id, number: container.number });
    return container;
  }
  getContainer(id: string): Container | undefined { return this.engine.getContainer(id); }
  listContainers(filter?: { status?: ContainerStatus; shipmentId?: string }): Container[] {
    return this.engine.listContainers(filter);
  }
  updateContainerStatus(id: string, status: ContainerStatus, portId?: string): Container | undefined {
    return this.engine.updateContainerStatus(id, status, portId);
  }

  // ---- shipments + tracking ----------------------------------------------

  createShipment(input: CreateShipmentInput): Shipment {
    const shipment = this.engine.createShipment(input);
    void this.api.bus.emit(LogisticsEvents.ShipmentCreated, { id: shipment.id, trackingRef: shipment.trackingRef, mode: shipment.mode });
    void this.recordMemory('logistics_shipment', `shipment ${shipment.trackingRef} booked: ${shipment.origin} → ${shipment.destination}`, {
      shipmentId: shipment.id, trackingRef: shipment.trackingRef, mode: shipment.mode,
    });
    return shipment;
  }

  getShipment(id: string): Shipment | undefined { return this.engine.getShipment(id); }
  getShipmentByTrackingRef(ref: string): Shipment | undefined { return this.engine.getShipmentByTrackingRef(ref); }
  listShipments(filter?: { status?: ShipmentStatus; mode?: ShipmentMode; consignee?: string }): Shipment[] {
    return this.engine.listShipments(filter);
  }
  assignContainer(shipmentId: string, containerId: string): { shipment: Shipment; container: Container } | undefined {
    return this.engine.assignContainer(shipmentId, containerId);
  }

  async trackShipment(input: { shipmentId: string; code: TrackingCode; location: string; note?: string }): Promise<TrackingEvent> {
    const event = this.engine.addTrackingEvent(input);
    void this.api.bus.emit(LogisticsEvents.ShipmentTracked, { shipmentId: input.shipmentId, code: input.code });
    if (input.code === 'delivered') {
      void this.api.bus.emit(LogisticsEvents.ShipmentDelivered, { shipmentId: input.shipmentId });
    }
    await this.recordMemory('logistics_shipment', `shipment ${input.shipmentId} ${input.code} at ${input.location}`, {
      shipmentId: input.shipmentId, code: input.code, location: input.location,
    });
    return event;
  }

  shipmentTimeline(shipmentId: string): TrackingEvent[] { return this.engine.shipmentTimeline(shipmentId); }

  // ---- warehouses + analytics -------------------------------------------

  registerWarehouse(input: { name: string; location: string; capacitySlots?: number }): Warehouse {
    return this.engine.registerWarehouse(input);
  }
  listWarehouses(): Warehouse[] { return this.engine.listWarehouses(); }
  adjustWarehouseSlots(id: string, delta: number): Warehouse | undefined {
    return this.engine.adjustWarehouseSlots(id, delta);
  }
  stats(): LogisticsStats { return this.engine.stats(); }

  // ---- internals ---------------------------------------------------------

  private async recordMemory(category: string, summary: string, data: Record<string, unknown>): Promise<void> {
    if (!this.memory) return;
    try {
      await this.memory.record({ category, summary, data, tags: ['logistics', category] });
    } catch { /* non-fatal */ }
  }

  private tryModule<T extends IModule>(id: string): T | undefined {
    try { return this.api.getModule<T>(id); } catch { return undefined; }
  }
}
