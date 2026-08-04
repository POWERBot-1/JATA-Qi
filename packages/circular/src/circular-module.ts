// CircularModule — KARIS LOOP kernel module. Wraps the engine, emits bus
// events, and records collection milestones into the Digital Memory Engine.

import type { KernelApi, IModule } from '@jataqi/core-kernel';
import type { DigitalMemoryModule } from '@jataqi/memory';
import { CircularEngine, type RecordCollectionInput, type RegisterStreamInput } from './engine.js';
import type {
  CircularityScore, CircularStats, Collection, CollectionStatus, MaterialStream,
  MaterialType, TakeBackItem,
} from './types.js';

export const CircularEvents = Object.freeze({
  StreamRegistered: 'circular.stream.registered',
  CollectionRecorded: 'circular.collection.recorded',
  CollectionProcessed: 'circular.collection.processed',
  TakeBackRegistered: 'circular.takeback.registered',
} as const);

export class CircularModule implements IModule {
  readonly id = 'circular';
  readonly tags = ['core', 'circular', 'intelligence'] as const;
  readonly dependsOn = [] as const;

  private api!: KernelApi;
  private memory?: DigitalMemoryModule;
  readonly engine = new CircularEngine();

  async init(kernel: KernelApi): Promise<void> {
    this.api = kernel;
    kernel.container.registerValue('circular', this);
    this.memory = this.tryModule<DigitalMemoryModule>('memory');
    kernel.logger.info('circular module initialized (KARIS LOOP)');
  }
  async start(_kernel: KernelApi): Promise<void> { /* no bg work */ }
  async stop(_kernel: KernelApi): Promise<void> { /* stateless */ }

  registerStream(input: RegisterStreamInput): MaterialStream {
    const stream = this.engine.registerStream(input);
    void this.api.bus.emit(CircularEvents.StreamRegistered, { id: stream.id, name: stream.name });
    return stream;
  }
  getStream(id: string): MaterialStream | undefined { return this.engine.getStream(id); }
  listStreams(activeOnly?: boolean): MaterialStream[] { return this.engine.listStreams(activeOnly); }
  setStreamActive(id: string, active: boolean): MaterialStream | undefined { return this.engine.setStreamActive(id, active); }

  async recordCollection(input: RecordCollectionInput): Promise<Collection> {
    const collection = this.engine.recordCollection(input);
    void this.api.bus.emit(CircularEvents.CollectionRecorded, { id: collection.id, streamId: collection.streamId, weightKg: collection.weightKg });
    await this.recordMemory('circular_collection', `collected ${collection.weightKg}kg from ${collection.source}`, {
      collectionId: collection.id, streamId: collection.streamId, weightKg: collection.weightKg,
    });
    return collection;
  }
  listCollections(streamId?: string, status?: CollectionStatus): Collection[] {
    return this.engine.listCollections(streamId, status);
  }

  updateCollectionStatus(id: string, status: CollectionStatus): Collection | undefined {
    const collection = this.engine.updateCollectionStatus(id, status);
    if (collection) {
      void this.api.bus.emit(CircularEvents.CollectionProcessed, { id: collection.id, status: collection.status });
      void this.recordMemory('circular_collection', `collection ${collection.id} → ${collection.status}`, {
        collectionId: collection.id, status: collection.status,
      });
    }
    return collection;
  }

  registerTakeBack(input: { productId: string; productName: string; composition: Record<string, number>; returnedBy: string }): TakeBackItem {
    const item = this.engine.registerTakeBack(input);
    void this.api.bus.emit(CircularEvents.TakeBackRegistered, { id: item.id, productId: item.productId });
    return item;
  }
  listTakeBack(status?: TakeBackItem['status']): TakeBackItem[] { return this.engine.listTakeBack(status); }
  updateTakeBackStatus(id: string, status: TakeBackItem['status']): TakeBackItem | undefined {
    return this.engine.updateTakeBackStatus(id, status);
  }

  scoreCircularity(scope: 'product' | 'organization', scopeId: string, itemIds?: string[]): CircularityScore {
    return this.engine.scoreCircularity(scope, scopeId, itemIds);
  }

  stats(): CircularStats { return this.engine.stats(); }

  // ---- internals ---------------------------------------------------------

  private async recordMemory(category: string, summary: string, data: Record<string, unknown>): Promise<void> {
    if (!this.memory) return;
    try {
      await this.memory.record({ category, summary, data, tags: ['circular', category] });
    } catch { /* non-fatal */ }
  }

  private tryModule<T extends IModule>(id: string): T | undefined {
    try { return this.api.getModule<T>(id); } catch { return undefined; }
  }
}
