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
//   cloud.*            — PRX Part E instances + autoscaling
//   cdn.*              — PRX CDN zones, lookups, purges
//   email.*            — PRX Email domains, send, inbox
//   ipam.*             — PRX RIR Member blocks, announcements, stats

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
import type { CloudModule } from '@jataqi/cloud';
import type { CdnModule } from '@jataqi/cdn';
import type { EmailModule } from '@jataqi/email';
import type { IpamModule } from '@jataqi/ipam';

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

// ---------------------------------------------------------------------------
// Cloud (PRX Part E)
// ---------------------------------------------------------------------------

/** cloud.instances — list cloud compute instances. */
export function cloudInstancesTool(getModule: () => CloudModule | undefined): Tool {
  return {
    name: 'cloud.instances',
    description: 'List cloud compute instances, optionally filtered by region or status.',
    inputSchema: {
      type: 'object',
      properties: {
        regionId: { type: 'string', description: 'Optional region id to filter by.' },
        status: { type: 'string', description: 'Optional status filter: provisioning | running | stopped | terminated | failed.' },
      },
    },
    async execute(input: any, ctx: ToolContext) {
      const mod = getModule();
      if (!mod) return missing('cloud');
      const instances = mod.listInstances({
        ...(input.regionId ? { regionId: String(input.regionId) } : {}),
        ...(input.status ? { status: String(input.status) as any } : {}),
      });
      ctx.logger.info(`cloud.instances -> ${instances.length} instance(s)`);
      return {
        instances: instances.map((i) => ({
          id: i.id, name: i.name, status: i.status, regionId: i.regionId, zone: i.zone,
          flavorId: i.flavorId, imageId: i.imageId, publicIp: i.publicIp, privateIp: i.privateIp,
          vpcId: i.vpcId, hostingPlanId: i.hostingPlanId, autoscalingGroupId: i.autoscalingGroupId,
        })),
      };
    },
  };
}

