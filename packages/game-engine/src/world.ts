// World — the ECS container. Holds entities, typed component stores, systems,
// and a clock. `step(dt)` runs all systems (sorted by priority) and advances
// the clock. Deterministic: given the same systems, components, and dt, the
// world evolves identically — which is what simulation, replays, and lockstep
// multiplayer require.

import type { ComponentName, ComponentStore, EntityId, Query, System, World as WorldI, WorldEvent } from './types.js';

class StoreImpl<T = unknown> implements ComponentStore<T> {
  private map = new Map<EntityId, T>();
  constructor(readonly name: ComponentName) {}
  has(e: EntityId): boolean { return this.map.has(e); }
  get(e: EntityId): T | undefined { return this.map.get(e); }
  set(e: EntityId, value: T): void { this.map.set(e, value); }
  delete(e: EntityId): boolean { return this.map.delete(e); }
  entries(): IterableIterator<[EntityId, T]> { return this.map.entries(); }
  get size(): number { return this.map.size; }
}

export class World implements WorldI {
  private entitySet = new Set<EntityId>();
  private stores = new Map<ComponentName, ComponentStore>();
  private systemList: System[] = [];
  private systemsDirty = false;
  private nextId = 1;
  private clock = 0;
  private clockTick = 0;
  private listeners = new Map<string, Set<(e: WorldEvent) => void>>();

  get time(): number { return this.clock; }
  get tick(): number { return this.clockTick; }

  // ---- entities ----------------------------------------------------------

  createEntity(): EntityId {
    const id = this.nextId++;
    this.entitySet.add(id);
    this.emit({ type: 'entity.created', entity: id });
    return id;
  }

  destroyEntity(e: EntityId): boolean {
    if (!this.entitySet.delete(e)) return false;
    for (const store of this.stores.values()) store.delete(e);
    this.emit({ type: 'entity.destroyed', entity: e });
    return true;
  }

  hasEntity(e: EntityId): boolean { return this.entitySet.has(e); }

  entities(): EntityId[] { return [...this.entitySet]; }

  /** Total live entity count. */
  get entityCount(): number { return this.entitySet.size; }

  // ---- components --------------------------------------------------------

  registerComponent<T>(name: ComponentName): ComponentStore<T> {
    let s = this.stores.get(name);
    if (!s) { s = new StoreImpl<T>(name); this.stores.set(name, s); }
    return s as ComponentStore<T>;
  }

  store<T>(name: ComponentName): ComponentStore<T> {
    return this.registerComponent<T>(name);
  }

  add<T>(e: EntityId, name: ComponentName, value: T): void {
    if (!this.hasEntity(e)) throw new Error(`world: entity ${e} does not exist`);
    this.store<T>(name).set(e, value);
    this.emit({ type: 'component.added', entity: e, component: name });
  }

  get<T>(e: EntityId, name: ComponentName): T | undefined {
    return this.stores.get(name)?.get(e) as T | undefined;
  }

  require<T>(e: EntityId, name: ComponentName): T {
    const v = this.get<T>(e, name);
    if (v === undefined) throw new Error(`world: entity ${e} has no component "${name}"`);
    return v;
  }

  has(e: EntityId, name: ComponentName): boolean {
    return this.stores.get(name)?.has(e) ?? false;
  }

  remove(e: EntityId, name: ComponentName): boolean {
    const removed = this.stores.get(name)?.delete(e) ?? false;
    if (removed) this.emit({ type: 'component.removed', entity: e, component: name });
    return removed;
  }

  /** List of registered component names. */
  componentNames(): ComponentName[] { return [...this.stores.keys()]; }

  // ---- systems -----------------------------------------------------------

  addSystem(system: System): void {
    this.systemList.push(system);
    this.systemsDirty = true;
    this.emit({ type: 'system.added', component: system.name });
  }

  removeSystem(name: string): boolean {
    const before = this.systemList.length;
    this.systemList = this.systemList.filter((s) => s.name !== name);
    const removed = this.systemList.length !== before;
    if (removed) this.emit({ type: 'system.removed', component: name });
    return removed;
  }

  systems(): ReadonlyArray<System> {
    if (this.systemsDirty) {
      this.systemList.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
      this.systemsDirty = false;
    }
    return this.systemList;
  }

  // ---- queries -----------------------------------------------------------

  query(q: Query): EntityId[] {
    const all = q.all ?? [];
    const any = q.any;
    const none = q.none ?? [];
    if (all.length === 0 && !any && none.length === 0) return this.entities();
    // Start from the smallest required store for efficiency.
    let candidates: EntityId[];
    if (all.length > 0) {
      const first = this.stores.get(all[0]!);
      candidates = first ? [...first.entries()].map(([e]) => e) : [];
    } else if (any && any.length > 0) {
      const set = new Set<EntityId>();
      for (const n of any) { const s = this.stores.get(n); if (s) for (const [e] of s.entries()) set.add(e); }
      candidates = [...set];
    } else {
      candidates = this.entities();
    }
    return candidates.filter((e) => {
      for (const n of all) if (!this.stores.get(n)?.has(e)) return false;
      if (any && any.length > 0) { if (!any.some((n) => this.stores.get(n)?.has(e))) return false; }
      for (const n of none) if (this.stores.get(n)?.has(e)) return false;
      return true;
    });
  }

  // ---- stepping ----------------------------------------------------------

  step(dt: number): void {
    if (dt < 0) throw new Error('world: dt must be non-negative');
    for (const s of this.systems()) s.update(this, dt);
    this.clock += dt;
    this.clockTick++;
  }

  // ---- events ------------------------------------------------------------

  on(type: string, fn: (e: WorldEvent) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) { set = new Set(); this.listeners.set(type, set); }
    set.add(fn);
    return () => set!.delete(fn);
  }

  private emit(e: WorldEvent): void {
    const set = this.listeners.get(e.type);
    if (set) for (const fn of set) fn(e);
  }

  /** Serialize the world to a plain object (JSON-safe). */
  serialize(): { entityIds: EntityId[]; components: Record<string, [EntityId, unknown][]>; time: number; tick: number } {
    const components: Record<string, [EntityId, unknown][]> = {};
    for (const [name, store] of this.stores) {
      components[name] = [...store.entries()];
    }
    return { entityIds: this.entities(), components, time: this.clock, tick: this.clockTick };
  }

  /** Rebuild the world from a serialized snapshot (clears existing state). */
  load(data: { entityIds?: EntityId[]; components?: Record<string, [EntityId, unknown][]>; time?: number; tick?: number }): void {
    this.entitySet.clear();
    this.stores.clear();
    this.clock = data.time ?? 0;
    this.clockTick = data.tick ?? 0;
    const ids = new Set<EntityId>(data.entityIds ?? []);
    if (data.components) {
      for (const [, entries] of Object.entries(data.components)) {
        for (const [e] of entries) ids.add(e);
      }
    }
    this.nextId = 1;
    for (const id of ids) {
      this.entitySet.add(id);
      if (id >= this.nextId) this.nextId = id + 1;
    }
    if (data.components) {
      for (const [name, entries] of Object.entries(data.components)) {
        const store = this.registerComponent(name);
        for (const [e, v] of entries) store.set(e, v);
      }
    }
  }
}
