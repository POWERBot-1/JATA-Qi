// NYUMBANI KITCHEN (Phase 7) tests: venues, menus, tables, the order flow
// (create → submit → paid) with table lifecycle, ingredient inventory with
// reorder alerts, revenue analytics, and memory integration.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RestaurantEngine } from '../src/index.js';
import { RestaurantsModule } from '../src/index.js';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { DigitalMemoryModule } from '@jataqi/memory';

describe('RestaurantEngine', () => {
  it('registers venues, menu items, and tables', () => {
    const r = new RestaurantEngine();
    const venue = r.registerVenue({ name: 'Nyumbani Grill', ownerId: 'u1', cuisine: 'Swahili' });
    assert.equal(r.listVenues('u1').length, 1);
    assert.throws(() => r.registerVenue({ name: '', ownerId: 'u1' }), /required/);

    const item = r.addMenuItem({ venueId: venue.id, name: 'Beef Samosa', category: 'appetizer', price: 250 });
    r.addMenuItem({ venueId: venue.id, name: 'Grilled Fish', category: 'main', price: 1200 });
    assert.equal(r.listMenu(venue.id).length, 2);
    assert.equal(r.listMenu(venue.id, 'appetizer').length, 1);
    r.setMenuItemAvailable(item.id, false);
    assert.equal(r.getMenuItem(item.id)!.available, false);

    const table = r.addTable({ venueId: venue.id, number: 'T1', seats: 4 });
    assert.equal(table.status, 'free');
    assert.equal(r.listTables(venue.id, 'free').length, 1);
    assert.throws(() => r.addMenuItem({ venueId: 'nope', name: 'X', price: 1 }), /unknown venue/);
  });

  it('walks the order flow and frees the table on payment', () => {
    const r = new RestaurantEngine();
    const venue = r.registerVenue({ name: 'V', ownerId: 'u1' });
    const samosa = r.addMenuItem({ venueId: venue.id, name: 'Samosa', price: 250 });
    const fish = r.addMenuItem({ venueId: venue.id, name: 'Fish', price: 1200 });
    const table = r.addTable({ venueId: venue.id, number: 'T2' });

    const order = r.createOrder({ venueId: venue.id, tableId: table.id, lines: [{ menuItemId: samosa.id, quantity: 2 }, { menuItemId: fish.id, quantity: 1 }] });
    assert.equal(order.status, 'open');
    assert.equal(r.listTables(venue.id)[0]!.status, "occupied");
    assert.throws(() => r.createOrder({ venueId: venue.id, lines: [] }), /at least one line/);
    assert.throws(() => r.createOrder({ venueId: venue.id, lines: [{ menuItemId: samosa.id, quantity: -1 }] }), /positive/);

    const submitted = r.submitOrder(order.id);
    assert.equal(submitted!.status, 'submitted');
    assert.equal(submitted!.total, 1700); // 2×250 + 1200

    const paid = r.updateOrderStatus(order.id, 'paid');
    assert.equal(paid!.status, 'paid');
    // Table freed after payment.
    assert.equal(r.listTables(venue.id)[0]!.status, 'free');

    // Unavailable item blocks new orders.
    r.setMenuItemAvailable(samosa.id, false);
    assert.throws(() => r.createOrder({ venueId: venue.id, lines: [{ menuItemId: samosa.id, quantity: 1 }] }), /not available/);
  });

  it('tracks ingredient stock and flags reorder levels', () => {
    const r = new RestaurantEngine();
    const venue = r.registerVenue({ name: 'V', ownerId: 'u1' });
    const flour = r.addIngredient({ venueId: venue.id, name: 'Flour', stock: 500, reorderLevel: 200 });
    r.addIngredient({ venueId: venue.id, name: 'Fish', stock: 50, reorderLevel: 100 });
    assert.equal(r.listIngredients(venue.id).length, 2);
    r.adjustStock(flour.id, -350);
    assert.equal(r.listIngredients(venue.id)[0]!.stock, 150);
    const low = r.lowStock(venue.id);
    assert.equal(low.length, 2);
    assert.throws(() => r.adjustStock(flour.id, -1000), /negative/);
  });

  it('computes revenue analytics', () => {
    const r = new RestaurantEngine();
    const venue = r.registerVenue({ name: 'V', ownerId: 'u1' });
    const item = r.addMenuItem({ venueId: venue.id, name: 'Tea', price: 100 });
    const o1 = r.createOrder({ venueId: venue.id, lines: [{ menuItemId: item.id, quantity: 3 }] });
    const o2 = r.createOrder({ venueId: venue.id, lines: [{ menuItemId: item.id, quantity: 1 }] });
    r.submitOrder(o1.id);
    r.submitOrder(o2.id);
    r.updateOrderStatus(o1.id, 'paid');
    r.updateOrderStatus(o2.id, 'cancelled');

    const stats = r.stats(venue.id);
    assert.equal(stats.orders, 2);
    assert.equal(stats.paidOrders, 1);
    assert.equal(stats.cancelledOrders, 1);
    assert.equal(stats.revenueMinorUnits, 300);
    assert.equal(stats.avgOrderValueMinorUnits, 300);
  });
});

describe('RestaurantsModule', () => {
  it('integrates with memory and emits payment events', async () => {
    const kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new DigitalMemoryModule());
    kernel.register(new RestaurantsModule());
    await kernel.boot();
    try {
      const mod = kernel.getModule<RestaurantsModule>('restaurants');
      const paid: string[] = [];
      kernel.bus.on('restaurants.order.paid', (p: { id: string }) => { paid.push(p.id); });

      const venue = mod.registerVenue({ name: 'Demo Kitchen', ownerId: 'u1' });
      const item = mod.addMenuItem({ venueId: venue.id, name: 'Ugali + Fish', price: 800 });
      const order = await mod.createOrder({ venueId: venue.id, lines: [{ menuItemId: item.id, quantity: 2 }] });
      await mod.submitOrder(order.id);
      await mod.updateOrderStatus(order.id, 'paid');
      assert.equal(paid.length, 1);
      assert.equal(paid[0], order.id);

      // Orders recorded in the DME (order-independent).
      const memory = kernel.getModule<DigitalMemoryModule>('memory');
      const recs = memory.query({ category: 'restaurant_order' });
      assert.equal(recs.length, 3); // created + submitted + paid
      assert.ok(recs.some((r) => /paid — 1600 minor units/.test(r.summary)));

      assert.equal(mod.stats(venue.id)!.revenueMinorUnits, 1600);
    } finally {
      await kernel.shutdown();
    }
  });
});
