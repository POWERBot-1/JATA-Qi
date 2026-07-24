// Public API for @jataqi/simulation.
export { SimulationModule } from './simulation-module.js';
export { simulate } from './simulator.js';
export { mulberry32, randomSeed } from './rng.js';
export { computeStats, quantile, histogram } from './statistics.js';
export {
  constant,
  uniform,
  normal,
  triangular,
  exponential,
  bernoulli,
  choice,
  createDistribution,
} from './distributions.js';
export { SIMULATION_CAVEAT, SimulationEvents } from './types.js';
export type { Distribution, Scenario, SimulationResult, Stats } from './types.js';
