// Public API for @jataqi/model-registry.
export { ModelRegistryModule } from './model-registry-module.js';
export type { ModelRegistryConfig } from './model-registry-module.js';
export { filter, score, select } from './selector.js';
export { ModelRegistryEvents } from './types.js';
export type {
  ModelCapability,
  ModelDescriptor,
  SelectionPreference,
  SelectionRequest,
  SelectionResult,
} from './types.js';
