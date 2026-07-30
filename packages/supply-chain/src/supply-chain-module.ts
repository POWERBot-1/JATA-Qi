// SupplyChainModule — suppliers, inventory, purchase orders, deliveries (#22).
// Integrates with governance, audit, and notifications.

import { randomUUID } from 'node:crypto';
import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { ICollection } from '@jataqi/storage';
import { SupplyChainEvents } from './types.js';
import type { Delivery, InventoryItem, PurchaseOrder, Supplier } from './types.js';

const COL = { SUP: 'supply.suppliers', INV: 'supply.inventory', ORD: 'supply.orders', DEL: 'supply.deliveries' };

export class SupplyChainModule implements IModule {
  readonly id = 'supply-chain';
  readonly tags = ['intelligence', 'supply-chain'] as const;
  readonly dependsOn = ['storage'] as const;

  private api!: KernelApi;
  private suppliers!: ICollection<Supplier>;
  private inventory!: ICollection<InventoryItem>;
  private orders!: ICollection<PurchaseOrder>;
  private deliveries!: ICollection<Delivery>;

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    const storage = kernel.getModule('storage') as unknown as { collection: <T extends { id: string }>(n: string) => Promise<ICollection<T>> };
    const C = <T extends { id: string }>(n: string) => storage.collection<T>(n);
    this.suppliers = await C<Supplier>(COL.SUP);
    this.inventory = await C<InventoryItem>(COL.INV);
    this.orders = await C<PurchaseOrder>(COL.ORD);
    this.deliveries = await C<Delivery>(COL.DEL);
    kernel.container.registerValue('supply-chain', this);
    kernel.logger.info('supply-chain module initialized');
  }
  async start(_k: KernelApi): Promise<void> {}
  async stop(_k: KernelApi): Promise<void> {}

  // --- suppliers ---
  async registerSupplier(input: { name: string; category?: string; contactEmail?: string; organizationId?: string }): Promise<Supplier> {
    const s: Supplier = { id: randomUUID(), name: input.name, status: 'active', createdAt: Date.now(), ...(input.category ? { category: input.category } : {}), ...(input.contactEmail ? { contactEmail: input.contactEmail } : {}), ...(input.organizationId ? { organizationId: input.organizationId } : {}) };
    await this.suppliers.put(s);
    await this.audit(input.organizationId ?? 'system', 'supplier_registered', { id: s.id });
    return s;
  }
  async listSuppliers(category?: string): Promise<Supplier[]> {
    const all = await this.suppliers.all();
    return category ? all.filter((s) => s.category === category) : all;
  }
  async rateSupplier(id: string, rating: number): Promise<Supplier> {
    const s = await this.suppliers.get(id);
    if (!s) throw new Error(`supply-chain: supplier "${id}" not found`);
    const u: Supplier = { ...s, rating: Math.max(0, Math.min(5, rating)) };
    await this.suppliers.put(u);
    return u;
  }

  // --- inventory ---
  async addInventoryItem(input: { sku: string; name: string; quantity: number; reorderLevel: number; unitCost?: number; supplierId?: string; organizationId?: string }): Promise<InventoryItem> {
    const item: InventoryItem = { id: randomUUID(), ...input, updatedAt: Date.now() };
    await this.inventory.put(item);
    return item;
  }
  async adjustStock(id: string, delta: number): Promise<InventoryItem> {
    const item = await this.inventory.get(id);
    if (!item) throw new Error(`supply-chain: item "${id}" not found`);
    const updated: InventoryItem = { ...item, quantity: item.quantity + delta, updatedAt: Date.now() };
    await this.inventory.put(updated);
    if (updated.quantity <= updated.reorderLevel) {
      await this.api.bus.emit(SupplyChainEvents.LowStock, { sku: updated.sku, quantity: updated.quantity, reorderLevel: updated.reorderLevel });
      await this.notify(updated.organizationId ?? 'system', 'supply', 'Low stock alert', `Item ${updated.sku} at ${updated.quantity} (reorder at ${updated.reorderLevel})`);
    }
    return updated;
  }
  async listInventory(organizationId?: string): Promise<InventoryItem[]> {
    const all = await this.inventory.all();
    return organizationId ? all.filter((i) => i.organizationId === organizationId) : all;
  }
  async lowStockReport(): Promise<InventoryItem[]> {
    return (await this.inventory.all()).filter((i) => i.quantity <= i.reorderLevel);
  }

  // --- purchase orders ---
  async createPurchaseOrder(input: { supplierId: string; lines: { sku: string; name: string; quantity: number; unitCost: number }[]; currency?: string; createdBy: string; organizationId?: string }): Promise<PurchaseOrder> {
    const total = input.lines.reduce((s, l) => s + l.quantity * l.unitCost, 0);
    const order: PurchaseOrder = { id: randomUUID(), supplierId: input.supplierId, lines: input.lines, total: Math.round(total * 100) / 100, currency: input.currency ?? 'USD', status: 'submitted', createdBy: input.createdBy, ...(input.organizationId ? { organizationId: input.organizationId } : {}), createdAt: Date.now() };
    await this.orders.put(order);
    await this.audit(input.createdBy, 'order_created', { orderId: order.id, total: order.total });
    return order;
  }
  async approveOrder(id: string, approvedBy: string): Promise<PurchaseOrder> {
    const o = await this.orders.get(id);
    if (!o) throw new Error(`supply-chain: order "${id}" not found`);
    if (o.status !== 'submitted') throw new Error(`supply-chain: order status is ${o.status}`);
    const u: PurchaseOrder = { ...o, status: 'approved', approvedAt: Date.now() };
    await this.orders.put(u);
    await this.api.bus.emit(SupplyChainEvents.OrderApproved, { orderId: id });
    await this.audit(approvedBy, 'order_approved', { orderId: id });
    return u;
  }
  async listOrders(status?: string): Promise<PurchaseOrder[]> {
    const all = await this.orders.all();
    return status ? all.filter((o) => o.status === status) : all;
  }

  // --- deliveries ---
  async recordDelivery(input: { orderId: string; estimatedArrival?: number; trackingRef?: string }): Promise<Delivery> {
    const d: Delivery = { id: randomUUID(), orderId: input.orderId, status: 'in_transit', ...(input.estimatedArrival ? { estimatedArrival: input.estimatedArrival } : {}), ...(input.trackingRef ? { trackingRef: input.trackingRef } : {}), createdAt: Date.now() };
    await this.deliveries.put(d);
    return d;
  }
  async completeDelivery(id: string): Promise<Delivery> {
    const d = await this.deliveries.get(id);
    if (!d) throw new Error(`supply-chain: delivery "${id}" not found`);
    const now = Date.now();
    const u: Delivery = { ...d, status: 'delivered', actualArrival: now };
    await this.deliveries.put(u);
    // Update order status + add stock.
    const order = await this.orders.get(d.orderId);
    if (order) {
      order.status = 'delivered';
      await this.orders.put(order);
      for (const line of order.lines) {
        const items = (await this.inventory.all()).filter((i) => i.sku === line.sku);
        if (items.length > 0) await this.adjustStock(items[0]!.id, line.quantity);
      }
    }
    await this.api.bus.emit(SupplyChainEvents.DeliveryCompleted, { deliveryId: id });
    return u;
  }
  async listDeliveries(orderId?: string): Promise<Delivery[]> {
    const all = await this.deliveries.all();
    return orderId ? all.filter((d) => d.orderId === orderId) : all;
  }

  private async audit(actor: string, action: string, detail: Record<string, unknown>): Promise<void> {
    try { const s = this.api.getModule('security') as unknown as { audit: (r: Record<string, unknown>) => Promise<unknown> } | undefined; if (s?.audit) await s.audit({ actor, action: `supply.${action}`, result: 'success', detail }); } catch {}
  }
  private async notify(r: string, t: string, title: string, body: string): Promise<void> {
    try { const n = this.api.getModule('notifications') as unknown as { notify: (r: string, p: { type: string; title: string; body?: string }) => Promise<unknown> } | undefined; if (n?.notify) await n.notify(r, { type: t, title, body }); } catch {}
  }
}
