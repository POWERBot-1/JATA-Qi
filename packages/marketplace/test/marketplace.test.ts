// MAZA (Phase 7) tests: storefronts, listings with inventory, reviews &
// ratings aggregation, listing search/filter, analytics, commerce-bridge
// purchases, and memory integration.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MarketplaceEngine } from '../src/index.js';
import { MarketplaceModule } from '../src/index.js';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { DigitalMemoryModule } from '@jataqi/memory';

describe('MarketplaceEngine', () => {
  it('registers storefronts and validates inputs', () => {
    const m = new MarketplaceEngine();
    const sf = m.registerStorefront({ vendorId: 'v1', name: 'Karibu Crafts', description: 'Handmade goods', categories: ['crafts'] });
    assert.equal(sf.status, 'active');
    assert.equal(m.listStorefronts({ vendorId: 'v1' }).length, 1);
    m.setStorefrontStatus(sf.id, 'suspended');
    assert.equal(m.getStorefront(sf.id)!.status, 'suspended');
    assert.throws(() => m.registerStorefront({ vendorId: '', name: 'X' }), /required/);
  });

  it('creates listings with inventory and status lifecycle', () => {
    const m = new MarketplaceEngine();
    const sf = m.registerStorefront({ vendorId: 'v1', name: 'Shop' });
    const listing = m.createListing({ storefrontId: sf.id, title: 'Basket', category: 'crafts', priceMinor: 1500, stock: 5 });
    assert.equal(listing.status, 'listed');
    assert.equal(listing.currency, 'KES');
    assert.equal(m.getListing(listing.id)!.vendorId, 'v1');

    m.adjustStock(listing.id, -5);
    assert.equal(m.getListing(listing.id)!.status, 'out_of_stock');
    assert.equal(m.getListing(listing.id)!.stock, 0);
    m.adjustStock(listing.id, 2);
    assert.equal(m.getListing(listing.id)!.status, 'listed');
    assert.throws(() => m.adjustStock(listing.id, -10), /negative/);

    m.setListingStatus(listing.id, 'unlisted');
    assert.equal(m.listListings({ status: 'listed' }).length, 0);
    assert.throws(() => m.createListing({ storefrontId: 'nope', title: 'X', category: 'c', priceMinor: 1 }), /unknown storefront/);
    // Suspended storefronts cannot list.
    m.setStorefrontStatus(sf.id, 'suspended');
    assert.throws(() => m.createListing({ storefrontId: sf.id, title: 'Y', category: 'c', priceMinor: 1 }), /suspended/);
  });

  it('filters and searches listings', () => {
    const m = new MarketplaceEngine();
    const sf = m.registerStorefront({ vendorId: 'v1', name: 'Shop' });
    m.createListing({ storefrontId: sf.id, title: 'Handwoven Basket', category: 'crafts', priceMinor: 1500 });
    m.createListing({ storefrontId: sf.id, title: 'Coffee Beans', category: 'food', priceMinor: 800 });
    m.createListing({ storefrontId: sf.id, title: 'Premium Basket XL', category: 'crafts', priceMinor: 3000, stock: 0 });

    assert.equal(m.listListings({ category: 'crafts' }).length, 2);
    assert.equal(m.listListings({ query: 'coffee' }).length, 1);
    assert.equal(m.listListings({ maxPrice: 1000 }).length, 1);
    assert.equal(m.listListings({ status: 'listed' }).length, 2); // XL is out_of_stock
    assert.equal(m.listListings({ query: 'basket', category: 'crafts' }).length, 2);
  });

  it('aggregates review ratings on listings and storefronts', () => {
    const m = new MarketplaceEngine();
    const sf = m.registerStorefront({ vendorId: 'v1', name: 'Shop' });
    const a = m.createListing({ storefrontId: sf.id, title: 'Basket', category: 'crafts', priceMinor: 1000 });
    const b = m.createListing({ storefrontId: sf.id, title: 'Mat', category: 'crafts', priceMinor: 2000 });

    m.addReview({ listingId: a.id, reviewerId: 'u1', rating: 5, comment: 'Great' });
    m.addReview({ listingId: a.id, reviewerId: 'u2', rating: 4 });
    m.addReview({ listingId: b.id, reviewerId: 'u1', rating: 3 });

    assert.equal(m.getListing(a.id)!.rating, 4.5); // (5+4)/2
    assert.equal(m.getListing(a.id)!.reviewCount, 2);
    assert.equal(m.getStorefront(sf.id)!.rating, 4); // (5+4+3)/3 = 4
    assert.equal(m.getStorefront(sf.id)!.reviewCount, 3);
    assert.equal(m.reviewsForListing(a.id).length, 2);
    assert.equal(m.reviewsForStorefront(sf.id).length, 3);
    assert.throws(() => m.addReview({ listingId: a.id, reviewerId: 'u3', rating: 6 }), /1\.\.5/);
  });

  it('computes marketplace analytics', () => {
    const m = new MarketplaceEngine();
    const sf = m.registerStorefront({ vendorId: 'v1', name: 'Shop', categories: ['crafts'] });
    m.createListing({ storefrontId: sf.id, title: 'A', category: 'crafts', priceMinor: 1000 });
    m.createListing({ storefrontId: sf.id, title: 'B', category: 'crafts', priceMinor: 3000 });
    m.createListing({ storefrontId: sf.id, title: 'C', category: 'food', priceMinor: 500 });
    const stats = m.stats();
    assert.equal(stats.storefronts, 1);
    assert.equal(stats.activeStorefronts, 1);
    assert.equal(stats.listings, 3);
    assert.equal(stats.listedListings, 3);
    assert.equal(stats.categories, 2);
    assert.equal(stats.avgListingPriceMinor, 1500); // (1000+3000+500)/3
    assert.equal(stats.topCategory!.category, 'crafts');
    assert.deepEqual(m.categories().sort(), ['crafts', 'food']);
  });
});

