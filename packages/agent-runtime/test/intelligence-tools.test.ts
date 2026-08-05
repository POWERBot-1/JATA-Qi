// Intelligence tools tests: every Phase 6/7 engine is reachable by agents as
// a tool; tools execute real operations on a full kernel and degrade
// gracefully on partial kernels.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestKernel } from '@jataqi/core-kernel/testing';
import { StorageModule } from '@jataqi/storage';
import { VectorSearchModule } from '@jataqi/vector-search';
import { KnowledgeService } from '@jataqi/knowledge-service';
import { KnowledgeGraphModule } from '@jataqi/knowledge-graph';
import { AgentRuntimeModule, EchoLLM } from '../src/index.js';
import { FxModule } from '@jataqi/fx';
import { MobilityModule } from '@jataqi/mobility';
import { LogisticsModule } from '@jataqi/logistics';
import { AgricultureModule } from '@jataqi/agriculture';
import { CircularModule } from '@jataqi/circular';
import { EnergyModule } from '@jataqi/energy';
import { BorderModule } from '@jataqi/border';
import { RestaurantsModule } from '@jataqi/restaurants';
import { MarketplaceModule } from '@jataqi/marketplace';
import { SearchModule } from '@jataqi/search';
import { UniversalWalletModule } from '@jataqi/universal-wallet';
import { CryptoModule } from '@jataqi/crypto';

/** Boot a kernel with the core stack + all intelligence modules. */
async function bootFull() {
  const kernel = createTestKernel();
  kernel.register(new StorageModule());
  kernel.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
  kernel.register(new KnowledgeService());
  kernel.register(new KnowledgeGraphModule({ autoIndexDocuments: false }));
  kernel.register(new FxModule());
  kernel.register(new MobilityModule());
  kernel.register(new LogisticsModule());
  kernel.register(new AgricultureModule());
  kernel.register(new CircularModule());
  kernel.register(new EnergyModule());
  kernel.register(new BorderModule());
  kernel.register(new RestaurantsModule());
  kernel.register(new MarketplaceModule());
  kernel.register(new SearchModule());
  kernel.register(new UniversalWalletModule());
  kernel.register(new CryptoModule());
  kernel.register(new AgentRuntimeModule({ llm: new EchoLLM() }));
  await kernel.boot();
  return kernel;
}

/** Find a tool on the default agent. */
function toolOf(kernel: Awaited<ReturnType<typeof bootFull>>, name: string) {
  const agents = kernel.getModule<AgentRuntimeModule>('agent-runtime');
  const tool = agents.getAgent('main').getTools().find((t) => t.name === name);
  assert.ok(tool, `tool ${name} should be registered`);
  return tool;
}

async function callTool(kernel: Awaited<ReturnType<typeof bootFull>>, name: string, input: unknown) {
  const agents = kernel.getModule<AgentRuntimeModule>('agent-runtime');
  const tool = toolOf(kernel, name);
  return tool.execute(input as never, {
    runId: 'test', logger: { info: () => {}, debug: () => {}, error: () => {} }, metadata: {},
  });
}

