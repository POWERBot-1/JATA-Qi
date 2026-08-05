// Intelligence tools — agent-facing tools for the Phase 6/7 platform engines.
// Each tool follows the established builtins pattern (factory over a module
// getter) and degrades gracefully with a clear message when its module is not
// registered on the kernel, so agents built on partial kernels still work.
//
// Tools exposed:
//   fx.*               — KARIS FX rates + conversions
//   mobility.*         — MOTO X dispatch + fleet status
//   logistics.*        — PORTLINK shipment tracking + lists
//   agriculture.*      — KARIS FARM stats + harvests
//   circular.*         — KARIS LOOP stats + collections
//   energy.*           — KARIS ENERGY stats + readings
//   border.*           — KARIS BORDER X screening + crossings
//   restaurants.*      — NYUMBANI KITCHEN menu + orders
//   marketplace.*      — MAZA listing search
//   platform.search    — federated search across all sources
//   wallet.*           — universal wallet balances
//   crypto.*           — KRT asset balances

import type { Tool, ToolContext } from './tools.js';
import type { FxModule } from '@jataqi/fx';
import type { MobilityModule } from '@jataqi/mobility';
import type { LogisticsModule } from '@jataqi/logistics';
import type { AgricultureModule } from '@jataqi/agriculture';
import type { CircularModule } from '@jataqi/circular';
import type { EnergyModule } from '@jataqi/energy';
import type { BorderModule } from '@jataqi/border';
import type { RestaurantsModule } from '@jataqi/restaurants';
import type { MarketplaceModule } from '@jataqi/marketplace';
import type { SearchModule } from '@jataqi/search';
import type { UniversalWalletModule } from '@jataqi/universal-wallet';
import type { CryptoModule } from '@jataqi/crypto';

/** Flattened geo input fields (the tool schema supports flat scalars only). */
const GEO_FIELDS = {
  pickupLat: { type: 'number', description: 'Pickup latitude (e.g. -1.2921 for Nairobi).' },
  pickupLng: { type: 'number', description: 'Pickup longitude (e.g. 36.8219 for Nairobi).' },
  dropoffLat: { type: 'number', description: 'Dropoff latitude.' },
  dropoffLng: { type: 'number', description: 'Dropoff longitude.' },
} as const;

function missing(name: string): { error: string } {
  return { error: `${name} module not registered on this kernel` };
}

// ---------------------------------------------------------------------------
// KARIS FX
// ---------------------------------------------------------------------------

/** fx.rate — current exchange rate between two currencies. */
export function fxRateTool(getModule: () => FxModule | undefined): Tool {
  return {
    name: 'fx.rate',
    description: 'Get the current exchange rate (bid/ask) between two currencies, e.g. USD to KES.',
    inputSchema: {
      type: 'object',
      properties: {
        base: { type: 'string', description: 'Base currency code, e.g. USD.' },
        quote: { type: 'string', description: 'Quote currency code, e.g. KES.' },
      },
      required: ['base', 'quote'],
    },
    async execute(input: any, ctx: ToolContext) {
      const mod = getModule();
      if (!mod) return missing('fx');
      const quote = mod.getRate(String(input.base ?? ''), String(input.quote ?? ''));
      if (!quote) return { error: `no rate for ${input.base}/${input.quote}` };
      ctx.logger.info(`fx.rate ${quote.pair} bid=${quote.bid} ask=${quote.ask}`);
      return { pair: quote.pair, bid: quote.bid, ask: quote.ask, mid: (quote.bid + quote.ask) / 2, source: quote.source };
    },
  };
}

