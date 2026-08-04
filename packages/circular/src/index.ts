// @jataqi/circular — KARIS LOOP Circular Economy Platform (Phase 7).
// Public API.

export { CircularModule, CircularEvents } from './circular-module.js';
export { CircularEngine, PROCESSED_RECYCLED_FRACTION } from './engine.js';
export type { RegisterStreamInput, RecordCollectionInput } from './engine.js';
export type {
  MaterialType, MaterialStream, CollectionStatus, Collection, TakeBackItem,
  CircularityScore, CircularStats,
} from './types.js';
