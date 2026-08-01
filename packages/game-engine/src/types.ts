// NOVA engine types — Entity-Component-System (ECS) data model. The ECS is the
// universal substrate of the engine: every game (2D platformer, 3D FPS,
// sandbox, card game) is expressed as entities bearing components, advanced by
// systems each tick. This keeps the engine genre-agnostic and data-oriented.

/** A unique entity identifier (a monotonically increasing integer). */
export type EntityId = number;

/** The kind/name of a component (e.g. 'Transform', 'RigidBody', 'Health'). */
export type ComponentName = string;

/** A typed component store: entity id -> component data. */
export interface ComponentStore<T = unknown> {
  readonly name: ComponentName;
  has(e: EntityId): boolean;
  get(e: EntityId): T | undefined;
  set(e: EntityId, value: T): void;
  delete(e: EntityId): boolean;
  entries(): IterableIterator<[EntityId, T]>;
  readonly size: number;
}

/** A query selects entities whose component set matches the predicate. */
export interface Query {
  /** All of these components must be present. */
  all?: readonly ComponentName[];
  /** At least one of these must be present (optional). */
  any?: readonly ComponentName[];
  /** None of these may be present. */
  none?: readonly ComponentName[];
}

/** A system advances the world by `dt` seconds each tick. */
export interface System {
  readonly name: string;
  /** Entities the system operates on (optional). */
  readonly query?: Query;
  /** Lower priority runs first (default 0). */
  readonly priority?: number;
  update(world: World, dt: number): void;
}

/** Listener invoked when a world event occurs. */
export type WorldEvent = { type: string; entity?: EntityId; component?: ComponentName };

/** Public ECS surface implemented by World. */
export interface World {
  readonly time: number;
  readonly tick: number;
  createEntity(): EntityId;
  destroyEntity(e: EntityId): boolean;
  hasEntity(e: EntityId): boolean;
  entities(): EntityId[];
  registerComponent<T>(name: ComponentName): ComponentStore<T>;
  store<T>(name: ComponentName): ComponentStore<T>;
  add<T>(e: EntityId, name: ComponentName, value: T): void;
  get<T>(e: EntityId, name: ComponentName): T | undefined;
  require<T>(e: EntityId, name: ComponentName): T;
  has(e: EntityId, name: ComponentName): boolean;
  remove(e: EntityId, name: ComponentName): boolean;
  addSystem(system: System): void;
  removeSystem(name: string): boolean;
  systems(): ReadonlyArray<System>;
  query(q: Query): EntityId[];
  step(dt: number): void;
  on(type: string, fn: (e: WorldEvent) => void): () => void;
}

/** Built-in Transform component: position, rotation (quaternion), scale. */
export interface Transform {
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
  parent?: EntityId;
}

/** Built-in Name/Tag component. */
export interface Name { name: string; }

/** A mesh/asset reference (resolved by the asset pipeline). */
export interface MeshRef { asset: string; material?: string; castShadow?: boolean; }

/** A camera component. */
export interface Camera { fov: number; near: number; far: number; active?: boolean; }

/** A light component. */
export interface Light { kind: 'directional' | 'point' | 'spot'; color: [number, number, number]; intensity: number; }