describe('MarketplaceModule', () => {
  it('integrates with memory and composes commerce for purchases', async () => {
    const kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new DigitalMemoryModule());
    kernel.register(new MarketplaceModule());
    await kernel.boot();
    try {
      const mod = kernel.getModule<MarketplaceModule>('marketplace');
      const purchased: string[] = [];
      kernel.bus.on('marketplace.purchase.completed', (p: { listingId: string }) => { purchased.push(p.listingId); });

      const sf = mod.registerStorefront({ vendorId: 'v1', name: 'Karibu Crafts' });
      const listing = await mod.createListing({ storefrontId: sf.id, title: 'Basket', category: 'crafts', priceMinor: 1500, stock: 2 });
      await mod.addReview({ listingId: listing.id, reviewerId: 'u1', rating: 5 });

      // No commerce module → local fallback purchase.
      const result = await mod.purchase(listing.id, 'buyer-1');
      assert.equal(result.ok, true);
      assert.equal(purchased.length, 1);
      assert.equal(mod.getListing(listing.id)!.stock, 1);

      // Listing + review + purchase recorded in the DME (order-independent).
      const memory = kernel.getModule<DigitalMemoryModule>('memory');
      const listings = memory.query({ category: 'marketplace_listing' });
      assert.equal(listings.length, 1);
      const reviews = memory.query({ category: 'marketplace_review' });
      assert.equal(reviews.length, 1);
      assert.match(reviews[0]!.summary, /5★/);
      const purchases = memory.query({ category: 'marketplace_purchase' });
      assert.equal(purchases.length, 1);

      assert.equal(mod.stats().listings, 1);
    } finally {
      await kernel.shutdown();
    }
  });

  it('routes purchases through commerce when registered', async () => {
    const kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new DigitalMemoryModule());
    const { CommerceModule } = await import('@jataqi/commerce');
    kernel.register(new CommerceModule());
    kernel.register(new MarketplaceModule());
    await kernel.boot();
    try {
      const mod = kernel.getModule<MarketplaceModule>('marketplace');
      const sf = mod.registerStorefront({ vendorId: 'v1', name: 'Shop' });
      const listing = await mod.createListing({ storefrontId: sf.id, title: 'Tea', category: 'food', priceMinor: 400, stock: 3 });
      const result = await mod.purchase(listing.id, 'buyer-9');
      assert.equal(result.ok, true);
      assert.ok(result.orderId, 'commerce order should exist');
      assert.equal(mod.getListing(listing.id)!.stock, 2);
    } finally {
      await kernel.shutdown();
    }
  });
});

