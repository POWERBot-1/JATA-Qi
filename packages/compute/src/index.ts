// Public API for @jataqi/compute.
export { ComputeModule } from './compute-module.js';
export {
  mean, median, variance, stdev, min, max, sum, quantile, correlation, covariance, summarize,
} from './statistics.js';
export type { StatsSummary } from './statistics.js';
export { linearRegression } from './regression.js';
export type { LinearFit } from './regression.js';
export { minimize, bisect } from './numerical.js';
export type { OptimizeOptions, OptimizeResult, BisectOptions } from './numerical.js';
export { statsTool, regressionTool, computeTools } from './tools.js';
