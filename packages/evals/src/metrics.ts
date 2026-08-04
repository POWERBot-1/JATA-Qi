// Built-in evaluation metrics. Each returns a score in [0, 1].

import type { EvalMetric } from './types.js';

/** Exact string match (case-insensitive after trimming). */
export const exactMatch: EvalMetric = {
  name: 'exact_match',
  description: 'Exact match (case-insensitive, trimmed)',
  score: (actual, expected) => (expected !== undefined && actual.trim().toLowerCase() === expected.trim().toLowerCase() ? 1 : 0),
};

/** Actual contains expected (case-insensitive). */
export const contains: EvalMetric = {
  name: 'contains',
  description: 'Output contains expected string',
  score: (actual, expected) => (expected !== undefined && actual.toLowerCase().includes(expected.toLowerCase()) ? 1 : 0),
};

/** Actual starts with expected. */
export const startsWith: EvalMetric = {
  name: 'starts_with',
  score: (actual, expected) => (expected !== undefined && actual.trim().toLowerCase().startsWith(expected.trim().toLowerCase()) ? 1 : 0),
};

/** Token overlap (Jaccard similarity). Good for measuring semantic closeness cheaply. */
export const tokenOverlap: EvalMetric = {
  name: 'token_overlap',
  description: 'Jaccard token overlap between actual and expected',
  score: (actual, expected) => {
    if (!expected) return 0;
    const at = new Set(actual.toLowerCase().split(/\s+/).filter(Boolean));
    const et = new Set(expected.toLowerCase().split(/\s+/).filter(Boolean));
    if (at.size === 0 && et.size === 0) return 1;
    if (at.size === 0 || et.size === 0) return 0;
    let intersection = 0;
    for (const t of at) if (et.has(t)) intersection += 1;
    return intersection / (at.size + et.size - intersection);
  },
};

/** Regex match against expected (expected is a regex pattern). */
export const regex: EvalMetric = {
  name: 'regex',
  score: (actual, expected) => {
    if (!expected) return 0;
    try { return new RegExp(expected).test(actual) ? 1 : 0; } catch { return 0; }
  },
};

/** Output length within a reasonable range (not empty, not absurdly long). */
export const notEmpty: EvalMetric = {
  name: 'not_empty',
  score: (actual) => (actual.trim().length > 0 ? 1 : 0),
};

export const BUILTIN_METRICS: EvalMetric[] = [exactMatch, contains, startsWith, tokenOverlap, regex, notEmpty];
