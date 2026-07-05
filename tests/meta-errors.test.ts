import { describe, it, expect } from 'vitest';
import { classify, MetaApiError } from '../src/meta/errors';

describe('classify', () => {
  it('429 -> retryable', () => {
    expect(classify(429, null)).toBe(true);
  });
  it('5xx -> retryable', () => {
    expect(classify(500, null)).toBe(true);
    expect(classify(503, { code: 100 })).toBe(true); // 5xx prime sur le code
  });
  it('408 / 425 (timeout, too early) -> retryable', () => {
    expect(classify(408, null)).toBe(true);
    expect(classify(425, null)).toBe(true);
  });
  it('code transitoire connu -> retryable', () => {
    expect(classify(400, { code: 131026 })).toBe(true);
    expect(classify(400, { code: 1 })).toBe(true);
  });
  it('code terminal connu -> non retryable', () => {
    expect(classify(400, { code: 100 })).toBe(false);
    expect(classify(400, { code: 131049 })).toBe(false);
  });
  it('4xx sans code connu -> terminal', () => {
    expect(classify(400, { code: 999999 })).toBe(false);
    expect(classify(403, null)).toBe(false);
  });
});

describe('MetaApiError', () => {
  it('expose code/subcode/type/httpStatus et retryable', () => {
    const err = new MetaApiError(400, { code: 100, error_subcode: 33, type: 'OAuthException', message: 'bad' });
    expect(err).toBeInstanceOf(Error);
    expect(err.httpStatus).toBe(400);
    expect(err.code).toBe(100);
    expect(err.subcode).toBe(33);
    expect(err.type).toBe('OAuthException');
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('bad');
  });
});