describe('Agent intelligence tools (Phase 6/7 engines)', () => {
  it('registers all 20 intelligence tools on the default agent', async () => {
    const kernel = await bootFull();
    try {
      const names = kernel.getModule<AgentRuntimeModule>('agent-runtime').getAgent('main').getTools().map((t) => t.name);
      for (const expected of [
        'fx.rate', 'fx.convert', 'mobility.dispatch', 'mobility.vehicles',
        'logistics.track', 'logistics.shipments', 'agriculture.stats', 'agriculture.harvests',
        'circular.stats', 'circular.collections', 'energy.stats', 'energy.readings',
        'border.screen', 'border.crossings', 'restaurants.menu', 'restaurants.orders',
        'marketplace.listings', 'platform.search', 'wallet.balance', 'crypto.balance',
      ]) {
        assert.ok(names.includes(expected), `expected tool ${expected} registered`);
      }
    } finally {
      await kernel.shutdown();
    }
  });

  it('fx.rate and fx.convert return live rates', async () => {
    const kernel = await bootFull();
    try {
      const fx = kernel.getModule<FxModule>('fx');
      fx.setRate({ base: 'USD', quote: 'KES', bid: 128.5, ask: 129.0, source: 'test' });

      const rate = await callTool(kernel, 'fx.rate', { base: 'USD', quote: 'KES' }) as { pair: string; bid: number };
      assert.equal(rate.pair, 'USD/KES');
      assert.equal(rate.bid, 128.5);

      const conv = await callTool(kernel, 'fx.convert', { from: 'USD', to: 'KES', amount: '10000' }) as { result: string };
      assert.equal(conv.result, '1287500'); // 100.00 USD × 128.75 mid
    } finally {
      await kernel.shutdown();
    }
  });

  it('mobility.dispatch finds a vehicle and returns a fare', async () => {
    const kernel = await bootFull();
    try {
      const mobility = kernel.getModule<MobilityModule>('mobility');
      mobility.registerVehicle({ registration: 'KDD 123A', make: 'Toyota', model: 'Corolla', location: { lat: -1.2921, lng: 36.8219 } });

      const trip = await callTool(kernel, 'mobility.dispatch', {
        pickupLat: -1.2921, pickupLng: 36.8219, dropoffLat: -1.2864, dropoffLng: 36.8172,
      }) as { tripId: string; fare: string; status: string };
      assert.ok(trip.tripId);
      assert.ok(BigInt(trip.fare) > 0n);
      assert.equal(trip.status, 'requested');

      const vehicles = await callTool(kernel, 'mobility.vehicles', { status: 'on_trip' }) as unknown[];
      assert.equal(vehicles.length, 1);
    } finally {
      await kernel.shutdown();
    }
  });

  it('logistics.track follows a shipment by reference', async () => {
    const kernel = await bootFull();
    try {
      const logistics = kernel.getModule<LogisticsModule>('logistics');
      const shipment = logistics.createShipment({ mode: 'sea', origin: 'Shanghai', destination: 'Mombasa', shipper: 'S', consignee: 'C' });
      await logistics.trackShipment({ shipmentId: shipment.id, code: 'arrived', location: 'Mombasa Port' });

      const tracked = await callTool(kernel, 'logistics.track', { ref: shipment.trackingRef }) as { status: string; timeline: unknown[] };
      assert.equal(tracked.status, 'arrived');
      assert.equal(tracked.timeline.length, 1);

      const missing = await callTool(kernel, 'logistics.track', { ref: 'JQ-NOPE' }) as { error: string };
      assert.match(missing.error, /not found/);
    } finally {
      await kernel.shutdown();
    }
  });

  it('agriculture, circular, energy, and border tools expose live stats', async () => {
    const kernel = await bootFull();
    try {
      // Agriculture: farm + harvest.
      const agriculture = kernel.getModule<AgricultureModule>('agriculture');
      const farm = agriculture.registerFarm({ name: 'Green Acres', ownerId: 'u1' });
      const field = agriculture.addField({ farmId: farm.id, name: 'P1', areaHa: 2 });
      const cycle = agriculture.plantCrop({ fieldId: field.id, crop: 'maize', expectedYieldKg: 2000 });
      await agriculture.recordHarvest({ cropCycleId: cycle.id, yieldKg: 2400 });
      const astats = await callTool(kernel, 'agriculture.stats', {}) as { totalHarvestedKg: number };
      assert.equal(astats.totalHarvestedKg, 2400);
      const harvests = await callTool(kernel, 'agriculture.harvests', {}) as unknown[];
      assert.equal(harvests.length, 1);

      // Circular: collection.
      const circular = kernel.getModule<CircularModule>('circular');
      const stream = circular.registerStream({ name: 'PET', type: 'plastic' });
      await circular.recordCollection({ streamId: stream.id, weightKg: 200, source: 'Nairobi' });
      const cstats = await callTool(kernel, 'circular.stats', {}) as { collectedKg: number };
      assert.equal(cstats.collectedKg, 200);
      const collections = await callTool(kernel, 'circular.collections', { status: 'collected' }) as unknown[];
      assert.equal(collections.length, 1);

      // Energy: meter + reading.
      const energy = kernel.getModule<EnergyModule>('energy');
      const meter = energy.registerMeter({ name: 'Shop' });
      await energy.recordReading({ meterId: meter.id, kwh: 120 });
      const estats = await callTool(kernel, 'energy.stats', {}) as { meters: number; totalConsumptionKwh: number };
      assert.equal(estats.meters, 1);
      assert.equal(estats.totalConsumptionKwh, 120);
      const readings = await callTool(kernel, 'energy.readings', { meterId: meter.id }) as unknown[];
      assert.equal(readings.length, 1);

      // Border: watchlist screening.
      const border = kernel.getModule<BorderModule>('border');
      border.addWatchlist({ name: 'Watch Target', documentNo: 'W-001', category: 'person', reason: 'test' });
      const screen = await callTool(kernel, 'border.screen', { documentNo: 'W-001' }) as { matched: boolean };
      assert.equal(screen.matched, true);
      const clean = await callTool(kernel, 'border.screen', { documentNo: 'P-999' }) as { matched: boolean };
      assert.equal(clean.matched, false);
      const crossings = await callTool(kernel, 'border.crossings', {}) as unknown[];
      assert.ok(Array.isArray(crossings));
    } finally {
      await kernel.shutdown();
    }
  });

  it('restaurants, marketplace, wallet, and crypto tools work end-to-end', async () => {
    const kernel = await bootFull();
    try {
      // Restaurants: menu.
      const restaurants = kernel.getModule<RestaurantsModule>('restaurants');
      const venue = restaurants.registerVenue({ name: 'Nyumbani Grill', ownerId: 'u1' });
      restaurants.addMenuItem({ venueId: venue.id, name: 'Grilled Fish', category: 'main', price: 1200 });
      const menu = await callTool(kernel, 'restaurants.menu', { venueId: venue.id }) as unknown[];
      assert.equal(menu.length, 1);
      const orders = await callTool(kernel, 'restaurants.orders', { venueId: venue.id }) as unknown[];
      assert.equal(orders.length, 0);

      // Marketplace: listing search.
      const marketplace = kernel.getModule<MarketplaceModule>('marketplace');
      const sf = marketplace.registerStorefront({ vendorId: 'v1', name: 'Karibu Crafts' });
      await marketplace.createListing({ storefrontId: sf.id, title: 'Handwoven Basket', category: 'crafts', priceMinor: 1500 });
      const listings = await callTool(kernel, 'marketplace.listings', { query: 'basket' }) as unknown[];
      assert.equal(listings.length, 1);

      // Wallet: balance.
      const wallet = kernel.getModule<UniversalWalletModule>('universal-wallet');
      const w = wallet.openWallet('u1', 'developer');
      wallet.deposit(w.id, 'KES', 50000n, 'seed');
      const balance = await callTool(kernel, 'wallet.balance', { walletId: w.id, currency: 'KES' }) as { balance: string };
      assert.equal(balance.balance, '50000');

      // Crypto: balance.
      const crypto = kernel.getModule<CryptoModule>('crypto');
      crypto.registerAsset({ symbol: 'KRT', name: 'KRT', type: 'fungible', decimals: 2, totalSupply: 1000000n, chain: 'native' });
      crypto.mint('addr-1', 'KRT', 250n);
      const cbalance = await callTool(kernel, 'crypto.balance', { address: 'addr-1', symbol: 'KRT' }) as { balance: string };
      assert.equal(cbalance.balance, '250');
    } finally {
      await kernel.shutdown();
    }
  });

  it('platform.search federates across sources', async () => {
    const kernel = await bootFull();
    try {
      const knowledge = kernel.getModule<KnowledgeService>('knowledge');
      await knowledge.ingestText('JATA Qi unified search indexes the entire platform.', { title: 'Search docs' });
      const result = await callTool(kernel, 'platform.search', { query: 'unified search' }) as { total: number; hits: Array<{ source: string }> };
      assert.ok(result.total >= 1);
      assert.ok(result.hits.some((h) => h.source === 'knowledge'));
    } finally {
      await kernel.shutdown();
    }
  });

  it('tools degrade gracefully when their module is absent', async () => {
    // Core stack only (agent-runtime's dependsOn) — none of the Phase 6/7
    // engine modules registered.
    const kernel = createTestKernel();
    kernel.register(new StorageModule());
    kernel.register(new VectorSearchModule({ model: 'hash', hashDim: 64 }));
    kernel.register(new KnowledgeService());
    kernel.register(new KnowledgeGraphModule({ autoIndexDocuments: false }));
    kernel.register(new AgentRuntimeModule({ llm: new EchoLLM() }));
    await kernel.boot();
    try {
      const agents = kernel.getModule<AgentRuntimeModule>('agent-runtime');
      const tool = agents.getAgent('main').getTools().find((t) => t.name === 'fx.rate')!;
      const result = await tool.execute({ base: 'USD', quote: 'KES' }, {
        runId: 'test', logger: { info: () => {}, debug: () => {}, error: () => {} }, metadata: {},
      }) as { error: string };
      assert.match(result.error, /fx module not registered/);
    } finally {
      await kernel.shutdown();
    }
  });

  it('agents can use intelligence tools in a full run (ScriptedLLM)', async () => {
    const kernel = await bootFull();
    try {
      const agents = kernel.getModule<AgentRuntimeModule>('agent-runtime');
      const fx = kernel.getModule<FxModule>('fx');
      fx.setRate({ base: 'USD', quote: 'KES', bid: 128.5, ask: 129.0 });
      // A scripted run that first calls fx.rate then answers.
      const { ScriptedLLM } = await import('../src/index.js');
      const scripted = new ScriptedLLM([
        { toolCalls: [{ id: 't1', name: 'fx.rate', input: { base: 'USD', quote: 'KES' } }] },
        { text: 'The USD/KES rate is available.' },
      ]);
      agents.createAgent('fx-agent', { llm: scripted });
      const result = await agents.run('What is the USD/KES rate?', { agent: 'fx-agent' });
      assert.equal(result.finishedReason, 'answer');
      assert.equal(result.toolCalls.length, 1);
      assert.equal(result.toolCalls[0]!.tool, 'fx.rate');
      assert.match(JSON.stringify(result.toolCalls[0]!.output), /128\.5/);
    } finally {
      await kernel.shutdown();
    }
  });
});
