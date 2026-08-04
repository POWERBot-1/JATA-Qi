// CircularEngine — KARIS LOOP core: material streams, collection lifecycle
// (collected → processed → recycled/diverted/landfill), product take-back
// with composition, circularity scoring, and CO2e savings. Pure engine.

import { randomUUID } from 'node:crypto';
import type {
  CircularityScore, CircularStats, Collection, CollectionStatus, MaterialStream,
  MaterialType, TakeBackItem,
} from './types.js';

export interface RegisterStreamInput {
  name: string;
  type?: MaterialType;
  co2ePerKg?: number;
}

export interface RecordCollectionInput {
  streamId: string;
  weightKg: number;
  source: string;
}

const RECYCLED_WEIGHT_FRACTION = 0.7; // 70% of processed material becomes recycled feedstock
const DIVERTED_WEIGHT_FRACTION = 0.2; // 20% diverted to energy recovery / reuse

export class CircularEngine {
  private streams = new Map<string, MaterialStream>();
  private collections = new Map<string, Collection>();
  private takeBack = new Map<string, TakeBackItem>();

  // ---- material streams --------------------------------------------------

  registerStream(input: RegisterStreamInput): MaterialStream {
    if (!input.name) throw new Error('stream name is required');
    const stream: MaterialStream = {
      id: randomUUID(), name: input.name, type: input.type ?? 'other',
      active: true, co2ePerKg: input.co2ePerKg ?? 0.5,
      createdAt: Date.now(),
    };
    this.streams.set(stream.id, stream);
    return stream;
  }

  getStream(id: string): MaterialStream | undefined { return this.streams.get(id); }
  listStreams(activeOnly?: boolean): MaterialStream[] {
    const all = [...this.streams.values()];
    return activeOnly ? all.filter((s) => s.active) : all;
  }

  setStreamActive(id: string, active: boolean): MaterialStream | undefined {
    const stream = this.streams.get(id);
    if (!stream) return undefined;
    stream.active = active;
    return stream;
  }

  // ---- collections -------------------------------------------------------

  recordCollection(input: RecordCollectionInput): Collection {
    const stream = this.streams.get(input.streamId);
    if (!stream) throw new Error(`unknown stream ${input.streamId}`);
    if (input.weightKg <= 0) throw new Error('weightKg must be positive');
    const collection: Collection = {
      id: randomUUID(),
      streamId: input.streamId,
      weightKg: input.weightKg,
      status: 'collected',
      source: input.source,
      collectedAt: Date.now(),
    };
    this.collections.set(collection.id, collection);
    return collection;
  }

  getCollection(id: string): Collection | undefined { return this.collections.get(id); }
  listCollections(streamId?: string, status?: CollectionStatus): Collection[] {
    return [...this.collections.values()].filter((c) =>
      (!streamId || c.streamId === streamId) && (!status || c.status === status));
  }

  updateCollectionStatus(id: string, status: CollectionStatus): Collection | undefined {
    const collection = this.collections.get(id);
    if (!collection) return undefined;
    collection.status = status;
    return collection;
  }

  // ---- take-back ---------------------------------------------------------

  registerTakeBack(input: { productId: string; productName: string; composition: Record<string, number>; returnedBy: string }): TakeBackItem {
    if (!input.productId || !input.productName) throw new Error('productId and productName are required');
    const total = Object.values(input.composition).reduce((s, v) => s + v, 0);
    if (Object.keys(input.composition).length > 0 && Math.abs(total - 1) > 0.001) {
      throw new Error('composition fractions must sum to 1');
    }
    const item: TakeBackItem = {
      id: randomUUID(), productId: input.productId, productName: input.productName,
      composition: { ...input.composition }, returnedBy: input.returnedBy,
      status: 'returned', receivedAt: Date.now(),
    };
    this.takeBack.set(item.id, item);
    return item;
  }

  getTakeBackItem(id: string): TakeBackItem | undefined { return this.takeBack.get(id); }
  listTakeBack(status?: TakeBackItem['status']): TakeBackItem[] {
    const all = [...this.takeBack.values()];
    return status ? all.filter((i) => i.status === status) : all;
  }

  updateTakeBackStatus(id: string, status: TakeBackItem['status']): TakeBackItem | undefined {
    const item = this.takeBack.get(id);
    if (!item) return undefined;
    item.status = status;
    return item;
  }

  // ---- circularity -------------------------------------------------------

  /** Circularity score for a set of take-back items (product or org scope). */
  scoreCircularity(scope: 'product' | 'organization', scopeId: string, itemIds?: string[]): CircularityScore {
    const items = itemIds
      ? itemIds.map((id) => this.takeBack.get(id)).filter((i): i is TakeBackItem => i !== undefined)
      : [...this.takeBack.values()].filter((i) => scope === 'organization' || i.productId === scopeId);
    const total = items.length;
    if (total === 0) {
      return { scope, scopeId, score: 0, circularRate: 0, landfillRate: 0, totalMaterialKg: 0, computedAt: Date.now() };
    }
    const recycled = items.filter((i) => i.status === 'recycled').length;
    const refurbished = items.filter((i) => i.status === 'refurbished').length;
    const disposed = items.filter((i) => i.status === 'disposed').length;
    const circularRate = (recycled + refurbished) / total;
    const landfillRate = disposed / total;
    const score = Math.round(circularRate * 100);
    return {
      scope, scopeId, score, circularRate, landfillRate,
      totalMaterialKg: total,
      computedAt: Date.now(),
    };
  }

  // ---- analytics ---------------------------------------------------------

  stats(): CircularStats {
    const all = [...this.collections.values()];
    const recycledKg = all.filter((c) => c.status === 'recycled').reduce((s, c) => s + c.weightKg, 0);
    const divertedKg = all.filter((c) => c.status === 'diverted').reduce((s, c) => s + c.weightKg, 0);
    const landfillKg = all.filter((c) => c.status === 'landfill').reduce((s, c) => s + c.weightKg, 0);
    const processedKg = all.filter((c) => c.status === 'processed').reduce((s, c) => s + c.weightKg, 0);
    const totalCollected = all.reduce((s, c) => s + c.weightKg, 0);
    // CO2e saved on material actually recycled.
    const co2eSaved = [...all.entries()].reduce((s, [_, c]) => {
      if (c.status !== 'recycled') return s;
      return s + (this.streams.get(c.streamId)?.co2ePerKg ?? 0) * c.weightKg;
    }, 0);
    const takeBackItems = [...this.takeBack.values()];
    const circularRate = totalCollected > 0
      ? (recycledKg + divertedKg + processedKg * RECYCLED_WEIGHT_FRACTION) / totalCollected
      : 0;
    return {
      streams: this.streams.size,
      activeStreams: this.listStreams(true).length,
      collections: all.length,
      collectedKg: totalCollected,
      recycledKg,
      divertedKg,
      landfillKg,
      takeBackItems: takeBackItems.length,
      refurbishedItems: takeBackItems.filter((i) => i.status === 'refurbished').length,
      totalCo2eSavedKg: co2eSaved,
      circularRate,
    };
  }
}

/** Fraction of processed material that becomes recycled feedstock. */
export const PROCESSED_RECYCLED_FRACTION = RECYCLED_WEIGHT_FRACTION;
