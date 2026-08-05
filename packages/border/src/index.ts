// @jataqi/border — KARIS BORDER X Border Security Intelligence (Phase 7).
// Public API.

export { BorderModule, BorderEvents } from './border-module.js';
export { BorderEngine } from './engine.js';
export type { RegisterPostInput, ProcessCrossingInput, DeclareManifestInput } from './engine.js';
export type {
  BorderPost, CrossingMode, Clearance, Crossing, ManifestStatus, CargoManifest,
  WatchlistEntry, BorderStats,
} from './types.js';
