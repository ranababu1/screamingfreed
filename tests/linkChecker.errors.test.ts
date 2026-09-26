import { describe, expect, it } from 'vitest';
import {
  categorizeError,
  isSocketCloseError,
  parseRetryAfter,
} from '../src/crawling/linkChecker.js';

describe('categorizeError', () => {
  const withCode = (code: string): Error =>
    Object.assign(new Error('boom'), { code });

  it('classifies timeouts', () => {
    expect(categorizeError(new DOMException('timed out', 'TimeoutError'))).toBe('timeout');
    expect(categorizeError(new DOMException('aborted', 'AbortError'))).toBe('timeout');
    expect(categorizeError(withCode('ABORT_ERR'))).toBe('timeout');
    expect(categorizeError(withCode('UND_ERR_ABORT'))).toBe('timeout');
  });

  it('classifies dns failures', () => {
    expect(categorizeError(withCode('ENOTFOUND'))).toBe('dns_failure');
    expect(categorizeError(withCode('EAI_AGAIN'))).toBe('dns_failure');
  });

  it('classifies connection refused, reset and socket errors', () => {
    expect(categorizeError(withCode('ECONNREFUSED'))).toBe('connection_refused');
    expect(categorizeError(withCode('ECONNRESET'))).toBe('connection_reset');
    expect(categorizeError(withCode('UND_ERR_SOCKET'))).toBe('connection_reset');
  });

  it('classifies TLS errors', () => {
    expect(categorizeError(withCode('ERR_TLS_CERT_ALTNAME_INVALID'))).toBe('tls_error');
    expect(categorizeError(withCode('DEPTH_ZERO_SELF_SIGNED_CERT'))).toBe('tls_error');
    expect(categorizeError(withCode('CERT_HAS_EXPIRED'))).toBe('tls_error');
  });

  it('walks the cause chain', () => {
    const wrapped = new Error('wrapped', { cause: withCode('ECONNREFUSED') });
    expect(categorizeError(wrapped)).toBe('connection_refused');
  });

  it('falls back to unknown', () => {
    expect(categorizeError(new Error('mystery'))).toBe('unknown');
    expect(categorizeError('not an error')).toBe('unknown');
  });
});

describe('isSocketCloseError', () => {
  const withCode = (code: string): Error =>
    Object.assign(new Error('boom'), { code });

  it('detects socket-close codes including in the cause chain', () => {
    expect(isSocketCloseError(withCode('ECONNRESET'))).toBe(true);
    expect(isSocketCloseError(withCode('UND_ERR_SOCKET'))).toBe(true);
    expect(isSocketCloseError(new Error('wrapped', { cause: withCode('EPIPE') }))).toBe(true);
    expect(isSocketCloseError(withCode('ENOTFOUND'))).toBe(false);
    expect(isSocketCloseError(new Error('clean'))).toBe(false);
  });
});

describe('parseRetryAfter', () => {
  it('parses delay-seconds', () => {
    expect(parseRetryAfter('0', 0)).toBe(0);
    expect(parseRetryAfter('2', 0)).toBe(2_000);
  });

  it('parses HTTP dates relative to now', () => {
    const future = new Date(60_000 + 3_000).toUTCString(); // 3s after epoch
    expect(parseRetryAfter(future, 60_000)).toBe(3_000);
    const past = new Date(60_000 - 3_000).toUTCString();
    expect(parseRetryAfter(past, 60_000)).toBe(0);
  });

  it('caps absurd delays and returns null when absent or invalid', () => {
    expect(parseRetryAfter('3600', 0)).toBe(60_000);
    expect(parseRetryAfter('garbage', 0)).toBeNull();
    expect(parseRetryAfter(undefined, 0)).toBeNull();
  });
});