/** cloud.provision — provision a new compute instance. */
export function cloudProvisionTool(getModule: () => CloudModule | undefined): Tool {
  return {
    name: 'cloud.provision',
    description: 'Provision a cloud compute instance in a region from a flavor and image.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Instance name.' },
        regionId: { type: 'string', description: 'Region id with available capacity.' },
        zone: { type: 'string', description: 'Optional availability zone within the region.' },
        flavorId: { type: 'string', description: 'Flavor (compute sizing) id.' },
        imageId: { type: 'string', description: 'OS image id.' },
        vpcId: { type: 'string', description: 'Optional VPC to attach the instance to.' },
        hostingPlanId: { type: 'string', description: 'Optional hosting plan id.' },
      },
      required: ['name', 'regionId', 'flavorId', 'imageId'],
    },
    async execute(input: any, ctx: ToolContext) {
      const mod = getModule();
      if (!mod) return missing('cloud');
      try {
        const instance = await mod.provisionInstance({
          name: String(input.name),
          regionId: String(input.regionId),
          ...(input.zone ? { zone: String(input.zone) } : {}),
          flavorId: String(input.flavorId),
          imageId: String(input.imageId),
          ...(input.vpcId ? { vpcId: String(input.vpcId) } : {}),
          ...(input.hostingPlanId ? { hostingPlanId: String(input.hostingPlanId) } : {}),
        });
        ctx.logger.info(`cloud.provision ${instance.id} (${instance.name}) in ${instance.regionId}`);
        return {
          instance: {
            id: instance.id, name: instance.name, status: instance.status, regionId: instance.regionId,
            zone: instance.zone, flavorId: instance.flavorId, imageId: instance.imageId,
            publicIp: instance.publicIp, privateIp: instance.privateIp,
          },
        };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

/** cloud.autoscale — evaluate an autoscaling group against current load. */
export function cloudAutoscaleTool(getModule: () => CloudModule | undefined): Tool {
  return {
    name: 'cloud.autoscale',
    description: 'Evaluate an autoscaling group against the current load (0..1 CPU utilization) and return the recommended action.',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: 'Autoscaling group id.' },
        load: { type: 'number', description: 'Current load as CPU utilization 0..1.' },
      },
      required: ['groupId', 'load'],
    },
    async execute(input: any, ctx: ToolContext) {
      const mod = getModule();
      if (!mod) return missing('cloud');
      try {
        const result = mod.evaluateAutoscaling(String(input.groupId), Number(input.load));
        ctx.logger.info(`cloud.autoscale ${input.groupId} load=${input.load} -> ${result.action}`);
        return result;
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// CDN (PRX CDN Provider)
// ---------------------------------------------------------------------------

/** cdn.zones — list CDN zones. */
export function cdnZonesTool(getModule: () => CdnModule | undefined): Tool {
  return {
    name: 'cdn.zones',
    description: 'List CDN zones (domains with origins, TLS, and TTL settings).',
    inputSchema: { type: 'object', properties: {} },
    async execute(_input: any, ctx: ToolContext) {
      const mod = getModule();
      if (!mod) return missing('cdn');
      const zones = mod.listZones();
      ctx.logger.info(`cdn.zones -> ${zones.length} zone(s)`);
      return {
        zones: zones.map((z) => ({
          id: z.id, domain: z.domain, origin: z.origin, status: z.status,
          originShield: z.originShield, tlsEnabled: z.tlsEnabled, defaultTtlSec: z.defaultTtlSec,
        })),
      };
    },
  };
}

/** cdn.lookup — look up a cached asset on a zone. */
export function cdnLookupTool(getModule: () => CdnModule | undefined): Tool {
  return {
    name: 'cdn.lookup',
    description: 'Look up a path on a CDN zone; returns the cache outcome (hit | miss | stale | shield_hit) and asset details when cached.',
    inputSchema: {
      type: 'object',
      properties: {
        zoneId: { type: 'string', description: 'CDN zone id.' },
        path: { type: 'string', description: 'Cache key path, e.g. /assets/logo.png.' },
      },
      required: ['zoneId', 'path'],
    },
    async execute(input: any, ctx: ToolContext) {
      const mod = getModule();
      if (!mod) return missing('cdn');
      const zone = mod.getZone(String(input.zoneId));
      if (!zone) return { error: `zone ${input.zoneId} not found` };
      const result = mod.lookup(zone.id, String(input.path));
      ctx.logger.info(`cdn.lookup ${zone.domain}${input.path} -> ${result.outcome}`);
      return {
        outcome: result.outcome,
        asset: result.asset
          ? {
              path: result.asset.path, contentType: result.asset.contentType, sizeBytes: result.asset.sizeBytes,
              cachedAt: result.asset.cachedAt, expiresAt: result.asset.expiresAt, hits: result.asset.hits,
              shieldServed: result.asset.shieldServed,
            }
          : undefined,
      };
    },
  };
}

/** cdn.purge — purge cached assets from a zone. */
export function cdnPurgeTool(getModule: () => CdnModule | undefined): Tool {
  return {
    name: 'cdn.purge',
    description: 'Purge cached assets from a CDN zone by exact path, by prefix, or the whole zone.',
    inputSchema: {
      type: 'object',
      properties: {
        zoneId: { type: 'string', description: 'CDN zone id.' },
        path: { type: 'string', description: 'Exact path to purge (optional).' },
        prefix: { type: 'string', description: 'Prefix to purge, e.g. /assets (optional).' },
        all: { type: 'boolean', description: 'Purge the entire zone (optional).' },
      },
      required: ['zoneId'],
    },
    async execute(input: any, ctx: ToolContext) {
      const mod = getModule();
      if (!mod) return missing('cdn');
      const zone = mod.getZone(String(input.zoneId));
      if (!zone) return { error: `zone ${input.zoneId} not found` };
      const result = await mod.purge(zone.id, {
        ...(input.path ? { path: String(input.path) } : {}),
        ...(input.prefix ? { prefix: String(input.prefix) } : {}),
        ...(input.all ? { all: true } : {}),
      });
      ctx.logger.info(`cdn.purge ${zone.domain} -> ${result.purged} asset(s)`);
      return { purged: result.purged };
    },
  };
}

// ---------------------------------------------------------------------------
// Email (PRX Email Provider)
// ---------------------------------------------------------------------------

/** email.domains — list email domains with verification state. */
export function emailDomainsTool(getModule: () => EmailModule | undefined): Tool {
  return {
    name: 'email.domains',
    description: 'List email domains with their MX/SPF/DKIM/DMARC records and verification state.',
    inputSchema: {
      type: 'object',
      properties: {
        verifiedOnly: { type: 'boolean', description: 'Only list verified domains (optional).' },
      },
    },
    async execute(input: any, ctx: ToolContext) {
      const mod = getModule();
      if (!mod) return missing('email');
      const domains = mod.listDomains(input.verifiedOnly ? true : undefined);
      ctx.logger.info(`email.domains -> ${domains.length} domain(s)`);
      return {
        domains: domains.map((d) => ({
          id: d.id, domain: d.domain, verified: d.verified, dmarcPolicy: d.dmarcPolicy,
          dkimSelector: d.dkimSelector, mxHosts: d.mxHosts, spfRecord: d.spfRecord,
        })),
      };
    },
  };
}

/** email.send — send an outbound email. */
export function emailSendTool(getModule: () => EmailModule | undefined): Tool {
  return {
    name: 'email.send',
    description: 'Send an email from a verified domain. Fails when the sending domain is not verified.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Sender address on a verified domain, e.g. no-reply@example.com.' },
        to: { type: 'string', description: 'Recipient address, or comma-separated list of addresses.' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['from', 'to', 'subject', 'body'],
    },
    async execute(input: any, ctx: ToolContext) {
      const mod = getModule();
      if (!mod) return missing('email');
      try {
        const to = Array.isArray(input.to)
          ? input.to.map((t: unknown) => String(t))
          : String(input.to ?? '').split(',').map((t: string) => t.trim()).filter(Boolean);
        const message = await mod.send({
          from: String(input.from),
          to,
          subject: String(input.subject),
          body: String(input.body),
        });
        ctx.logger.info(`email.send ${message.id} ${message.from} -> ${to.length} recipient(s) [${message.status}]`);
        return {
          message: {
            id: message.id, from: message.from, to: message.to, subject: message.subject,
            status: message.status, dkimSigned: message.dkimSigned, spfChecked: message.spfChecked,
            dmarcEvaluated: message.dmarcEvaluated, sentAt: message.sentAt, error: message.error,
          },
        };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

/** email.inbox — list received inbound messages. */
export function emailInboxTool(getModule: () => EmailModule | undefined): Tool {
  return {
    name: 'email.inbox',
    description: 'List inbound email messages received by the mail system, optionally filtered by status.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Optional status filter: received | spam | quarantined | read | archived.' },
      },
    },
    async execute(input: any, ctx: ToolContext) {
      const mod = getModule();
      if (!mod) return missing('email');
      const messages = mod.listInbound(undefined, input.status ? String(input.status) as any : undefined);
      ctx.logger.info(`email.inbox -> ${messages.length} message(s)`);
      return {
        messages: messages.map((m) => ({
          id: m.id, mailboxId: m.mailboxId, from: m.from, subject: m.subject, status: m.status,
          dmarcDisposition: m.dmarcDisposition, receivedAt: m.receivedAt,
        })),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// IPAM (PRX RIR Member)
// ---------------------------------------------------------------------------

/** ipam.blocks — list IP address blocks. */
export function ipamBlocksTool(getModule: () => IpamModule | undefined): Tool {
  return {
    name: 'ipam.blocks',
    description: 'List IP address blocks held from Regional Internet Registries (AFRINIC/APNIC/ARIN/RIPE/LACNIC).',
    inputSchema: {
      type: 'object',
      properties: {
        family: { type: 'string', description: 'Optional address family: ipv4 | ipv6.' },
        rir: { type: 'string', description: 'Optional RIR: AFRINIC | APNIC | ARIN | RIPE | LACNIC.' },
        status: { type: 'string', description: 'Optional status: allocated | assigned | available | returned.' },
      },
    },
    async execute(input: any, ctx: ToolContext) {
      const mod = getModule();
      if (!mod) return missing('ipam');
      const blocks = mod.listBlocks({
        ...(input.family ? { family: String(input.family) as any } : {}),
        ...(input.rir ? { rir: String(input.rir) as any } : {}),
        ...(input.status ? { status: String(input.status) as any } : {}),
      });
      ctx.logger.info(`ipam.blocks -> ${blocks.length} block(s)`);
      return {
        blocks: blocks.map((b) => ({
          id: b.id, cidr: b.cidr, family: b.family, rir: b.rir, status: b.status,
          parentId: b.parentId, purpose: b.purpose,
        })),
      };
    },
  };
}

/** ipam.announcements — list BGP announcements. */
export function ipamAnnouncementsTool(getModule: () => IpamModule | undefined): Tool {
  return {
    name: 'ipam.announcements',
    description: 'List active BGP announcements linking IP blocks to autonomous system numbers (ASNs).',
    inputSchema: { type: 'object', properties: {} },
    async execute(_input: any, ctx: ToolContext) {
      const mod = getModule();
      if (!mod) return missing('ipam');
      const announcements = mod.listAnnouncements();
      ctx.logger.info(`ipam.announcements -> ${announcements.length} announcement(s)`);
      return { announcements: announcements.map((a) => ({ blockId: a.blockId, asnId: a.asnId, since: a.since })) };
    },
  };
}

/** ipam.stats — IPAM utilization analytics. */
export function ipamStatsTool(getModule: () => IpamModule | undefined): Tool {
  return {
    name: 'ipam.stats',
    description: 'IP address management utilization analytics (blocks, addresses, ASNs).',
    inputSchema: { type: 'object', properties: {} },
    async execute(_input: any, ctx: ToolContext) {
      const mod = getModule();
      if (!mod) return missing('ipam');
      const stats = mod.stats();
      ctx.logger.info(`ipam.stats blocks=${stats.blocks} utilization=${stats.utilizationPct}%`);
      return {
        blocks: stats.blocks,
        allocatedBlocks: stats.allocatedBlocks,
        totalAddresses: stats.totalAddresses.toString(),
        allocatedAddresses: stats.allocatedAddresses.toString(),
        utilizationPct: stats.utilizationPct,
        asns: stats.asns,
        activeAsns: stats.activeAsns,
        addressEntries: stats.addressEntries,
      };
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
    cloudInstancesTool(() => get<CloudModule>('cloud')),
    cloudProvisionTool(() => get<CloudModule>('cloud')),
    cloudAutoscaleTool(() => get<CloudModule>('cloud')),
    cdnZonesTool(() => get<CdnModule>('cdn')),
    cdnLookupTool(() => get<CdnModule>('cdn')),
    cdnPurgeTool(() => get<CdnModule>('cdn')),
    emailDomainsTool(() => get<EmailModule>('email')),
    emailSendTool(() => get<EmailModule>('email')),
    emailInboxTool(() => get<EmailModule>('email')),
    ipamBlocksTool(() => get<IpamModule>('ipam')),
    ipamAnnouncementsTool(() => get<IpamModule>('ipam')),
    ipamStatsTool(() => get<IpamModule>('ipam')),
  ];
}
