import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { SupplyChainModule } from '../src/index.js';
import type { Kernel } from '@jataqi/core-kernel';

describe('SupplyChainModule', () => {
  let kernel: Kernel; let scm: SupplyChainModule;
  beforeEach(async () => { kernel = createTestKernel(); kernel.register(new StorageModule()); kernel.register(new SupplyChainModule()); await kernel.boot(); scm = kernel.getModule<SupplyChainModule>('supply-chain'); });

  it('registers and rates suppliers', async () => {
    const s = await scm.registerSupplier({ name: 'Acme Corp', category: 'electronics', contactEmail: 'sales@acme.com' });
    assert.equal(s.status, 'active');
    const rated = await scm.rateSupplier(s.id, 4.5);
    assert.equal(rated.rating, 4.5);
  });

  it('manages inventory and triggers low-stock alerts', async () => {
    let lowStock = 0; kernel.bus.on('supply.low_stock', () => { lowStock++; });
    const item = await scm.addInventoryItem({ sku: 'WIDGET-001', name: 'Widget', quantity: 10, reorderLevel: 5 });
    await scm.adjustStock(item.id, -6); // 10→4, below reorder=5
    assert.equal(lowStock, 1);
    const report = await scm.lowStockReport();
    assert.equal(report.length, 1);
  });

  it('creates, approves orders and tracks deliveries with auto-stock-in', async () => {
    const sup = await scm.registerSupplier({ name: 'Supplier A' });
    const item = await scm.addInventoryItem({ sku: 'BOLT', name: 'Bolt M8', quantity: 0, reorderLevel: 10, supplierId: sup.id });
    const order = await scm.createPurchaseOrder({ supplierId: sup.id, lines: [{ sku: 'BOLT', name: 'Bolt M8', quantity: 100, unitCost: 0.5 }], createdBy: 'mgr' });
    assert.equal(order.total, 50);
    assert.equal(order.status, 'submitted');
    const approved = await scm.approveOrder(order.id, 'admin');
    assert.equal(approved.status, 'approved');
    const delivery = await scm.recordDelivery({ orderId: order.id, trackingRef: 'TRK123' });
    assert.equal(delivery.status, 'in_transit');
    const completed = await scm.completeDelivery(delivery.id);
    assert.equal(completed.status, 'delivered');
    // Stock should have increased by 100.
    const after = (await scm.listInventory()).find((i) => i.sku === 'BOLT')!;
    assert.equal(after.quantity, 100);
    // Order status updated.
    assert.equal((await scm.listOrders()).find((o) => o.id === order.id)!.status, 'delivered');
  });
});