/** fx.convert — convert an amount between currencies with optional margin. */
export function fxConvertTool(getModule: () => FxModule | undefined): Tool {
  return {
    name: 'fx.convert',
    description: 'Convert an amount (in minor units, e.g. cents) from one currency to another, optionally applying a margin.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
        amount: { type: 'string', description: 'Amount in minor units of the source currency (integer string).' },
        margin: { type: 'number', description: 'Optional margin multiplier >= 1 (default 1).' },
      },
      required: ['from', 'to', 'amount'],
    },
    async execute(input: any, ctx: ToolContext) {
      const mod = getModule();
      if (!mod) return missing('fx');
      try {
        const result = mod.convert({
          from: String(input.from),
          to: String(input.to),
          amount: BigInt(String(input.amount)),
          ...(typeof input.margin === 'number' ? { margin: input.margin } : {}),
        });
        ctx.logger.info(`fx.convert ${result.amount} ${result.from} -> ${result.result} ${result.to}`);
        return {
          from: result.from, to: result.to,
          amount: result.amount.toString(), result: result.result.toString(),
          rate: result.rate, margin: result.margin, marginAmount: result.marginAmount.toString(),
        };
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// MOTO X
// ---------------------------------------------------------------------------

/** mobility.dispatch — request a trip and get the nearest vehicle + fare. */
export function mobilityDispatchTool(getModule: () => MobilityModule | undefined): Tool {
  return {
    name: 'mobility.dispatch',
    description: 'Dispatch a ride: find the nearest available vehicle between a pickup and dropoff location and return the estimated fare.',
    inputSchema: {
      type: 'object',
      properties: {
        ...GEO_FIELDS,
        riderId: { type: 'string', description: 'Optional rider identifier.' },
      },
      required: ['pickupLat', 'pickupLng', 'dropoffLat', 'dropoffLng'],
    },
    async execute(input: any, ctx: ToolContext) {
      const mod = getModule();
      if (!mod) return missing('mobility');
      try {
        const trip = mod.requestTrip({
          pickup: { lat: Number(input.pickupLat), lng: Number(input.pickupLng) },
          dropoff: { lat: Number(input.dropoffLat), lng: Number(input.dropoffLng) },
          ...(typeof input.riderId === 'string' ? { riderId: input.riderId } : {}),
        });
        ctx.logger.info(`mobility.dispatch trip ${trip.id} vehicle=${trip.vehicleId}`);
        return {
          tripId: trip.id, status: trip.status, vehicleId: trip.vehicleId, driverId: trip.driverId,
          distanceKm: trip.distanceKm, fare: trip.fare,
        };
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
  };
}

/** mobility.vehicles — list vehicles by status/type. */
export function mobilityVehiclesTool(getModule: () => MobilityModule | undefined): Tool {
  return {
    name: 'mobility.vehicles',
    description: 'List vehicles in the fleet, optionally filtered by status (available/on_trip/maintenance/offline) or type.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Optional status filter.' },
        type: { type: 'string', description: 'Optional vehicle type filter (car/bike/van/truck/bus/ev).' },
      },
    },
    async execute(input: any, ctx: ToolContext) {
      const mod = getModule();
      if (!mod) return missing('mobility');
      const vehicles = mod.listVehicles({
        ...(typeof input.status === 'string' ? { status: input.status as never } : {}),
        ...(typeof input.type === 'string' ? { type: input.type as never } : {}),
      });
      ctx.logger.info(`mobility.vehicles found ${vehicles.length}`);
      return vehicles.map((v) => ({
        id: v.id, registration: v.registration, make: v.make, model: v.model,
        type: v.type, status: v.status, driverId: v.driverId,
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// PORTLINK
// ---------------------------------------------------------------------------

/** logistics.track — track a shipment by its reference. */
export function logisticsTrackTool(getModule: () => LogisticsModule | undefined): Tool {
  return {
    name: 'logistics.track',
    description: 'Track a shipment by its tracking reference (e.g. JQ-XXXXXX) and return its current status and timeline.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Tracking reference, e.g. JQ-8F3K2M.' },
      },
      required: ['ref'],
    },
    async execute(input: any, ctx: ToolContext) {
      const mod = getModule();
      if (!mod) return missing('logistics');
      const shipment = mod.getShipmentByTrackingRef(String(input.ref));
      if (!shipment) return { error: `shipment ${input.ref} not found` };
      const timeline = mod.shipmentTimeline(shipment.id).map((e) => ({
        code: e.code, location: e.location, ts: e.ts, note: e.note,
      }));
      ctx.logger.info(`logistics.track ${input.ref} status=${shipment.status}`);
      return {
        trackingRef: shipment.trackingRef, status: shipment.status, mode: shipment.mode,
        origin: shipment.origin, destination: shipment.destination,
        containers: shipment.containerIds.length, weightKg: shipment.weightKg, timeline,
      };
    },
  };
}

/** logistics.shipments — list shipments by status/mode. */
export function logisticsShipmentsTool(getModule: () => LogisticsModule | undefined): Tool {
  return {
    name: 'logistics.shipments',
    description: 'List shipments, optionally filtered by status (booked/in_transit/arrived/customs/delivered/exception) or mode.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        mode: { type: 'string', description: 'sea/air/road/rail.' },
      },
    },
    async execute(input: any, ctx: ToolContext) {
      const mod = getModule();
      if (!mod) return missing('logistics');
      const shipments = mod.listShipments({
        ...(typeof input.status === 'string' ? { status: input.status as never } : {}),
        ...(typeof input.mode === 'string' ? { mode: input.mode as never } : {}),
      });
      ctx.logger.info(`logistics.shipments found ${shipments.length}`);
      return shipments.map((s) => ({
        trackingRef: s.trackingRef, status: s.status, mode: s.mode,
        origin: s.origin, destination: s.destination, consignee: s.consignee,
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// KARIS FARM
// ---------------------------------------------------------------------------

/** agriculture.stats — farm/field/yield statistics. */
export function agricultureStatsTool(getModule: () => AgricultureModule | undefined): Tool {
  return {
    name: 'agriculture.stats',
    description: 'Get agricultural statistics (farms, fields, crop cycles, harvests, livestock) for the platform or a specific farm.',
    inputSchema: {
      type: 'object',
      properties: {
        farmId: { type: 'string', description: 'Optional farm id to scope the stats.' },
      },
    },
    async execute(input: any, ctx: ToolContext) {
      const mod = getModule();
      if (!mod) return missing('agriculture');
      const stats = mod.stats(typeof input.farmId === 'string' ? input.farmId : undefined);
      ctx.logger.info(`agriculture.stats farms=${stats.farms}`);
      return stats;
    },
  };
}

/** agriculture.harvests — recent harvest records. */
export function agricultureHarvestsTool(getModule: () => AgricultureModule | undefined): Tool {
  return {
    name: 'agriculture.harvests',
    description: 'List recent harvest records (crop, yield kg) for the platform or a specific farm.',
    inputSchema: {
      type: 'object',
      properties: {
        farmId: { type: 'string' },
      },
    },
    async execute(input: any, ctx: ToolContext) {
      const mod = getModule();
      if (!mod) return missing('agriculture');
      const harvests = mod.harvestsList(typeof input.farmId === 'string' ? input.farmId : undefined);
      ctx.logger.info(`agriculture.harvests found ${harvests.length}`);
      return harvests.map((h) => ({ crop: h.crop, yieldKg: h.yieldKg, harvestedAt: h.harvestedAt, fieldId: h.fieldId }));
    },
  };
}

// ---------------------------------------------------------------------------
// KARIS LOOP
// ---------------------------------------------------------------------------

/** circular.stats — circular economy statistics. */
export function circularStatsTool(getModule: () => CircularModule | undefined): Tool {
  return {
    name: 'circular.stats',
    description: 'Get circular economy statistics: streams, collections, recycled/diverted/landfill kg, CO2e saved, circular rate.',
    inputSchema: { type: 'object', properties: {} },
    async execute(_input: unknown, ctx: ToolContext) {
      const mod = getModule();
      if (!mod) return missing('circular');
      const stats = mod.stats();
      ctx.logger.info(`circular.stats circularRate=${stats.circularRate.toFixed(3)}`);
      return stats;
    },
  };
}

/** circular.collections — list material collections by status. */
export function circularCollectionsTool(getModule: () => CircularModule | undefined): Tool {
  return {
    name: 'circular.collections',
    description: 'List material collections, optionally filtered by status (collected/processed/recycled/diverted/landfill).',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
      },
    },
    async execute(input: any, ctx: ToolContext) {
      const mod = getModule();
      if (!mod) return missing('circular');
      const collections = mod.listCollections(undefined, typeof input.status === 'string' ? input.status as never : undefined);
      ctx.logger.info(`circular.collections found ${collections.length}`);
      return collections.map((c) => ({ id: c.id, streamId: c.streamId, weightKg: c.weightKg, status: c.status, source: c.source }));
    },
  };
}

// ---------------------------------------------------------------------------
// KARIS ENERGY
// ---------------------------------------------------------------------------

/** energy.stats — energy assets/meters/consumption statistics. */
export function energyStatsTool(getModule: () => EnergyModule | undefined): Tool {
  return {
    name: 'energy.stats',
    description: 'Get energy statistics: generation assets, total capacity, meters, total consumption, latest reading.',
    inputSchema: { type: 'object', properties: {} },
    async execute(_input: unknown, ctx: ToolContext) {
      const mod = getModule();
      if (!mod) return missing('energy');
      const stats = mod.stats();
      ctx.logger.info(`energy.stats assets=${stats.assets} consumption=${stats.totalConsumptionKwh}`);
      return stats;
    },
  };
}

/** energy.readings — recent meter readings. */
export function energyReadingsTool(getModule: () => EnergyModule | undefined): Tool {
  return {
    name: 'energy.readings',
    description: 'List recent energy meter readings for a meter id (cumulative kWh).',
    inputSchema: {
      type: 'object',
      properties: {
        meterId: { type: 'string' },
        limit: { type: 'number', description: 'Max readings (default 10).' },
      },
      required: ['meterId'],
    },
    async execute(input: any, ctx: ToolContext) {
      const mod = getModule();
      if (!mod) return missing('energy');
      const readings = mod.readingsFor(String(input.meterId), { limit: Number(input.limit ?? 10) });
      ctx.logger.info(`energy.readings found ${readings.length}`);
      return readings.map((r) => ({ id: r.id, kwh: r.kwh, ts: r.ts, voltageV: r.voltageV }));
    },
  };
}

// ---------------------------------------------------------------------------
// KARIS BORDER X
// ---------------------------------------------------------------------------

/** border.screen — screen a traveler document against the watchlist. */
export function borderScreenTool(getModule: () => BorderModule | undefined): Tool {
  return {
    name: 'border.screen',
    description: 'Screen a traveler document number (and optional name) against the border watchlist.',
    inputSchema: {
      type: 'object',
      properties: {
        documentNo: { type: 'string' },
        name: { type: 'string' },
      },
      required: ['documentNo'],
    },
    async execute(input: any, ctx: ToolContext) {
      const mod = getModule();
      if (!mod) return missing('border');
      const matches = mod.engine.screen(String(input.documentNo), typeof input.name === 'string' ? input.name : undefined);
      ctx.logger.info(`border.screen matched ${matches.length}`);
      return { matched: matches.length > 0, matches: matches.map((m) => ({ name: m.name, documentNo: m.documentNo, category: m.category, reason: m.reason })) };
    },
  };
}

/** border.crossings — recent crossings by clearance. */
export function borderCrossingsTool(getModule: () => BorderModule | undefined): Tool {
  return {
    name: 'border.crossings',
    description: 'List recent border crossings, optionally filtered by clearance (cleared/referred/denied).',
    inputSchema: {
      type: 'object',
      properties: {
        clearance: { type: 'string' },
        limit: { type: 'number' },
      },
    },
    async execute(input: any, ctx: ToolContext) {
      const mod = getModule();
      if (!mod) return missing('border');
      const crossings = mod.listCrossings({
        ...(typeof input.clearance === 'string' ? { clearance: input.clearance as never } : {}),
      }).slice(-Number(input.limit ?? 20));
      ctx.logger.info(`border.crossings found ${crossings.length}`);
      return crossings.map((c) => ({
        travelerName: c.travelerName, documentNo: c.documentNo, mode: c.mode,
        direction: c.direction, clearance: c.clearance, reason: c.reason, crossedAt: c.crossedAt,
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// NYUMBANI KITCHEN
// ---------------------------------------------------------------------------

/** restaurants.menu — venue menu. */
export function restaurantsMenuTool(getModule: () => RestaurantsModule | undefined): Tool {
  return {
    name: 'restaurants.menu',
    description: 'List the menu of a restaurant venue (name, price, category, availability).',
    inputSchema: {
      type: 'object',
      properties: {
        venueId: { type: 'string' },
        category: { type: 'string', description: 'Optional category filter.' },
      },
      required: ['venueId'],
    },
    async execute(input: any, ctx: ToolContext) {
      const mod = getModule();
      if (!mod) return missing('restaurants');
      const items = mod.listMenu(String(input.venueId), typeof input.category === 'string' ? input.category as never : undefined);
      ctx.logger.info(`restaurants.menu found ${items.length}`);
      return items.map((m) => ({ id: m.id, name: m.name, price: m.price, category: m.category, available: m.available }));
    },
  };
}

/** restaurants.orders — venue orders by status. */
export function restaurantsOrdersTool(getModule: () => RestaurantsModule | undefined): Tool {
  return {
    name: 'restaurants.orders',
    description: 'List restaurant orders, optionally filtered by venue or status (open/submitted/served/paid/cancelled).',
    inputSchema: {
      type: 'object',
      properties: {
        venueId: { type: 'string' },
        status: { type: 'string' },
      },
    },
    async execute(input: any, ctx: ToolContext) {
      const mod = getModule();
      if (!mod) return missing('restaurants');
      const orders = mod.listOrders({
        ...(typeof input.venueId === 'string' ? { venueId: input.venueId } : {}),
        ...(typeof input.status === 'string' ? { status: input.status as never } : {}),
      });
      ctx.logger.info(`restaurants.orders found ${orders.length}`);
      return orders.map((o) => ({ id: o.id, status: o.status, lines: o.lines.length, total: o.total, tableId: o.tableId }));
    },
  };
}

// ---------------------------------------------------------------------------
// MAZA
// ---------------------------------------------------------------------------

/** marketplace.listings — search marketplace listings. */
export function marketplaceListingsTool(getModule: () => MarketplaceModule | undefined): Tool {
  return {
    name: 'marketplace.listings',
    description: 'Search marketplace listings by keyword, category, max price, or minimum rating.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword search on title/description.' },
        category: { type: 'string' },
        maxPrice: { type: 'number', description: 'Maximum price in minor units.' },
        minRating: { type: 'number', description: 'Minimum rating 0..5.' },
      },
    },
    async execute(input: any, ctx: ToolContext) {
      const mod = getModule();
      if (!mod) return missing('marketplace');
      const listings = mod.listListings({
        ...(typeof input.query === 'string' ? { query: input.query } : {}),
        ...(typeof input.category === 'string' ? { category: input.category } : {}),
        ...(typeof input.maxPrice === 'number' ? { maxPrice: input.maxPrice } : {}),
        ...(typeof input.minRating === 'number' ? { minRating: input.minRating } : {}),
      });
      ctx.logger.info(`marketplace.listings found ${listings.length}`);
      return listings.map((l) => ({
        id: l.id, title: l.title, category: l.category,
        priceMinor: l.priceMinor, currency: l.currency, status: l.status,
        stock: l.stock, rating: l.rating,
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// Unified search
// ---------------------------------------------------------------------------

/** platform.search — federated search across all registered sources. */
export function platformSearchTool(getModule: () => SearchModule | undefined): Tool {
  return {
    name: 'platform.search',
    description: 'Search across the whole platform (knowledge, memory, graph, conversations, tools) with one federated query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        topK: { type: 'number', description: 'Max results (default 10).' },
        userId: { type: 'string', description: 'Optional user id for personalized ranking.' },
        orgId: { type: 'string' },
      },
      required: ['query'],
    },
    async execute(input: any, ctx: ToolContext) {
      const mod = getModule();
      if (!mod) return missing('search');
      const result = await mod.search(String(input.query), {
        topK: Number(input.topK ?? 10),
        ...(typeof input.userId === 'string' ? { userId: input.userId } : {}),
        ...(typeof input.orgId === 'string' ? { orgId: input.orgId } : {}),
      });
      ctx.logger.info(`platform.search "${input.query}" -> ${result.total} hits`);
      return {
        query: result.query, total: result.total,
        hits: result.hits.map((h) => ({ source: h.source, title: h.title, snippet: h.snippet, score: h.score, url: h.url })),
        facets: result.facets,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Wallet + crypto
// ---------------------------------------------------------------------------

/** wallet.balance — universal wallet balance. */
export function walletBalanceTool(getModule: () => UniversalWalletModule | undefined): Tool {
  return {
    name: 'wallet.balance',
    description: 'Get the balance of a wallet in a given currency (minor units as an integer string).',
    inputSchema: {
      type: 'object',
      properties: {
        walletId: { type: 'string' },
        currency: { type: 'string', description: 'Currency code, e.g. KES or USD.' },
      },
      required: ['walletId', 'currency'],
    },
    async execute(input: any, ctx: ToolContext) {
      const mod = getModule();
      if (!mod) return missing('universal-wallet');
      const wallet = mod.getWallet(String(input.walletId));
      if (!wallet) return { error: `wallet ${input.walletId} not found` };
      const balance = mod.balance(wallet.id, String(input.currency));
      ctx.logger.info(`wallet.balance ${wallet.id} ${input.currency}=${balance}`);
      return { walletId: wallet.id, currency: String(input.currency), balance: balance.toString(), status: wallet.status };
    },
  };
}

/** crypto.balance — KRT asset balance for an address. */
export function cryptoBalanceTool(getModule: () => CryptoModule | undefined): Tool {
  return {
    name: 'crypto.balance',
    description: 'Get the balance of a digital asset (e.g. KRT) for an address, in minor units as an integer string.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string' },
        symbol: { type: 'string', description: 'Asset symbol, e.g. KRT.' },
      },
      required: ['address', 'symbol'],
    },
    async execute(input: any, ctx: ToolContext) {
      const mod = getModule();
      if (!mod) return missing('crypto');
      const balance = mod.getBalance(String(input.address), String(input.symbol));
      ctx.logger.info(`crypto.balance ${input.address} ${input.symbol}=${balance}`);
      return { address: String(input.address), symbol: String(input.symbol), balance: balance.toString() };
    },
  };
}

/** All intelligence tools with a getter resolver keyed by module id. */
export function allIntelligenceTools(resolve: (id: string) => unknown): Tool[] {
  const get = <T>(id: string): T | undefined => resolve(id) as T | undefined;
  return [
    fxRateTool(() => get<FxModule>('fx')),
    fxConvertTool(() => get<FxModule>('fx')),
    mobilityDispatchTool(() => get<MobilityModule>('mobility')),
    mobilityVehiclesTool(() => get<MobilityModule>('mobility')),
    logisticsTrackTool(() => get<LogisticsModule>('logistics')),
    logisticsShipmentsTool(() => get<LogisticsModule>('logistics')),
    agricultureStatsTool(() => get<AgricultureModule>('agriculture')),
    agricultureHarvestsTool(() => get<AgricultureModule>('agriculture')),
    circularStatsTool(() => get<CircularModule>('circular')),
    circularCollectionsTool(() => get<CircularModule>('circular')),
    energyStatsTool(() => get<EnergyModule>('energy')),
    energyReadingsTool(() => get<EnergyModule>('energy')),
    borderScreenTool(() => get<BorderModule>('border')),
    borderCrossingsTool(() => get<BorderModule>('border')),
    restaurantsMenuTool(() => get<RestaurantsModule>('restaurants')),
    restaurantsOrdersTool(() => get<RestaurantsModule>('restaurants')),
    marketplaceListingsTool(() => get<MarketplaceModule>('marketplace')),
    platformSearchTool(() => get<SearchModule>('search')),
    walletBalanceTool(() => get<UniversalWalletModule>('universal-wallet')),
    cryptoBalanceTool(() => get<CryptoModule>('crypto')),
  ];
}