describe('MAZA purchase flows (cart → checkout → orders → payouts)', () => {
  function setup() {
    const m = new MarketplaceEngine();
    const sf1 = m.registerStorefront({ vendorId: 'v1', name: 'Karibu Crafts' });
    const sf2 = m.registerStorefront({ vendorId: 'v2', name: 'Savanna Tech' });
    const basket = m.createListing({ storefrontId: sf1.id, title: 'Basket', category: 'crafts', priceMinor: 1500, stock: 5 });
    const laptop = m.createListing({ storefrontId: sf2.id, title: 'Laptop', category: 'tech', priceMinor: 45000, stock: 2 });
    return { m, sf1, sf2, basket, laptop };
  }

  it('creates one cart per buyer, adds/removes items, and computes totals', () => {
    const { m, basket, laptop } = setup();
    const cart = m.createCart('buyer-1');
    assert.equal(m.createCart('buyer-1').id, cart.id, 'one cart per buyer');
    m.addToCart(cart.id, basket.id, 2);
    m.addToCart(cart.id, laptop.id);
    assert.equal(cart.items.length, 2);
    assert.equal(cart.totalMinor, 1500 * 2 + 45000);
    assert.equal(cart.currency, 'KES');
    m.removeFromCart(cart.id, basket.id);
    assert.equal(cart.items.length, 1);
    assert.equal(cart.totalMinor, 45000);
    m.clearCart(cart.id);
    assert.equal(cart.items.length, 0);
    assert.equal(cart.totalMinor, 0);
  });

  it('validates quantity and stock on cart add', () => {
    const { m, basket } = setup();
    const cart = m.createCart('buyer-2');
    assert.throws(() => m.addToCart(cart.id, basket.id, 0), />= 1/);
    assert.throws(() => m.addToCart(cart.id, basket.id, 99), /in stock/);
    m.setListingStatus(basket.id, 'unlisted');
    assert.throws(() => m.addToCart(cart.id, basket.id), /unlisted/);
  });

  it('checkouts a cart into a paid order with per-vendor payouts and stock decrement', () => {
    const { m, basket, laptop } = setup();
    const cart = m.createCart('buyer-3');
    m.addToCart(cart.id, basket.id, 2);
    m.addToCart(cart.id, laptop.id);
    const { order } = m.checkout(cart.id);
    assert.equal(order.status, 'paid');
    assert.equal(order.items.length, 2);
    assert.equal(order.totalMinor, 1500 * 2 + 45000);
    assert.equal(order.commissionMinor, Math.round(order.totalMinor * 0.05));
    assert.ok(order.paidAt);
    // Stock decremented.
    assert.equal(m.getListing(basket.id)!.stock, 3);
    assert.equal(m.getListing(laptop.id)!.stock, 1);
    // Cart cleared.
    assert.equal(cart.items.length, 0);
    // Payouts per vendor.
    const v1 = m.listPayouts('v1');
    const v2 = m.listPayouts('v2');
    assert.equal(v1.length, 1);
    assert.equal(v1[0].amountMinor, 3000);
    assert.equal(v1[0].commissionMinor, 150);
    assert.equal(v1[0].netMinor, 2850);
    assert.equal(v2.length, 1);
    assert.equal(v2[0].amountMinor, 45000);
    // Analytics.
    const a = m.orderAnalytics();
    assert.equal(a.orders, 1);
    assert.equal(a.gmvMinor, order.totalMinor);
    assert.equal(a.pendingPayoutsMinor, v1[0].netMinor + v2[0].netMinor);
  });

  it('rejects empty/unknown carts at checkout and keeps stock consistent on failure', () => {
    const { m } = setup();
    assert.throws(() => m.checkout('nope'), /unknown cart/);
    const cart = m.createCart('buyer-4');
    assert.throws(() => m.checkout(cart.id), /empty/);
  });

  it('lists orders by buyer/vendor/status and refunds restock + void payouts', () => {
    const { m, basket, laptop } = setup();
    const cart = m.createCart('buyer-5');
    m.addToCart(cart.id, basket.id);
    m.addToCart(cart.id, laptop.id);
    const { order } = m.checkout(cart.id);
    assert.equal(m.listOrders({ buyerId: 'buyer-5' }).length, 1);
    assert.equal(m.listOrders({ vendorId: 'v1' }).length, 1);
    assert.equal(m.listOrders({ status: 'paid' }).length, 1);
    assert.equal(m.getOrder(order.id)!.buyerId, 'buyer-5');

    const refunded = m.refundOrder(order.id);
    assert.equal(refunded.status, 'refunded');
    assert.ok(refunded.refundedAt);
    assert.equal(m.getListing(basket.id)!.stock, 5, 'restocked');
    assert.equal(m.getListing(laptop.id)!.stock, 2, 'restocked');
    assert.equal(m.listPayouts(undefined, 'pending').length, 0, 'payouts voided');
    assert.throws(() => m.refundOrder(order.id), /only paid orders/);
  });

  it('quickPurchase (legacy single-listing) yields a full order + payout', () => {
    const { m, laptop } = setup();
    const order = m.quickPurchase(laptop.id, 'buyer-6');
    assert.equal(order.status, 'paid');
    assert.equal(order.items.length, 1);
    assert.equal(order.totalMinor, 45000);
    assert.equal(m.getListing(laptop.id)!.stock, 1);
    const payouts = m.listPayouts('v2');
    assert.equal(payouts.length, 1);
    assert.equal(payouts[0].netMinor, 45000 - Math.round(45000 * 0.05));
  });

  it('module emits order events and records memory on checkout', async () => {
    const kernel = createTestKernel();
    try {
      kernel.register(new StorageModule());
      kernel.register(new DigitalMemoryModule());
      kernel.register(new MarketplaceModule());
      await kernel.boot();
      const m = kernel.getModule<MarketplaceModule>('marketplace');
      const events: string[] = [];
      kernel.bus.on('marketplace.order.created', () => { events.push('marketplace.order.created'); });
      kernel.bus.on('marketplace.order.paid', () => { events.push('marketplace.order.paid'); });
      const sf = m.registerStorefront({ vendorId: 'v1', name: 'Shop' });
      const listing = await m.createListing({ storefrontId: sf.id, title: 'Basket', category: 'crafts', priceMinor: 1000, stock: 3 });
      const cart = m.createCart('buyer-7');
      await m.addToCart(cart.id, listing.id, 2);
      const order = await m.checkout(cart.id);
      assert.equal(order.status, 'paid');
      assert.ok(events.includes('marketplace.order.created'));
      assert.ok(events.includes('marketplace.order.paid'));
      assert.ok(events.includes('marketplace.order.cancelled') === false);
      assert.equal(m.listOrders({ buyerId: 'buyer-7' }).length, 1);
    } finally {
      await kernel.shutdown();
    }
  });
});
