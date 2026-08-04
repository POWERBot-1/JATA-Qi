// Fixed-window rate limiter. Tracks request counts per key (principal id or IP)
// within a rolling window. Cheap, dependency-free, suitable as gateway middleware.

export interface RateLimitOptions {
  /** Max requests per window per key. */
  limit: number;
  /** Window size in milliseconds. */
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Epoch ms when the current window resets. */
  resetAt: number;
  /** Seconds until reset (for the Retry-After header). */
  retryAfterSec: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(opts: RateLimitOptions) {
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
  }

  /** Account for one request from `key`. Returns the decision (and mutates state). */
  consume(key: string, now: number = Date.now()): RateLimitDecision {
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    const allowed = bucket.count <= this.limit;
    const remaining = Math.max(0, this.limit - bucket.count);
    return {
      allowed,
      limit: this.limit,
      remaining,
      resetAt: bucket.resetAt,
      retryAfterSec: allowed ? 0 : Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  /** Number of tracked keys (for tests/observability). */
  size(): number {
    return this.buckets.size;
  }
}
