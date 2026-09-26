import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenBucketRateLimiter } from '../src/crawling/tokenBucket.js';

describe('TokenBucketRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('never exceeds the configured rate under concurrent load', async () => {
    const limiter = new TokenBucketRateLimiter(2); // 2 requests/second
    const times: number[] = [];
    const acquires = Array.from({ length: 10 }, () =>
      limiter.acquire('example.com').then(() => {
        times.push(Date.now());
      }),
    );
    await vi.advanceTimersByTimeAsync(6_000);
    await Promise.all(acquires);

    expect(times).toHaveLength(10);
    times.sort((a, b) => a - b);
    // With capacity one and 2 rps, releases must be spaced >= ~500ms apart,
    // so no one-second window ever contains more than two requests.
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index] - times[index - 1]).toBeGreaterThanOrEqual(490);
    }
    expect(times[9]).toBeGreaterThanOrEqual(4_500);
  });

  it('serves each host from an independent bucket', async () => {
    const limiter = new TokenBucketRateLimiter(2);
    const first: string[] = [];
    await limiter.acquire('a.com').then(() => first.push('a'));
    await limiter.acquire('b.com').then(() => first.push('b'));
    expect(first).toEqual(['a', 'b']); // both immediate: separate buckets

    const start = Date.now(); // fake Date starts at real time, so compare relatively
    const second: number[] = [];
    const p1 = limiter.acquire('a.com').then(() => second.push(Date.now()));
    const p2 = limiter.acquire('b.com').then(() => second.push(Date.now()));
    await vi.advanceTimersByTimeAsync(500);
    await Promise.all([p1, p2]);
    expect(second).toEqual([start + 500, start + 500]);
  });

  it('refills fractionally so sub-second rates space requests evenly', async () => {
    const limiter = new TokenBucketRateLimiter(4); // 4 rps => 250ms spacing
    const times: number[] = [];
    const acquires = Array.from({ length: 5 }, () =>
      limiter.acquire('slow.example.com').then(() => {
        times.push(Date.now());
      }),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.all(acquires);
    times.sort((a, b) => a - b);
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index] - times[index - 1]).toBeGreaterThanOrEqual(240);
    }
  });

  it('rejects non-positive rates', () => {
    expect(() => new TokenBucketRateLimiter(0)).toThrow(RangeError);
    expect(() => new TokenBucketRateLimiter(-1)).toThrow(RangeError);
  });
});