import { describe, it, expect } from 'vitest';
import { withRetry, RateLimiter } from '../src/meta/http';
import { MetaApiError } from '../src/meta/errors';

const noSleep = async (): Promise<void> => {};
const noJitter = (): number => 0;

describe('withRetry', () => {
  it('rejoue une erreur retryable puis réussit', async () => {
    let calls = 0;
    const res = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new MetaApiError(503, null); // retryable
        return 'ok';
      },
      { maxRetries: 4, sleep: noSleep, random: noJitter },
    );
    expect(res).toBe('ok');
    expect(calls).toBe(3);
  });

  it('throw après maxRetries si toujours retryable', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new MetaApiError(500, null);
        },
        { maxRetries: 2, sleep: noSleep, random: noJitter },
      ),
    ).rejects.toBeInstanceOf(MetaApiError);
    expect(calls).toBe(3); // 1 essai + 2 retries
  });

  it('erreur terminale -> une seule tentative, pas de retry', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new MetaApiError(400, { code: 100 }); // terminal
        },
        { maxRetries: 5, sleep: noSleep, random: noJitter },
      ),
    ).rejects.toBeInstanceOf(MetaApiError);
    expect(calls).toBe(1);
  });

  it('erreur réseau (non-Meta) est traitée comme retryable', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new TypeError('fetch failed');
        },
        { maxRetries: 1, sleep: noSleep, random: noJitter },
      ),
    ).rejects.toBeInstanceOf(TypeError);
    expect(calls).toBe(2);
  });
});

describe('RateLimiter', () => {
  it('espace les appels de minIntervalMs', async () => {
    let clock = 0;
    const waits: number[] = [];
    const rl = new RateLimiter(100, {
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    await rl.acquire(); // t=0, pas d'attente
    await rl.acquire(); // attend 100
    await rl.acquire(); // attend 100
    expect(waits).toEqual([100, 100]);
  });
});
