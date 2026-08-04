// Agent tools backed by the compute service. These let a JATA Qi agent perform
// statistical analysis and regression on data it gathers during a workflow.

import type { Tool } from '@jataqi/agent-runtime';
import { summarize, correlation } from './statistics.js';
import { linearRegression } from './regression.js';

function asNumbers(v: unknown): number[] {
  if (!Array.isArray(v)) throw new Error('expected an array of numbers');
  return v.map((n) => Number(n));
}

/** Summarize a numeric series (count, mean, median, stdev, min, max, ...). */
export function statsTool(): Tool {
  return {
    name: 'compute.stats',
    description: 'Compute descriptive statistics (mean, median, stdev, min, max, ...) for an array of numbers.',
    inputSchema: {
      type: 'object',
      properties: { values: { type: 'array', description: 'numeric series' } },
      required: ['values'],
    },
    async execute(input: any) {
      const values = asNumbers((input as { values: unknown }).values);
      if (values.length === 0) return { error: 'empty series' };
      return summarize(values);
    },
  };
}

/** Fit a least-squares line y = slope*x + intercept and report R^2. */
export function regressionTool(): Tool {
  return {
    name: 'compute.regression',
    description: 'Fit a least-squares linear regression y ~ x. Returns slope, intercept, r2.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'array', description: 'independent variable' },
        y: { type: 'array', description: 'dependent variable' },
      },
      required: ['x', 'y'],
    },
    async execute(input: any) {
      const { x, y } = input as { x: unknown; y: unknown };
      const xs = asNumbers(x);
      const ys = asNumbers(y);
      const fit = linearRegression(xs, ys);
      return { ...fit, correlation: correlation(xs, ys) };
    },
  };
}

/** All compute tools, for convenient registration. */
export function computeTools(): Tool[] {
  return [statsTool(), regressionTool()];
}
