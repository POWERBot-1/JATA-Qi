// Probability distributions used to define scenario inputs. Each has a `kind`
// tag and serializable params so scenarios can be described declaratively.

import type { Distribution } from './types.js';

/** Constant value (deterministic input). */
export function constant(value: number): Distribution {
  return {
    kind: 'constant',
    params: { value },
    sample: () => value,
  };
}

/** Uniform distribution on [min, max]. */
export function uniform(min: number, max: number): Distribution {
  return {
    kind: 'uniform',
    params: { min, max },
    sample: (rng) => min + (max - min) * rng(),
  };
}

/** Normal distribution via Box–Muller transform. */
export function normal(mean: number, sd: number): Distribution {
  return {
    kind: 'normal',
    params: { mean, sd },
    sample: (rng) => {
      const u1 = Math.max(rng(), Number.EPSILON);
      const u2 = rng();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      return mean + sd * z;
    },
  };
}

/** Triangular distribution (min <= mode <= max). */
export function triangular(min: number, mode: number, max: number): Distribution {
  return {
    kind: 'triangular',
    params: { min, mode, max },
    sample: (rng) => {
      const u = rng();
      const fc = (mode - min) / (max - min);
      return u < fc
        ? min + Math.sqrt(u * (max - min) * (mode - min))
        : max - Math.sqrt((1 - u) * (max - min) * (max - mode));
    },
  };
}

/** Exponential distribution with the given rate (lambda). */
export function exponential(rate: number): Distribution {
  return {
    kind: 'exponential',
    params: { rate },
    sample: (rng) => -Math.log(Math.max(rng(), Number.EPSILON)) / rate,
  };
}

/** Bernoulli distribution: returns 1 with probability p, else 0. */
export function bernoulli(p: number): Distribution {
  return {
    kind: 'bernoulli',
    params: { p },
    sample: (rng) => (rng() < p ? 1 : 0),
  };
}

/** Discrete uniform choice over a list of values. */
export function choice(values: number[]): Distribution {
  return {
    kind: 'choice',
    params: { values },
    sample: (rng) => {
      const i = Math.floor(rng() * values.length) % values.length;
      return values[i]!;
    },
  };
}

/** Build a distribution from a declarative spec (for HTTP/JSON scenario inputs). */
export function createDistribution(spec: { kind: string } & Record<string, unknown>): Distribution {
  const n = (k: string): number => Number(spec[k]);
  switch (spec.kind) {
    case 'constant':
      return constant(n('value'));
    case 'uniform':
      return uniform(n('min'), n('max'));
    case 'normal':
      return normal(n('mean'), n('sd'));
    case 'triangular':
      return triangular(n('min'), n('mode'), n('max'));
    case 'exponential':
      return exponential(n('rate'));
    case 'bernoulli':
      return bernoulli(n('p'));
    case 'choice':
      return choice((spec.values as number[]) ?? [0]);
    default:
      throw new Error(`unknown distribution kind "${spec.kind}"`);
  }
}
