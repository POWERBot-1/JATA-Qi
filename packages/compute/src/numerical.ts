// Numerical optimization and root finding (Step 11 Mathematics: optimization).

export interface OptimizeOptions {
  /** Learning rate (default 0.1). */
  lr?: number;
  /** Max iterations (default 1000). */
  iters?: number;
  /** Stop when |gradient| < eps (default 1e-6). */
  eps?: number;
  /** Step size for the finite-difference gradient (default 1e-5). */
  h?: number;
}

export interface OptimizeResult {
  x: number;
  fx: number;
  iterations: number;
  converged: boolean;
}

/**
 * Minimize a 1-D differentiable function via gradient descent with a central
 * finite-difference gradient estimate.
 */
export function minimize(f: (x: number) => number, x0: number, opts: OptimizeOptions = {}): OptimizeResult {
  const lr = opts.lr ?? 0.1;
  const maxIters = opts.iters ?? 1000;
  const eps = opts.eps ?? 1e-6;
  const h = opts.h ?? 1e-5;

  let x = x0;
  let iterations = 0;
  let converged = false;
  for (; iterations < maxIters; iterations++) {
    const grad = (f(x + h) - f(x - h)) / (2 * h);
    if (Math.abs(grad) < eps) {
      converged = true;
      break;
    }
    x -= lr * grad;
  }
  return { x, fx: f(x), iterations: iterations + 1, converged };
}

export interface BisectOptions {
  iters?: number;
  tol?: number;
}

/**
 * Find a root of f in [a, b] by bisection. Requires f(a) and f(b) to have
 * opposite signs.
 */
export function bisect(f: (x: number) => number, a: number, b: number, opts: BisectOptions = {}): number {
  const maxIters = opts.iters ?? 100;
  const tol = opts.tol ?? 1e-6;
  let lo = a;
  let hi = b;
  let flo = f(lo);
  let fhi = f(hi);
  if (Number.isNaN(flo) || Number.isNaN(fhi) || flo * fhi > 0) {
    throw new Error('bisect: f(a) and f(b) must have opposite signs');
  }
  let mid = lo;
  for (let i = 0; i < maxIters; i++) {
    mid = (lo + hi) / 2;
    const fmid = f(mid);
    if (Math.abs(fmid) < tol || (hi - lo) / 2 < tol) return mid;
    if (flo * fmid < 0) {
      hi = mid;
      fhi = fmid;
    } else {
      lo = mid;
      flo = fmid;
    }
  }
  return mid;
}
