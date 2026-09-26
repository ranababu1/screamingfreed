/**
 * Per-host token bucket rate limiter.
 *
 * The bucket for each host holds at most one token and refills continuously
 * at `requestsPerSecond`. Because the capacity is exactly one token, a host
 * can never receive more than `requestsPerSecond` requests in any one-second
 * window, even under heavy concurrent load (no burst allowance).
 */

interface Bucket {
  /** Fractional number of available tokens, capped at 1. */
  tokens: number;
  /** Timestamp (ms) of the last refill. */
  lastRefill: number;
}

export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly clock: () => number;

  constructor(
    private readonly requestsPerSecond: number,
    clock: () => number = () => Date.now(),
  ) {
    if (!Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0) {
      throw new RangeError(
        `requestsPerSecond must be a positive number, received ${requestsPerSecond}`,
      );
    }
    this.clock = clock;
  }

  /** Resolves once the caller may send one request to `host`. */
  async acquire(host: string): Promise<void> {
    for (;;) {
      const bucket = this.bucketFor(host);
      this.refill(bucket);
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return;
      }
      const deficit = 1 - bucket.tokens;
      const waitMs = Math.max(
        1,
        Math.ceil((deficit / this.requestsPerSecond) * 1000),
      );
      await sleep(waitMs);
    }
  }

  private bucketFor(host: string): Bucket {
    let bucket = this.buckets.get(host);
    if (bucket === undefined) {
      bucket = { tokens: 1, lastRefill: this.clock() };
      this.buckets.set(host, bucket);
    }
    return bucket;
  }

  private refill(bucket: Bucket): void {
    const current = this.clock();
    const elapsedMs = current - bucket.lastRefill;
    if (elapsedMs > 0) {
      bucket.tokens = Math.min(
        1,
        bucket.tokens + (elapsedMs / 1000) * this.requestsPerSecond,
      );
      bucket.lastRefill = current;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}