// Least-squares linear regression and numerical methods.

export interface LinearFit {
  slope: number;
  intercept: number;
  /** Coefficient of determination (0..1). */
  r2: number;
}

/** Fit y = slope*x + intercept via ordinary least squares. */
export function linearRegression(xs: number[], ys: number[]): LinearFit {
  if (xs.length !== ys.length || xs.length < 2) {
    throw new Error('linearRegression: need two equal-length arrays with >= 2 points');
  }
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  if (den === 0) throw new Error('linearRegression: zero variance in x');
  const slope = num / den;
  const intercept = my - slope * mx;

  // R^2 via total/ residual sum of squares.
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const predicted = slope * xs[i]! + intercept;
    ssRes += (ys[i]! - predicted) ** 2;
    ssTot += (ys[i]! - my) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  return { slope, intercept, r2 };
}
