import { describe, it, expect } from 'vitest';
import { makeDbReadinessCheck } from '../src/db/readiness';

describe('makeDbReadinessCheck', () => {
  it('la query résout -> ne rejette pas', async () => {
    const check = makeDbReadinessCheck({ query: async () => ({ rows: [{ n: 1 }] }) }, 2000);
    await expect(check()).resolves.toBeUndefined();
  });

  it('la query rejette (DB KO) -> propage l\'erreur', async () => {
    const check = makeDbReadinessCheck({ query: async () => { throw new Error('ECONNREFUSED'); } }, 2000);
    await expect(check()).rejects.toThrow('ECONNREFUSED');
  });

  it('la query pend au-delà du timeout -> rejette « readiness timeout » (ne pend pas 8 s)', async () => {
    // query qui ne se règle jamais -> c'est le timeout court qui doit trancher.
    const check = makeDbReadinessCheck({ query: () => new Promise(() => {}) }, 30);
    const start = Date.now();
    await expect(check()).rejects.toThrow('readiness timeout');
    expect(Date.now() - start).toBeLessThan(500); // borné par le timeout, pas par le connectionTimeout de 8 s
  });
});
